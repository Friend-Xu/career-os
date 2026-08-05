/**
 * Artifact Timeline IR（M4-5.3，契约 M4-5-ARTIFACT-STUDIO-UI-v0.3 §3.2）。
 * - UI projection：Engine Events → Timeline Adapter → ArtifactTimelineEvent → Timeline UI
 * - 不暴露 TransitionRecord（UI 不感知领域差异：transition/delivery/proposal source 统一投影）
 * - Proposal 是事件来源（source），不是事件类型——Timeline 展示 Artifact Evolution Event
 */
import type { ArtifactType } from './artifact-summary.ts'

export type ArtifactTimelineEventType =
  | 'created' // Artifact 初次建档
  | 'state_transition' // Evolution State 推进
  | 'expression_changed' // 表达内容变更（apply proposal 改写 statement/text/unit）
  | 'reference_added' // Reference 关系新增（v0.1 无 append-only 事件源——预留，不发明事件）
  | 'delivery' // 投递记录（cover-letter deliveries）

export interface ArtifactTimelineEvent {
  id: string // 确定性 id：`${artifactId}-${entityAppendIndex}`（同文件同输出）
  artifactType: ArtifactType
  artifactId: string
  event: ArtifactTimelineEventType
  title: string // 展示标题（adapter 生成：Created / State changed / Expression changed / Delivery）
  detail?: string // 展示细节（state_transition: `${from} → ${to}`；delivery: target）
  source?: {
    type: 'proposal' // v0.1 固定；via 提案触发的表达改写
    id: string
  }
  at: string // ISO（lexicographic 可排序）
}

/** 内部排序形状（非契约：adapter → 聚合器间传输，UI 只消费 ArtifactTimelineEvent） */
export interface TimelineEntry {
  event: ArtifactTimelineEvent
  /** 实体内 append 顺序（同 timestamp 稳定排序第二键） */
  order: number
}
