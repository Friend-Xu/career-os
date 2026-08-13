/**
 * Opportunity Projection（P3.2——契约 docs/domain/resume-opportunity-model-v0.1.md，FROZEN）。
 * - 一等对象「为什么值得改」：纯投影不落盘，id 确定性派生（重建=重算幂等）
 * - alignment 类：消费 ResumeAlignmentProjection 行级派生——expressive_gap → improve_value；
 *   unsupported_claim → reduce_risk；covered / capability_gap 不产生（契约 §3.1）
 * - material 类：evidence 被岗位 coverage 匹配但无任何 claim 引用 → activate_asset（契约 §3.2）
 * - expression 类：v0.2 实现判定（契约 §3.3——模型定义不做）
 * - applyTarget 为默认应用建议，不限制 Proposal 生成策略（契约 §2）
 */
import type { CareerClaim, EvidenceItem, JobRecord } from '../ir/schema.ts'
import type { ResumeDocument, WorkingCopy, WorkingBlock } from '../ir/resume.ts'
import { blocksOf } from '../ir/resume.ts'
import { computeResumeAlignment } from './resume-alignment.ts'
import { computeEvidenceCoverage, relates } from './evidence-coverage.ts'

export type OpportunitySource = 'alignment' | 'expression' | 'material'
export type OpportunitySeverity = 'high' | 'medium' | 'low'
export type OpportunityIntent = 'improve_value' | 'reduce_risk' | 'activate_asset'

export interface OpportunityAnchor {
  kind: 'alignment' | 'material' | 'claim'
  jobId?: string
  responsibilityId?: string
  state?: 'expressive_gap' | 'unsupported_claim'
  evidenceId?: string
  claimId?: string // reserved for expression source v0.2——v0.1 不产生此类机会
}

export interface ApplyTarget {
  wcId: string
  blockId?: string // 缺省 = 新增块
  action: 'rewrite' | 'insert' | 'delete'
}

export interface Opportunity {
  id: string // 确定性派生 `${source}:${anchorKey}`——幂等
  source: OpportunitySource
  severity: OpportunitySeverity
  intent: OpportunityIntent // 与 severity 正交：同为 high，可能是提升价值或消除风险
  severityReason: string
  anchor: OpportunityAnchor
  applyTarget?: ApplyTarget // 默认应用建议，不限制 Proposal 生成策略
  reason: string
  suggestedAction: string
  refs: { evidenceIds: string[]; claimIds: string[] }
}

export interface OpportunityInput {
  job: JobRecord
  evidenceItems: EvidenceItem[]
  claims: CareerClaim[]
  resumeDocument: ResumeDocument // workingCopyToDocument 组装投影（promote/alignment 同源）
  wc: WorkingCopy // 弱命中/delete 落点定位
}

/** 弱命中：unbound 块（无 claim 锚）文本与责任语句双向包含——「在写但没资产化」→ rewrite 落点 */
function weakHitBlock(wc: WorkingCopy, statement: string): WorkingBlock | undefined {
  return wc.sections.flatMap(blocksOf).find((b) => !b.provenanceLinks?.length && relates(b.text, statement))
}

/** 精确落点：sentence 文本在工作副本中的块（Assembly 无损——wc block.text = document bullet.sentence） */
function blockByText(wc: WorkingCopy, sentence: string): WorkingBlock | undefined {
  return wc.sections.flatMap(blocksOf).find((b) => b.text === sentence)
}

export function computeOpportunities(input: OpportunityInput): Opportunity[] {
  const { job, evidenceItems, claims, resumeDocument, wc } = input
  const out: Opportunity[] = []

  // ── alignment 类（消费四态投影，不重实现判定）──
  const alignment = computeResumeAlignment({ job, evidenceItems, claims, resumeDocument })
  for (const row of alignment.rows) {
    if (row.state === 'expressive_gap') {
      const weak = weakHitBlock(wc, row.statement)
      out.push({
        id: `alignment:${job.id}:${row.responsibilityId}`,
        source: 'alignment',
        severity: 'high',
        intent: 'improve_value',
        severityReason: '岗位要求 + 证据存在 + 未表达——最高价值改写点（提升价值）',
        anchor: { kind: 'alignment', jobId: job.id, responsibilityId: row.responsibilityId, state: 'expressive_gap' },
        applyTarget: weak
          ? { wcId: wc.id, blockId: weak.id, action: 'rewrite' }
          : { wcId: wc.id, action: 'insert' },
        reason: row.explanation,
        suggestedAction: '生成候选表达（基于已有证据改写）',
        refs: { evidenceIds: row.evidenceRefs, claimIds: row.claimRefs },
      })
    } else if (row.state === 'unsupported_claim') {
      const hit = row.bulletRefs.length > 0 ? blockByText(wc, row.bulletRefs[0]) : undefined
      out.push({
        id: `alignment:${job.id}:${row.responsibilityId}`,
        source: 'alignment',
        severity: 'high',
        intent: 'reduce_risk',
        severityReason: '可信度风险：写了但无证据锚，需要处置（消除风险）',
        anchor: { kind: 'alignment', jobId: job.id, responsibilityId: row.responsibilityId, state: 'unsupported_claim' },
        applyTarget: hit ? { wcId: wc.id, blockId: hit.id, action: 'delete' } : undefined,
        reason: row.explanation,
        suggestedAction: '补充证据或删除该表达',
        refs: { evidenceIds: row.evidenceRefs, claimIds: row.claimRefs },
      })
    }
  }

  // ── material 类（素材未资产化：被岗位匹配但无 claim 引用）──
  const coverage = computeEvidenceCoverage(job, evidenceItems)
  const matched = new Set(coverage.flatMap((r) => r.expectations.flatMap((e) => e.matchedItems)))
  const referenced = new Set(claims.flatMap((c) => c.provenance.map((p) => p.evidenceId)))
  for (const evidenceId of matched) {
    if (referenced.has(evidenceId)) continue
    out.push({
      id: `material:${evidenceId}`,
      source: 'material',
      severity: 'medium',
      intent: 'activate_asset',
      severityReason: '有岗位价值但未资产化——激活素材（价值低于 expressive_gap：后者已映射到岗位要求）',
      anchor: { kind: 'material', evidenceId },
      reason: '该事实被岗位匹配但未成为表达资产（无 Claim 引用）',
      suggestedAction: '走 ClaimProposal 通道资产化为 Claim',
      refs: { evidenceIds: [evidenceId], claimIds: [] },
    })
  }

  return out
}
