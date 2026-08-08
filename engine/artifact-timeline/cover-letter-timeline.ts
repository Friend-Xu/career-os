/**
 * Cover Letter Timeline Adapter（M4-5.3，Concrete First）。
 * - 事件源：letter.transitions + letter.deliveries（append-only）
 * - transitions 映射同 Portfolio；deliveries → delivery 事件（order 排在 transitions 之后）
 * - reference_added 预留：v0.1 无 append-only 事件源，不发明事件（诚实投影）
 */
import type { CoverLetter } from '../ir/cover-letter.ts'
import type { ArtifactTimelineEvent, TimelineEntry } from '../ir/artifact-timeline.ts'

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  reviewed: '已评审',
  ready: '就绪',
}

/** 状态值 → 展示标签（历史数据可能含早期非标值，展示层保留原文） */
const stateLabel = (s: string): string => STATUS_LABEL[s] ?? s

export function buildCoverLetterTimeline(letters: CoverLetter[]): TimelineEntry[] {
  const items: TimelineEntry[] = []
  for (const c of letters) {
    const trans = c.transitions
    if (trans.length === 0 && !c.createdAt) continue
    if (trans.length === 0) {
      items.push({
        order: 0,
        event: {
          id: `${c.id}-0`,
          artifactType: 'cover-letter',
          artifactId: c.id,
          event: 'created',
          title: '建档',
          at: c.createdAt as string,
        },
      })
    } else {
      trans.forEach((t, i) => {
        const base: Omit<ArtifactTimelineEvent, 'event' | 'title'> = {
          id: `${c.id}-${i}`,
          artifactType: 'cover-letter',
          artifactId: c.id,
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
    c.deliveries.forEach((d, i) => {
      const order = trans.length + i
      items.push({
        order,
        event: {
          id: `${c.id}-${order}`,
          artifactType: 'cover-letter',
          artifactId: c.id,
          event: 'delivery',
          title: '投递',
          ...(d.targetCompany ? { detail: d.targetJobId ? `${d.targetCompany} · ${d.targetJobId}` : d.targetCompany } : {}),
          at: d.at,
        },
      })
    })
  }
  return items
}
