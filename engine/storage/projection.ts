/**
 * SQLite Projection（第 3 步）：markdown 真相源的查询投影，一切查询走投影。
 * 5 张表（方案文档冻结，列级 schema 本步定稿）：
 *   persons_projection / decisions_projection / applications_projection /
 *   sessions_projection / timeline_projection（人生决策时间线视图）
 * - syncFromDecisions：全量重建 decisions_projection + timeline_projection（单事务）
 *   + persons_projection upsert（profiles/ 扫描，id 稳定保留）
 * - listDecisions：全部返回（含 validation 标记；invalid 实体由调用方决定过滤）
 * - listCompanies/listPersons：companies|profiles 目录扫描（公司走 parseCompanyMarkdown 完整 IR 解析 + validation；
 *   profiles 为 H1 + 目标方向表最小扫描）
 * - graph：由最近一次投影的决策快照 + 目录扫描派生信息池图谱（graph-builder）
 * WAL 模式（better-sqlite3 文档标准做法）。
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  CompanyRecord,
  DecisionRecord,
  Person,
  PersonSkill,
  PoolEdge,
  PoolNode,
  RiskLevel,
  Validation,
  ValidationIssue,
} from '../ir/schema.ts'
import { finalize, type FieldCheck, type Validated } from '../ir/validator.ts'
import type { Workspace } from './workspace.ts'
import type { Logger } from '../logger.ts'
import { parseSummaryTable } from '../ir/summary-table.ts'
import { parsePercent, parseRisk, scanDecisions, type ParsedDecision } from './report-watcher.ts'
import { buildGraph } from './graph-builder.ts'
import { scanKnowledge, extractPersonSkills } from './knowledge-watcher.ts'
import { scanPersons } from './person-watcher.ts'
import { ProtocolVersion } from '../ir/schema.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS persons_projection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#4f6ef2',
  emoji TEXT NOT NULL DEFAULT '👤',
  match_score INTEGER,
  risk_level TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  profile_path TEXT NOT NULL,
  target_roles TEXT,
  skills TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions_projection (
  id TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  title TEXT NOT NULL,
  skill TEXT,
  direction TEXT,
  direction_match INTEGER,
  direction_confidence TEXT,
  city TEXT,
  city_score INTEGER,
  salary_feasible INTEGER,
  risk_level TEXT,
  key_risk TEXT,
  status TEXT,
  profile TEXT,
  person_id TEXT,
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT '',
  protocol_version TEXT,
  payload TEXT,
  validation_status TEXT,
  validation_issues TEXT
);
CREATE TABLE IF NOT EXISTS applications_projection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  company TEXT NOT NULL,
  position TEXT NOT NULL,
  source_decision TEXT,
  status TEXT NOT NULL DEFAULT '已评估',
  applied_at TEXT,
  followup_due TEXT,
  urgency TEXT NOT NULL DEFAULT 'waiting',
  notes TEXT
);
CREATE TABLE IF NOT EXISTS sessions_projection (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  person_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS timeline_projection (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'decision',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  direction TEXT,
  city TEXT,
  profile TEXT,
  sort_key TEXT NOT NULL DEFAULT ''
);
`

/** 公司档案视图：完整 CompanyRecord + validation 标记（invalid 由调用方决定过滤） */
export type CompanyView = CompanyRecord & { validation?: Validation }

export type DecisionView = DecisionRecord & { validation?: Validation }

export interface ProjectionStore {
  init(): { protocol: string; version: string; workspace: string; serverTime: string }
  syncFromDecisions(parsed: ParsedDecision[]): ParsedDecision[]
  listDecisions(): DecisionView[]
  rescan(): { count: number }
  listCompanies(): CompanyView[]
  listPersons(): Person[]
  graph(): { nodes: PoolNode[]; edges: PoolEdge[] }
  /** 关闭 SQLite 连接（释放文件锁；引擎随进程退出，测试/嵌入场景显式调用） */
  close(): void
}

// ─── 公司 IR 解析（companies/{name}.md → CompanyRecord；摘要表协议同决策文件）──

/** 必填字段（parkId 可选）：缺失 → invalid（error） */
const COMPANY_REQUIRED: readonly (keyof CompanyRecord)[] = ['city', 'industry', 'matchScore', 'riskLevel', 'source', 'tags', 'contacted']

interface CompanyFieldSpec {
  field: keyof CompanyRecord
  parse: (raw: string) => unknown
  legal: string
}

/** 摘要表字段 → IR 字段（snake_case → camelCase；% / X/10 / 风险档共用决策解析器） */
const COMPANY_FIELD_MAP: Record<string, CompanyFieldSpec> = {
  city: { field: 'city', parse: (raw) => raw, legal: '非空字符串' },
  industry: { field: 'industry', parse: (raw) => raw, legal: '非空字符串' },
  match_score: { field: 'matchScore', parse: (raw) => parsePercent(raw), legal: '百分比（如 85%）或 X/10（如 8.2/10）' },
  risk_level: { field: 'riskLevel', parse: (raw) => parseRisk(raw), legal: '低/中/中高/高（或 low/medium/high）' },
  source: { field: 'source', parse: (raw) => raw, legal: '非空字符串' },
  tags: { field: 'tags', parse: (raw) => raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean), legal: '逗号分隔的标签列表' },
  contacted: { field: 'contacted', parse: (raw) => parseContacted(raw), legal: '是/否' },
  park_id: { field: 'parkId', parse: (raw) => parseParkId(raw), legal: '数字' },
  headcount: { field: 'headcount', parse: (raw) => raw, legal: '人数规模（如 1.5万人 / 1000-5000）' },
}

function parseContacted(v: string): boolean | undefined {
  if (v === '是' || v === 'true') return true
  if (v === '否' || v === 'false') return false
  return undefined
}

function parseParkId(v: string): number | undefined {
  return /^\d+$/.test(v) ? Number(v) : undefined
}

/**
 * 单个公司档案 md → CompanyRecord：
 * - 摘要表缺失 → invalid；必填字段缺失 → invalid（error）
 * - 字段存在但值域非法 → degraded（warn）保留原值展示（validator 降级惯例）
 */
/** 删除公司档案文件：id = 文件名（无 .md）；companies/ 无 watcher，删除后由 RPC 层广播 */
export function deleteCompanyFile(workspace: Workspace, id: string): void {
  if (!/^[^\\/]+$/.test(id)) throw new Error(`非法公司 id：${JSON.stringify(id)}`)
  const rel = `companies/${id}.md`
  if (!workspace.exists(rel)) throw new Error(`公司不存在：${id}`)
  workspace.delete(rel)
}

/** 读取公司档案全文（尽调详情正文渲染：UI 端截取 `## 尽调详情` 之后渲染） */
export function readCompanyFile(workspace: Workspace, id: string): { id: string; markdown: string } {
  if (!/^[^\\/]+$/.test(id)) throw new Error(`非法公司 id：${JSON.stringify(id)}`)
  const rel = `companies/${id}.md`
  if (!workspace.exists(rel)) throw new Error(`公司不存在：${id}`)
  return { id, markdown: workspace.read(rel) }
}

export function parseCompanyMarkdown(md: string, sourceFile: string): Validated<CompanyRecord> {
  const id = sourceFile.replace(/\.md$/, '')
  const fields = parseSummaryTable(md)
  if (!fields) {
    // id/name 无条件派生：invalid 档案仍需在列表中按 id 可识别（图谱已跳过）
    return finalize({ id, name: extractH1(md, id) } as CompanyRecord, [
      { path: sourceFile, reason: '未找到 `## 分析摘要` 表格', severity: 'error' },
    ])
  }

  const record: Record<string, unknown> = { id, name: extractH1(md, id) }
  const checks: FieldCheck[] = []
  for (const [tableField, spec] of Object.entries(COMPANY_FIELD_MAP)) {
    const raw = fields[tableField]
    if (raw === undefined || raw === '-' || raw === '') continue // 缺失填 - 属常态
    const parsed = spec.parse(raw)
    if (parsed !== undefined) {
      record[spec.field] = parsed
    } else {
      record[spec.field] = raw // 保留原值展示，标记可疑
      checks.push({ path: spec.field, reason: `非法值 ${JSON.stringify(raw)}（合法值：${spec.legal}）`, severity: 'warn' })
    }
  }
  for (const field of COMPANY_REQUIRED) {
    if (record[field] === undefined) checks.push({ path: field, reason: '缺失（摘要表未填或为 -）', severity: 'error' })
  }
  return finalize(record as unknown as CompanyRecord, checks)
}

// ─── md 最小扫描（profiles 目标方向表；公司走 parseCompanyMarkdown）─────────

function extractH1(md: string, fallback: string): string {
  const h1 = md.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : fallback
}

/** 目标岗位/目标方向段：表格首列去重 */
function extractTargetRoles(md: string): string[] {
  const m = md.match(/^##\s*(目标方向|目标岗位)\s*\n((?:\|[^\n]*\|\n)+)/m)
  if (!m) return []
  const roles: string[] = []
  for (const line of m[2].split('\n')) {
    const t = line.trim()
    if (!t.startsWith('|') || /^\|[\s\-:|]+\|$/.test(t)) continue
    const first = t.slice(1).split('|')[0]?.trim()
    if (first && first !== '方向' && first !== '目标岗位') roles.push(first)
  }
  return roles
}

/** 画像最小扫描产物（profiles/{name}.md：H1 + 目标方向表 + `## 技能` 声明段落） */
export interface ProfileScan {
  name: string
  profilePath: string
  targetRoles: string[]
  skills: PersonSkill[]
}

/** profiles/ 全量扫描（V2 起含技能声明；knowledge/gap 与投影共用） */
export function scanProfiles(workspace: Workspace): ProfileScan[] {
  return workspace.listMarkdown('profiles').sort().map((f) => {
    const md = workspace.read(`profiles/${f}`)
    return {
      name: extractH1(md, f.replace(/\.md$/, '')),
      profilePath: `profiles/${f}`,
      targetRoles: extractTargetRoles(md),
      skills: extractPersonSkills(md),
    }
  })
}

/** 投影 schema 版本：升级时 +1；旧版本 drop 重建（投影是 md 真相源的派生，重建零损失） */
const SCHEMA_VERSION = 5

export function createProjection(opts: { dbPath: string; workspace: Workspace; logger: Logger }): ProjectionStore {
  const { dbPath, workspace } = opts
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  // schema 演进：v1 决策列 NOT NULL 与 invalid 实体字段缺失矛盾（联调 smoke 发现），v2 放宽
  const version = db.pragma('user_version', { simple: true }) as number
  if (version < SCHEMA_VERSION) {
    db.exec('DROP TABLE IF EXISTS timeline_projection; DROP TABLE IF EXISTS sessions_projection; DROP TABLE IF EXISTS applications_projection; DROP TABLE IF EXISTS decisions_projection; DROP TABLE IF EXISTS persons_projection;')
    db.exec(SCHEMA)
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  } else {
    db.exec(SCHEMA)
  }

  let lastParsed: ParsedDecision[] = []

  // ─── 目录扫描（真相源 → 投影）──────────────────────────────────────────

  function scanCompanies(): CompanyView[] {
    return workspace.listMarkdown('companies').sort().map((f) => {
      const parsed = parseCompanyMarkdown(workspace.read(`companies/${f}`), f)
      const view: CompanyView = { ...parsed.value }
      if (parsed.validation) view.validation = parsed.validation
      return view
    })
  }

  // ─── 全量重建（单事务）───────────────────────────────────────────────

  const rebuild = db.transaction((parsed: ParsedDecision[]): void => {
    db.prepare('DELETE FROM decisions_projection').run()
    db.prepare('DELETE FROM timeline_projection').run()

    const insDecision = db.prepare(`
      INSERT INTO decisions_projection (
        id, source_file, title, skill, direction, direction_match, direction_confidence,
        city, city_score, salary_feasible, risk_level, key_risk, status, profile, person_id,
        summary, created_at, protocol_version, payload, validation_status, validation_issues
      ) VALUES (
        @id, @sourceFile, @title, @skill, @direction, @directionMatch, @directionConfidence,
        @city, @cityScore, @salaryFeasible, @riskLevel, @keyRisk, @status, @profile, @personId,
        @summary, @createdAt, @protocolVersion, @payload, @validationStatus, @validationIssues
      )
    `)
    const insTimeline = db.prepare(`
      INSERT INTO timeline_projection (id, date, type, title, summary, direction, city, profile, sort_key)
      VALUES (@id, @date, 'decision', @title, @summary, @direction, @city, @profile, @sortKey)
    `)
    const upsertPerson = db.prepare(`
      INSERT INTO persons_projection (name, color, emoji, archived, profile_path, target_roles, skills, updated_at)
      VALUES (@name, @color, @emoji, 0, @profilePath, @targetRoles, @skills, @now)
      ON CONFLICT(name) DO UPDATE SET profile_path = @profilePath, target_roles = @targetRoles, skills = @skills, updated_at = @now
    `)

    for (const p of parsed) {
      const r = p.record
      const validation = p.validation
      const params = {
        id: r.id, sourceFile: p.sourceFile, title: r.title, skill: r.skill,
        direction: r.direction ?? null, directionMatch: r.directionMatch ?? null,
        directionConfidence: r.directionConfidence ?? null,
        city: r.city ?? null, cityScore: r.cityScore ?? null,
        salaryFeasible: r.salaryFeasible === undefined ? null : r.salaryFeasible ? 1 : 0,
        riskLevel: r.riskLevel ?? null, keyRisk: r.keyRisk ?? null, status: r.status ?? null,
        profile: r.profile ?? null,
        personId: r.personId ?? null,
        summary: r.summary ?? '', createdAt: r.createdAt ?? '',
        protocolVersion: r.protocolVersion ?? '',
        payload: r.payload ? JSON.stringify(r.payload) : null,
        validationStatus: validation?.status ?? null,
        validationIssues: validation ? JSON.stringify(validation.issues) : null,
      }
      insDecision.run(params)
      insTimeline.run({
        id: r.id, date: r.createdAt ?? '', title: r.title ?? '', summary: r.summary ?? '',
        direction: r.direction ?? null, city: r.city ?? null, profile: r.profile ?? null,
        sortKey: r.createdAt ?? '',
      })
    }

    const now = new Date().toISOString()
    for (const p of scanProfiles(workspace)) {
      upsertPerson.run({ name: p.name, color: '#4f6ef2', emoji: '👤', profilePath: p.profilePath, targetRoles: JSON.stringify(p.targetRoles), skills: JSON.stringify(p.skills), now })
    }
  })

  // ─── 行 → IR ────────────────────────────────────────────────────────

  interface DecisionRow {
    id: string; title: string; skill: string; direction: string | null
    direction_match: number | null; direction_confidence: string | null
    city: string | null; city_score: number | null; salary_feasible: number | null
    risk_level: string | null; key_risk: string | null; status: string | null
    profile: string | null; person_id: string | null; summary: string; created_at: string; protocol_version: string
    payload: string | null
    validation_status: string | null; validation_issues: string | null
  }

  function rowToDecision(row: DecisionRow): DecisionView {
    const record: Partial<DecisionRecord> & { validation?: Validation } = {
      id: row.id, title: row.title, skill: row.skill, riskLevel: row.risk_level as RiskLevel,
      keyRisk: row.key_risk ?? '', status: row.status ?? '', summary: row.summary,
      createdAt: row.created_at, protocolVersion: row.protocol_version,
    }
    if (row.direction !== null) record.direction = row.direction
    if (row.direction_match !== null) record.directionMatch = row.direction_match
    if (row.direction_confidence !== null) record.directionConfidence = row.direction_confidence as DecisionRecord['directionConfidence']
    if (row.city !== null) record.city = row.city
    if (row.city_score !== null) record.cityScore = row.city_score
    if (row.salary_feasible !== null) record.salaryFeasible = row.salary_feasible === 1
    if (row.profile !== null) record.profile = row.profile
    if (row.person_id !== null) record.personId = row.person_id
    if (row.payload !== null) {
      try {
        record.payload = JSON.parse(row.payload) as DecisionRecord['payload']
      } catch { /* 投影自产 JSON，解析失败视为无 payload */ }
    }
    if (row.validation_status !== null) {
      const validation: Validation = { status: row.validation_status as Validation['status'], issues: [] }
      if (row.validation_issues) {
        try {
          validation.issues = JSON.parse(row.validation_issues) as ValidationIssue[]
        } catch { /* 投影自产 JSON，解析失败视为空 */ }
      }
      record.validation = validation
    }
    return record as DecisionView
  }

  interface PersonRow {
    id: number; name: string; color: string; emoji: string
    match_score: number | null; risk_level: string | null
    archived: number; profile_path: string; target_roles: string | null
    skills: string | null
  }

  // ─── 服务 ───────────────────────────────────────────────────────────

  /**
   * ADR-014 身份校验：person_id 缺失或不属于已登记 Person → invalid（身份错误是数据污染，不降级）。
   * Agent 从任务上下文传递归属（frontmatter），引擎校验防编造/留空——错误在信息池「待人工处理」可见。
   */
  function assertDecisionIdentity(parsed: ParsedDecision[]): ParsedDecision[] {
    const validIds = new Set(scanPersons(workspace).map((p) => p.personId))
    const tag = (p: ParsedDecision, reason: string): ParsedDecision => {
      const issue: ValidationIssue = { path: p.sourceFile, reason, severity: 'error' }
      const base = p.validation
      return {
        ...p,
        validation: base
          ? { status: 'invalid', issues: [...base.issues, issue] }
          : { status: 'invalid', issues: [issue] },
      }
    }
    return parsed.map((p) => {
      const pid = p.record.personId
      if (!pid) return tag(p, 'person_id 缺失（ADR-014 身份字段：Agent 从任务上下文传递，不得留空）')
      if (!validIds.has(pid)) {
        const legal = [...validIds].join('/') || '无'
        return tag(p, `person_id=${pid} 不属于已登记 Person（合法：${legal}）`)
      }
      return p
    })
  }

  function syncFromDecisions(parsed: ParsedDecision[]): ParsedDecision[] {
    const checked = assertDecisionIdentity(parsed)
    lastParsed = parsed
    rebuild(checked)
    return checked
  }

  return {
    init() {
      return {
        protocol: 'career-os',
        version: ProtocolVersion,
        workspace: workspace.paths.root,
        serverTime: new Date().toISOString(),
      }
    },
    syncFromDecisions,
    listDecisions() {
      const rows = db
        .prepare('SELECT * FROM decisions_projection ORDER BY created_at DESC, id DESC')
        .all() as unknown as DecisionRow[]
      return rows.map(rowToDecision)
    },
    rescan() {
      const parsed = scanDecisions(workspace)
      syncFromDecisions(parsed)
      return { count: parsed.length }
    },
    listCompanies() {
      return scanCompanies()
    },
    listPersons() {
      // M6.5：persons/ 主体资产优先（person-watcher 扫描）；未建立 → 投影表降级（profiles/ 旧扫描）
      const snapshots = scanPersons(workspace)
      if (snapshots.length > 0) {
        return snapshots.map((s, i): Person => ({
          id: i + 1,
          personId: s.personId,
          name: s.name,
          color: '#4f6ef2',
          emoji: '👤',
          matchScore: 0,
          riskLevel: 'medium',
          archived: s.status === 'archived',
          profilePath: s.manifestPath,
          targetRoles: s.careerProfile?.targetRoles ?? [],
          ...(s.initState ? { initStatus: s.initState === 'in_progress' ? 'pending' : 'active' as const } : {}),
          ...(s.sourceMode ? { sourceMode: s.sourceMode } : {}),
        }))
      }
      const rows = db.prepare('SELECT * FROM persons_projection ORDER BY id').all() as unknown as PersonRow[]
      return rows.map((row): Person => {
        const person: Partial<Person> = {
          id: row.id, name: row.name, color: row.color, emoji: row.emoji,
          archived: row.archived === 1, profilePath: row.profile_path, targetRoles: [],
        }
        if (row.match_score !== null) person.matchScore = row.match_score
        if (row.risk_level !== null) person.riskLevel = row.risk_level as RiskLevel
        if (row.target_roles) {
          try { person.targetRoles = JSON.parse(row.target_roles) as string[] } catch { /* 忽略 */ }
        }
        if (row.skills) {
          try {
            const skills = JSON.parse(row.skills) as PersonSkill[]
            if (skills.length > 0) person.skills = skills
          } catch { /* 忽略 */ }
        }
        return person as Person
      })
    },
    graph() {
      const knowledge = scanKnowledge(workspace)
      // M6.5：person 节点来自 persons/ 主体资产；未建立 → profiles/ 旧扫描降级
      const personNames = scanPersons(workspace).map((p) => p.name)
      return buildGraph({
        decisions: lastParsed,
        companies: scanCompanies(),
        profileNames: personNames.length > 0 ? personNames : scanProfiles(workspace).map((p) => p.name),
        skills: knowledge.skills,
        roles: knowledge.roles,
      })
    },
    close() {
      db.close()
    },
  }
}
