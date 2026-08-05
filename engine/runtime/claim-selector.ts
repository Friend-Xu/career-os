/**
 * claim-selector：ClaimSelector（M3-1 Step 4）——岗位上下文选择可消费 Claims 为表达候选。
 * - 复用 Coverage 引擎责任关联 + claim provenance（ADR-003：不做语义匹配）
 * - 每候选携带 SelectionReason（expectationId/matchedDimension/coverageStatus）——"为什么选它"可追溯
 * - priority 可解释排序（规则进代码，不靠 LLM 自由裁量）：
 *   fact 主体优先（+1000，v1.2 §8.3）> 覆盖状态 covered 优先（+100×rank）> 命中维度数
 * - 输入必须 canUseClaim（消费前置——不允许不可消费 Claim 进入表达系统）
 */
import type { CareerClaim, ClaimType, EvidenceItem, JobRecord } from '../ir/schema.ts'
import { computeEvidenceCoverage, type CoverageStatus } from './evidence-coverage.ts'
import { canUseClaim, indexEvidence } from '../storage/claim-policy.ts'

export interface SelectionReason {
  expectationId: string
  matchedDimension: string
  coverageStatus: 'covered' | 'partial' | 'missing'
}

export interface ExpressionCandidate {
  claimId: string
  claimType: ClaimType
  priority: number
  reason: SelectionReason
}

export interface ResponsibilityCandidates {
  responsibility: string // JobResponsibility.statement
  candidates: ExpressionCandidate[]
}

const STATUS_RANK: Record<CoverageStatus, number> = { covered: 2, partial: 1, missing: 0 }

/** 可解释优先级：fact 主体优先（+1000）> 覆盖状态 covered 优先（+100×rank）> 命中维度数 */
function score(claimType: ClaimType, status: CoverageStatus, dimensionCount: number): number {
  return (claimType === 'fact' ? 1000 : 0) + STATUS_RANK[status] * 100 + dimensionCount
}

/** 每 responsibility 选择表达候选（纯派生，不落盘；responsibility 与 coverage 同源——只遍历有 evidenceExpectations 的责任单元） */
export function selectExpressionCandidates(
  job: JobRecord,
  evidence: EvidenceItem[],
  claims: CareerClaim[],
): ResponsibilityCandidates[] {
  const rows = computeEvidenceCoverage(job, evidence)
  const evidenceById = indexEvidence(evidence)
  const usable = claims.filter((c) => canUseClaim(c, evidenceById))

  return rows.map((row) => {
    const candidates: ExpressionCandidate[] = []
    for (const c of usable) {
      const refs = c.provenance.map((p) => p.evidenceId)
      if (!refs.some((id) => row.expectations.some((e) => e.matchedItems.includes(id)))) continue
      // 选择理由：命中该 responsibility expectations 中覆盖状态最好的一条（covered > partial > missing）
      const hit = row.expectations
        .filter((e) => e.matchedItems.some((id) => refs.includes(id)))
        .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])[0]
      if (!hit) continue
      candidates.push({
        claimId: c.id,
        claimType: c.claimType,
        priority: score(c.claimType, hit.status, hit.matchedItems.length),
        reason: { expectationId: hit.patternId, matchedDimension: hit.dimension, coverageStatus: hit.status },
      })
    }
    candidates.sort((a, b) => b.priority - a.priority)
    return { responsibility: row.statement, candidates }
  })
}
