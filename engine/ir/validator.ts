/**
 * IR validator：合法化 + 降级。
 *
 * 规则：
 * - 必填字段缺失或类型错误 → invalid（error）——实体不参与统计/图谱连线
 * - 字段存在但值域非法（枚举外/数值越界）→ degraded（warn）——保留原值展示，标记可疑
 * - 完全合法 → 不带 validation
 * - 不支持的协议版本 → invalid（error）
 *
 * 必填集合对齐 skill 协议（SKILL.md 摘要字段表）：skill/risk_level/key_risk/status/
 * protocol_version 必填；direction/city/薪资/匹配度等语义字段可选（skill 按类型输出，
 * 缺失填 `-`，属常态 → degraded）。v2.1 额外要求 profile（语义 = 人名）。
 */
import type {
  Application,
  CompanyRecord,
  Confidence,
  DecisionRecord,
  EdgeStrength,
  Person,
  PoolEdge,
  PoolNode,
  ProfileSummary,
  RiskLevel,
  Session,
  Validation,
  ValidationStatus,
} from './schema.ts'
import { isSupportedVersion, protocolVersionOf } from './version.ts'

export interface Validated<T> {
  value: T
  validation?: Validation
}

export interface FieldCheck {
  path: string
  reason: string
  severity: 'warn' | 'error'
}

export function finalize<T>(value: T, checks: FieldCheck[]): Validated<T> {
  if (checks.length === 0) return { value }
  const status: ValidationStatus = checks.some((c) => c.severity === 'error') ? 'invalid' : 'degraded'
  return { value, validation: { status, issues: checks } }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high']
const CONFIDENCES: Confidence[] = ['high', 'medium', 'low']
const EDGE_STRENGTHS: EdgeStrength[] = ['high', 'medium', 'low']

function missing(field: string, value: unknown): FieldCheck {
  return { path: field, reason: `缺失或类型错误（值：${JSON.stringify(value)}）`, severity: 'error' }
}
function illegal(field: string, value: unknown, legal: string): FieldCheck {
  return { path: field, reason: `非法值 ${JSON.stringify(value)}（合法值：${legal}）`, severity: 'warn' }
}
function expectString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function checkString(checks: FieldCheck[], field: string, v: unknown): void {
  if (!expectString(v)) checks.push(missing(field, v))
}
function checkEnum<T extends string>(checks: FieldCheck[], field: string, v: unknown, legal: readonly T[]): void {
  if (v === undefined) return // 可选字段缺失合法（协议允许填 -）；必填字段由各实体 required 列表的 missing 检查覆盖
  if (typeof v !== 'string' || !(legal as readonly string[]).includes(v)) {
    checks.push(illegal(field, v, legal.join('/')))
  }
}
function checkPercent(checks: FieldCheck[], field: string, v: unknown): void {
  if (v === undefined) return // 可选字段缺失合法（协议允许填 -）
  if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 100) {
    checks.push(illegal(field, v, '0-100'))
  }
}

// ─── 各实体 ──────────────────────────────────────────────────────────────

/** 协议必填字段（SKILL.md 摘要字段表）+ 解析器自产字段 */
const DECISION_REQUIRED: Record<'v21' | 'v20', string[]> = {
  v21: ['id', 'title', 'skill', 'riskLevel', 'keyRisk', 'status', 'protocolVersion', 'profile', 'summary'],
  v20: ['id', 'title', 'skill', 'riskLevel', 'keyRisk', 'status', 'protocolVersion', 'summary'],
}

export function validateDecisionRecord(input: unknown, opts: { requireProfile?: boolean } = {}): Validated<DecisionRecord> {
  const value = isRecord(input) ? input : {}
  const checks: FieldCheck[] = []

  const version = protocolVersionOf(value)
  if (!isSupportedVersion(version)) {
    checks.push({ path: 'protocolVersion', reason: `不支持的协议版本 ${JSON.stringify(version)}（合法值：2.0/2.1/2.2/2.3）`, severity: 'error' })
  }
  const required = opts.requireProfile ? DECISION_REQUIRED.v21 : DECISION_REQUIRED.v20
  for (const field of required) {
    if (!expectString(value[field])) checks.push(missing(field, value[field]))
  }
  checkEnum(checks, 'directionConfidence', value.directionConfidence, CONFIDENCES)
  checkEnum(checks, 'riskLevel', value.riskLevel, RISK_LEVELS)
  checkPercent(checks, 'directionMatch', value.directionMatch)
  checkPercent(checks, 'cityScore', value.cityScore)
  if (typeof value.salaryFeasible !== 'boolean') {
    checks.push(illegal('salaryFeasible', value.salaryFeasible, 'true/false'))
  }
  return finalize(value as unknown as DecisionRecord, checks)
}

export function validatePerson(input: unknown): Validated<Person> {
  const value = isRecord(input) ? input : {}
  const checks: FieldCheck[] = []
  for (const field of ['name', 'color', 'emoji', 'profilePath']) {
    checkString(checks, field, value[field])
  }
  if (typeof value.id !== 'number') checks.push(missing('id', value.id))
  if (typeof value.matchScore !== 'number') checks.push(illegal('matchScore', value.matchScore, 'number'))
  checkPercent(checks, 'matchScore', value.matchScore)
  checkEnum(checks, 'riskLevel', value.riskLevel, RISK_LEVELS)
  if (typeof value.archived !== 'boolean') checks.push(illegal('archived', value.archived, 'true/false'))
  if (value.targetRoles !== undefined && (!Array.isArray(value.targetRoles) || value.targetRoles.some((t) => typeof t !== 'string'))) {
    checks.push(illegal('targetRoles', value.targetRoles, 'string[]'))
  }
  return finalize(value as unknown as Person, checks)
}

export function validateCompanyRecord(input: unknown): Validated<CompanyRecord> {
  const value = isRecord(input) ? input : {}
  const checks: FieldCheck[] = []
  for (const field of ['id', 'name', 'city', 'industry', 'source']) {
    checkString(checks, field, value[field])
  }
  checkPercent(checks, 'matchScore', value.matchScore)
  checkEnum(checks, 'riskLevel', value.riskLevel, RISK_LEVELS)
  if (typeof value.contacted !== 'boolean') checks.push(illegal('contacted', value.contacted, 'true/false'))
  if (!Array.isArray(value.tags) || value.tags.some((t) => typeof t !== 'string')) {
    checks.push(illegal('tags', value.tags, 'string[]'))
  }
  return finalize(value as unknown as CompanyRecord, checks)
}

export function validateProfileSummary(input: unknown): Validated<ProfileSummary> {
  const value = isRecord(input) ? input : {}
  const checks: FieldCheck[] = []
  for (const field of ['name', 'profilePath']) {
    checkString(checks, field, value[field])
  }
  if (value.matchScore !== undefined) checkPercent(checks, 'matchScore', value.matchScore)
  if (value.riskLevel !== undefined) checkEnum(checks, 'riskLevel', value.riskLevel, RISK_LEVELS)
  for (const field of ['targetRoles', 'constraints'] as const) {
    if (!Array.isArray(value[field]) || value[field].some((t) => typeof t !== 'string')) {
      checks.push(illegal(field, value[field], 'string[]'))
    }
  }
  return finalize(value as unknown as ProfileSummary, checks)
}

const POOL_NODE_TYPES = ['person', 'decision', 'direction', 'city', 'company'] as const

export function validatePoolNode(input: unknown): Validated<PoolNode> {
  const value = isRecord(input) ? input : {}
  const checks: FieldCheck[] = []
  for (const field of ['id', 'label']) {
    checkString(checks, field, value[field])
  }
  if (typeof value.type !== 'string' || !POOL_NODE_TYPES.includes(value.type as never)) {
    checks.push(illegal('type', value.type, POOL_NODE_TYPES.join('/')))
  }
  if (value.riskLevel !== undefined) checkEnum(checks, 'riskLevel', value.riskLevel, RISK_LEVELS)
  if (value.matchScore !== undefined) checkPercent(checks, 'matchScore', value.matchScore)
  return finalize(value as unknown as PoolNode, checks)
}

export function validatePoolEdge(input: unknown): Validated<PoolEdge> {
  const value = isRecord(input) ? input : {}
  const checks: FieldCheck[] = []
  for (const field of ['id', 'source', 'target', 'relation']) {
    checkString(checks, field, value[field])
  }
  checkEnum(checks, 'strength', value.strength, EDGE_STRENGTHS)
  return finalize(value as unknown as PoolEdge, checks)
}

const APPLICATION_STATUSES = ['已评估', '已投递', '已联系', '已回复', '面试中', '已录取', '已拒绝'] as const
const URGENCIES = ['urgent', 'overdue', 'waiting', 'cooled'] as const

export function validateApplication(input: unknown): Validated<Application> {
  const value = isRecord(input) ? input : {}
  const checks: FieldCheck[] = []
  if (typeof value.id !== 'number') checks.push(missing('id', value.id))
  if (typeof value.personId !== 'number') checks.push(missing('personId', value.personId))
  for (const field of ['company', 'position']) {
    checkString(checks, field, value[field])
  }
  if (value.sourceDecision !== undefined && !expectString(value.sourceDecision)) {
    checks.push(illegal('sourceDecision', value.sourceDecision, 'string'))
  }
  checkEnum(checks, 'status', value.status, APPLICATION_STATUSES)
  checkEnum(checks, 'urgency', value.urgency, URGENCIES)
  return finalize(value as unknown as Application, checks)
}

export function validateSession(input: unknown): Validated<Session> {
  const value = isRecord(input) ? input : {}
  const checks: FieldCheck[] = []
  for (const field of ['id', 'title', 'createdAt', 'updatedAt']) {
    checkString(checks, field, value[field])
  }
  if (typeof value.personId !== 'number') checks.push(missing('personId', value.personId))
  if (typeof value.archived !== 'boolean') checks.push(illegal('archived', value.archived, 'true/false'))
  if (!Array.isArray(value.messages)) checks.push(illegal('messages', value.messages, 'ChatMessage[]'))
  return finalize(value as unknown as Session, checks)
}

/** 版本分派入口：按 record.protocolVersion 选择解析规则（协议升级只动这里） */
export function validateByProtocol(input: unknown): Validated<DecisionRecord> {
  const value = isRecord(input) ? input : {}
  const version = protocolVersionOf(value)
  switch (version) {
    case '2.3':
    case '2.2':
    case '2.1':
      return validateDecisionRecord(value, { requireProfile: true })
    case '2.0':
      return validateDecisionRecord(value)
    default:
      return finalize(value as unknown as DecisionRecord, [
        { path: 'protocolVersion', reason: `不支持的协议版本 ${JSON.stringify(version)}（合法值：2.0/2.1/2.2/2.3）`, severity: 'error' },
      ])
  }
}
