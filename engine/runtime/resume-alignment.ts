/**
 * Resume Alignment Projection（R2.1——ADR-021 §6 四态矩阵落地）。
 * 契约：docs/domain/resume-alignment-projection-v0.1.md
 * - 定位：extends computeEvidenceCoverage（加 resume 表达维度，非新 Engine）
 * - 锚点：JobRecord.responsibilities（evidenceExpectations[].patternId）；expectationId = patternId
 * - 纯函数不落盘；AI 不自动修改（只投影）
 */
import type { CareerClaim, EvidenceItem, JobRecord } from '../ir/schema.ts'
import type { ResumeDocument, ResumeBullet } from '../ir/resume.ts'
import { computeEvidenceCoverage, type ResponsibilityCoverage } from './evidence-coverage.ts'

export type AlignmentState = 'covered' | 'expressive_gap' | 'unsupported_claim' | 'capability_gap'

export interface AlignmentRow {
  responsibilityId: string
  statement: string // 岗位责任原文
  state: AlignmentState
  evidenceRefs: string[] // matchedItems（person 证据，可追溯）
  claimRefs: string[] // 引用这些证据的可消费 Claims
  bulletRefs: string[] // 命中该责任的简历 bullet（无 = 未表达）
  explanation: string // 为什么（用户语言）
}

export interface ResumeAlignmentProjection {
  jobId: string
  resumeId: string
  rows: AlignmentRow[]
  generatedAt: string
}

export interface ResumeAlignmentInput {
  job: JobRecord
  evidenceItems: EvidenceItem[]
  resumeDocument: ResumeDocument
  claims: CareerClaim[]
}

/** 责任 → 命中该责任任一期望模式的简历 bullet（expectationId = patternId） */
function hitBullets(resp: JobRecord['responsibilities'][number], resume: ResumeDocument): ResumeBullet[] {
  const patterns = new Set(resp.evidenceExpectations.map((e) => e.patternId))
  const out: ResumeBullet[] = []
  for (const s of resume.sections) {
    for (const b of s.bullets) {
      if (b.metadata?.expectationId && patterns.has(b.metadata.expectationId)) out.push(b)
    }
  }
  return out
}

/** 红线补充判定：bullet 命中但 claimId 缺失或 claim 无证据锚 → unsupported_claim */
function bulletAnchored(bullets: ResumeBullet[], claims: CareerClaim[]): boolean {
  return bullets.some((b) => {
    const claim = claims.find((c) => c.id === b.claimId)
    return Boolean(claim && claim.provenance.length > 0)
  })
}

function explain(state: AlignmentState, resp: { statement: string }, bulletText: string, evidenceCount: number): string {
  switch (state) {
  case 'covered':
    return `已覆盖——简历表达「${bulletText}」有 ${evidenceCount} 条证据支撑`
  case 'expressive_gap':
    return `你有 ${evidenceCount} 条相关经历但简历未体现——可生成候选表达（基于已有事实改写）`
  case 'unsupported_claim':
    return `简历写了「${bulletText}」但找不到可信事实来源——补充证据或删除（不生成建议）`
  case 'capability_gap':
    return `当前没有「${resp.statement}」的相关经历——诚实留白，不生成`
  }
}

export function computeResumeAlignment(input: ResumeAlignmentInput): ResumeAlignmentProjection {
  const { job, resumeDocument, claims } = input
  const coverage = computeEvidenceCoverage(job, input.evidenceItems)
  const byRespId = new Map<string, ResponsibilityCoverage>(coverage.map((c) => [c.responsibilityId, c]))

  const rows: AlignmentRow[] = []
  for (const resp of job.responsibilities) {
    // 只遍历有 evidenceExpectations 的责任（对齐 computeEvidenceCoverage——无期望不产出行）
    if (resp.evidenceExpectations.length === 0) continue
    const cov = byRespId.get(resp.id)
    const bullets = hitBullets(resp, resumeDocument)
    const exprHit = bullets.length > 0
    const evdHit = Boolean(cov && cov.expectations.some((e) => e.status !== 'missing'))
    const evidenceRefs = [...new Set(cov?.expectations.flatMap((e) => e.matchedItems) ?? [])]

    let state: AlignmentState
    if (exprHit && evdHit) state = 'covered'
    else if (!exprHit && evdHit) state = 'expressive_gap'
    else if (exprHit && !evdHit) state = 'unsupported_claim'
    else state = 'capability_gap'

    // 治理红线：命中但无证据锚 → 强制 unsupported_claim（不因 evdHit 降级）
    if (state === 'covered' && !bulletAnchored(bullets, claims)) state = 'unsupported_claim'

    const claimRefs = claims
      .filter((c) => c.provenance.some((p) => evidenceRefs.includes(p.evidenceId)))
      .map((c) => c.id)

    rows.push({
      responsibilityId: resp.id,
      statement: resp.statement,
      state,
      evidenceRefs,
      claimRefs,
      bulletRefs: bullets.map((b) => b.sentence),
      explanation: explain(state, resp, bullets[0]?.sentence ?? '', evidenceRefs.length),
    })
  }

  return {
    jobId: job.id,
    resumeId: resumeDocument.id,
    rows,
    generatedAt: new Date().toISOString(),
  }
}
