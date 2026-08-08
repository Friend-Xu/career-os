/**
 * Portfolio Timeline Adapter（M4-5.3，Concrete First）。
 * - 事件源：project.transitions（append-only 演化记录）
 * - 映射：from=''（首条登记）→ created；via 存在（提案 apply 改写）→ expression_changed + source；
 *   其余 → state_transition（detail: `${from} → ${to}`）
 * - 无 transitions 但有 createdAt → 投影 created（at = createdAt 日期）
 */
import type { PortfolioProject } from '../ir/portfolio.ts'
import type { ArtifactTimelineEvent, TimelineEntry } from '../ir/artifact-timeline.ts'

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  reviewed: '已评审',
  published: '已发布',
}

/** 状态值 → 展示标签（历史数据可能含早期非标值，展示层保留原文） */
const stateLabel = (s: string): string => STATUS_LABEL[s] ?? s

export function buildPortfolioTimeline(projects: PortfolioProject[]): TimelineEntry[] {
  const items: TimelineEntry[] = []
  for (const p of projects) {
    const trans = p.transitions
    if (trans.length === 0) {
      if (p.createdAt) {
        items.push({
          order: 0,
          event: {
            id: `${p.id}-0`,
            artifactType: 'portfolio',
            artifactId: p.id,
            event: 'created',
            title: '建档',
            at: p.createdAt,
          },
        })
      }
      continue
    }
    trans.forEach((t, i) => {
      const base: Omit<ArtifactTimelineEvent, 'event' | 'title'> = {
        id: `${p.id}-${i}`,
        artifactType: 'portfolio',
        artifactId: p.id,
        at: t.at,
      }
      if (t.from === '') {
        items.push({ order: i, event: { ...base, event: 'created', title: '建档' } })
      } else if (t.via) {
        items.push({
          order: i,
          event: { ...base, event: 'expression_changed', title: '表达变更', source: { type: 'proposal', id: t.via } },
        })
      } else {
        items.push({ order: i, event: { ...base, event: 'state_transition', title: '状态变更', detail: `${stateLabel(t.from)} → ${stateLabel(t.to)}` } })
      }
    })
  }
  return items
}
