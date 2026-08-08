/**
 * Portfolio Summary Adapter（M4-5.1，Concrete First）。
 * - 类级 summary：state = 类聚合"最高状态"（published 优先 → reviewed → draft）
 * - items = projects 数；references = 0（Portfolio 是引用目标不是发出方，诚实投影）
 */
import type { PortfolioProject, PortfolioProposal, PortfolioStatus } from '../ir/portfolio.ts'
import type { ArtifactSummary } from '../ir/artifact-summary.ts'

export const PORTFOLIO_SUMMARY_ID = 'portfolio'

const STATE_LABEL: Record<PortfolioStatus, string> = {
  draft: '草稿',
  reviewed: '已评审',
  published: '已发布',
}

const AGGREGATE_ORDER: PortfolioStatus[] = ['published', 'reviewed', 'draft']

export function buildPortfolioSummary(
  projects: PortfolioProject[],
  proposals: PortfolioProposal[],
): ArtifactSummary {
  const value = AGGREGATE_ORDER.find((s) => projects.some((p) => p.status === s)) ?? 'draft'
  return {
    id: PORTFOLIO_SUMMARY_ID,
    type: 'portfolio',
    state: { value, label: STATE_LABEL[value] },
    counts: {
      items: projects.length,
      pendingProposals: proposals.filter((p) => p.status === 'pending').length,
      references: 0,
    },
    ...(latestEvolutionAt(projects) ? { updatedAt: latestEvolutionAt(projects) } : {}),
  }
}

/** 类内最近演化：transitions 最大 at（ISO 字符串可比较）；无 transitions 时取 createdAt 最大 */
function latestEvolutionAt(projects: PortfolioProject[]): string | undefined {
  let max: string | undefined
  for (const p of projects) {
    for (const t of p.transitions) {
      if (max === undefined || t.at > max) max = t.at
    }
  }
  if (max !== undefined) return max
  let created: string | undefined
  for (const p of projects) {
    if (p.createdAt && (created === undefined || p.createdAt > created)) created = p.createdAt
  }
  return created
}
