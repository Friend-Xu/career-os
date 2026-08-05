/**
 * Artifact Summary IR（M4-5.1，契约 M4-5-ARTIFACT-STUDIO-UI-v0.3）。
 * - UI projection endpoint：Engine Context → ArtifactSummary[] → UI View Model
 * - 类级聚合（每类一条）：id = 类标识；state = 类聚合 Evolution State
 * - 禁止：version / facts / claims / sourceRefs / transitions（属 Engine Projection，不进 summary）
 */
export type ArtifactType = 'resume' | 'portfolio' | 'interview' | 'cover-letter'

export interface ArtifactSummary {
  id: string // 类 id（与 type 同值；UI key + 未来 Proposal Center 锚点）
  type: ArtifactType
  state: {
    value: string // 各 Artifact 自有 Evolution State（不强制统一枚举；类聚合取"最高状态"）
    label: string // UI 可读标签（projection endpoint 生成）
  }
  counts: {
    items: number // Fact Layer 条目（resume: 最新版本 bullets；portfolio: projects；interview: QA；cover-letter: units）
    pendingProposals: number
    references: number // 发出引用数（cover-letter: sourceRefs 总数；未接入 Reference Protocol = 0，诚实投影）
  }
  updatedAt?: string // 最近演化（类内 transitions 最大 at；resume: 最新版本 generatedAt）
}
