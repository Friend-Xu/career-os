import type { AIReference, EvidenceRef, ResumeRewriteContext } from '../ir/schema.ts'
import type { GapDisplayRow } from './decision-draft.ts'

/**
 * Resume Rewrite Context 适配（Career Decision Loop v0.1 Step 4）：
 * Decision Record → Adapter → ResumeRewriteContext（resume-writing 只消费此结构，不解析 decisions/ markdown）。
 * 语义边界：GapReference 传 dimension/requirement/status/evidence——禁止「缺少流体机械经验」类自由文本判断。
 */

const NARRATIVE_SECTIONS: { section: AIReference['section']; title: string }[] = [
  { section: 'understanding', title: '岗位理解' },
  { section: 'preparationPlan', title: '准备建议' },
  { section: 'resumeAdvice', title: '简历调整方案' },
]

/** 决策记录叙述段解析（Engine 解析自家格式；剥离 AI 参考标注行——参考语义由调用方标注） */
export function parseNarrativeSections(md: string): AIReference[] {
  const out: AIReference[] = []
  for (const { section, title } of NARRATIVE_SECTIONS) {
    // 无 m 标志：$ 仅匹配输入末尾（m 会使 $ 匹配每个行尾，lazy 匹配在首行即终止）
    const m = md.match(new RegExp(`##\\s*${title}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|\\n---|$)`, ''))
    if (!m) continue
    const content = m[1]
      .split('\n')
      .filter((l) => !l.trim().startsWith('> AI 参考'))
      .join('\n')
      .trim()
    if (content.length > 0) out.push({ section, content })
  }
  return out
}

/** 差距展示行 + 证据引用 → ResumeRewriteContext（evidenceHighlights 按 source:id 去重） */
export function buildResumeRewriteContext(
  jobId: string,
  gaps: GapDisplayRow[],
  evidenceByRef: Map<string, EvidenceRef[]>,
  notes: AIReference[],
): ResumeRewriteContext {
  const confirmedGaps = gaps.map((g) => ({
    dimension: g.dim,
    requirement: g.requirement,
    status: g.status,
    evidence: evidenceByRef.get(g.constraintRef) ?? [],
  }))
  const seen = new Set<string>()
  const evidenceHighlights: EvidenceRef[] = []
  for (const refs of evidenceByRef.values()) {
    for (const ref of refs) {
      const key = `${ref.source}:${ref.id}`
      if (seen.has(key)) continue
      seen.add(key)
      evidenceHighlights.push(ref)
    }
  }
  return { jobId, confirmedGaps, evidenceHighlights, preparationNotes: notes }
}
