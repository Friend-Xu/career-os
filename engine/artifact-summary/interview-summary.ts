/**
 * Interview Summary Adapter（M4-5.1，Concrete First）。
 * - 类级 summary：state = 类聚合"最高状态"（ready 优先 → reviewed → draft）
 * - items = QA 数；references = 0（Interview 是引用目标不是发出方，诚实投影）
 */
import type { InterviewQa, InterviewProposal, InterviewStatus } from '../ir/interview.ts'
import type { ArtifactSummary } from '../ir/artifact-summary.ts'

export const INTERVIEW_SUMMARY_ID = 'interview'

const STATE_LABEL: Record<InterviewStatus, string> = {
  draft: '草稿',
  reviewed: '已评审',
  ready: '就绪',
}

const AGGREGATE_ORDER: InterviewStatus[] = ['ready', 'reviewed', 'draft']

export function buildInterviewSummary(
  qas: InterviewQa[],
  proposals: InterviewProposal[],
): ArtifactSummary {
  const value = AGGREGATE_ORDER.find((s) => qas.some((q) => q.status === s)) ?? 'draft'
  return {
    id: INTERVIEW_SUMMARY_ID,
    type: 'interview',
    state: { value, label: STATE_LABEL[value] },
    counts: {
      items: qas.length,
      pendingProposals: proposals.filter((p) => p.status === 'pending').length,
      references: 0,
    },
    ...(latestEvolutionAt(qas) ? { updatedAt: latestEvolutionAt(qas) } : {}),
  }
}

function latestEvolutionAt(qas: InterviewQa[]): string | undefined {
  let max: string | undefined
  for (const q of qas) {
    for (const t of q.transitions) {
      if (max === undefined || t.at > max) max = t.at
    }
  }
  if (max !== undefined) return max
  let created: string | undefined
  for (const q of qas) {
    if (q.createdAt && (created === undefined || q.createdAt > created)) created = q.createdAt
  }
  return created
}
