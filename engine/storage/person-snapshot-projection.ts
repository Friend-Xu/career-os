/**
 * person-snapshot-projection：Person 快照三件的 Engine 投影器（Materialized View）。
 *
 * 实时归位（Agent Execution Boundary Repair P0-A'）：候选确认（resolveCandidate）→ Registration（facts/）
 * → 本投影器立即重投影三件快照。Agent 不写快照；快照 = 已登记事实的 Materialized View——
 * 会话中断不丢已确认信息（每确认一条归位一条，不攒批收尾）。
 *
 * 契约统一：identity.md 是 Projection（person-education-registration-contract §1），
 * 与 person-snapshot-identity-contract 的"Agent 直写"冲突消除——快照归 Engine。
 *
 * 数据源（只投影，不新增解析/推导）：
 * - identity.md      ← facts/education.md（education/graduation_year 取 end_year 最大的确定性聚合）
 *                        + facts/experience.md（工作经历表原文）
 * - preference_constraints.md ← confirmed 约束/兴趣候选：结构化 payload（薪资=/城市=）→ 规范键；
 *                        content 原文 → 「偏好约束」原文列表（不拆解——Derived Data Separation）
 * - skill_inventory.md ← confirmed 技能候选（结构化 payload 技能=/级别=/场景=）
 * - career_profile.md ← confirmed 约束/兴趣候选：结构化 payload（意向岗位=/优先级=）→
 *                        User Career Intent 表（只承载用户意向——契约
 *                        references/career-profile-contract.md；推荐/决策结论禁止写入）
 *
 * 幂等：全量重投影（从事实源聚合重写，不增量 patch）；无事实 → 不生成对应文件
 * （"没有证据的字段就不存在"——缺值不生成字段，不用 `-` 占位）。
 */
import type { Workspace } from './workspace.ts'
import { listCandidates, parseEducationFacts, parseExperienceFacts } from './person-watcher.ts'

// ─── 技能候选结构化载荷（与 education/experience 键值段同形态）──────────────

/** 技能候选 payload → 结构化（`技能=…；级别=…；场景=…`；缺技能 → 无结构化，原文仍在） */
export function parseSkillPayload(payload: string | undefined): { skill: string; level?: string; context?: string } | undefined {
  if (!payload?.trim()) return undefined
  const fields: Record<string, string> = {}
  for (const seg of payload.split(/[；;]/)) {
    const m = seg.trim().match(/^([^=：]+?)[=：](.+)$/)
    if (m && m[2]!.trim()) fields[m[1]!.trim()] = m[2]!.trim()
  }
  const skill = fields['技能'] ?? fields['skill']
  if (!skill) return undefined
  return { skill, level: fields['级别'] ?? fields['level'], context: fields['场景'] ?? fields['context'] }
}

/** 约束候选 payload → 结构化（`意向岗位=…；优先级=…；薪资=…；城市=…；现居=…`；
 *  可选载荷，无则原文列表兜底。优先级仅 high/medium/low 落入结构化，其余未识别 → undefined（投影用中性档 medium，不发明语义） */
export function parseConstraintPayload(payload: string | undefined): { jobRole?: string; priority?: 'high' | 'medium' | 'low'; salary?: string; city?: string; location?: string } {
  if (!payload?.trim()) return {}
  const fields: Record<string, string> = {}
  for (const seg of payload.split(/[；;]/)) {
    const m = seg.trim().match(/^([^=：]+?)[=：](.+)$/)
    if (m && m[2]!.trim()) fields[m[1]!.trim()] = m[2]!.trim()
  }
  const p = fields['优先级'] ?? fields['priority']
  return {
    jobRole: fields['意向岗位'] ?? fields['目标岗位'] ?? fields['target'],
    priority: p === 'high' || p === 'medium' || p === 'low' ? p : undefined,
    salary: fields['薪资'] ?? fields['salary'],
    city: fields['城市'] ?? fields['city'],
    location: fields['现居'] ?? fields['location'],
  }
}

// ─── 投影器（全量重投影；三件各自独立：有事实源才写）──────────────────────

/** 学历归一（事实层 degree 已是枚举；投影原样，不新造映射） */
function cell(v: string | undefined): string {
  return v === undefined || v === '' ? '-' : String(v).replace(/\|/g, '\\|')
}

/** identity.md：facts/education（最新学历标量）+ facts/experience（工作经历表） */
function projectIdentity(ws: Workspace, personId: string): string | null {
  const edu = parseEducationFacts(ws.exists(`persons/${personId}/facts/education.md`) ? ws.read(`persons/${personId}/facts/education.md`) : '')
  const exp = parseExperienceFacts(ws.exists(`persons/${personId}/facts/experience.md`) ? ws.read(`persons/${personId}/facts/experience.md`) : '')
  if (edu.length === 0 && exp.length === 0) return null

  // 最新学历 = end_year 最大（确定性聚合；缺 end_year 视为较旧）
  const latest = edu.reduce<(typeof edu)[number] | null>((acc, e) => {
    if (!acc) return e
    return (e.graduationYear ?? 0) >= (acc.graduationYear ?? 0) ? e : acc
  }, null)
  const rows: string[] = [
    '# 身份档案（Engine 投影）',
    '',
    '## 分析摘要',
    '',
    '| 字段 | 值 |',
    '|------|-----|',
  ]
  if (latest) {
    if (latest.degree) rows.push(`| education | ${cell(latest.degree)} |`)
    if (latest.graduationYear) rows.push(`| graduation_year | ${cell(String(latest.graduationYear))} |`)
  }
  if (exp.length > 0) {
    rows.push(
      '',
      '## 工作经历',
      '',
      '| company | role | start | end |',
      '|---------|------|-------|-----|',
      ...exp.map((e) => `| ${cell(e.company)} | ${cell(e.role)} | ${cell(e.start)} | ${cell(e.end)} |`),
    )
  }
  rows.push('')
  return rows.join('\n')
}

/** preference_constraints.md：规范键（来自结构化 payload）+ 原文列表（不拆解） */
function projectPreference(ws: Workspace, personId: string): string | null {
  const confirmed = listCandidates(ws, personId).filter((c) => c.status === 'confirmed' && (c.category === 'constraint' || c.category === 'interest'))
  if (confirmed.length === 0) return null
  const salaryParts: string[] = []
  const cityParts: string[] = []
  const locationParts: string[] = []
  const rawLines: string[] = []
  for (const c of confirmed) {
    const p = parseConstraintPayload(c.payload)
    if (p.salary) salaryParts.push(p.salary)
    if (p.city) cityParts.push(p.city)
    if (p.location) locationParts.push(p.location)
    rawLines.push(`- ${c.content.replace(/\|/g, '\\|')}（${c.category === 'constraint' ? '约束' : '兴趣'}）`)
  }
  const rows: string[] = ['# 偏好约束（Engine 投影）', '', '## 分析摘要', '', '| 字段 | 值 |', '|------|-----|']
  if (salaryParts.length > 0) rows.push(`| salary_range | ${cell(salaryParts.join('；'))} |`)
  if (cityParts.length > 0) rows.push(`| city | ${cell(cityParts.join('；'))} |`)
  if (locationParts.length > 0) rows.push(`| location | ${cell(locationParts.join('；'))} |`)
  rows.push('', '## 偏好约束', '', ...rawLines, '')
  return rows.join('\n')
}

/** career_profile.md：confirmed 约束/兴趣候选（载荷 `意向岗位=…`，可带 `优先级=high/medium/low`）
 *  → User Career Intent 表（source=user 行才是 Person.targetRoles 消费行；priority 未采集 →
 *  medium 中性档，注释说明不发明语义）。契约：references/career-profile-contract.md——
 *  只承载用户意向（推荐/决策结论禁止写入，权威源在 decisions/）。无载荷 → null（不生成文件，
 *  "意向岗位未确认" = 缺件语义，不假装）。 */
function projectCareerProfile(ws: Workspace, personId: string): string | null {
  const confirmed = listCandidates(ws, personId).filter((c) => c.status === 'confirmed' && (c.category === 'constraint' || c.category === 'interest'))
  const seen = new Set<string>()
  const roles: { target: string; priority: string }[] = []
  for (const c of confirmed) {
    const p = parseConstraintPayload(c.payload)
    if (p.jobRole && !seen.has(p.jobRole)) {
      seen.add(p.jobRole)
      roles.push({ target: p.jobRole, priority: p.priority ?? 'medium' })
    }
  }
  if (roles.length === 0) return null
  const rows: string[] = [
    '# 职业目标（Engine 投影）',
    '',
    '> 用户明确目标岗位（User Career Intent，source=user）。priority 未采集时恒为 medium——高/低语义需用户显式确认，引擎不猜。',
    '',
    '## User Career Intent',
    '',
    '| target_role | priority | source |',
    '|-------------|----------|--------|',
    ...roles.map((r) => `| ${cell(r.target)} | ${r.priority} | user |`),
    '',
  ]
  return rows.join('\n')
}

/** 技能语义级别 → skill_inventory level 词表（映射非打分；未识别 → applied） */
const SKILL_LEVEL_ALIAS: Record<string, string> = {
  熟练: 'applied-professional',
  胜任: 'applied-intermediate',
  掌握: 'applied',
  入门: 'applied-basic',
}

/** skill_inventory.md：confirmed 技能候选（结构化 payload）投影 */
function projectSkillInventory(ws: Workspace, personId: string): string | null {
  const confirmed = listCandidates(ws, personId).filter((c) => c.status === 'confirmed' && c.category === 'skill')
  const skills = confirmed
    .map((c) => ({ payload: parseSkillPayload(c.payload), content: c.content }))
    .filter((s) => s.payload !== undefined)
  if (skills.length === 0) return null
  const rows: string[] = [
    '---',
    `id: ${personId}`,
    'status: v1',
    '---',
    '',
    '# 技能清单（Engine 投影）',
    '',
    '## 分析摘要',
    '',
    '| 字段 | 值 |',
    '|------|-----|',
    `| skill_count | ${skills.length} |`,
    '',
    '## A. 技能清单',
    '',
    '| skill_id | 技能 | level | usage_context |',
    '|----------|------|-------|---------------|',
  ]
  skills.forEach((s, i) => {
    const p = s.payload!
    const level = SKILL_LEVEL_ALIAS[p.level ?? ''] ?? (p.level ?? 'applied')
    rows.push(`| skill_${String(i + 1).padStart(3, '0')} | ${cell(p.skill)} | ${level} | ${cell(p.context ?? '-')} |`)
  })
  rows.push('')
  return rows.join('\n')
}

/**
 * 全量重投影三件快照（幂等）：有事实源 → 写；无 → 不生成文件（缺件语义交给门禁判定）。
 * 返回本次写入的文件名清单（空数组 = 无事实源，零写入）。
 */
export function projectPersonSnapshots(ws: Workspace, personId: string): string[] {
  const written: string[] = []
  const identity = projectIdentity(ws, personId)
  if (identity) {
    ws.write(`persons/${personId}/snapshot/current/identity.md`, identity)
    written.push('identity.md')
  }
  const preference = projectPreference(ws, personId)
  if (preference) {
    ws.write(`persons/${personId}/snapshot/current/preference_constraints.md`, preference)
    written.push('preference_constraints.md')
  }
  const skill = projectSkillInventory(ws, personId)
  if (skill) {
    ws.write(`persons/${personId}/snapshot/current/skill_inventory.md`, skill)
    written.push('skill_inventory.md')
  }
  const career = projectCareerProfile(ws, personId)
  if (career) {
    ws.write(`persons/${personId}/snapshot/current/career_profile.md`, career)
    written.push('career_profile.md')
  }
  return written
}
