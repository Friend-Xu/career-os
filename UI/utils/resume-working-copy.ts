/**
 * Working Copy ↔ 编辑模块转换（P2.3：编辑空间与 Dashboard 共用）。
 * 行级 block——text = 行原样（含 - 前缀），round-trip 无损（序列化 `- {text}` 解析后还原）。
 * 条目化段（Resume Entry Contract v0.2）：工作经历/项目经验 = entries（条目头 + 描述 + 表述行）。
 */
import type { WorkingSection } from '../../engine/ir/resume.ts'
import type { Person, ResumeIdentityEntry, ResumeModule } from '../types'

export function sectionsToModules(sections: WorkingSection[]): ResumeModule[] {
  return sections.map((s, i) => ({
    id: s.id,
    title: s.title,
    content: s.blocks.map((b) => b.text).join('\n'),
    order: i,
    // 条目化段：entries → 模块 entries（表述行 = 块文本拼接，同平铺段行契约）
    ...(s.entries && s.entries.length > 0
      ? {
          entries: s.entries.map((e) => ({
            id: e.id,
            title: e.title,
            ...(e.role ? { role: e.role } : {}),
            ...(e.period ? { period: e.period } : {}),
            ...(e.description ? { description: e.description } : {}),
            content: e.blocks.map((b) => b.text).join('\n'),
          })),
        }
      : {}),
    // 身份事实通道（M5.2 G6）：identity 条目独立于 claim 通道，不混入 content
    ...(s.identity && s.identity.length > 0 ? { identity: s.identity } : {}),
  }))
}

export function modulesToSections(mods: ResumeModule[]): WorkingSection[] {
  return mods.map((m) => ({
    id: m.id,
    title: m.title,
    // 空行不产生块（序列化 `- ` 无法被解析往返——行级块契约只承载非空文本）
    blocks: m.content.split('\n').filter(Boolean).map((text, i) => ({ id: `${m.id}-${i}`, text })),
    // 条目化段：entries → WorkingEntry（条目头 + 描述透传 + 块 id 带条目维度——RPC 定位链 section → entry → block）
    ...(m.entries && m.entries.length > 0
      ? {
          entries: m.entries.map((e, ei) => ({
            id: e.id,
            title: e.title,
            ...(e.role ? { role: e.role } : {}),
            ...(e.period ? { period: e.period } : {}),
            // Entry Contract v0.2：description 单行序列化（换行折叠为空格）
            ...(e.description && e.description.trim() ? { description: e.description.trim().replace(/\n+/g, ' ') } : {}),
            blocks: e.content.split('\n').filter(Boolean).map((text, i) => ({ id: `${m.id}-e${ei}-${i}`, text })),
          })),
        }
      : {}),
    ...(m.identity && m.identity.length > 0 ? { identity: m.identity } : {}),
  }))
}

/** 身份字段 seed（person 档案投影——User Confirmation 的 Candidate；用户在编辑器中修改/保存 = 确认） */
export function buildPersonIdentity(person: Person): ResumeIdentityEntry[] {
  const edu = person.education?.find((e) => e.status === 'confirmed')
  const years = [edu?.startYear, edu?.graduationYear].filter((y) => y != null).join('-')
  return [
    { label: '姓名', body: person.name },
    ...(person.targetRoles?.[0] ? [{ label: '目标职位', body: person.targetRoles[0] }] : []),
    ...(edu
      ? [{ label: '教育', body: [edu.school, edu.major, `${edu.degree ?? ''}${years ? `（${years}）` : ''}`].filter(Boolean).join(' · ') }]
      : []),
    ...(person.identity?.location ? [{ label: '城市', body: person.identity.location }] : []),
    ...(person.identity?.yearsExperience ? [{ label: '经验', body: person.identity.yearsExperience }] : []),
  ]
}

/** 初始创作对象骨架（仅演示简历可用时——模块结构 + 档案身份，不携带演示人设内容）。
 *  Entry Contract v0.1：工作经历种子 = 公司条目（person 档案工作经历表）；项目经验空条目（从资产添加时自动建） */
export function buildSkeletonModules(person: Person): ResumeModule[] {
  const company = person.experiences?.[0]
  return [
    { id: 'm1', title: '个人信息', content: '', order: 0, identity: buildPersonIdentity(person) },
    { id: 'm2', title: '专业摘要', content: '', order: 1 },
    {
      id: 'm3',
      title: '工作经历',
      content: '',
      order: 2,
      ...(company
        ? {
            entries: [
              {
                id: 'ent-company',
                title: company.company,
                ...(company.role ? { role: company.role } : {}),
                ...(company.start || company.end ? { period: [company.start, company.end].filter(Boolean).join('-') } : {}),
                content: '',
              },
            ],
          }
        : {}),
    },
    { id: 'm4', title: '项目经验', content: '', order: 3 },
    { id: 'm5', title: '技能', content: '', order: 4 },
  ]
}
