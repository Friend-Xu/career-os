/**
 * Artifact Timeline 聚合入口（M4-5.3）：四 adapter 投影合并 + 确定性排序。
 * - 排序键：at ascending → 实体内 append order → 事件 id lexical（同 timestamp 稳定，replay 一致）
 * - 输出纯 ArtifactTimelineEvent[]（UI 不感知领域内部事件结构，也不重排）
 */
import type { Workspace } from '../storage/workspace.ts'
import { scanResumes } from '../storage/resume-watcher.ts'
import { scanPortfolioProjects } from '../storage/portfolio-watcher.ts'
import { scanInterviewQas } from '../storage/interview-watcher.ts'
import { scanCoverLetters } from '../storage/cover-letter-watcher.ts'
import type { ArtifactTimelineEvent, TimelineEntry } from '../ir/artifact-timeline.ts'
import { buildResumeTimeline } from './resume-timeline.ts'
import { buildPortfolioTimeline } from './portfolio-timeline.ts'
import { buildInterviewTimeline } from './interview-timeline.ts'
import { buildCoverLetterTimeline } from './cover-letter-timeline.ts'

export function buildArtifactTimeline(ws: Workspace): ArtifactTimelineEvent[] {
  const entries: TimelineEntry[] = [
    // resume 过滤 invalid（parse 空 record，同 artifact-summary 输入边界）
    ...buildResumeTimeline(scanResumes(ws).filter((r) => r.validation?.status !== 'invalid').map((r) => r.record)),
    ...buildPortfolioTimeline(scanPortfolioProjects(ws).map((p) => p.record)),
    ...buildInterviewTimeline(scanInterviewQas(ws).map((q) => q.record)),
    ...buildCoverLetterTimeline(scanCoverLetters(ws).map((c) => c.record)),
  ]
  return entries
    .sort((a, b) => a.event.at.localeCompare(b.event.at) || a.order - b.order || a.event.id.localeCompare(b.event.id))
    .map((t) => t.event)
}
