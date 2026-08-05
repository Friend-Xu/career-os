/**
 * Benchmark provenance check（M3-3.3 §4.2/4.3）：lineage 结构完整性。
 * - oldSentence Identity：精确匹配（空格标准化；禁止模糊）——case009
 * - mergedClaims：new 句完整包含未命中 bullet 的句子（子串包含，结构性非语义）——case008
 * - claimRetentionRate = (源 claim 数 − lostClaims) / 源 claim 数；v0.1 lostClaims = mergedClaims
 * - expectation 重锚（change 的 expectationId ≠ 命中 bullet 原锚点）→ warning
 */
import type { ParsedChange, ProvenanceCheckResult } from './report-types.ts'

export interface ResumeBulletRef {
  claimId: string
  section: string
  sentence: string
  expectationId?: string
}

/** 空格标准化：trim + 内部空白折叠为单空格（允许 markdown/缩进差异，禁止模糊匹配） */
function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

export function checkProvenance(opts: { changes: ParsedChange[]; resumeBullets: ResumeBulletRef[] }): ProvenanceCheckResult {
  const { changes, resumeBullets } = opts
  const warnings: string[] = []

  // 4.2 oldSentence Identity（精确匹配 + 空格标准化）
  const oldSentenceMismatch: ProvenanceCheckResult['oldSentenceMismatch'] = []
  for (const c of changes) {
    const hit = resumeBullets.find((b) => b.claimId === c.targetClaimId && b.section === c.section)
    if (hit && normalize(c.oldSentence) !== normalize(hit.sentence)) {
      oldSentenceMismatch.push({ changeId: c.changeId, expected: hit.sentence, actual: c.oldSentence })
    }
  }

  // 4.3 mergedClaims（子串包含；排除被 change 自身命中的 bullet）
  const mergedClaims: string[] = []
  for (const c of changes) {
    const newNorm = normalize(c.suggestedSentence)
    for (const b of resumeBullets) {
      if (b.claimId === c.targetClaimId && b.section === c.section) continue // self 不计数
      if (mergedClaims.includes(b.claimId)) continue
      const sentenceNorm = normalize(b.sentence)
      if (sentenceNorm.length > 0 && newNorm.includes(sentenceNorm)) {
        mergedClaims.push(b.claimId)
        warnings.push(`${c.changeId} 的 new 句完整包含 bullet（${b.claimId}）的句子——内容被并入，归属断裂（结构性信号）`)
      }
    }
  }

  // 期望锚点保留（重锚 → warning）
  for (const c of changes) {
    const hit = resumeBullets.find((b) => b.claimId === c.targetClaimId && b.section === c.section)
    if (c.expectationId && hit?.expectationId && c.expectationId !== hit.expectationId) {
      warnings.push(`${c.changeId} 重锚期望：${hit.expectationId} → ${c.expectationId}（EXPECTATION_REANCHORED）`)
    }
  }

  const claimCount = new Set(resumeBullets.map((b) => b.claimId)).size
  const lostClaims = [...mergedClaims]
  return {
    oldSentenceMismatch,
    claimRetentionRate: claimCount === 0 ? 1 : (claimCount - lostClaims.length) / claimCount,
    mergedClaims,
    lostClaims,
    warnings,
  }
}
