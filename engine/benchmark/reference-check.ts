/**
 * Benchmark reference check（M3-3.3 §4.1）：引用合法性。
 * - targetClaimId ∈ claims.json（全文扫描含非法格式引用——case010 claim_99999999）
 * - expectationId ∈ context.job.expectations[].patternId
 * - evidence 引用合法性（proposal 无 evidence 字段，预留——全文扫描）
 */
import type { ParsedChange, ReferenceCheckResult } from './report-types.ts'

export function checkReferences(opts: {
  changes: ParsedChange[]
  rawRefs: string[]
  claimIds: Set<string>
  evidenceIds: Set<string>
  expectationIds: Set<string>
}): ReferenceCheckResult {
  const { changes, rawRefs, claimIds, evidenceIds, expectationIds } = opts
  const invalidClaimRefs = [...new Set(rawRefs.filter((r) => r.startsWith('claim_') && !claimIds.has(r)))]
  const invalidEvidenceRefs = [...new Set(rawRefs.filter((r) => r.startsWith('evidence_') && !evidenceIds.has(r)))]
  const invalidExpectationRefs = changes
    .filter((c) => c.expectationId !== undefined && !expectationIds.has(c.expectationId))
    .map((c) => c.expectationId!)
  return { invalidClaimRefs, invalidExpectationRefs, invalidEvidenceRefs }
}
