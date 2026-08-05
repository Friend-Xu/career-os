/**
 * evidence-coverage：岗位证据覆盖（M2 层3）——evidenceExpectations × Evidence Inventory。
 * - 双层过滤，不做匹配分（ADR-003 约束延续）：
 *   1. 责任关联：item.contribution 与 R.statement 双向文本包含（MVP 近似，允许误关联）
 *   2. 维度覆盖：e.patternId 对应 dimension 在关联 items 任一 evidence 中存在（数组非空）
 * - 每 expectation 输出三态：covered / partial / missing + reason（内部保留，UI 只显示三态）
 * - weak_relation 预留（语义匹配引入时启用）；MVP 二值判定只产出 no_evidence / missing_dimension
 */
import type { EvidenceItem, JobRecord } from '../ir/schema.ts'
import { EVIDENCE_PATTERNS_V0 } from '../ir/schema.ts'

export type CoverageStatus = 'covered' | 'partial' | 'missing'
export type CoverageReason = 'missing_dimension' | 'weak_relation' | 'no_evidence'

export interface EvidenceExpectationCoverage {
  patternId: string
  dimension: string
  status: CoverageStatus
  reason?: CoverageReason // 内部保留（UI 只显示三态）
  matchedItems: string[] // 关联 item id（覆盖来源可追溯）
  missingDimensions?: string[]
}

export interface ResponsibilityCoverage {
  responsibilityId: string
  statement: string
  expectations: EvidenceExpectationCoverage[]
}

/** 双向文本包含（MVP 责任关联近似；中文短文本命中率高，允许误关联） */
function relates(contribution: string, statement: string): boolean {
  if (!contribution || !statement) return false
  return contribution.includes(statement) || statement.includes(contribution)
}

/** 岗位证据覆盖（纯函数，不落盘）：只遍历有 evidenceExpectations 的责任单元 */
export function computeEvidenceCoverage(job: JobRecord, items: EvidenceItem[]): ResponsibilityCoverage[] {
  const byPattern = new Map(EVIDENCE_PATTERNS_V0.map((p) => [p.id, p.dimension]))
  const active = items.filter((i) => i.status !== 'archived')
  const out: ResponsibilityCoverage[] = []

  for (const r of job.responsibilities) {
    if (r.evidenceExpectations.length === 0) continue
    const matched = active.filter((i) => relates(i.contribution, r.statement))
    const expectations = r.evidenceExpectations.flatMap((e) => {
      const dimension = byPattern.get(e.patternId)
      if (!dimension) return [] // pattern 词表外（数据异常）跳过
      const coveredItems = matched.filter((i) => (i.evidence[dimension] ?? []).length > 0)
      const status: CoverageStatus = coveredItems.length > 0 ? 'covered' : matched.length > 0 ? 'partial' : 'missing'
      return [{
        patternId: e.patternId,
        dimension,
        status,
        ...(status === 'partial' ? { reason: 'missing_dimension' as CoverageReason, missingDimensions: [dimension] } : {}),
        ...(status === 'missing' ? { reason: 'no_evidence' as CoverageReason } : {}),
        matchedItems: matched.map((i) => i.id),
      }]
    })
    if (expectations.length > 0) {
      out.push({ responsibilityId: r.id, statement: r.statement, expectations })
    }
  }
  return out
}
