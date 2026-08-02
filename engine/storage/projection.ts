/**
 * SQLite Projection（第 3 步）：markdown 真相源的查询投影，一切查询走投影。
 * 5 张表（方案文档冻结，列级 schema 本步定稿）：
 *   persons_projection / decisions_projection / applications_projection /
 *   sessions_projection / timeline_projection（人生决策时间线视图）
 * - syncFromDecisions：全量重建 decisions_projection + timeline_projection（单事务）
 *   + persons_projection upsert（profiles/ 扫描，id 稳定保留）
 * - listDecisions：全部返回（含 validation 标记；invalid 实体由调用方决定过滤）
 * - listCompanies/listPersons：companies|profiles 目录最小扫描（H1 + 首段 / H1 + 目标方向表；
 *   companies IR 解析器未建，先最小实现）
 * - graph：由最近一次投影的决策快照 + 目录扫描派生信息池图谱（graph-builder）
 * WAL 模式（better-sqlite3 文档标准做法）。
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  DecisionRecord,
  Person,
  PoolEdge,
  PoolNode,
  RiskLevel,
  Validation,
  ValidationIssue,
} from '../ir/schema.ts'
import type { Workspace } from './workspace.ts'
import type { Logger } from '../logger.ts'
import { scanDecisions, type ParsedDecision } from './report-watcher.ts'
import { buildGraph } from './graph-builder.ts'
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
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions_projection (
  id TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  title TEXT NOT NULL,
  skill TEXT NOT NULL,
  direction TEXT,
  direction_match INTEGER,
  direction_confidence TEXT,
  city TEXT,
  city_score INTEGER,
  salary_feasible INTEGER,
  risk_level TEXT NOT NULL,
  key_risk TEXT NOT NULL,
  status TEXT NOT NULL,
  profile TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT '',
  protocol_version TEXT NOT NULL,
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

export interface CompanyView {
  id: string
  name: string
  summary: string
}

export type DecisionView = DecisionRecord & { validation?: Validation }

export interface ProjectionStore {
  init(): { protocol: string; version: string; workspace: string; serverTime: string }
  syncFromDecisions(parsed: ParsedDecision[]): void
  listDecisions(): DecisionView[]
  rescan(): { count: number }
  listCompanies(): CompanyView[]
  listPersons(): Person[]
  graph(): { nodes: PoolNode[]; edges: PoolEdge[] }
}

// ─── md 最小扫描（companies IR 解析器未建，H1 + 首段）─────────────────────

function extractH1(md: string, fallback: string): string {
  const h1 = md.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : fallback
}

/** 首段：标题/表格/引用/分隔线之外的首个内容行（bullet 行保留并去 `- ` 前缀） */
function firstContentLine(md: string, max = 120): string {
  for (const line of md.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('|') || t.startsWith('>') || t.startsWith('---')) continue
    return t.replace(/^-\s*/, '').slice(0, max)
  }
  return ''
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

export function createProjection(opts: { dbPath: string; workspace: Workspace; logger: Logger }): ProjectionStore {
  const { dbPath, workspace, logger } = opts
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)

  let lastParsed: ParsedDecision[] = []

  // ─── 目录扫描（真相源 → 投影）──────────────────────────────────────────

  function scanCompanies(): CompanyView[] {
    return workspace.listMarkdown('companies').sort().map((f) => {
      const md = workspace.read(`companies/${f}`)
      return { id: f.replace(/\.md$/, ''), name: extractH1(md, f.replace(/\.md$/, '')), summary: firstContentLine(md) }
    })
  }

  function scanProfiles(): { name: string; profilePath: string; targetRoles: string[] }[] {
    return workspace.listMarkdown('profiles').sort().map((f) => ({
      name: extractH1(workspace.read(`profiles/${f}`), f.replace(/\.md$/, '')),
      profilePath: `profiles/${f}`,
      targetRoles: extractTargetRoles(workspace.read(`profiles/${f}`)),
    }))
  }

  // ─── 全量重建（单事务）───────────────────────────────────────────────

  const rebuild = db.transaction((parsed: ParsedDecision[]): void => {
    db.prepare('DELETE FROM decisions_projection').run()
    db.prepare('DELETE FROM timeline_projection').run()

    const insDecision = db.prepare(`
      INSERT INTO decisions_projection (
        id, source_file, title, skill, direction, direction_match, direction_confidence,
        city, city_score, salary_feasible, risk_level, key_risk, status, profile,
        summary, created_at, protocol_version, validation_status, validation_issues
      ) VALUES (
        @id, @sourceFile, @title, @skill, @direction, @directionMatch, @directionConfidence,
        @city, @cityScore, @salaryFeasible, @riskLevel, @keyRisk, @status, @profile,
        @summary, @createdAt, @protocolVersion, @validationStatus, @validationIssues
      )
    `)
    const insTimeline = db.prepare(`
      INSERT INTO timeline_projection (id, date, type, title, summary, direction, city, profile, sort_key)
      VALUES (@id, @date, 'decision', @title, @summary, @direction, @city, @profile, @sortKey)
    `)
    const upsertPerson = db.prepare(`
      INSERT INTO persons_projection (name, color, emoji, archived, profile_path, target_roles, updated_at)
      VALUES (@name, @color, @emoji, 0, @profilePath, @targetRoles, @now)
      ON CONFLICT(name) DO UPDATE SET profile_path = @profilePath, target_roles = @targetRoles, updated_at = @now
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
        summary: r.summary ?? '', createdAt: r.createdAt ?? '',
        protocolVersion: r.protocolVersion ?? '',
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
    for (const p of scanProfiles()) {
      upsertPerson.run({ name: p.name, color: '#4f6ef2', emoji: '👤', profilePath: p.profilePath, targetRoles: JSON.stringify(p.targetRoles), now })
    }
  })

  // ─── 行 → IR ────────────────────────────────────────────────────────

  interface DecisionRow {
    id: string; title: string; skill: string; direction: string | null
    direction_match: number | null; direction_confidence: string | null
    city: string | null; city_score: number | null; salary_feasible: number | null
    risk_level: string | null; key_risk: string | null; status: string | null
    profile: string | null; summary: string; created_at: string; protocol_version: string
    validation_status: string | null; validation_issues: string | null
  }

  function rowToDecision(row: DecisionRow): DecisionView {
    const record: DecisionRecord = {
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
    if (row.validation_status !== null) {
      const validation: Validation = { status: row.validation_status as Validation['status'], issues: [] }
      if (row.validation_issues) {
        try {
          validation.issues = JSON.parse(row.validation_issues) as ValidationIssue[]
        } catch { /* 投影自产 JSON，解析失败视为空 */ }
      }
      record.validation = validation
    }
    return record
  }

  interface PersonRow {
    id: number; name: string; color: string; emoji: string
    match_score: number | null; risk_level: string | null
    archived: number; profile_path: string; target_roles: string | null
  }

  // ─── 服务 ───────────────────────────────────────────────────────────

  function syncFromDecisions(parsed: ParsedDecision[]): void {
    lastParsed = parsed
    rebuild(parsed)
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
      const rows = db.prepare('SELECT * FROM persons_projection ORDER BY id').all() as unknown as PersonRow[]
      return rows.map((row): Person => {
        const person: Person = {
          id: row.id, name: row.name, color: row.color, emoji: row.emoji,
          archived: row.archived === 1, profilePath: row.profile_path, targetRoles: [],
        }
        if (row.match_score !== null) person.matchScore = row.match_score
        if (row.risk_level !== null) person.riskLevel = row.risk_level as RiskLevel
        if (row.target_roles) {
          try { person.targetRoles = JSON.parse(row.target_roles) as string[] } catch { /* 忽略 */ }
        }
        return person
      })
    },
    graph() {
      return buildGraph({
        decisions: lastParsed,
        companies: scanCompanies().map((c) => ({ id: c.id, name: c.name })),
        profileNames: scanProfiles().map((p) => p.name),
      })
    },
  }
}
