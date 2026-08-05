/**
 * report-watcher：md → IR（第 2 步目录扫描，第 3 步加入文件监听）。
 * - scanDecisions：decisions/*.md 全量扫描 + 解析 + 校验
 * - watchDecisions：decisions/ 目录监听（add/change/unlink → 全量重扫，chokidar）
 * - parseDecisionMarkdown：单个 md → DecisionRecord（14 字段摘要表解析 + 版本分派校验）
 *
 * 摘要表协议（SKILL.md）：`## 分析摘要` 两列表格（字段|值），字段 snake_case；
 * 缺失值填 `-`（属常态）；risk_level 四档中文（低/中/中高/高）；city_score X/10。
 */
import type { Confidence, DecisionRecord, RiskLevel, Validation } from '../ir/schema.ts'
import { validateByProtocol, type Validated, finalize } from '../ir/validator.ts'
import type { Workspace } from './workspace.ts'
import { watch } from 'chokidar'
import { registerDecisionIdentity, splitFrontmatter } from './decision-registry.ts'

const SUMMARY_RE = /##\s*分析摘要\s*\n((?:\|[^\n]*\|\n)+)/
const ROW_RE = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|$/

/** 摘要表字段 → IR 字段（snake_case → camelCase；IR 无对应字段的不映射） */
const FIELD_MAP: Record<string, keyof DecisionRecord> = {
  skill: 'skill',
  direction: 'direction',
  direction_match: 'directionMatch',
  direction_confidence: 'directionConfidence',
  city: 'city',
  city_score: 'cityScore',
  salary_feasible: 'salaryFeasible',
  risk_level: 'riskLevel',
  key_risk: 'keyRisk',
  status: 'status',
  protocol_version: 'protocolVersion',
  profile: 'profile',
}

const RISK_MAP: Record<string, RiskLevel> = { 低: 'low', 中: 'medium', 中高: 'high', 高: 'high' }
const CONFIDENCE_MAP: Record<string, Confidence> = { 高: 'high', 中: 'medium', 低: 'low' }
const HIGHLOW: readonly string[] = ['high', 'medium', 'low']

/** 百分比解析：85% → 85、8.2/10 → 82（公司/决策摘要表共用） */
export function parsePercent(v: string): number | undefined {
  if (v === '-' || v === '') return undefined
  const pct = v.match(/^(\d+(?:\.\d+)?)%$/)
  if (pct) return Math.round(Number(pct[1]))
  const tenth = v.match(/^(\d+(?:\.\d+)?)\/10$/)
  if (tenth) return Math.round(Number(tenth[1]) * 10)
  return undefined
}

/** 风险档解析：中文四档（低/中/中高/高）→ low/medium/high/high；英文原值透传（公司/决策摘要表共用） */
export function parseRisk(v: string): RiskLevel | undefined {
  return RISK_MAP[v] ?? (HIGHLOW.includes(v) ? (v as RiskLevel) : undefined)
}

function parseConfidence(v: string): Confidence | undefined {
  return CONFIDENCE_MAP[v] ?? (HIGHLOW.includes(v) ? (v as Confidence) : undefined)
}

function parseBool(v: string): boolean | undefined {
  if (v === 'true') return true
  if (v === 'false') return false
  return undefined
}

function deriveTitle(md: string, file: string): string {
  const h1 = md.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : file.replace(/\.md$/, '')
}

/** createdAt 派生：旧协议文件名（2026-08-01-主题）→ 日期；系统登记文件名（decision_20260801_NNNNN）→ 日期 */
function deriveCreatedAt(file: string): string {
  const legacy = file.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
  if (legacy) return legacy
  const sys = file.match(/^decision_(\d{4})(\d{2})(\d{2})_/)
  return sys ? `${sys[1]}-${sys[2]}-${sys[3]}` : ''
}

/** 分析摘要表之后第一个非空文本段（非标题/表格/分隔线） */
function deriveSummary(md: string): string {
  const after = md.split(/##\s*分析摘要/, 2)[1] ?? ''
  for (const line of after.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('|') || t.startsWith('#') || t.startsWith('---')) continue
    return t.slice(0, 200)
  }
  return ''
}

/** 摘要表解析：`## 分析摘要` 两列表格 → { 字段: 值 }（决策/公司档案共用协议） */
export function parseSummaryTable(md: string): Record<string, string> | null {
  const m = md.match(SUMMARY_RE)
  if (!m) return null
  const fields: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    if (!line.trim().startsWith('|')) continue
    if (/^\|[\s\-|]+\|$/.test(line)) continue // 分隔行
    const r = line.match(ROW_RE)
    if (r) {
      const key = r[1].trim()
      if (key && key !== '字段') fields[key] = r[2].trim()
    }
  }
  return fields
}

/** 单个决策 md → IR（摘要表缺失 → invalid；版本分派校验）。
 *  引擎登记（M1.6）后文件头有 frontmatter（id/created_at 系统生成），解析优先取其值，fallback 文件名。 */
export function parseDecisionMarkdown(md: string, sourceFile: string): Validated<DecisionRecord> {
  const { meta, body } = splitFrontmatter(md)
  const fields = parseSummaryTable(body)
  if (!fields) {
    return finalize({} as DecisionRecord, [
      { path: sourceFile, reason: '未找到 `## 分析摘要` 表格', severity: 'error' },
    ])
  }

  const record: Record<string, unknown> = {
    id: meta.id ?? sourceFile.replace(/\.md$/, ''),
    title: deriveTitle(body, sourceFile),
    createdAt: meta.created_at ?? deriveCreatedAt(sourceFile),
    summary: deriveSummary(body) || deriveTitle(body, sourceFile),
  }
  for (const [tableField, irField] of Object.entries(FIELD_MAP)) {
    const raw = fields[tableField]
    if (raw === undefined || raw === '-' || raw === '') continue
    switch (irField) {
      case 'directionMatch':
      case 'cityScore': {
        const n = parsePercent(raw)
        if (n !== undefined) record[irField] = n
        break
      }
      case 'directionConfidence': {
        const c = parseConfidence(raw)
        if (c !== undefined) record[irField] = c
        break
      }
      case 'riskLevel': {
        const r = parseRisk(raw)
        if (r !== undefined) record[irField] = r
        break
      }
      case 'salaryFeasible': {
        const b = parseBool(raw)
        if (b !== undefined) record[irField] = b
        break
      }
      default:
        record[irField] = raw
    }
  }
  return validateByProtocol(record)
}

export interface ParsedDecision {
  sourceFile: string
  record: DecisionRecord
  validation?: Validation
}

/** decisions/ 全量扫描（一次性；监听第 3 步引入） */
export function scanDecisions(ws: Workspace): ParsedDecision[] {
  const files = ws.listMarkdown('decisions').sort()
  return files.map((f) => {
    const parsed = parseDecisionMarkdown(ws.read(`decisions/${f}`), f)
    return { sourceFile: f, record: parsed.value, validation: parsed.validation }
  })
}

/**
 * decisions/ 目录监听（第 3 步）：add/change/unlink 任一触发 → 全量重扫 → onChanged(parsed)。
 * add 事件先做身份登记（M1.6：新决策文件 → 系统 ID；登记后文件名变化再触发 unlink/add 重扫，幂等）。
 * 全量重扫是明确决策（个人工具文件量小，增量复杂度不值）；返回 { close } 供测试/退出。
 */
export function watchDecisions(ws: Workspace, onChanged: (parsed: ParsedDecision[]) => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.decisions, { ignoreInitial: true })
  const rescan = (): void => onChanged(scanDecisions(ws))
  watcher.on('add', (path: string) => {
    if (!path.endsWith('.md')) return
    registerDecisionIdentity(ws)
    rescan()
  })
  watcher.on('change', (path: string) => {
    if (path.endsWith('.md')) rescan()
  })
  watcher.on('unlink', (path: string) => {
    if (path.endsWith('.md')) rescan()
  })
  return { close: () => watcher.close() }
}
