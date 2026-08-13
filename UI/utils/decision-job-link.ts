/**
 * jd-analysis 决策 ↔ 岗位关联判定（系统身份优先）：
 * subjectId（frontmatter subject_id，Engine Registration 写入）直连岗位 ID——
 * 身份关联不靠标题解析；存量旧记录无 subject_id → 标题公司名回退（仅存量兼容，
 * 新决策通道已携带 subject_id，单向收敛）。
 * 标题匹配容错：公司名可能为简称（"示例智造科技" vs 建档全称）——双向子串。
 */
export function decisionMatchesJob(
  d: { subjectId?: string; title: string },
  job: { id: string; company: string },
): boolean {
  if (d.subjectId === job.id) return true
  if (d.title.includes(job.company)) return true
  const brief = (d.title.split(/[：:]/)[1] ?? '').trim().split(/\s+/)[0]
  return Boolean(brief && brief.length >= 2 && (brief.includes(job.company) || job.company.includes(brief)))
}
