/**
 * person-watcher：M6.5 Person Intelligence Layer（ADR-009）——persons/{person_id}/ 主体资产解析。
 * - parsePersonManifest：manifest.md（frontmatter: id/name/status/created_at + 摘要表）→ 根声明
 * - parseSnapshotTable：snapshot/*.md 的 `## 分析摘要` 表 → 字段映射（缺表 → 空对象）
 * - scanPersons：persons/ 子目录扫描 → PersonSnapshot[]（manifest 缺 id → 跳过；
 *   无 persons/ 目录 → 空数组，调用方降级 profiles 旧扫描）
 * - createPersonSession / appendSessionTurn：Initialization Session 持久化（切片 2.1）——
 *   manifest.md + intake/session-001.md（原始对话记录，非事实层）
 *
 * 真相源由对话式采集/用户维护，引擎只读解析不写。降级惯例同 evidence-watcher：
 * 摘要表缺失 → 字段缺省（空对象），不 invalid——Person 是导航资产，缺字段不阻塞。
 */
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { watch } from 'chokidar'
import type { PersonSkill, PersonSnapshot } from '../ir/schema.ts'
import type { Workspace } from './workspace.ts'
import { splitFrontmatter } from './artifact-registry.ts'
import { parseSummaryTable } from '../ir/summary-table.ts'

export interface PersonManifest {
  id: string
  name: string
  status: string
  createdAt?: string
  /** 初始化状态（生命周期摘要：in_progress=首次采集未完成；completed=已进入正常使用；缺失=旧档案） */
  initState?: 'in_progress' | 'completed'
  /** 初始化通道（manifest source_mode；刷新后恢复通道语义） */
  sourceMode?: 'resume' | 'interview'
}

const STATUSES = ['active', 'archived'] as const

/** persons/ 子目录名 → person_id 列表（无目录 → 空） */
function scanPersonIds(ws: Workspace): string[] {
  try {
    return readdirSync(ws.paths.persons, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** 创建 Person + Initialization Session：persons/{person_id}/manifest.md + intake/session-001.md */
export function createPersonSession(ws: Workspace, params: { name: string; sourceMode: 'resume' | 'interview' }): { personId: string; sessionId: string } {
  const { name, sourceMode } = params
  const seq = scanPersonIds(ws).reduce((m, id) => Math.max(m, Number(id.replace('person_', '')) || 0), 0) + 1
  const personId = `person_${String(seq).padStart(3, '0')}`
  const today = new Date().toISOString().slice(0, 10)
  const manifest = [
    '---',
    `id: ${personId}`,
    `name: ${name}`,
    'status: active',
    `created_at: ${today}`,
    '---',
    '',
    `# Person ${String(seq).padStart(3, '0')} — ${name}`,
    '',
    '## 分析摘要',
    '',
    '| 字段 | 值 |',
    '|------|-----|',
    `| id | ${personId} |`,
    `| name | ${name} |`,
    '| status | active |',
    `| source_mode | ${sourceMode} |`,
    '| init_state | in_progress |',
    '| init_session | session-001 |',
    `| created_at | ${today} |`,
    '',
  ].join('\n')
  ws.write(`persons/${personId}/manifest.md`, manifest)
  ws.write(`persons/${personId}/intake/session-001.md`, sessionTemplate(personId, sourceMode))
  return { personId, sessionId: 'session-001' }
}

/** 重置初始化（Person 生命周期 v0.1）：清 intake/extraction/events/snapshot/documents，重建空 session；manifest（id/name/created_at）保留 */
export function resetPerson(ws: Workspace, personId: string): { personId: string } {
  if (!/^person_\d{3}$/.test(personId)) throw new Error(`非法 personId: ${personId}`)
  for (const sub of ['intake', 'extraction', 'events', 'snapshot', 'documents']) {
    rmSync(join(ws.paths.persons, personId, sub), { recursive: true, force: true })
  }
  const manifest = ws.exists(`persons/${personId}/manifest.md`) ? ws.read(`persons/${personId}/manifest.md`) : ''
  const sourceMode: 'resume' | 'interview' = /^\| source_mode \| resume \|/m.test(manifest) ? 'resume' : 'interview'
  setManifestInitState(ws, personId, 'in_progress')
  ws.write(`persons/${personId}/intake/session-001.md`, sessionTemplate(personId, sourceMode))
  return { personId }
}

/** 物理删除 Person 资产（dev/测试清理：persons/{person_id}/ 整目录移除，不可恢复；目录不存在 → 幂等成功） */
export function deletePerson(ws: Workspace, personId: string): { personId: string } {
  if (!/^person_\d{3}$/.test(personId)) throw new Error(`非法 personId: ${personId}`)
  rmSync(join(ws.paths.persons, personId), { recursive: true, force: true })
  return { personId }
}

function sessionTemplate(personId: string, sourceMode: 'resume' | 'interview'): string {
  return [
    '# Initialization Session',
    '',
    `Person: ${personId}`,
    'Mode: initialization',
    `Source: ${sourceMode === 'resume' ? 'resume' : 'user_reported'}`,
    '',
    '## Conversation',
    '',
    '（对话记录将在这里累积——用户说过的话不会消失）',
    '',
    '## Status',
    '',
    'Collected: ',
    'Pending: ',
    '',
  ].join('\n')
}

/** 追加一轮对话到 intake/session-001.md（原始认知输入，非 AI 总结事实） */
export function appendSessionTurn(ws: Workspace, params: { personId: string; role: 'user' | 'assistant'; content: string; timestamp?: string }): void {
  const { personId, role, content } = params
  const rel = `persons/${personId}/intake/session-001.md`
  if (!ws.exists(rel)) return // 无 session 资产 → 不创建（UI 创建流程负责先 create）
  const ts = params.timestamp ?? new Date().toISOString()
  const block = [
    '',
    `### Turn（${ts}）`,
    '',
    `**${role === 'user' ? 'User' : 'Agent'}:**`,
    '',
    content.trim(),
    '',
  ].join('\n')
  ws.write(rel, ws.read(rel).replace(/^## Status\n\nCollected: .*\nPending: .*\n?$/m, block + '\n\n## Status\n\nCollected: \nPending: '))
}

const CANDIDATE_CATEGORY_LABEL: Record<string, string> = {
  education: '教育',
  experience: '经历',
  skill: '技能',
  constraint: '约束',
  interest: '兴趣',
}

/** 候选行 → 表格行（extraction/candidates.md 追加）；category 非法 → 跳过该条（不 invalid 整个批次）。
 *  payload 为通用结构化载荷列（education 类目键值段：学校=…；专业=…；学历=…；起=…；止=…；其余类目留空）——
 *  空 payload 输出 5 列（旧格式兼容），有 payload 输出 6 列 */
function candidateRow(c: { category: string; content: string; source: string; payload?: string }): string | null {
  const category = CANDIDATE_CATEGORY_LABEL[c.category]
  if (!category || !c.content.trim()) return null
  const source = c.source === 'resume' ? 'resume' : 'user_reported'
  const payload = c.payload?.trim() ? c.payload.trim().replace(/\|/g, '\\|') : ''
  const content = c.content.trim().replace(/\|/g, '\\|')
  return payload ? `pending | ${category} | ${content} | ${source} | ${payload}` : `pending | ${category} | ${content} | ${source}`
}

/** 追加候选批次到 extraction/candidates.md（append-only；id 按现有行数递增） */
export function appendCandidates(ws: Workspace, params: { personId: string; candidates: { category: string; content: string; source: string; payload?: string }[] }): { id: string; category: string; content: string; source: string; status: 'pending'; sessionRef: string; payload?: string }[] {
  const { personId } = params
  const rel = `persons/${personId}/extraction/candidates.md`
  if (!ws.exists(rel)) {
    ws.write(rel, ['# Extraction Candidates', '', '| id | status | category | content | source | payload |', '|----|--------|----------|---------|--------|---------|', ''].join('\n'))
  }
  const existing = ws.read(rel)
  const count = (existing.match(/^\| c-\d+ \|/gm) ?? []).length
  const added: { id: string; category: string; content: string; source: string; status: 'pending'; sessionRef: string; payload?: string }[] = []
  const rows: string[] = []
  for (const c of params.candidates) {
    const row = candidateRow(c)
    if (!row) continue
    const id = `c-${String(count + rows.length + 1).padStart(3, '0')}`
    rows.push(`| ${id} | ${row} |`)
    added.push({ id, category: c.category, content: c.content.trim(), source: c.source === 'resume' ? 'resume' : 'user_reported', status: 'pending', sessionRef: 'session-001', payload: c.payload?.trim() })
  }
  if (rows.length > 0) ws.write(rel, existing.replace(/\n?$/, '\n') + rows.join('\n') + '\n')
  return added
}

/** 教育候选键值段 → 结构化 proposal（`学校=…；专业=…；学历=…；起=…；止=…`；缺学校 → 无结构化——
 *  结构化失败时 content 原文仍在（Candidate 双层：raw_content + structured_proposal）） */
export function parseEducationPayload(payload: string | undefined): { school: string; major?: string; degree?: string; startYear?: number; endYear?: number } | undefined {
  if (!payload?.trim()) return undefined
  const fields: Record<string, string> = {}
  for (const seg of payload.split(/[；;]/)) {
    const m = seg.trim().match(/^([^=：]+?)[=：](.+)$/)
    if (m && m[2]!.trim()) fields[m[1]!.trim()] = m[2]!.trim()
  }
  const school = fields['学校'] ?? fields['school']
  if (!school) return undefined
  const num = (v: string | undefined): number | undefined => (v && /^\d+$/.test(v) ? Number(v) : undefined)
  return {
    school,
    major: fields['专业'] ?? fields['major'],
    degree: fields['学历'] ?? fields['degree'],
    startYear: num(fields['起'] ?? fields['start'] ?? fields['start_year']),
    endYear: num(fields['止'] ?? fields['end'] ?? fields['end_year']),
  }
}

/** extraction/candidates.md → 候选列表（状态过滤 pending/confirmed/rejected；文件缺 → 空；
 *  5 列旧格式（无 payload）兼容） */
export function listCandidates(ws: Workspace, personId: string): import('../ir/schema.ts').InitCandidate[] {
  const rel = `persons/${personId}/extraction/candidates.md`
  if (!ws.exists(rel)) return []
  const labelToKey = Object.fromEntries(Object.entries(CANDIDATE_CATEGORY_LABEL).map(([k, v]) => [v, k]))
  const out: import('../ir/schema.ts').InitCandidate[] = []
  for (const line of ws.read(rel).split('\n')) {
    const m6 = line.match(/^\| (c-\d+) \| (\w+) \| ([^|]+) \| (.+?) \| (\w+) \| (.+?) \|$/)
    const m5 = !m6 ? line.match(/^\| (c-\d+) \| (\w+) \| ([^|]+) \| (.+?) \| (\w+) \|$/) : null
    const m = m6 ?? m5
    if (!m) continue
    const category = labelToKey[m[3]!.trim()]
    if (!category) continue
    const payload = m6 ? m6[6]!.trim() : undefined
    const cand: import('../ir/schema.ts').InitCandidate = {
      id: m[1]!,
      category: category as never,
      content: (m6 ?? m5)![4]!.trim(),
      source: (m6 ?? m5)![5]! as never,
      status: m[2]! as never,
      sessionRef: 'session-001',
    }
    if (payload && category === 'education') {
      cand.payload = payload
      cand.education = parseEducationPayload(payload)
    }
    out.push(cand)
  }
  return out
}

const RESOLUTION_ACTION_LABEL: Record<string, string> = { confirmed: '确认', rejected: '拒绝', modified: '修改' }

/** 候选行 source（resume/user_reported）——resolve 后从行末取 */
function m5Source(ws: Workspace, personId: string, candidateId: string): 'resume' | 'user_reported' {
  const rel = `persons/${personId}/extraction/candidates.md`
  if (!ws.exists(rel)) return 'user_reported'
  for (const line of ws.read(rel).split('\n')) {
    const m = line.match(new RegExp(`^\\| ${candidateId} \\| \\w+ \\| [^|]+ \\| .+? \\| (\\w+) \\|`))
    if (m) return m[1] === 'resume' ? 'resume' : 'user_reported'
  }
  return 'user_reported'
}

/** facts/education.md 已登记候选 id 集合（幂等：同一候选不重复登记） */
function registeredEducationIds(ws: Workspace, personId: string): Set<string> {
  const rel = `persons/${personId}/facts/education.md`
  if (!ws.exists(rel)) return new Set()
  const ids = new Set<string>()
  for (const line of ws.read(rel).split('\n')) {
    const m = line.match(/^\|\s*(c-\d+)\s*\|/)
    if (m) ids.add(m[1]!.trim())
  }
  return ids
}

/** 教育事实登记（Registration Owner = Engine）：candidate resolve 确认（education 类目 + 结构化
 *  payload）→ facts/education.md 追加行。契约：references/person-education-registration-contract.md */
export function registerEducationFact(
  ws: Workspace,
  personId: string,
  fact: { candidateId: string; school: string; major?: string; degree?: string; startYear?: number; endYear?: number; source: 'resume' | 'user_reported' },
): void {
  const rel = `persons/${personId}/facts/education.md`
  if (!ws.exists(rel)) {
    ws.write(rel, ['# Education Facts', '', '## 教育记录', '', '| candidate_id | school | major | degree | start_year | end_year | status | source |', '|--------------|--------|-------|--------|-----------|----------|--------|--------|', ''].join('\n'))
  }
  const cell = (v: string | number | undefined): string => (v === undefined || v === '' ? '-' : String(v).replace(/\|/g, '\\|'))
  const row = `| ${fact.candidateId} | ${cell(fact.school)} | ${cell(fact.major)} | ${cell(fact.degree)} | ${cell(fact.startYear)} | ${cell(fact.endYear)} | confirmed | ${fact.source} |`
  ws.write(rel, ws.read(rel).replace(/\n?$/, '\n') + row + '\n')
}

/**
 * 候选裁决（切片 2.3）：更新 candidates.md 状态 + 写 resolution 事件（审计：
 * "为什么档案里有这个事实" → "因为用户在某次初始化会话中确认了这个候选"）。
 * confirmed/modified → status confirmed；rejected → status rejected；modified 替换内容。
 * education 类目 confirmed（含结构化 payload）→ 同步登记 facts/education.md（Registration）。
 */
export function resolveCandidate(
  ws: Workspace,
  params: { personId: string; candidateId: string; action: 'confirmed' | 'rejected' | 'modified'; modifiedContent?: string; timestamp?: string },
): { candidateId: string; action: string; status: string } | null {
  const { personId, candidateId, action } = params
  const rel = `persons/${personId}/extraction/candidates.md`
  if (!ws.exists(rel)) return null
  const lines = ws.read(rel).split('\n')
  let changed = false
  let categoryLabel = ''
  let content = ''
  let payload = ''
  const next = lines.map((line) => {
    const m6 = line.match(/^\| (c-\d+) \| (\w+) \| ([^|]+) \| (.+?) \| (\w+) \| (.+?) \|$/)
    const m5 = !m6 ? line.match(/^\| (c-\d+) \| (\w+) \| ([^|]+) \| (.+?) \| (\w+) \|$/) : null
    const m = m6 ?? m5
    if (!m || m[1] !== candidateId) return line
    changed = true
    categoryLabel = m[3]!.trim()
    content = m[4]!.trim()
    payload = m6 ? m6[6]!.trim() : ''
    if (action === 'rejected') return line.replace(/^(\| \S+ \| )\w+( \|)/, `$1rejected$2`)
    const newContent = action === 'modified' && params.modifiedContent?.trim() ? params.modifiedContent.trim() : content
    return `| ${m[1]} | confirmed | ${m[3]} | ${newContent.replace(/\|/g, '\\|')} | ${m[5]}${m6 ? ` | ${m6[6]}` : ''} |`
  })
  if (!changed) return null
  ws.write(rel, next.join('\n'))

  // Registration：education 类目确认 + 结构化 payload → facts/education.md（幂等）
  if (action !== 'rejected' && categoryLabel === '教育') {
    const edu = parseEducationPayload(payload)
    if (edu && !registeredEducationIds(ws, personId).has(candidateId)) {
      registerEducationFact(ws, personId, {
        candidateId,
        school: edu.school,
        major: edu.major,
        degree: edu.degree,
        startYear: edu.startYear,
        endYear: edu.endYear,
        source: m5Source(ws, personId, candidateId),
      })
    }
  }

  const ts = params.timestamp ?? new Date().toISOString()
  const date = ts.slice(0, 10).replace(/-/g, '')
  const eventsDir = `persons/${personId}/events`
  let seq = 0
  try {
    seq = ws.listMarkdown(eventsDir).length
  } catch {
    /* events/ 未创建 → 0 */
  }
  const seqStr = String(seq + 1).padStart(6, '0')
  const eventId = `pe_${date}_${seqStr}`
  const actionLabel = RESOLUTION_ACTION_LABEL[action] ?? action
  const evt = [
    '---',
    `id: ${eventId}`,
    `time: ${ts}`,
    'type: candidate_resolution',
    'source: user_action',
    '---',
    '',
    `# 事件：候选${actionLabel} ${candidateId}`,
    '',
    `- time: ${ts}`,
    '- type: candidate_resolution',
    `- description: 用户在初始化会话中${actionLabel}候选 ${candidateId}（${categoryLabel}｜${content}）`,
    '- source: user_action',
    `- candidate_id: ${candidateId}`,
    `- action: ${action}`,
    '- actor: user',
    '',
  ].join('\n')
  ws.write(`persons/${personId}/events/event_${date}_${seqStr}_resolution.md`, evt)
  return { candidateId, action, status: action === 'rejected' ? 'rejected' : 'confirmed' }
}

/** manifest.md → 根声明（frontmatter id/name/status 必填；缺任一 → undefined） */
export function parsePersonManifest(md: string): PersonManifest | undefined {
  const { meta, body } = splitFrontmatter(md)
  const fields = parseSummaryTable(body)
  const id = meta.id?.trim() || fields?.id?.trim()
  const name = meta.name?.trim() || fields?.name?.trim()
  const status = meta.status?.trim() || fields?.status?.trim() || 'active'
  if (!id || !name) return undefined
  if (!(STATUSES as readonly string[]).includes(status)) return undefined
  const rawInit = meta.init_state?.trim() || fields?.init_state?.trim()
  const initState = rawInit === 'in_progress' || rawInit === 'completed' ? rawInit : undefined
  const rawMode = meta.source_mode?.trim() || fields?.source_mode?.trim()
  const sourceMode = rawMode === 'resume' || rawMode === 'interview' ? rawMode : undefined
  return {
    id,
    name,
    status,
    createdAt: meta.created_at?.trim(),
    ...(initState ? { initState } : {}),
    ...(sourceMode ? { sourceMode } : {}),
  }
}

/** manifest 摘要表 init_state 行更新（缺失行插入——旧档案无该字段）；非法 personId 抛错 */
function setManifestInitState(ws: Workspace, personId: string, state: 'in_progress' | 'completed'): void {
  if (!/^person_\d{3}$/.test(personId)) throw new Error(`非法 personId: ${personId}`)
  const path = `persons/${personId}/manifest.md`
  if (!ws.exists(path)) throw new Error(`manifest 不存在：${personId}`)
  const md = ws.read(path)
  const line = `| init_state | ${state} |`
  const next = /^\| init_state \| .+ \|$/m.test(md)
    ? md.replace(/^\| init_state \| .+ \|$/m, line)
    : md.replace(/^(\|------\|-----(\|------)*\|)$/m, `$1\n${line}`)
  ws.write(path, next)
}

/** 完成初始化（用户声明基础信息达到可用状态，非封闭）：manifest init_state → completed */
export function completePersonInit(ws: Workspace, personId: string): { personId: string; initState: 'completed' } {
  setManifestInitState(ws, personId, 'completed')
  return { personId, initState: 'completed' }
}

/** snapshot/current/*.md 摘要表 → 字段映射（缺表 → 空对象；值域非法字段丢弃） */
export function parseSnapshotTable(md: string): Record<string, string> {
  const fields = parseSummaryTable(md)
  if (!fields) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' && v && v !== '（待采集）' && v !== '-' && !v.startsWith('（待')) {
      out[k] = v
    }
  }
  return out
}

/** snapshot/career_profile.md 的 User Career Intent 表 → targetRoles（只取 source=user 行——
 *  用户确认的目标岗位；推荐/决策结论不消费为目标，权威源在 decisions/）。无新表时兼容旧
 *  `- {方向} {匹配度}%` 行（迁移过渡期，不静默丢弃）。契约：references/career-profile-contract.md */
function extractTargetRoles(md: string): string[] {
  const roles: string[] = []
  let inIntent = false
  for (const line of md.split('\n')) {
    if (line.startsWith('## User Career Intent')) {
      inIntent = true
      continue
    }
    if (inIntent && line.startsWith('## ')) break
    if (!inIntent) continue
    const m = line.match(/^\|\s*(.+?)\s*\|\s*\w+\s*\|\s*(\w+)\s*\|$/)
    if (!m || m[1]!.trim() === 'target_role' || m[1]!.trim().startsWith('-')) continue
    if (m[2]!.trim() === 'user') roles.push(m[1]!.trim())
  }
  if (roles.length > 0) return roles
  // 兼容旧 `- {方向} {匹配度}%` 行
  for (const line of md.split('\n')) {
    const m = line.match(/^\s*[-*]\s*(.+?)\s+\d{1,3}%\s*$/)
    if (m) roles.push(m[1]!.trim())
  }
  return roles
}

function snapshotOf(ws: Workspace, pid: string, file: string): Record<string, string> | undefined {
  const rel = `persons/${pid}/snapshot/current/${file}`
  return ws.exists(rel) ? parseSnapshotTable(ws.read(rel)) : undefined
}

/** skill_inventory 语义级别 → SFIA 数字（词表映射非打分；inferred/learned/未识别 → 跳过） */
const SKILL_LEVEL_MAP: Record<string, number> = {
  'applied-professional': 4,
  'applied-intermediate': 3,
  applied: 3,
  'applied-basic': 2,
}

/** skill_inventory 技能名括号内工具词 → tools（确定性派生，非推理；Skill Representation v0.1）：
 *  「机械制图与三维建模（SolidWorks/Creo/AutoCAD）」→ [SolidWorks, Creo, AutoCAD]；无括号 → 空 */
function deriveTools(name: string): string[] {
  const m = name.match(/[（(]([^（）()]+)[)）]/)
  if (!m) return []
  return m[1]!
    .split(/[/／,，;；、\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !/^\d+$/.test(s))
}

/**
 * snapshot/skill_inventory.md → confirmed 技能 + 版本。
 * 解析所有 `| skill_id | 名称 | level |` 表格行（A/B/C 段）；level 单元格取首词
 * （`applied（cross-domain）` → applied）；inferred/learned 不进 Person.skills。
 */
function parseSkillInventory(md: string): { skills: PersonSkill[]; version: string } {
  const skills: PersonSkill[] = []
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*(skill_\w+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/)
    if (!m) continue
    const levelWord = m[3]!.trim().split(/[（(]/)[0]!.trim()
    const level = SKILL_LEVEL_MAP[levelWord]
    if (level === undefined) continue
    const name = m[2]!.trim()
    const tools = deriveTools(name)
    skills.push({ skillId: m[1]!.trim(), name, level, ...(tools.length > 0 ? { tools } : {}) })
  }
  const version = md.match(/^status:\s*(v[\w.-]+)/m)?.[1] ?? 'v1'
  return { skills, version }
}

/** facts/education.md → PersonEducation[]（教育事实登记表；无行 → 空数组） */
function parseEducationFacts(md: string): import('../ir/schema.ts').PersonEducation[] {
  const out: import('../ir/schema.ts').PersonEducation[] = []
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*(c-\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(\w+)\s*\|\s*(\w+)\s*\|$/)
    if (!m) continue
    const dash = (v: string): string | undefined => (v.trim() === '-' ? undefined : v.trim())
    out.push({
      candidateId: m[1]!.trim(),
      school: m[2]!.trim(),
      major: dash(m[3]!),
      degree: m[4]!.trim(),
      startYear: dash(m[5]!) ? Number(dash(m[5]!)) : undefined,
      graduationYear: dash(m[6]!) ? Number(dash(m[6]!)) : undefined,
      status: m[7]!.trim() as never,
      source: m[8]!.trim() as never,
    })
  }
  return out
}

/** persons/ 子目录扫描 → PersonSnapshot[]（manifest 缺 id → 跳过该 person） */
export function scanPersons(ws: Workspace): PersonSnapshot[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(ws.paths.persons, { withFileTypes: true })
  } catch {
    return [] // persons/ 未创建 → 空（调用方降级 profiles）
  }

  const out: PersonSnapshot[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const pid = e.name
    const manifestPath = `persons/${pid}/manifest.md`
    if (!ws.exists(manifestPath)) continue
    const manifest = parsePersonManifest(ws.read(manifestPath))
    if (!manifest) continue

    const identity = snapshotOf(ws, pid, 'identity.md')
    const careerRel = `persons/${pid}/snapshot/current/career_profile.md`
    const careerMd = ws.exists(careerRel) ? ws.read(careerRel) : undefined
    const career = careerMd ? parseSnapshotTable(careerMd) : undefined
    const preference = snapshotOf(ws, pid, 'preference_constraints.md')
    const eduRel = `persons/${pid}/facts/education.md`
    const education = ws.exists(eduRel) ? parseEducationFacts(ws.read(eduRel)) : undefined

    let eventCount = 0
    try {
      eventCount = ws.listMarkdown(`persons/${pid}/events`).length
    } catch {
      /* events/ 未创建 → 0 */
    }

    const snapshot: PersonSnapshot = {
      personId: manifest.id,
      name: manifest.name,
      status: manifest.status,
      initState: manifest.initState,
      sourceMode: manifest.sourceMode,
      manifestPath,
      eventCount: 0,
    }
    if (identity) {
      snapshot.identity = {
        education: identity.education,
        graduationYear: identity.graduation_year,
        location: identity.location,
        currentStatus: identity.current_status,
        yearsExperience: identity.years_experience,
      }
    }
    if (education && education.length > 0) {
      snapshot.education = education
    }
    if (career) {
      snapshot.careerProfile = {
        currentRole: career.current_role,
        targetRoles: extractTargetRoles(careerMd ?? ''),
        excludedRoles: career.excluded_roles ? career.excluded_roles.split(/[，,]/).map((s) => s.trim()).filter(Boolean) : undefined,
      }
    }
    if (preference) {
      snapshot.preference = {
        salaryRange: preference.salary_range,
        city: preference.city,
      }
    }
    // M6.6.5：技能真相源 = skill_inventory.md（confirmed → Person.skills；决策 provenance 键）
    const skillRel = `persons/${pid}/snapshot/current/skill_inventory.md`
    if (ws.exists(skillRel)) {
      const inv = parseSkillInventory(ws.read(skillRel))
      if (inv.skills.length > 0) {
        snapshot.skills = inv.skills
        snapshot.skillInventoryVersion = inv.version
      }
    }
    snapshot.eventCount = eventCount
    out.push(snapshot)
  }
  return out.sort((a, b) => a.personId.localeCompare(b.personId))
}

/**
 * watchPersons：persons/{person_id}/ 目录监听（P1 Person Aggregate 生命周期闭环——
 * identity/career_profile/skill_inventory 等变化 → personsChanged → UI 重拉 persons/list）。
 * add/change/unlink 任一触发 → onChanged()；返回 { close } 供测试/退出。
 */
export function watchPersons(ws: Workspace, onChanged: () => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.persons, { ignoreInitial: true })
  const rescan = (): void => onChanged()
  watcher.on('add', (path: string) => {
    if (path.endsWith('.md')) rescan()
  })
  watcher.on('change', (path: string) => {
    if (path.endsWith('.md')) rescan()
  })
  watcher.on('unlink', (path: string) => {
    if (path.endsWith('.md')) rescan()
  })
  return { close: () => watcher.close() }
}
