/**
 * skill-registry：Skill Registry v0.3（ADR-031 Domain Identity Governance）——技能身份的权威层。
 *
 * - skills.md = Registry 真相源 + 投影（Engine 单方写；Agent 直写禁止——技能候选走 skill-proposals/ 提案通道）
 * - SkillProposal → 四态判定（EXISTING / NEW_PROPOSAL→REGISTERED / REJECTED）——确定性规则，无语义判断
 * - 形态规则闸门：≤12 字 / 无工具词括号堆叠 / 无句标点——防止「JD 长句偷渡为 identity」
 * - 域分类先于 Registry：Capability Matching Boundary 执行（category=soft 结构性过滤为主周期 + 词表兜底）
 * - 单通道硬规则：任何来源（JD/简历/用户/种子）只走本通道；领域引用（RoleSkill/PersonSkill）无 creation side effect
 * - Proposal ≠ Registration：提案落盘（proposed_by）与登记授权（registered_by=engine：证据充分 + 形态合格）分离
 */
import type { Skill } from '../ir/schema.ts'
import type { Workspace } from './workspace.ts'
import { parseSkillsMarkdown, serializeSkillsMarkdown } from './knowledge-watcher.ts'

export const SKILL_PROPOSAL_SPEC = {
  type: 'skill_proposal',
  dir: 'skill-proposals',
  idPrefix: 'skill_proposal_',
} as const

/** 域分类软词表（Capability Matching Boundary 执行——确定性过滤；结构性 category=soft 为主通道，本表为提案兜底） */
export const SOFT_SKILL_TERMS = [
  '抗压能力', '主动性', '责任心', '团队合作', '团队协作', '沟通能力', '学习能力', '学习接受能力',
  '逻辑思维', '诚信踏实', '耐心', '细心', '服从安排', '吃苦耐劳', '积极性', '保密意识', '服务意识',
  '奉献精神', '创新意识', '亲和力',
] as const

export interface SkillProposalInput {
  source_phrase: string // Reference——JD/简历原文短语（必填，可回溯）
  proposed_name: string // 语义候选（形态规则 —— 必须是能力主体，不是 JD 长句）
  binds_to_id?: string // Agent 推荐绑定（Engine 只验存在性；substring 候选允许显式绑定并留痕）
  evidence_source: string // 来源标识（JD-{公司}-{日期} / 简历标识 / 用户）
  aliases?: string[]
}

export interface SkillProposalRecord extends SkillProposalInput {
  id: string
  skill_id?: string
  status: 'registered' | 'existing' | 'invalid' // invalid = REJECTED（审计保留）
  reason?: string
  createdAt: string
}

export type SkillResolution =
  | { outcome: 'existing'; skillId: string; match: 'exact-canonical' | 'exact-alias' | 'explicit-bind' | 'legacy-upgrade' }
  | { outcome: 'registered'; skillId: string }
  | { outcome: 'rejected'; reason: string }

export interface SkillSearchHit {
  skill_id?: string // legacy 条目（无 id）→ 缺省；resolve 时会升级分配
  canonical_name: string
  match: 'exact-canonical' | 'exact-alias' | 'substring'
}

// ─── 形态规则（确定性闸门：Ability 主体 vs JD 长句）────────────────────────────

/** 含工具词括号堆叠：「三维 CAD 软件(CATIA/UG/SolidWorks/Pro/E)」→ 必须提炼为「三维 CAD」 */
export function hasBracketTools(name: string): boolean {
  const m = name.match(/[（(]([^（）()]{2,40})[)）]/)
  if (!m) return false
  return /[/／,，;；、]/.test(m[1]!)
}

/** 含句子标点（JD 长句/责任描述特征）→ 必须提炼 */
function hasSentencePunctuation(name: string): boolean {
  return /[。，、；：]/.test(name)
}

/** canonical 形态合格：≤12 字、名词性能力短语、无工具词括号堆叠、无句标点 */
export function isCanonicalShape(name: string): boolean {
  return (
    Array.from(name.trim()).length <= 12 &&
    !hasBracketTools(name) &&
    !hasSentencePunctuation(name)
  )
}

/** 域分类：soft/非技能词（词表兜底——系统性过滤见 role-derivation category 过滤） */
export function isSoftSkill(name: string): boolean {
  const n = name.trim()
  return SOFT_SKILL_TERMS.some((t) => n.includes(t))
}

// ─── 提案/检索/登记 ────────────────────────────────────────────────────────

/** 解析 skills.md 条目（缺失 → 空;非法结构 → 空列表不崩——与 scanKnowledge 降级惯例一致） */
export function loadSkills(ws: Workspace): Skill[] {
  if (!ws.exists('knowledge/skills.md')) return []
  return parseSkillsMarkdown(ws.read('knowledge/skills.md'), 'skills.md').value
}

function nextSkillId(ws: Workspace): string {
  let max = 0
  for (const s of loadSkills(ws)) {
    if (!s.id) continue
    const n = Number(s.id.slice('skill_'.length))
    if (!Number.isNaN(n) && n > max) max = n
  }
  return `skill_${String(max + 1).padStart(5, '0')}`
}

/** Registry 注册（Engine 登记授权——唯一创建点）：upgrade 已有条目（legacy→id）/新增条目，重投影 skills.md */
function registerEntry(ws: Workspace, entry: {
  name: string
  aliases: string[]
  status: 'seed' | 'active'
  proposedBy: Skill['proposedBy']
  registeredBy: 'engine' | 'user'
  source: string
  existing?: Skill // legacy 条目升级时保留 anchor
}): Skill {
  const skills = loadSkills(ws)
  const idx = skills.findIndex((s) => s.name === entry.name)
  if (idx >= 0) {
    skills[idx] = {
      ...skills[idx],
      id: skills[idx].id ?? nextSkillId(ws),
      status: entry.status,
      aliases: [...new Set([...skills[idx].aliases, ...entry.aliases])],
      proposedBy: skills[idx].proposedBy ?? entry.proposedBy,
      registeredBy: entry.registeredBy,
      source: skills[idx].source ?? entry.source,
    }
    ws.write('knowledge/skills.md', serializeSkillsMarkdown(skills))
    return skills[idx]!
  }
  const skill: Skill = {
    name: entry.name,
    aliases: [...new Set(entry.aliases)],
    id: nextSkillId(ws),
    status: entry.status,
    proposedBy: entry.proposedBy,
    registeredBy: entry.registeredBy,
    source: entry.source,
  }
  const next = [...skills, skill].sort((a, b) => a.name.localeCompare(b.name))
  ws.write('knowledge/skills.md', serializeSkillsMarkdown(next))
  return skill
}

/** Registry 检索（前置必做——见契约 §四）：「搜索到了」≠「身份解析成功」——exact 才自动绑定 */
export function searchSkills(ws: Workspace, term: string): SkillSearchHit[] {
  const t = term.trim()
  if (!t) return []
  const hits: SkillSearchHit[] = []
  for (const s of loadSkills(ws)) {
    if (s.name === t) {
      hits.push({ skill_id: s.id, canonical_name: s.name, match: 'exact-canonical' })
      continue
    }
    if (s.aliases.includes(t)) {
      hits.push({ skill_id: s.id, canonical_name: s.name, match: 'exact-alias' })
      continue
    }
    if (s.name.includes(t) || s.aliases.some((a) => a.includes(t))) {
      hits.push({ skill_id: s.id, canonical_name: s.name, match: 'substring' })
    }
  }
  return hits
}

function serializeProposal(p: SkillProposalRecord): string {
  return [
    '---',
    `id: ${p.id}`,
    `status: ${p.status}`,
    ...(p.skill_id ? [`skill_id: ${p.skill_id}`] : []),
    `created_at: ${p.createdAt}`,
    '---',
    '# 技能提案',
    '',
    `- 原文: ${p.source_phrase}`,
    `- 候选名: ${p.proposed_name}`,
    ...(p.binds_to_id ? [`- 绑定: ${p.binds_to_id}`] : []),
    `- 来源: ${p.evidence_source}`,
    ...(p.reason ? [`- 判定: ${p.reason}`] : []),
    '',
  ].join('\n')
}

function nextProposalId(ws: Workspace, now: Date): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `${SKILL_PROPOSAL_SPEC.idPrefix}${day}_`
  let max = 0
  for (const f of ws.listMarkdown(SKILL_PROPOSAL_SPEC.dir)) {
    if (!f.startsWith(prefix)) continue
    const n = parseInt(f.slice(prefix.length, -3), 10)
    if (!Number.isNaN(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(5, '0')}`
}

/** 提案落盘（审计——status=invalid 也保留，屏蔽/回归可查） */
function writeProposalFile(ws: Workspace, p: SkillProposalRecord): void {
  ws.write(`${SKILL_PROPOSAL_SPEC.dir}/${p.id}.md`, serializeProposal(p))
}

/**
 * 四态判定（确定性，无语义判断——契约 §五）：
 * ① binds_to_id 提供：存在且非 deprecated → EXISTING(explicit-bind)；不存在 → REJECTED
 * ② 精确命中（规范名/别名，无 id 的 legacy 条目自动升级分配 id）→ EXISTING
 * ③ substring 命中：不自动绑定（候选供决策），继续 NEW 流程（Agent 未显式绑定时）
 * ④ 无命中 & 形态合格 & 来源可溯 → 登记授权 → REGISTERED（skill_id 派生 + provenance + 投影）
 * 域分类（soft）先于一切 → REJECTED
 */
export function resolveSkillProposal(ws: Workspace, input: SkillProposalInput, now: Date = new Date()): SkillResolution {
  const sourcePhrase = input.source_phrase.trim()
  const proposedName = input.proposed_name.trim()
  const evidence = input.evidence_source.trim()
  const id = nextProposalId(ws, now)

  if (!sourcePhrase || !evidence || !proposedName) {
    const rec: SkillProposalRecord = { id, status: 'invalid', ...input, reason: '必填缺失（原文/候选名/来源）', createdAt: now.toISOString() }
    writeProposalFile(ws, rec)
    return { outcome: 'rejected', reason: '必填缺失（原文/候选名/来源）' }
  }
  if (isSoftSkill(proposedName) || isSoftSkill(sourcePhrase)) {
    const rec: SkillProposalRecord = { id, status: 'invalid', ...input, reason: `soft/非技能词（域分类：${isSoftSkill(proposedName) ? proposedName : sourcePhrase}）——不进技能矩阵`, createdAt: now.toISOString() }
    writeProposalFile(ws, rec)
    return { outcome: 'rejected', reason: 'soft/非技能词，不进技能矩阵（Capability Matching Boundary）' }
  }

  if (input.binds_to_id) {
    const hit = loadSkills(ws).find((s) => s.id === input.binds_to_id)
    if (!hit || hit.status === 'deprecated') {
      const rec: SkillProposalRecord = { id, status: 'invalid', ...input, reason: `绑定不存在或已废弃：${input.binds_to_id}`, createdAt: now.toISOString() }
      writeProposalFile(ws, rec)
      return { outcome: 'rejected', reason: `绑定不存在或已废弃（先 --skill-search 检索）：${input.binds_to_id}` }
    }
    const rec: SkillProposalRecord = { id, status: 'existing', skill_id: hit.id, ...input, createdAt: now.toISOString() }
    writeProposalFile(ws, rec)
    return { outcome: 'existing', skillId: hit.id, match: 'explicit-bind' }
  }

  const exact = loadSkills(ws).find((s) => s.name === proposedName || s.aliases.includes(proposedName))
  if (exact) {
    // legacy 条目（无 id）自动升级分配 id——升级写回投影；有 id 直接绑定
    const upgraded = exact.id ? exact : registerEntry(ws, {
      name: exact.name,
      aliases: exact.aliases,
      status: 'active',
      proposedBy: 'user', // 存量条目归位（无提案来源——非 Agent 新建）
      registeredBy: 'engine',
      source: exact.source ?? '',
    })!
    const rec: SkillProposalRecord = {
      id, status: 'existing', skill_id: upgraded.id,
      source_phrase: sourcePhrase, proposed_name: proposedName, evidence_source: evidence,
      createdAt: now.toISOString(),
    }
    writeProposalFile(ws, rec)
    return { outcome: 'existing', skillId: upgraded.id, match: exact.id ? 'exact-canonical' : 'legacy-upgrade' }
  }

  if (!isCanonicalShape(proposedName)) {
    const rec: SkillProposalRecord = {
      id, status: 'invalid', source_phrase: sourcePhrase, proposed_name: proposedName, evidence_source: evidence,
      reason: `形态不合格（≤12 字/无工具词括号/无句标点）——需提炼能力主体（如「三维 CAD 软件(CATIA/UG/SolidWorks/Pro/E)」→「三维 CAD」）`,
      createdAt: now.toISOString(),
    }
    writeProposalFile(ws, rec)
    return { outcome: 'rejected', reason: '形态不合格：需提炼为能力主体（≤12 字、无工具词括号堆叠、无句标点）' }
  }

  const skill = registerEntry(ws, {
    name: proposedName,
    aliases: input.aliases ?? [],
    status: 'active',
    proposedBy: 'agent_proposal',
    registeredBy: 'engine',
    source: evidence,
  })
  const rec: SkillProposalRecord = {
    id, status: 'registered', skill_id: skill.id,
    source_phrase: sourcePhrase, proposed_name: proposedName, evidence_source: evidence,
    createdAt: now.toISOString(),
  }
  writeProposalFile(ws, rec)
  return { outcome: 'registered', skillId: skill.id! }
}

// ─── 存量对账 / watcher（对齐 role-proposal-registry）────────────────────────

export function parseSkillProposalMarkdown(md: string): SkillProposalRecord | null {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  if (!meta.id) return null
  let sourcePhrase = ''
  let proposedName = ''
  let evidence = ''
  let binds: string | undefined
  let aliases: string[] | undefined
  for (const line of md.slice(m[0].length).split('\n')) {
    const t = line.trim()
    const sm = t.match(/^-\s*原文[：:]\s*(.+)$/)
    if (sm) sourcePhrase = sm[1]!.trim()
    const nm = t.match(/^-\s*候选名[：:]\s*(.+)$/)
    if (nm) proposedName = nm[1]!.trim()
    const em = t.match(/^-\s*来源[：:]\s*(.+)$/)
    if (em) evidence = em[1]!.trim()
    const bm = t.match(/^-\s*绑定[：:]\s*(\S+)$/)
    if (bm) binds = bm[1]!.trim()
  }
  return {
    id: meta.id,
    status: (meta.status === 'existing' || meta.status === 'registered' || meta.status === 'invalid') ? meta.status : 'invalid',
    skill_id: meta.skill_id,
    reason: meta.reason,
    createdAt: meta.created_at ?? '',
    source_phrase: sourcePhrase,
    proposed_name: proposedName,
    evidence_source: evidence,
    ...(binds ? { binds_to_id: binds } : {}),
    ...(aliases ? { aliases } : {}),
  }
}

export function scanSkillProposals(ws: Workspace): SkillProposalRecord[] {
  let files: string[]
  try {
    files = ws.listMarkdown(SKILL_PROPOSAL_SPEC.dir)
  } catch {
    return []
  }
  return files
    .sort()
    .map((f) => parseSkillProposalMarkdown(ws.read(`${SKILL_PROPOSAL_SPEC.dir}/${f}`)))
    .filter((p): p is SkillProposalRecord => p !== null)
}
