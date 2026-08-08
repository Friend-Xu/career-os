/**
 * Working Copy ↔ 编辑模块转换（P2.3：编辑空间与 Dashboard 共用）。
 * 行级 block——text = 行原样（含 - 前缀），round-trip 无损（序列化 `- {text}` 解析后还原）。
 */
import type { WorkingSection } from '../../engine/ir/resume.ts'
import type { ResumeModule } from '../types'

export function sectionsToModules(sections: WorkingSection[]): ResumeModule[] {
  return sections.map((s, i) => ({ id: s.id, title: s.title, content: s.blocks.map((b) => b.text).join('\n'), order: i }))
}

export function modulesToSections(mods: ResumeModule[]): WorkingSection[] {
  return mods.map((m) => ({
    id: m.id,
    title: m.title,
    blocks: m.content.split('\n').map((text, i) => ({ id: `${m.id}-${i}`, text })),
  }))
}
