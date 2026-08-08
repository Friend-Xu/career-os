/**
 * Context Bundle Assembly（ADR-020 §6 / 契约 §6：生命周期 Step 3）。
 * - 职责：组合 Reference Manifest——纯函数，无逻辑
 * - Bundle = 执行期数据（create → agent.start → stream → discard），不进入业务状态
 */
import type { AgentContextBundle, ResolvedContextReference } from '../../ir/agent-task.ts'

export function assembleContextBundle(
  resolved: ResolvedContextReference[],
  now: Date = new Date(),
): AgentContextBundle {
  return { references: resolved, generatedAt: now.toISOString() }
}
