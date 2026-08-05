/**
 * ledger-writer：M7.2 Ledger Writer（Ledger Candidate Contract v1）。
 * Candidate confirmed → ledger/events/ledger_YYYYMMDD_NNNNN.md 落盘（Markdown + frontmatter）。
 * - commitLedgerEvent：验证不变量 → 写入事件 + manifest 维护
 * - readLedgerEvents：ledger/events/ 扫描 → LedgerEventRecord[]（正序）
 *
 * 写入不变量（M7.2 冻结）：before_ref 可读 / after_ref 可读（版本存在 + unit 在
 * from→to 间有实际变化）/ confirmation 存在 / why 非空——任一不满足 → 不写入（fail fast）。
 * id = 系统登记制（ledger_YYYYMMDD_NNNNN，不派生业务语义——业务语义在 type/change_unit）。
 * 边界：只写 committed 事件，不写 proposed/rejected（拒绝 = 不 commit，无副作用）。
 */
import type { Workspace } from './workspace.ts'
import { WorkspaceError } from './workspace.ts'
import { splitFrontmatter } from './artifact-registry.ts'
import { diffSnapshotVersions, type CandidateTrigger, type Confidence, type LedgerChangeType } from '../runtime/ledger-candidate.ts'
import { projectDecision } from '../ir/decision-projection.ts'

export interface CandidateConfirmation {
  type: 'user_confirmation' | 'decision_confirmation' | 'evidence_confirmation'
  ref: string
}

export interface CommitLedgerInput {
  fromId: string
  toId: string
  unit: string
  trigger: CandidateTrigger
  attribution: { why: string; sourceRefs?: string[] } // why 必填（confirmed + committed 不变式）
  confirmation: CandidateConfirmation
}

export interface LedgerEventRecord {
  id: string
  personId: string
  type: LedgerChangeType
  status: 'committed'
  timestamp: string
  changeUnit: string
  trigger: { type: CandidateTrigger['type']; source?: string; refs: string[] }
  beforeRef: string // {snapshot_version_id}
  beforeScope: string // 变化单位
  afterRef: string
  afterScope: string
  change?: string // ## Change 段落摘要（before → after）
  why: string
  sourceRefs: string[]
  confidence: Confidence
}

const eventsDir = (pid: string): string => `persons/${pid}/ledger/events`
const manifestPath = (pid: string): string => `persons/${pid}/ledger/manifest.md`

function listEventFiles(ws: Workspace, pid: string): string[] {
  try {
    return ws.listMarkdown(eventsDir(pid))
  } catch {
    return [] // 首事件前目录未创建
  }
}

/** 系统登记 id：ledger_{YYYYMMDD}_{NNNNN}（当日最大序号 +1；业务语义不进 id） */
function nextLedgerEventId(ws: Workspace, pid: string): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `ledger_${day}_`
  let max = 0
  for (const f of listEventFiles(ws, pid)) {
    if (!f.startsWith(prefix)) continue
    const n = parseInt(f.slice(prefix.length, -3), 10)
    if (!Number.isNaN(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(5, '0')}`
}

function renderEvent(rec: LedgerEventRecord, change: string): string {
  const lines = [
    '---',
    `id: ${rec.id}`,
    `person_id: ${rec.personId}`,
    `type: ${rec.type}`,
    'status: committed',
    `timestamp: ${rec.timestamp}`,
    `trigger_type: ${rec.trigger.type}`,
    ...(rec.trigger.source ? [`trigger_source: ${rec.trigger.source}`] : []),
    `trigger_refs: ${rec.trigger.refs.join(',')}`,
    `before_ref: ${rec.beforeRef}`,
    `before_scope: ${rec.beforeScope}`,
    `after_ref: ${rec.afterRef}`,
    `after_scope: ${rec.afterScope}`,
    `confidence: ${rec.confidence}`,
    '---',
    '',
    `# ${rec.changeUnit}`,
    '',
    '## Change',
    '',
    change,
    '',
    '## Why',
    '',
    rec.why,
    '',
    '## Evidence',
    '',
    ...(rec.sourceRefs.length > 0 ? rec.sourceRefs.map((s) => `- ${s}`) : ['- （无）']),
    '',
  ]
  return lines.join('\n')
}

function ensureManifest(ws: Workspace, pid: string): void {
  const now = new Date().toISOString()
  const events = readLedgerEvents(ws, pid)
  const latest = events.at(-1)
  ws.write(
    manifestPath(pid),
    `---
id: ${pid}
created_at: ${now}
event_count: ${events.length}
latest_event_id: ${latest?.id ?? ''}
latest_timestamp: ${latest?.timestamp ?? ''}
---

# Ledger manifest — ${pid}
`,
  )
}

/**
 * confirmed 候选 → 事件落盘。不变量：before/after_ref 可读（diff 验证 unit 实际变化）、
 * confirmation 存在、why 非空——任一不满足抛 WorkspaceError（不写入）。
 */
export function commitLedgerEvent(ws: Workspace, pid: string, input: CommitLedgerInput): LedgerEventRecord {
  const why = input.attribution.why?.trim()
  if (!why) throw new WorkspaceError(`ledger（person ${pid}）`, 'commit 必须 why 非空（confirmed + committed 不变式）')
  const diffs = diffSnapshotVersions(ws, pid, input.fromId, input.toId) // before/after_ref 可读性：版本存在 + 变化
  const diff = diffs.find((d) => d.unit === input.unit)
  if (!diff) {
    throw new WorkspaceError(
      `ledger（person ${pid}）`,
      `commit 失败：${input.fromId} → ${input.toId} 间不存在变化单位 ${input.unit}（版本漂移或候选过期）`,
    )
  }

  const now = new Date().toISOString()
  const change = `${diff.before ?? '（新增）'}\n\n→\n\n${diff.after ?? '（删除）'}`
  const rec: LedgerEventRecord = {
    id: nextLedgerEventId(ws, pid),
    personId: pid,
    type: diff.changeType,
    status: 'committed',
    timestamp: now,
    changeUnit: diff.unit,
    trigger: { type: input.trigger.type, ...(input.trigger.source ? { source: input.trigger.source } : {}), refs: input.trigger.refs ?? [] },
    beforeRef: input.fromId,
    beforeScope: diff.unit,
    afterRef: input.toId,
    afterScope: diff.unit,
    change,
    why,
    sourceRefs: input.attribution.sourceRefs ?? [],
    confidence: 'high', // committed 事件恒 high（confirmed 候选）
  }
  ws.write(`${eventsDir(pid)}/${rec.id}.md`, renderEvent(rec, change))
  ensureManifest(ws, pid)
  return rec
}

export interface CommitDecisionLedgerInput {
  decisionId: string
  changeUnit: string
  changeType: LedgerChangeType
  before?: string
  after: string
  trigger: CandidateTrigger
  attribution: { why: string; sourceRefs?: string[] }
  confirmation: CandidateConfirmation
}

/** change_unit → decision 文件字段（after 防漂移验证用；jd_strategy 载体在 DecisionContext，v1 跳过） */
const DECISION_FIELD_OF: Record<string, 'direction' | 'city' | 'salaryFeasible'> = {
  direction_target: 'direction',
  city_constraint: 'city',
  salary_constraint: 'salaryFeasible',
}

/**
 * decision 来源候选 → 事件落盘（M7.3.3：复用 M7.2 落盘格式/id 登记/manifest）。
 * 不变量：why 非空 + after 与当前 decision 文件投影一致（防漂移——候选基于变更时点，提交时须仍成立）。
 * before_ref/after_ref = decision:{id}（状态载体 = 决策文件 + 事件摘要；无 snapshot 版本对）。
 */
export function commitDecisionLedgerEvent(ws: Workspace, pid: string, input: CommitDecisionLedgerInput): LedgerEventRecord {
  const why = input.attribution.why?.trim()
  if (!why) throw new WorkspaceError(`ledger（person ${pid}）`, 'commit 必须 why 非空（confirmed + committed 不变式）')

  const rel = `decisions/${input.decisionId}.md`
  if (!ws.exists(rel)) throw new WorkspaceError(`ledger（person ${pid}）`, `决策不存在：${input.decisionId}`)
  const field = DECISION_FIELD_OF[input.changeUnit]
  if (field) {
    const current = projectDecision(ws.read(rel), input.decisionId, '')
    const cur = current[field]
    const expected = field === 'salaryFeasible' ? input.after === 'true' : input.after
    if (cur !== expected) {
      throw new WorkspaceError(
        `ledger（person ${pid}）`,
        `commit 漂移：决策 ${input.decisionId} 当前 ${field}=${String(cur)}，候选 after=${input.after}（决策已再次变化）`,
      )
    }
  }

  const now = new Date().toISOString()
  const change = `${input.before ?? '（新增）'}\n\n→\n\n${input.after}`
  const rec: LedgerEventRecord = {
    id: nextLedgerEventId(ws, pid),
    personId: pid,
    type: input.changeType,
    status: 'committed',
    timestamp: now,
    changeUnit: input.changeUnit,
    trigger: { type: input.trigger.type, ...(input.trigger.source ? { source: input.trigger.source } : {}), refs: input.trigger.refs ?? [] },
    beforeRef: `decision:${input.decisionId}`,
    beforeScope: input.changeUnit,
    afterRef: `decision:${input.decisionId}`,
    afterScope: input.changeUnit,
    change,
    why,
    sourceRefs: input.attribution.sourceRefs ?? [],
    confidence: 'high',
  }
  ws.write(`${eventsDir(pid)}/${rec.id}.md`, renderEvent(rec, change))
  ensureManifest(ws, pid)
  return rec
}

/** ledger/events/ 扫描 → 事件列表（正序；目录缺失 → 空） */
export function readLedgerEvents(ws: Workspace, pid: string): LedgerEventRecord[] {  const out: LedgerEventRecord[] = []
  for (const f of listEventFiles(ws, pid)) {
    const rec = parseLedgerEvent(ws.read(`${eventsDir(pid)}/${f}`))
    if (rec) out.push(rec)
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function parseLedgerEvent(md: string): LedgerEventRecord | undefined {
  const { meta } = splitFrontmatter(md)
  const id = meta.id?.trim()
  const personId = meta.person_id?.trim()
  const type = meta.type?.trim()
  if (!id || !personId || !type || meta.status !== 'committed') return undefined
  const change = md.includes('## Change') ? md.split('## Change')[1]!.split('## Why')[0]!.trim() : undefined
  const why = md.includes('## Why') ? md.split('## Why')[1]!.split('## Evidence')[0]!.trim() : ''
  const evidence = md.includes('## Evidence')
    ? md.split('## Evidence')[1]!.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim())
    : []
  return {
    id,
    personId,
    type: type as LedgerChangeType,
    status: 'committed',
    timestamp: meta.timestamp?.trim() ?? '',
    changeUnit: meta.before_scope?.trim() ?? '',
    trigger: {
      type: (meta.trigger_type?.trim() ?? 'snapshot_change') as CandidateTrigger['type'],
      ...(meta.trigger_source?.trim() ? { source: meta.trigger_source.trim() } : {}),
      refs: (meta.trigger_refs ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    },
    beforeRef: meta.before_ref?.trim() ?? '',
    beforeScope: meta.before_scope?.trim() ?? '',
    afterRef: meta.after_ref?.trim() ?? '',
    afterScope: meta.after_scope?.trim() ?? '',
    ...(change ? { change } : {}),
    why,
    sourceRefs: evidence,
    confidence: (meta.confidence?.trim() ?? 'high') as Confidence,
  }
}
