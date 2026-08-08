/**
 * 简历内容质量规则（R0：从 resumes-page 抽取，Dashboard 与编辑空间共用单一实现）。
 * 仅作表达诊断（结构/量化/完整度），不产生权威分——三义分离（ADR-018），R1 升级为清单式检查。
 */
export function computeResumeQuality(modules: { content: string }[]): number {
  const totalLen = modules.reduce((s, m) => s + m.content.length, 0)
  const hasMetrics = modules.some((m) => /\d+%|\d+年/.test(m.content))
  let score = 70
  if (totalLen > 200) score += 10
  if (hasMetrics) score += 12
  if (modules.length >= 4) score += 5
  return Math.min(score, 96)
}
