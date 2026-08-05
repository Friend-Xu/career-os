/**
 * claim-coverage：岗位上下文 Claim Coverage 视图（M3-1 Step 3 UI 第三段数据）。
 * - 复用 Coverage 引擎的责任关联（computeEvidenceCoverage：contribution × statement 双向文本包含
 *   + 维度覆盖三态），在 evidence 层之上叠加 Claim 层：引用 matchedItems 的可消费 Claims
 * - Claim 关联走 provenance（claim → evidenceId），不做语义匹配（ADR-003 约束延续）
 * - 纯派生实时计算，不落盘；只显示可消费（canUseClaim）的 Claim；responsibility 级三态取 expectations 最差
 */
import type { CareerClaim, ClaimCoverageRow, EvidenceItem, JobRecord } from '../ir/schema.ts'
import { computeEvidenceCoverage, type CoverageStatus } from './evidence-coverage.ts'
import { canUseClaim, indexEvidence } from '../storage/claim-policy.ts'

const RANK: Record<CoverageStatus, number> = { covered: 2, partial: 1, missing: 0 }

export function computeClaimCoverage(job: JobRecord, evidence: EvidenceItem[], claims: CareerClaim[]): ClaimCoverageRow[] {
  const rows = computeEvidenceCoverage(job, evidence)
  const evidenceById = indexEvidence(evidence)
  const usable = claims.filter((c) => canUseClaim(c, evidenceById))

  return rows.map((row) => {
    const matchedItems = [...new Set(row.expectations.flatMap((e) => e.matchedItems))]
    const evidenceStatus = row.expectations.reduce<CoverageStatus>(
      (worst, e) => (RANK[e.status] < RANK[worst] ? e.status : worst),
      'covered',
    )
    return {
      responsibility: row.statement,
      evidenceStatus,
      matchedItems,
      claims: usable
        .filter((c) => c.provenance.some((p) => matchedItems.includes(p.evidenceId)))
        .map((c) => ({ id: c.id, statement: c.statement, claimType: c.claimType })),
    }
  })
}
