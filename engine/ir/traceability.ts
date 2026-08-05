/**
 * Traceability IR（M4-5.4，契约 M4-5-TRACEABILITY-UI-v0.1）。
 * - 解释能力非导航能力：展示"一个表达单元为什么存在、依赖哪些事实来源"
 * - factStatement 是 resolver 投影（每次读当前事实——地址非快照），不是复制事实
 * - 只读定位：查看 Traceability ≠ 产生新的 Artifact state（M4 核心不变量）
 */
import type { ArtifactLocator } from './reference.ts'

export interface TraceabilityContext {
  owner: {
    artifact: 'cover-letter' // v0.1 唯一支持（唯一真实 Reference adoption）
    id: string // cl_xxx
  }
  node: {
    type: 'narrative_unit'
    id: string // nu_001
    text: string
  }
  sources: TraceSource[]
}

export interface TraceSource {
  locator: ArtifactLocator // M4-4 形状（adapter 内从 NarrativeSourceRef 转换，不扩契约）
  factStatement: string // resolver 投影（exists 时当前事实；断链时空串——错误原因在 error）
  resolved: boolean
  error?: string // 断链原因（M4-4 LocatorResolution.error——显式，无 fallback）
}
