/**
 * Cover Letter Summary Adapter（M4-5.1，Concrete First）。
 * - 类级 summary：state = 类聚合"最高状态"（ready 优先 → reviewed → draft）
 * - items = units 总数（NarrativeUnit 是 Cover Letter 的内容条目）
 * - references = 全部 sourceRefs 总数（Cover Letter 是唯一发出引用的 Artifact，M4-4 Reference Protocol）
 */
import type { CoverLetter, CoverLetterProposal, CoverLetterStatus } from '../ir/cover-letter.ts'
import type { ArtifactSummary } from '../ir/artifact-summary.ts'

export const COVER_LETTER_SUMMARY_ID = 'cover-letter'

const STATE_LABEL: Record<CoverLetterStatus, string> = {
  draft: '草稿',
  reviewed: '已评审',
  ready: '就绪',
}

const AGGREGATE_ORDER: CoverLetterStatus[] = ['ready', 'reviewed', 'draft']

export function buildCoverLetterSummary(
  letters: CoverLetter[],
  proposals: CoverLetterProposal[],
): ArtifactSummary {
  const value = AGGREGATE_ORDER.find((s) => letters.some((c) => c.status === s)) ?? 'draft'
  const items = letters.reduce((n, c) => n + c.units.length, 0)
  const references = letters.reduce(
    (n, c) => n + c.units.reduce((m, u) => m + u.sourceRefs.length, 0),
    0,
  )
  return {
    id: COVER_LETTER_SUMMARY_ID,
    type: 'cover-letter',
    state: { value, label: STATE_LABEL[value] },
    counts: {
      items,
      pendingProposals: proposals.filter((p) => p.status === 'pending').length,
      references,
    },
    ...(latestEvolutionAt(letters) ? { updatedAt: latestEvolutionAt(letters) } : {}),
  }
}

function latestEvolutionAt(letters: CoverLetter[]): string | undefined {
  let max: string | undefined
  for (const c of letters) {
    for (const t of c.transitions) {
      if (max === undefined || t.at > max) max = t.at
    }
  }
  if (max !== undefined) return max
  let created: string | undefined
  for (const c of letters) {
    if (c.createdAt && (created === undefined || c.createdAt > created)) created = c.createdAt
  }
  return created
}
