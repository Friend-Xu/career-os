/**
 * 引擎简历版本的可读标签（优化/历史/侧栏共用——版本 ID 是系统流水号，无语义）。
 * 组合：目标岗位（targetJobId → jobs 映射）→ 派生类型 → 日期 → 状态。
 */
import type { ResumeDocument, WorkingCopy } from '../../engine/ir/resume.ts'

const DERIVATION_LABEL: Record<string, string> = {
  jd_generate: 'JD 生成',
  clone: '克隆',
  user_edit: '用户编辑',
  ai_revision: 'AI 修订',
}

export function resumeVersionLabel(
  v: ResumeDocument,
  jobs: { id: string; company: string; title: string }[],
): string {
  const job = v.targetJobId ? jobs.find((j) => j.id === v.targetJobId) : undefined
  const target = job ? `${job.company} · ${job.title}` : undefined
  const deriv = v.lineage ? (DERIVATION_LABEL[v.lineage.derivationType] ?? v.lineage.derivationType) : 'AI 生成'
  const date = v.generatedAt.slice(5, 10).replace('-', '/')
  const base = target ?? deriv
  return `${base} · ${date}${v.status === 'draft' ? '' : ` · ${v.status}`}`
}

/** 工作副本可读标签（编号命名修复——wc id 是系统流水号无语义）：
 *  目标岗位（targetContext.jobId）优先；否则首个内容块文本摘要（内容识别）。 */
export function workingCopyLabel(
  w: WorkingCopy,
  jobs: { id: string; company: string; title: string }[],
): string {
  const targetJobId = w.targetContext?.jobId
  const job = targetJobId ? jobs.find((j) => j.id === targetJobId) : undefined
  if (job) return `${job.company} · ${job.title}`
  const firstBlock = w.sections.find((s) => s.blocks.length > 0)?.blocks[0]
  const snippet = firstBlock ? firstBlock.text.slice(0, 16) : '空副本'
  return snippet.length === 16 ? `${snippet}…` : snippet
}
