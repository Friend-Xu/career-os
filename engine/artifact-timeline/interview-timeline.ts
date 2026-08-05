/**
 * Interview Timeline Adapter（M4-5.3，Concrete First）。
 * - 事件源：qa.transitions（append-only 演化记录；同 Portfolio 映射语义）
 */
import type { InterviewQa } from '../ir/interview.ts'
import type { ArtifactTimelineEvent, TimelineEntry } from '../ir/artifact-timeline.ts'

export function buildInterviewTimeline(qas: InterviewQa[]): TimelineEntry[] {
  const items: TimelineEntry[] = []
  for (const q of qas) {
    const trans = q.transitions
    if (trans.length === 0) {
      if (q.createdAt) {
        items.push({
          order: 0,
          event: {
            id: `${q.id}-0`,
            artifactType: 'interview',
            artifactId: q.id,
            event: 'created',
            title: 'Created',
            at: q.createdAt,
          },
        })
      }
      continue
    }
    trans.forEach((t, i) => {
      const base: Omit<ArtifactTimelineEvent, 'event' | 'title'> = {
        id: `${q.id}-${i}`,
        artifactType: 'interview',
        artifactId: q.id,
        at: t.at,
      }
      if (t.from === '') {
        items.push({ order: i, event: { ...base, event: 'created', title: 'Created' } })
      } else if (t.via) {
        items.push({
          order: i,
          event: { ...base, event: 'expression_changed', title: 'Expression changed', source: { type: 'proposal', id: t.via } },
        })
      } else {
        items.push({ order: i, event: { ...base, event: 'state_transition', title: 'State changed', detail: `${t.from} → ${t.to}` } })
      }
    })
  }
  return items
}
