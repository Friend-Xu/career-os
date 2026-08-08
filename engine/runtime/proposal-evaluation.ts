/**
 * Proposal Outcome Evaluation（P4.2——契约 docs/domain/proposal-outcome-evaluation-contract-v0.1.md，FROZEN）：
 * 结果观察器——一次 Opportunity → Proposal → Decision → Outcome 的状态迁移评估。
 * - 纯函数投影（不落盘、不修改 Opportunity、无 Agent 参与）；reasons 确定性规则生成（用户语言）
 * - 不打分：signals + category 足够回答观察问题（无 ground truth，quality: 87 是伪精确）
 * - resolved / riskReduced 分离（对应 OpportunityIntent improve_value / reduce_risk 两方向）
 */
import type { OpportunityHistoryEntry } from '../storage/opportunity-proposal-registry.ts'
import type { AlignmentState } from './resume-alignment.ts'

export interface ProposalEvaluation {
  historyId: string
  proposalId: string
  beforeState?: AlignmentState
  afterState?: AlignmentState
  signals: {
    accepted: boolean
    applied: boolean
    conflicted: boolean
    resolved: boolean // afterState = covered（价值提升——v0.1 四态+红线下不可达，P4.3 观察位）
    riskReduced: boolean // before = unsupported_claim ∧ after = capability_gap（风险降低）
    changed: boolean
  }
  diagnostics: {
    category: 'effective' | 'partial' | 'ignored' | 'conflicted' | 'unresolved'
    reasons: string[]
  }
}

export function computeProposalOutcomeEvaluation(history: OpportunityHistoryEntry): ProposalEvaluation {
  const before = history.opportunitySnapshot.anchor.state as AlignmentState | undefined
  const after = history.afterState
  const accepted = history.decision === 'approved'
  const applied = history.outcome === 'applied'
  const conflicted = history.outcome === 'conflict'
  const resolved = applied && after === 'covered'
  const riskReduced = applied && before === 'unsupported_claim' && after === 'capability_gap'
  const changed = applied && before !== after

  let category: ProposalEvaluation['diagnostics']['category']
  const reasons: string[] = []
  if (history.decision === 'rejected') {
    category = 'ignored'
    reasons.push('用户拒绝采纳')
  } else if (history.outcome === 'conflict') {
    category = 'conflicted'
    reasons.push('应用时版本漂移——建议基于旧版本生成')
  } else if (applied && (resolved || riskReduced)) {
    category = 'effective'
    if (resolved) reasons.push('机会已解决——表达覆盖岗位要求')
    if (riskReduced) reasons.push('无证据表达已移除，可信度风险降低')
  } else if (applied && changed) {
    category = 'partial'
    reasons.push(`状态迁移 ${before} → ${after}（进步但未完全解决）`)
  } else {
    category = 'unresolved'
    reasons.push('应用后状态未变化')
  }

  return {
    historyId: history.id,
    proposalId: history.proposalId,
    beforeState: before,
    afterState: after,
    signals: { accepted, applied, conflicted, resolved, riskReduced, changed },
    diagnostics: { category, reasons },
  }
}
