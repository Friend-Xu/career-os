/**
 * Resume Summary Adapter（M4-5.1，Concrete First——Resume 独立投影，不做 Generic 抽象）。
 * - 类级 summary：state = 最新版本状态（documents 文件名升序最大 = 最新，resume_YYYYMMDD_NNNNN 时间戳编号）
 * - items = 最新版本 bullets 总数（Statements）；references = 0（Resume 未接入 Reference Protocol，诚实投影）
 */
import type { ResumeDocument, ResumeProposal, ResumeStatus } from '../ir/resume.ts'
import type { ArtifactSummary } from '../ir/artifact-summary.ts'

export const RESUME_SUMMARY_ID = 'resume'

const STATE_LABEL: Record<ResumeStatus, string> = {
  draft: 'Draft',
  review: 'Review',
  exported: 'Exported',
  archived: 'Archived',
}

export function buildResumeSummary(
  resumes: ResumeDocument[],
  proposals: ResumeProposal[],
): ArtifactSummary {
  const latest = resumes[resumes.length - 1]
  const items = latest ? latest.sections.reduce((n, s) => n + s.bullets.length, 0) : 0
  return {
    id: RESUME_SUMMARY_ID,
    type: 'resume',
    state: latest
      ? { value: latest.status, label: STATE_LABEL[latest.status] }
      : { value: 'draft', label: STATE_LABEL.draft },
    counts: {
      items,
      pendingProposals: proposals.filter((p) => p.status === 'pending').length,
      references: 0,
    },
    ...(latest ? { updatedAt: latest.generatedAt } : {}),
  }
}
