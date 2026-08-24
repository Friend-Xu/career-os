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

/** ADR-034 §2.1 身份字段（冻结版；不得扩展业务字段） */
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

/** Execution 事件（增量事实；引擎广播 execution.event，executionId 为路由键） */
export type ExecutionEvent =
  | {
      type: 'execution.created'
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
      executionId: string
      from: ExecutionStatus
      to: ExecutionStatus
      at: string
    }
