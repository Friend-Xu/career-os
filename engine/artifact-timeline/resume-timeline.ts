/**
 * Resume Timeline Adapter（M4-5.3，Concrete First）。
 * - 事件源：ResumeOperation（append-only 审计）；无 operations 的旧文件以 generatedAt 投影 created
 * - 映射：create/clone → created；submit_review/export/archive → state_transition；apply_proposal → expression_changed（note = proposal id → source）
 * - attempt_change_status（rejected 越界尝试）与 rejected 操作不构成演化——跳过
 */
import type { ResumeDocument } from '../ir/resume.ts'
import type { ArtifactTimelineEvent, TimelineEntry } from '../ir/artifact-timeline.ts'

export function buildResumeTimeline(resumes: ResumeDocument[]): TimelineEntry[] {
  const items: TimelineEntry[] = []
  for (const r of resumes) {
    const ops = r.operations ?? []
    if (ops.length === 0) {
      // 无操作审计（旧文件）：以生成时间投影建档——诚实展示可追溯信息缺失
      items.push({
        order: 0,
        event: {
          id: `${r.id}-0`,
          artifactType: 'resume',
          artifactId: r.id,
          event: 'created',
          title: 'Created',
          at: r.generatedAt || r.id,
        },
      })
      continue
    }
    ops.forEach((op, i) => {
      if (op.rejected) return
      const base: Omit<ArtifactTimelineEvent, 'event' | 'title'> = {
        id: `${r.id}-${i}`,
        artifactType: 'resume',
        artifactId: r.id,
        at: op.at,
      }
      switch (op.action) {
      case 'create':
      case 'clone':
        items.push({ order: i, event: { ...base, event: 'created', title: 'Created' } })
        break
      case 'submit_review':
        items.push({ order: i, event: { ...base, event: 'state_transition', title: 'State changed', detail: 'draft → review' } })
        break
      case 'export':
        items.push({ order: i, event: { ...base, event: 'state_transition', title: 'State changed', detail: 'review → exported' } })
        break
      case 'archive':
        items.push({ order: i, event: { ...base, event: 'state_transition', title: 'State changed', detail: '→ archived' } })
        break
      case 'apply_proposal':
        items.push({
          order: i,
          event: {
            ...base,
            event: 'expression_changed',
            title: 'Expression changed',
            ...(op.note ? { source: { type: 'proposal' as const, id: op.note } } : {}),
          },
        })
        break
      case 'attempt_change_status':
        // 越界尝试被拒——审计操作，不构成演化
        break
      }
    })
  }
  return items
}
