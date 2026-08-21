/**
 * knowledge-watcher：V2 知识层——knowledge/skills.md（技能受控词表）+ knowledge/roles.md（岗位清单）。
 * - parseSkillsMarkdown：skills.md → Skill[]（`## 技能名` + 列表项：`别名：`逗号分隔 / `N级：`行为锚点）
 * - parseRolesMarkdown：roles.md → Role[]（`## 岗位名（公司名）` + 列表项：`essential/nice-to-have：技能（来源：xxx）`）
 * - serializeRolesMarkdown：Role[] → roles.md（Engine Registration 投影格式——roles-contract v0.2：
 *   roles.md 由 Engine 单方写，Agent 直写被禁止，全部登记走 role-proposals/ 提案通道）
 * - scanKnowledge：knowledge/ 目录扫描 → { skills, roles }（文件缺任一个 → 该列表为空；
 *   目录扫描式同 companies，每次调用重扫；目录变更经 watchKnowledge 广播 poolChanged）
 * - extractPersonSkills：profiles md 的 `## 技能` 段落 → PersonSkill[]（无段落 → 空数组）
 * - buildSkillIndex / canonicalSkillName：别名归一化（gap 计算与图谱连线共用）
 *
 * skills.md 真相源由 skill/用户维护，引擎只读解析不写；roles.md 由引擎投影写（role-proposal-registry）。
 * 降级惯例同 parseCompanyMarkdown：
 * 整文件无条目 → invalid（error）；单条目缺项/值域非法 → degraded（warn）保留。
 * 段落/列表项解析复用 context-watcher 的 sectionLines/listItems/splitFirstColon/splitList。
 */
import type { PersonSkill, Role, Skill } from '../ir/schema.ts'
import { finalize, type FieldCheck, type Validated } from '../ir/validator.ts'
import type { Workspace } from './workspace.ts'
import { listItems, sectionLines, splitFirstColon, splitList } from './context-watcher.ts'
import { watch } from 'chokidar'

/** knowledge/ 目录监听（V2 知识层词表——skills.md/roles.md 由用户/Agent 维护）：
 *  变更 → onChanged（main.ts 广播 poolChanged；图谱 role/skill 节点派生自 scanKnowledge） */
export function watchKnowledge(ws: Workspace, onChanged: () => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.knowledge, { ignoreInitial: true })
  watcher.on('add', (p: string) => {
    if (p.endsWith('.md')) onChanged()
  })
  watcher.on('change', (p: string) => {
    if (p.endsWith('.md')) onChanged()
  })
  watcher.on('unlink', (p: string) => {
    if (p.endsWith('.md')) onChanged()
  })
  return { close: () => watcher.close() }
}

const H2_RE = /^##\s+(.+?)\s*$/gm
const ALIAS_RE = /^别名[：:]\s*(.+)$/
const ANCHOR_RE = /^(\d+)级[：:]\s*(.+)$/
const SOURCE_RE = /（来源[：:](.+?)）$/
const COMPANY_RE = /^(.+?)[（(]([^（()]*?)[）)]$/

/** 词表别名索引：词表名/别名 → 规范名（未入表的名原样返回自身） */
export function buildSkillIndex(skills: Skill[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const s of skills) {
    index.set(s.name, s.name)
    for (const a of s.aliases) index.set(a, s.name)
  }
  return index
}

/** 别名归一化：词表内名/别名 → 规范名；词表外（自由技能）原样返回 */
export function canonicalSkillName(name: string, index: Map<string, string>): string {
  return index.get(name) ?? name
}

/** skills.md → Skill[]：整文件无 `## 技能名` → invalid；单条目缺列表项/锚点级别越界/重复名 → degraded */
export function parseSkillsMarkdown(md: string, sourceFile: string): Validated<Skill[]> {
  const headings = [...md.matchAll(H2_RE)].map((m) => m[1]!.trim())
  if (headings.length === 0) {
    return finalize([], [
      { path: sourceFile, reason: '未找到 `## 技能名` 条目（文件为空或结构缺失）', severity: 'error' },
    ])
  }

  const checks: FieldCheck[] = []
  const skills: Skill[] = []
  const seen = new Set<string>()
  for (const name of headings) {
    if (seen.has(name)) {
      checks.push({ path: name, reason: '重复技能名（受控词表应唯一，仅保留首个）', severity: 'warn' })
      continue
    }
    seen.add(name)
    const skill: Skill = { name, aliases: [] }
    let itemCount = 0
    for (const item of listItems(sectionLines(md, name))) {
      itemCount++
      const alias = item.match(ALIAS_RE)
      if (alias) {
        skill.aliases = splitList(alias[1]!)
        continue
      }
      const anchor = item.match(ANCHOR_RE)
      if (anchor) {
        const level = Number(anchor[1])
        if (level >= 1 && level <= 5) {
          if (!skill.anchor) skill.anchor = []
          skill.anchor[level - 1] = anchor[2]!.trim()
        } else {
          checks.push({ path: name, reason: `非法锚点级别 ${anchor[1]}（合法值：1-5 级）`, severity: 'warn' })
        }
        continue
      }
      checks.push({ path: name, reason: `无法识别的列表项 ${JSON.stringify(item)}（合法项：别名：… / N级：…）`, severity: 'warn' })
    }
    if (itemCount === 0) {
      checks.push({ path: name, reason: '缺列表项（未声明别名/锚点）', severity: 'warn' })
    }
    skills.push(skill)
  }
  return finalize(skills, checks)
}

/** roles.md → Role[]：整文件无 `## 岗位名` → invalid；缺公司名/缺需求列表项/重复 id → degraded */
export function parseRolesMarkdown(md: string, sourceFile: string): Validated<Role[]> {
  const headings = [...md.matchAll(H2_RE)].map((m) => m[1]!.trim())
  if (headings.length === 0) {
    return finalize([], [
      { path: sourceFile, reason: '未找到 `## 岗位名（公司名）` 条目（文件为空或结构缺失）', severity: 'error' },
    ])
  }

  const checks: FieldCheck[] = []
  const roles: Role[] = []
  const seen = new Set<string>()
  for (const heading of headings) {
    const companyMatch = heading.match(COMPANY_RE)
    const name = (companyMatch ? companyMatch[1]!.trim() : heading).trim()
    const company = companyMatch ? companyMatch[2]!.trim() : ''
    if (!companyMatch) {
      checks.push({ path: heading, reason: '缺公司名（应为 `## 岗位名（公司名）` 格式）', severity: 'warn' })
    }
    const id = company ? `${name}-${company}` : name
    if (seen.has(id)) {
      checks.push({ path: heading, reason: '重复岗位 id（仅保留首个）', severity: 'warn' })
      continue
    }
    seen.add(id)

    const skills: Role['skills'] = []
    let itemCount = 0
    for (const item of listItems(sectionLines(md, heading))) {
      itemCount++
      const [kind, rest] = splitFirstColon(item)
      if (kind !== 'essential' && kind !== 'nice-to-have') {
        checks.push({ path: heading, reason: `无法识别的需求项 ${JSON.stringify(item)}（合法项：essential：… / nice-to-have：…）`, severity: 'warn' })
        continue
      }
      const src = rest.match(SOURCE_RE)
      const skillName = (src ? rest.slice(0, src.index) : rest).trim()
      if (!skillName) {
        checks.push({ path: heading, reason: `需求项缺技能名：${JSON.stringify(item)}`, severity: 'warn' })
        continue
      }
      skills.push({ name: skillName, essential: kind === 'essential', source: src ? src[1]!.trim() : '' })
    }
    if (itemCount === 0) {
      checks.push({ path: heading, reason: '缺列表项（未声明技能需求）', severity: 'warn' })
    }
    roles.push({ id, name, company, skills })
  }
  return finalize(roles, checks)
}

export interface KnowledgeScan {
  skills: Skill[]
  roles: Role[]
}

/**
 * roles.md 投影序列化（Engine Registration 单方写——role-proposal-registry 登记后落盘）。
 * 统一产出契约格式（roles-contract.md §四：英文冒号 `essential: 技能名（来源: 标识）`）；
 * 解析器兼容中英文冒号（存量全角写法仍可读）。
 */
export function serializeRolesMarkdown(roles: Role[]): string {
  const lines = [
    '# 岗位清单（Roles）',
    '',
    '> 公司岗位实例库：每条目 = 一家公司在招/已分析的具体岗位。',
    '> 技能需求必须能从来源文档回溯，禁止写 JD 之外的泛化技能。',
    '> 本文件由引擎投影维护（role-proposals/ 提案登记），禁止手写。',
    '',
  ]
  for (const r of roles) {
    lines.push(`## ${r.name}（${r.company}）`, '')
    for (const s of r.skills) {
      lines.push(`- ${s.essential ? 'essential' : 'nice-to-have'}: ${s.name}（来源: ${s.source}）`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** knowledge/ 目录扫描（skills.md + roles.md；缺文件 → 空列表，不崩） */
export function scanKnowledge(ws: Workspace): KnowledgeScan {
  let skills: Skill[] = []
  let roles: Role[] = []
  for (const f of ws.listMarkdown('knowledge')) {
    if (f === 'skills.md') skills = parseSkillsMarkdown(ws.read(`knowledge/${f}`), f).value
    else if (f === 'roles.md') roles = parseRolesMarkdown(ws.read(`knowledge/${f}`), f).value
  }
  return { skills, roles }
}

/**
 * 画像技能声明：profiles md 的 `## 技能` 段落列表项 `- 技能名：熟练度(1-5)` → PersonSkill[]。
 * 无段落 → 空数组（合法）；级别非 1-5 整数 → 该条目丢弃（无 validation 通道，投影不标记）。
 */
export function extractPersonSkills(md: string): PersonSkill[] {
  const skills: PersonSkill[] = []
  for (const item of listItems(sectionLines(md, '技能'))) {
    const [name, levelRaw] = splitFirstColon(item)
    if (!name || !/^[1-5]$/.test(levelRaw)) continue
    skills.push({ name, level: Number(levelRaw) })
  }
  return skills
}
