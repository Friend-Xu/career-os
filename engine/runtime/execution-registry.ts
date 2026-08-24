/**
 * Execution Registry（ADR-034 §3.1——Runtime Execution 状态的唯一事实源）。
 *
 * - 地位：Runtime SoT，不是 Domain SoT。Registry 只记录「执行跑了没/跑完没/取消没」，
 *   不记录决策内容/评估分数/产物正文——业务真相归 Domain（Workflow/Stage/Artifact）。
 * - 实体：Execution = public/runtime identity；taskId = implementation detail（迁移期兼容，
 *   ADR-034 §2.2）。身份字段严格按 ADR-034 §2.1，不扩展（personId/业务字段=红线）。
 * - 生命周期：内存 + 事件日志（v1，ADR-034 §10.4；持久化另议）。
 * - 事件：Execution 事件流（created / status_changed）——Phase 2 的 agent/executions/events
 *   以本日志为来源；Query（当前快照）+ Events（后续变化）组合支撑 UI 投影重建（§6.1）。
 * - 状态机（ADR-034 §2.1 五态内定义的迁移表）：
 *     running  → waiting（挂起等用户输入）| completed | failed | cancelled
 *     waiting  → running（用户回答）| completed | failed | cancelled
 *     completed / failed / cancelled = 终点态（不再迁移；非法迁移 throw——内部契约，
 *     AgentRuntime 是唯一调用方，运行时真实竞态（cancel 后流剩余事件）由调用方守卫）。
 */
import type { Logger } from '../logger.ts'
import {
  isTerminalExecutionStatus,
  type Execution,
  type ExecutionEvent,
  type ExecutionEventInput,
  type ExecutionQuery,
  type ExecutionStatus,
  type PendingInteraction,
} from '../ir/execution.ts'
import { ExecutionEventLog } from './execution-event-log.ts'

export type {
  ExecutionStatus,
  Execution,
  ExecutionEvent,
  ExecutionQuery,
  PendingInteraction,
} from '../ir/execution.ts'
export { isTerminalExecutionStatus } from '../ir/execution.ts'

/** create 入参：身份字段来自调用方（AgentRuntime.start）；id 由 Registry 生成 */
export interface CreateExecutionInput {
  taskId: string
  sessionId?: string
  workflowId?: string
  stageId?: string
}

/** 迁移表（ADR-034 §2.1 五态；create 直接进入 running） */
const ALLOWED_TRANSITIONS: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  running: ['waiting', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

export class ExecutionRegistry {
  private executions = new Map<string, Execution>()
  /** 迁移期兼容索引：taskId → executionId（AgentRuntime/旧 RPC 反查；taskId 非一等身份） */
  private byTaskId = new Map<string, string>()
  private eventLog: ExecutionEvent[] = []
  private listeners = new Set<(ev: ExecutionEvent) => void>()
  private logger: Logger
  /** Persistence Adapter（Phase 3：append-only JSONL event log——注入时启动 replay 重建；
   *  不注入 = 纯内存（测试/无持久化实例）） */
  private adapter?: ExecutionEventLog

  constructor(logger: Logger, adapter?: ExecutionEventLog) {
    this.logger = logger
    this.adapter = adapter
    if (adapter !== undefined) this.replayEvents(adapter.all())
  }

  /**
   * 启动调和（Phase 3.3）：非终态（running/waiting）→ failed（note=process_restart）。
   * 进程重启后 TaskState/AbortController/runLoop 不存在——执行不可能继续；
   * failed 与 runLoop 异常映射同语义；不复活任务、不新增第六态（ADR 五态冻结）、
   * 不恢复 pendingInteraction（Runtime 已死——避免幽灵交互）。
   */
  reconcileAfterStartup(): Execution[] {
    const nonTerminal = [...this.executions.values()].filter((e) => !isTerminalExecutionStatus(e.status))
    if (nonTerminal.length === 0) return []
    for (const e of nonTerminal) this.transition(e.id, 'failed', 'process_restart')
    this.logger.info(`启动调和：${nonTerminal.length} 个非终态执行 → failed（process_restart）`)
    return nonTerminal.map((e) => this.executions.get(e.id)!)
  }

  /** 创建 Execution（status=running，startedAt=createdAt——start 语义即运行）；记录 created 事件 */
  create(input: CreateExecutionInput): Execution {
    const now = new Date().toISOString()
    const execution: Execution = {
      id: `execution_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      taskId: input.taskId,
      status: 'running',
      createdAt: now,
      startedAt: now,
    }
    if (input.sessionId !== undefined) execution.sessionId = input.sessionId
    if (input.workflowId !== undefined) execution.workflowId = input.workflowId
    if (input.stageId !== undefined) execution.stageId = input.stageId
    this.executions.set(execution.id, execution)
    this.byTaskId.set(execution.taskId, execution.id)
    this.append({
      type: 'execution.created',
      executionId: execution.id,
      taskId: execution.taskId,
      status: execution.status,
      at: now,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
      ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
    })
    this.logger.info(`execution/${execution.id} created（status=running，taskId=${execution.taskId}）`)
    return execution
  }

  get(executionId: string): Execution | undefined {
    return this.executions.get(executionId)
  }

  /** 迁移期兼容：taskId → Execution（旧 RPC agent/cancel、agent/answer 反查层可经此迁移） */
  getByTaskId(taskId: string): Execution | undefined {
    const executionId = this.byTaskId.get(taskId)
    return executionId === undefined ? undefined : this.executions.get(executionId)
  }

  /** 只读查询（ADR-034 §3.2 过滤维度 = Runtime 事实）；返回 createdAt 降序（最新在前） */
  query(filter: ExecutionQuery = {}): Execution[] {
    return [...this.executions.values()]
      .filter(
        (e) =>
          (filter.status === undefined || e.status === filter.status) &&
          (filter.sessionId === undefined || e.sessionId === filter.sessionId) &&
          (filter.workflowId === undefined || e.workflowId === filter.workflowId),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  }

  /**
   * 状态迁移（唯一正面入口——AgentRuntime runLoop/cancel 驱动；非法迁移 throw）。
   * 终点态设置 finishedAt 并清除 pendingInteraction（终态无等待交互——Runtime 事实守恒）；
   * 记录 status_changed 事件（note 仅限 Runtime/Infrastructure 语义，如 process_restart）并通知订阅者。
   */
  transition(executionId: string, to: ExecutionStatus, note?: string): Execution {
    const execution = this.executions.get(executionId)
    if (execution === undefined) throw new Error(`execution/${executionId} 不存在——无法迁移到 ${to}`)
    const allowed = ALLOWED_TRANSITIONS[execution.status]
    if (!allowed.includes(to)) {
      throw new Error(`非法状态迁移：execution/${executionId} ${execution.status} → ${to}`)
    }
    const from = execution.status
    const at = new Date().toISOString()
    execution.status = to
    if (isTerminalExecutionStatus(to)) {
      execution.finishedAt = at
      delete execution.pendingInteraction
    }
    this.append({
      type: 'execution.status_changed',
      executionId,
      from,
      to,
      at,
      ...(execution.resultRefs !== undefined ? { resultRefs: execution.resultRefs } : {}),
      ...(note !== undefined ? { note } : {}),
    })
    this.logger.info(`execution/${executionId} ${from} → ${to}${note !== undefined ? `（${note}）` : ''}`)
    return execution
  }

  /** 设置/清除等待交互（waiting=暂停等待外部输入的事实载荷；非终态才有效，终态由 transition 清除）。
   *  Atomic：交互事实与状态由 AgentRuntime 在挂起/恢复时成对更新——Registry 只存储与查询。 */
  setPendingInteraction(executionId: string, interaction: PendingInteraction | undefined): Execution {
    const execution = this.executions.get(executionId)
    if (execution === undefined) throw new Error(`execution/${executionId} 不存在——无法设置交互`)
    if (interaction === undefined) delete execution.pendingInteraction
    else execution.pendingInteraction = interaction
    return execution
  }

  /**
   * 设置产物引用（ADR-034 §3.1：Execution 知道「产生了哪个 Artifact」——引用非内容、非路径、非推断）。
   * 替换语义（done 钩子一次性写入；终态保留——引用是持久事实，与 pendingInteraction 的终态清除不同）。
   * v1 仅由 websocket Stage done 钩子（registered StageArtifact → artifact_id）调用。
   */
  setResultRefs(executionId: string, refs: string[]): Execution {
    const execution = this.executions.get(executionId)
    if (execution === undefined) throw new Error(`execution/${executionId} 不存在——无法设置结果引用`)
    if (refs.length === 0) delete execution.resultRefs
    else execution.resultRefs = refs
    return execution
  }

  /**
   * 取消（ADR-034 §5.1：cancel 是 Execution 语义）。running/waiting → cancelled（终点态）；
   * 已终点态 → 幂等返回现状（RPC 层重试安全，不产生新事件）。
   */
  cancel(executionId: string): Execution {
    const execution = this.executions.get(executionId)
    if (execution === undefined) throw new Error(`execution/${executionId} 不存在——无法取消`)
    if (isTerminalExecutionStatus(execution.status)) return execution
    return this.transition(executionId, 'cancelled')
  }

  /** 事件日志（append-only；filter.executionId 可按执行过滤——Phase 2 events RPC 来源） */
  events(filter: { executionId?: string } = {}): ExecutionEvent[] {
    if (filter.executionId === undefined) return [...this.eventLog]
    return this.eventLog.filter((ev) => ev.executionId === filter.executionId)
  }

  /** 订阅事件（Phase 2 agent/executions/events 增量推送；返回取消订阅函数） */
  subscribe(listener: (ev: ExecutionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 事件写入（唯一出口）：构造 eventId → 内存 journal → Persistence Adapter（双写——Adapter=实现非备份，
   *  JSONL 是唯一的跨进程事实；单线程同步执行无一致性窗口）→ 通知订阅者 */
  private append(ev: ExecutionEventInput): ExecutionEvent {
    const event = {
      ...ev,
      eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    } as ExecutionEvent
    this.eventLog.push(event)
    this.adapter?.append(event)
    for (const listener of this.listeners) listener(event)
    return event
  }

  /** 启动 replay（Adapter 注入时）：事件日志是唯一 SoT——逐条重建内存 index（不 notify、不双写文件）。
   *  容错（用户裁定②）：合法事件 apply；非法（状态机不允许）→ corruption warning + 跳过（不静默丢历史）。 */
  private replayEvents(entries: ExecutionEvent[]): void {
    for (const entry of entries) {
      if (entry.type === 'execution.created') {
        this.executions.set(entry.executionId, {
          id: entry.executionId,
          taskId: entry.taskId,
          status: entry.status,
          createdAt: entry.at,
          startedAt: entry.at,
          ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
          ...(entry.workflowId !== undefined ? { workflowId: entry.workflowId } : {}),
          ...(entry.stageId !== undefined ? { stageId: entry.stageId } : {}),
        })
        this.byTaskId.set(entry.taskId, entry.executionId)
        this.eventLog.push(entry)
        continue
      }
      // status_changed
      const execution = this.executions.get(entry.executionId)
      if (execution === undefined) continue // created 缺失（文件手工编辑/异常）——跳过该变更事件
      const allowed = ALLOWED_TRANSITIONS[execution.status]
      if (!allowed.includes(entry.to)) {
        this.logger.warn(
          `executions.jsonl replay 跳过非法事件：execution/${entry.executionId} ${execution.status} → ${entry.to}（eventId=${entry.eventId}）`,
        )
        continue
      }
      execution.status = entry.to
      if (isTerminalExecutionStatus(entry.to)) {
        execution.finishedAt = entry.at
        delete execution.pendingInteraction
      }
      if (entry.resultRefs !== undefined) execution.resultRefs = entry.resultRefs
      this.eventLog.push(entry)
    }
  }
}
