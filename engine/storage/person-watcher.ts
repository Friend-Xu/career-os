/**
 * person-watcher：M6.5 Person Intelligence Layer（ADR-009）——persons/{person_id}/ 主体资产解析。
 * - parsePersonManifest：manifest.md（frontmatter: id/name/status/created_at + 摘要表）→ 根声明
 * - parseSnapshotTable：snapshot/*.md 的 `## 分析摘要` 表 → 字段映射（缺表 → 空对象）
 * - scanPersons：persons/ 子目录扫描 → PersonSnapshot[]（manifest 缺 id → 跳过；
 *   无 persons/ 目录 → 空数组，调用方降级 profiles 旧扫描）
 *
 * 真相源由对话式采集/用户维护，引擎只读解析不写。降级惯例同 evidence-watcher：
 * 摘要表缺失 → 字段缺省（空对象），不 invalid——Person 是导航资产，缺字段不阻塞。
 */
import { readdirSync } from 'node:fs'
import type { PersonSkill, PersonSnapshot } from '../ir/schema.ts'
import type { Workspace } from './workspace.ts'
import { splitFrontmatter } from './artifact-registry.ts'
import { parseSummaryTable } from './report-watcher.ts'

export interface PersonManifest {
  id: string
  name: string
  status: string
  createdAt?: string
}

const STATUSES = ['active', 'archived'] as const

/** manifest.md → 根声明（frontmatter id/name/status 必填；缺任一 → undefined） */
export function parsePersonManifest(md: string, sourceFile: string): PersonManifest | undefined {
  const { meta, body } = splitFrontmatter(md)
  const fields = parseSummaryTable(body)
  const id = meta.id?.trim() || fields?.id?.trim()
  const name = meta.name?.trim() || fields?.name?.trim()
  const status = meta.status?.trim() || fields?.status?.trim() || 'active'
  if (!id || !name) return undefined
  if (!(STATUSES as readonly string[]).includes(status)) return undefined
  return { id, name, status, createdAt: meta.created_at?.trim() }
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

/** snapshot/career_profile.md 的目标方向表 → targetRoles（`- {方向} {匹配度}%` 行；无表 → 空数组） */
function extractTargetRoles(md: string): string[] {
  const roles: string[] = []
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
    skills.push({ skillId: m[1]!.trim(), name: m[2]!.trim(), level })
  }
  const version = md.match(/^status:\s*(v[\w.-]+)/m)?.[1] ?? 'v1'
  return { skills, version }
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
    const manifest = parsePersonManifest(ws.read(manifestPath), manifestPath)
    if (!manifest) continue

    const identity = snapshotOf(ws, pid, 'identity.md')
    const careerRel = `persons/${pid}/snapshot/current/career_profile.md`
    const careerMd = ws.exists(careerRel) ? ws.read(careerRel) : undefined
    const career = careerMd ? parseSnapshotTable(careerMd) : undefined
    const preference = snapshotOf(ws, pid, 'preference_constraints.md')

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
      manifestPath,
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
