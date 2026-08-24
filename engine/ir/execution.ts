/**
 * Execution 契约（ADR-034，引擎 ↔ UI 共享契约源——ir/schema.ts 同族）。
 *
 * - Execution = Runtime 层执行单位：public/runtime identity；taskId = implementation detail
 *   （§2.2）。身份字段严格按 ADR-034 §2.1 冻结版，禁止扩展业务字段
 *   （personId/companyId/assessment/score/recommendation/artifactContent = 红线：
 *   业务真相归 Domain，Registry/UI 只投影「跑了没/跑完没/取消没」）。
 * - 状态机（§2.1 五态内）：running ⇄ waiting，终点 completed/failed/cancelled；
 *   非法迁移由 Registry（Engine SoT）拒绝——UI 层只消费事实，不做判定。
 * - ExecutionEvent：Execution 事件流（created / status_changed）——engine 广播
 *   execution.event（executionId 路由键），UI 经 agent/executions query 重建快照后
 *   增量订阅（§6.1 组合：Query=当前快照，Events=后续变化，不以 Events 替代 Query）。
 */

/** ADR-034 §2.1：五态（无 created——start 语义即 running） */
export type ExecutionStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

export const TERMINAL_EXECUTION_STATUS: readonly ExecutionStatus[] = ['completed', 'failed', 'cancelled']

export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return TERMINAL_EXECUTION_STATUS.includes(status)
}

/** 等待外部输入的交互（waiting 状态的载荷——Runtime 事实，非业务字段：
 *  question=提问卡片、permission=工具授权；一个执行同时至多一个挂起（流式串行）） */
export interface PendingInteraction {
  type: 'question' | 'permission'
  /** 交互内容最小面（UI 恢复弹窗/卡片所需）：permission=tool 名；question=问题文本+选项 */
  tool?: string
  question?: string
  options?: string[]
}

/** ADR-034 §2.1 身份字段（冻结版；不得扩展业务字段）。
 *  pendingInteraction 是 §1.4 语义在 §2.1 之外的 Runtime 事实承载（waiting=暂停等待外部输入，
 *  interaction=对应的交互事件事实；终态时 Registry 自动清除——Execution 不持业务真相）。 */
export interface Execution {
  /** public identity：execution_{ts}_{rand}（§2.1；taskId 退居内部实现 ID） */
  id: string
  /** Interaction provenance（§1.6；UI 对话触发才有；可无——非必然父级） */
  sessionId?: string
  /** Domain provenance（Stage 执行；§1.5–§1.6，非第二套执行模型） */
  workflowId?: string
  /** Domain provenance（Stage 执行；§1.5–§1.6） */
  stageId?: string
  /** 内部实现 ID（迁移期兼容，§2.2） */
  taskId: string
  status: ExecutionStatus
  /** waiting 时挂起的交互（question/permission）；非终态才可能有值，终态由 Registry 清除 */
  pendingInteraction?: PendingInteraction
  /** 本执行确定产生的 Domain Artifact 身份引用（§3.1：Registry 知道产生了哪个 Artifact，
   *  但不拥有其真相——**Artifact IDs only**：非内容、非文件路径、非推断（目录 diff/工具埋点 v1 不做）。
   *  v1 仅接 StageArtifactRegistry 确定性产出链（done 钩子 registered → artifact_id）；
   *  无产物的执行（纯对话/改写/分析）合法为 undefined。 */
  resultRefs?: string[]
  createdAt: string
  startedAt: string
  finishedAt?: string
}

/** query 过滤维度 = Runtime 事实（§3.2：status/sessionId/workflowId；personId 不入） */
export interface ExecutionQuery {
  status?: ExecutionStatus
  sessionId?: string
  workflowId?: string
}

/** 事件输入形态（无 eventId——由 Registry/EventLog 生成；union 的 distributive Omit） */
export type ExecutionEventInput =
  | Omit<Extract<ExecutionEvent, { type: 'execution.created' }>, 'eventId'>
  | Omit<Extract<ExecutionEvent, { type: 'execution.status_changed' }>, 'eventId'>

/** Execution 事件（增量事实；引擎广播 execution.event，executionId 为路由键）。
 *  eventId = 事件唯一 ID（事件日志审计/去重/诊断）；note 仅限 Runtime/Infrastructure 语义
 *  （如 process_restart——不得演化成业务原因字段，保持 Execution 不被 Domain 污染）。 */
export type ExecutionEvent =
  | {
      type: 'execution.created'
      eventId: string
      executionId: string
      taskId: string
      status: ExecutionStatus
      at: string
      sessionId?: string
      workflowId?: string
      stageId?: string
    }
  | {
      type: 'execution.status_changed'
      eventId: string
      executionId: string
      from: ExecutionStatus
      to: ExecutionStatus
      at: string
      /** 该刻已产生的确定性产物引用（完成时快照——在线客户端无需补拉 get） */
      resultRefs?: string[]
      /** Runtime/Infrastructure 原因（仅允许 process_restart 等——非业务字段） */
      note?: string
    }
