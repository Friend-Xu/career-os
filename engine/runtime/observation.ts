/**
 * Observation Stats（P6——契约 docs/domain/observation-threshold-contract-v0.1.md，FROZEN 后实现）：
 * 观察阶段只读派生投影——从 OpportunityHistory + Outcome Evaluation 计算观察维度。
 * 不修改任何资产、不扩模型；数据已在闭环沉淀，本投影只是看数据（Dashboard 的最小 CLI 形态）。
 */
import type { Workspace } from '../storage/workspace.ts'
import { scanOpportunityHistory } from '../storage/opportunity-proposal-registry.ts'
import { scanClaimProposals } from '../storage/claim-proposal-registry.ts'
import { computeProposalOutcomeEvaluation } from './proposal-evaluation.ts'

export interface ObservationStats {
  historyCount: number
  opportunityDistribution: {
    source: Record<string, number>
    intent: Record<string, number>
    state: Record<string, number>
  }
  proposalBehavior: {
    approved: number
    rejected: number
    conflict: number
    acceptRate: number
    rejectRate: number
    conflictRate: number
  }
  resolutionPaths: {
    category: Record<string, number>
    transitions: Record<string, number> // "before → after" 路径计数
  }
  assetLoop: {
    proposals: number
    accepted: number
  }
  thresholds: {
    met: string[]
    unmet: string[]
  }
}

export function computeObservationStats(ws: Workspace): ObservationStats {
  const history = scanOpportunityHistory(ws)
  const source: Record<string, number> = {}
  const intent: Record<string, number> = {}
  const state: Record<string, number> = {}
  const category: Record<string, number> = {}
  const transitions: Record<string, number> = {}
  let approved = 0
  let rejected = 0
  let conflict = 0

  for (const h of history) {
    const s = h.opportunitySnapshot
    source[s.source] = (source[s.source] ?? 0) + 1
    intent[s.intent] = (intent[s.intent] ?? 0) + 1
    if (s.anchor.state) state[s.anchor.state] = (state[s.anchor.state] ?? 0) + 1
    if (h.decision === 'approved') approved++
    if (h.decision === 'rejected') rejected++
    if (h.outcome === 'conflict') conflict++
    const e = computeProposalOutcomeEvaluation(h)
    category[e.diagnostics.category] = (category[e.diagnostics.category] ?? 0) + 1
    if (e.beforeState && e.afterState) {
      const key = `${e.beforeState} → ${e.afterState}`
      transitions[key] = (transitions[key] ?? 0) + 1
    }
  }

  const total = history.length
  const assetProposals = scanClaimProposals(ws).filter((p) => p.source === 'opportunity_bridge')
  const assetAccepted = assetProposals.filter((p) => p.status === 'approved').length

  const met: string[] = []
  const unmet: string[] = []
  const check = (cond: boolean, label: string): void => {
    if (cond) met.push(label)
    else unmet.push(label)
  }
  check(total >= 30, '历史决策事件 ≥ 30 条')
  const topState = Object.entries(state).sort((a, b) => b[1] - a[1])[0]
  const topPct = topState ? Math.round((topState[1] / Math.max(total, 1)) * 100) : 0
  const topLabel = topState ? `${topState[0]} ${topPct}%` : '无'
  check(topState && topPct >= 40, `单一状态占比 ≥ 40%（当前 ${topLabel}）`)
  check(Object.values(transitions).some((n) => n >= 5), '某迁移路径出现 ≥ 5 次')
  check(assetAccepted >= 10, '资产化采用 ≥ 10 次')

  return {
    historyCount: total,
    opportunityDistribution: { source, intent, state },
    proposalBehavior: {
      approved,
      rejected,
      conflict,
      acceptRate: total ? Math.round((approved / total) * 100) : 0,
      rejectRate: total ? Math.round((rejected / total) * 100) : 0,
      conflictRate: total ? Math.round((conflict / total) * 100) : 0,
    },
    resolutionPaths: { category, transitions },
    assetLoop: { proposals: assetProposals.length, accepted: assetAccepted },
    thresholds: { met, unmet },
  }
}
