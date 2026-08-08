/**
 * Context Validation（ADR-020 §6 / 契约 §6：Context Assembly 生命周期 Step 1）。
 * - 职责：contextPolicy 规则检查（required 缺失 / emptyAllowed:false 空引用）——
 *   不读 Registry（规则与数据分离；存在性校验在 resolver）
 * - type/taskType 白名单由 RPC 边界校验（websocket agentStartParams）——内部信任契约，
 *   不重复校验（禁止兜底）
 */
import { CONTEXT_POLICY, type AgentTaskRejected, type AgentTaskRequest } from '../../ir/agent-task.ts'

/** 通过返回 null；违规返回 AgentTaskRejected（MISSING_REQUIRED_CONTEXT） */
export function validateContextPolicy(req: AgentTaskRequest): AgentTaskRejected | null {
  const policy = CONTEXT_POLICY[req.taskType]
  const refs = req.contextRefs ?? []
  if (!policy.emptyAllowed && refs.length === 0) {
    return { reason: 'MISSING_REQUIRED_CONTEXT', refs: [] }
  }
  const haveTypes = new Set(refs.map((r) => r.type))
  const missing = policy.required.filter((t) => !haveTypes.has(t))
  if (missing.length > 0) {
    return {
      reason: 'MISSING_REQUIRED_CONTEXT',
      refs: missing.map((type) => ({ type, id: '', error: `contextPolicy 要求 ${type} 引用（required）` })),
    }
  }
  return null
}
