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
// ─── v0.3（ADR-031）Skill Registry 行内元字段：id = Registry 身份;状态/provenance = 登记信息 ───
const SKILL_ID_RE = /^id[：:]\s*([^\s]+)$/
const SKILL_STATUS_RE = /^状态[：:]\s*([^\s]+)$/
const SKILL_PROPOSED_RE = /^提议[：:]\s*([^\s]+)$/
const SKILL_REGISTERED_RE = /^登记[：:]\s*([^\s]+)$/
const SKILL_SOURCE_LINE_RE = /^来源[：:]\s*(.+)$/
const SKILL_STATUSES = new Set(['seed', 'active', 'deprecated'])
const SKILL_PROPOSED_BY = new Set(['agent_proposal', 'seed_standard', 'user'])
const SKILL_REGISTERED_BY = new Set(['engine', 'user'])

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

/** skills.md → Skill[]：整文件无 `## 技能名` → invalid；单条目缺列表项/锚点级别越界/重复名/id 非法 → degraded
 *  v0.3（ADR-031）：行内元字段 `id:`/`状态:`/`提议:`/`登记:`/`来源:`——Registry 身份与登记信息（引擎投影写入；
 *  旧文件无元字段 → 兼容缺省（id 缺省 = legacy 条目，匹配降级 name）） */
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
  const seenIds = new Set<string>()
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
      const idm = item.match(SKILL_ID_RE)
      if (idm) {
        if (/^skill_\d+$/.test(idm[1]!)) {
          if (seenIds.has(idm[1]!)) {
            checks.push({ path: name, reason: `重复 skill_id ${idm[1]}（仅保留首个）`, severity: 'warn' })
          } else {
            seenIds.add(idm[1]!)
            skill.id = idm[1]!
          }
        } else {
          checks.push({ path: name, reason: `非法 skill_id ${JSON.stringify(idm[1])}（合法：skill_数字）`, severity: 'warn' })
        }
        continue
      }
      const stm = item.match(SKILL_STATUS_RE)
      if (stm) {
        if (SKILL_STATUSES.has(stm[1]!)) skill.status = stm[1] as Skill['status']
        else checks.push({ path: name, reason: `非法状态 ${JSON.stringify(stm[1])}（合法：seed/active/deprecated）`, severity: 'warn' })
        continue
      }
      const pm = item.match(SKILL_PROPOSED_RE)
      if (pm) {
        if (SKILL_PROPOSED_BY.has(pm[1]!)) skill.proposedBy = pm[1] as Skill['proposedBy']
        else checks.push({ path: name, reason: `非法提议者 ${JSON.stringify(pm[1])}（合法：agent_proposal/seed_standard/user）`, severity: 'warn' })
        continue
      }
      const rm = item.match(SKILL_REGISTERED_RE)
      if (rm) {
        if (SKILL_REGISTERED_BY.has(rm[1]!)) skill.registeredBy = rm[1] as Skill['registeredBy']
        else checks.push({ path: name, reason: `非法登记人 ${JSON.stringify(rm[1])}（合法：engine/user）`, severity: 'warn' })
        continue
      }
      const src = item.match(SKILL_SOURCE_LINE_RE)
      if (src) {
        skill.source = src[1]!.trim()
        continue
      }
      checks.push({ path: name, reason: `无法识别的列表项 ${JSON.stringify(item)}（合法项：id/状态/提议/登记/来源/别名：… / N级：…）`, severity: 'warn' })
    }
    if (itemCount === 0) {
      checks.push({ path: name, reason: '缺列表项（未声明 id/别名/锚点等）', severity: 'warn' })
    }
    skills.push(skill)
  }
  return finalize(skills, checks)
}

/** skills.md 投影序列化 v2（Engine Registration 单方写——skill-registry 登记后落盘；对齐 serializeRolesMarkdown）。
 *  Agent 直写 skills.md 被禁止（skill-registry-contract-v0.3 §三）；id/状态/provenance 由登记信息回写。 */
export function serializeSkillsMarkdown(skills: Skill[]): string {
  const lines = [
    '# 技能词表（Skill Registry 投影——Engine 单方维护，禁止手写；技能候选走 skill-proposals/ 提案通道）',
    '',
  ]
  for (const s of skills) {
    lines.push(`## ${s.name}`, '')
    if (s.id) lines.push(`- id: ${s.id}`)
    if (s.status) lines.push(`- 状态: ${s.status}`)
    if (s.proposedBy) lines.push(`- 提议: ${s.proposedBy}`)
    if (s.registeredBy) lines.push(`- 登记: ${s.registeredBy}`)
    if (s.source) lines.push(`- 来源: ${s.source}`)
    if (s.aliases.length > 0) lines.push(`- 别名: ${s.aliases.join('、')}`)
    for (const [i, a] of (s.anchor ?? []).entries()) {
      if (a) lines.push(`- ${i + 1}级: ${a}`)
    }
    lines.push('')
  }
  return lines.join('\n')
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
      const essential = kind === 'essential'
      // v0.3 投影 v2：`skill_00001｜机械结构设计（来源: JD-…；原文: 机械结构设计方法）`——Identity/Reference 分离
      const v2 = rest.match(/^([\w-]+)｜(.+)$/)
      if (v2) {
        const [id, namePart] = [v2[1]!.trim(), v2[2]!.trim()]
        const src = namePart.match(/（来源[：:](.+?)(?:；原文[：:](.+?))?）$/)
        const canonical = (src ? namePart.slice(0, src.index) : namePart).trim()
        if (!canonical) {
          checks.push({ path: heading, reason: `需求项缺技能名：${JSON.stringify(item)}`, severity: 'warn' })
          continue
        }
        skills.push({
          skill_id: id,
          name: canonical,
          essential,
          source: src ? src[1]!.trim() : '',
          ...(src?.[2] ? { source_phrase: src[2]!.trim() } : {}),
        })
        continue
      }
      const src = rest.match(SOURCE_RE)
      const skillName = (src ? rest.slice(0, src.index) : rest).trim()
      if (!skillName) {
        checks.push({ path: heading, reason: `需求项缺技能名：${JSON.stringify(item)}`, severity: 'warn' })
        continue
      }
      skills.push({ name: skillName, essential, source: src ? src[1]!.trim() : '' })
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
      // v0.3（ADR-031）投影 v2：skill_id｜canonical（来源: …；原文: JD 原文短语）——Identity/Reference 分离
      const head = s.skill_id ? `${s.skill_id}｜${s.name}` : s.name
      const tail = s.source_phrase
        ? `（来源: ${s.source}；原文: ${s.source_phrase}）`
        : `（来源: ${s.source}）`
      lines.push(`- ${s.essential ? 'essential' : 'nice-to-have'}: ${head}${tail}`)
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
