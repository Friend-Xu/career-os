/**
 * interview-watcher（M4-2.2）：Interview Artifact 存储服务。
 * - 契约：INTERVIEW-ARTIFACT-M4-v0.1（三层分离 + 四边界）
 * - QA：用户写问题/事实/回答/策略（interviews/暂存名.md）→ 引擎登记系统 ID + 初始化 draft + 演化记录
 * - 提案：AI 写（interviews/proposals/）→ 登记 pending → accept（I-01~I-08 校验 → 改写
 *   AnswerStatement.text + status=draft + transitions 追加）| reject（reason 写回，单向不 reopen）
 * - transition：draft→reviewed→ready 单向；ready 不可回退（修改必须 Proposal → draft）
 * - projection：buildInterviewContext（引擎确定性聚合，AI 读投影写提案）
 * - 独立性：helper 私有复制（Concrete first——不抽公共解析库；Empty Validation Rule 遵守）
 */
import { watch } from 'chokidar'
import type { Workspace } from './workspace.ts'
import { splitFrontmatter, nextArtifactId, type ArtifactSpec } from './artifact-registry.ts'
import type {
  InterviewContext,
  InterviewEvidence,
  InterviewEvidenceType,
  InterviewFactItem,
  InterviewFactType,
  InterviewIntent,
  InterviewProposal,
  InterviewProposalChange,
  InterviewProposalStatus,
  InterviewQa,
  InterviewStatement,
  InterviewStatus,
  InterviewTransitionRecord,
  InterviewValidation,
  InterviewValidationIssue,
} from '../ir/interview.ts'

export const INTERVIEW_SPEC: ArtifactSpec = {
  type: 'interview_qa',
  dir: 'interviews',
  idPrefix: 'qa_',
  marker: /##\s*问题/,
  passthroughFields: [],
}

export const INTERVIEW_PROPOSAL_SPEC: ArtifactSpec = {
  type: 'interview_proposal',
  dir: 'interviews/proposals',
  idPrefix: 'ip_',
  marker: /##\s*提案摘要/,
  passthroughFields: [],
}

const QA_STATUSES: InterviewStatus[] = ['draft', 'reviewed', 'ready']
const PROPOSAL_STATUSES: InterviewProposalStatus[] = ['pending', 'accepted', 'rejected']
const FACT_TYPES: InterviewFactType[] = ['project_context', 'responsibility', 'action', 'result', 'technical_decision']
const EVIDENCE_TYPES: InterviewEvidenceType[] = ['code', 'design', 'demo', 'result']
const CHANGE_TYPES = ['rewrite'] as const

const QA_ID_RE = /^qa_\d{8}_\d{5}$/

/** old 逐字匹配前的空格标准化（I-03：空白差异不判漂移） */
function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 引号保护切分：分隔符在 "..." 内不生效（text/old/new/reason 句子可含 ；：） */
function splitRespectingQuotes(input: string, sep: string): string[] {
  const parts: string[] = []
  let cur = ''
  let inQuote = false
  for (const ch of input) {
    if (ch === '"') inQuote = !inQuote
    if (ch === sep && !inQuote) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  parts.push(cur)
  return parts
}

/** 分隔行（|----|----|）判定 */
function isSeparatorRow(line: string): boolean {
  return line.replace(/[|\-:\s]/g, '').length === 0
}

/** 表格行 → 单元格（变长列；不匹配返回 undefined） */
function splitTableRow(line: string): string[] | undefined {
  const t = line.trim()
  if (!t.startsWith('|') || !t.endsWith('|')) return undefined
  return t.split('|').slice(1, -1).map((c) => c.trim())
}

/** 段内行（按段头切分，取首个段，截到下一个 ## 段） */
function sectionLines(md: string, header: RegExp): string[] {
  const parts = md.split(header, 2)
  if (parts.length < 2) return []
  return parts[1].split(/\n##\s+/)[0].split('\n')
}

/** 段表格数据行：跳过表头行（首数据行）与分隔行；单元格 trim */
function parseTableRows(md: string, header: RegExp): string[][] {
  const rows: string[][] = []
  let isHeader = true
  for (const line of sectionLines(md, header)) {
    if (isSeparatorRow(line)) continue
    const cells = splitTableRow(line)
    if (!cells) continue
    if (isHeader) {
      isHeader = false
      continue
    }
    if (cells[0].trim() === '') continue
    rows.push(cells.map((c) => c.trim()))
  }
  return rows
}

/** `## 回答` / `## 策略` 行格式：`- {id}（k: "..."；k: "..."）` */
function parseKvLines(md: string, header: RegExp): { id: string; kvs: Record<string, string> }[] {
  const out: { id: string; kvs: Record<string, string> }[] = []
  for (const line of sectionLines(md, header)) {
    const m = line.match(/^\s*[-*]\s*([\w-]+)（(.+)）\s*$/)
    if (!m) continue
    const kvs: Record<string, string> = {}
    for (const kv of splitRespectingQuotes(m[2], '；')) {
      const idx = kv.indexOf(':')
      if (idx <= 0) continue
      let v = kv.slice(idx + 1).trim()
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1)
      kvs[kv.slice(0, idx).trim()] = v
    }
    out.push({ id: m[1], kvs })
  }
  return out
}

// ─── QA 文件 ─────────────────────────────────────────────────────────────

export interface ParsedQa {
  sourceFile: string
  record: InterviewQa
  issues: { path: string; reason: string; severity: 'warn' | 'error' }[]
}

/** QA md → IR（`> status/metadata` 行 + 问题段 + 事实/证据表 + 回答/策略行 + 演化记录表） */
export function parseInterviewQaMarkdown(md: string, sourceFile: string): ParsedQa {
  const { meta, body } = splitFrontmatter(md)
  const issues: { path: string; reason: string; severity: 'warn' | 'error' }[] = []
  let status: InterviewStatus = 'draft'
  let metadata: Record<string, string> | undefined
  for (const line of body.split('\n')) {
    const m = line.match(/^>\s*(\w+):\s*(.+)$/)
    if (!m) continue
    if (m[1] === 'status') {
      if (QA_STATUSES.includes(m[2] as InterviewStatus)) status = m[2] as InterviewStatus
      else issues.push({ path: 'status', reason: `非法状态 ${JSON.stringify(m[2])}（合法值：${QA_STATUSES.join('/')}）`, severity: 'warn' })
    } else if (m[1] === 'metadata') {
      metadata = Object.fromEntries(
        m[2].split('；').map((kv) => {
          const i = kv.indexOf('=')
          return i <= 0 ? [kv.trim(), ''] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]
        }),
      )
    }
  }

  // 问题段：段头后到下一 ## 段的所有文本（trim 空行）
  const question = sectionLines(body, /##\s*问题/).map((l) => l.trim()).filter(Boolean).join('\n')

  const factItems: InterviewFactItem[] = []
  for (const row of parseTableRows(body, /##\s*事实/)) {
    const [id = '', statement = '', type = '', evidence = ''] = row
    if (!FACT_TYPES.includes(type as InterviewFactType)) {
      issues.push({ path: id, reason: `非法事实类型 ${JSON.stringify(type)}（合法值：${FACT_TYPES.join('/')}）`, severity: 'warn' })
    }
    factItems.push({
      id,
      statement,
      type: type as InterviewFactType,
      evidenceRefs: evidence === '-' || evidence === '' ? [] : evidence.split(',').map((s) => s.trim()).filter(Boolean),
    })
  }

  const evidence: InterviewEvidence[] = []
  for (const row of parseTableRows(body, /##\s*证据资产/)) {
    const [id = '', type = '', location = '', metadataCell = ''] = row
    if (!EVIDENCE_TYPES.includes(type as InterviewEvidenceType)) {
      issues.push({ path: id, reason: `非法证据类型 ${JSON.stringify(type)}（合法值：${EVIDENCE_TYPES.join('/')}）`, severity: 'warn' })
    }
    const metaMap: Record<string, string> | undefined =
      metadataCell === '-' || metadataCell === ''
        ? undefined
        : Object.fromEntries(
            metadataCell.split('；').map((kv) => {
              const i = kv.indexOf('=')
              return i <= 0 ? [kv.trim(), ''] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]
            }),
          )
    evidence.push({ id, type: type as InterviewEvidenceType, location, ...(metaMap ? { metadata: metaMap } : {}) })
  }

  const answerStatements: InterviewStatement[] = []
  for (const { id, kvs } of parseKvLines(body, /##\s*回答/)) {
    const factsRaw = kvs.facts === '-' ? '' : (kvs.facts ?? '')
    const factRefs = factsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    if (factRefs.length === 0) {
      issues.push({ path: id, reason: 'statement 无事实锚点（factRefs 必填，I-08）', severity: 'error' })
    }
    answerStatements.push({ id, text: kvs.text ?? '', factRefs })
  }

  const intents: InterviewIntent[] = []
  for (const { id, kvs } of parseKvLines(body, /##\s*策略/)) {
    intents.push({ id, statement: kvs.statement ?? '' })
  }

  const transitions: InterviewTransitionRecord[] = []
  for (const row of parseTableRows(body, /##\s*演化记录/)) {
    const [from = '', to = '', at = '', via = ''] = row
    transitions.push({ from: from === '-' ? '' : from, to, at, ...(via && via !== '-' ? { via } : {}) })
  }

  return {
    sourceFile,
    record: {
      id: meta.id ?? sourceFile.replace(/\.md$/, ''), // 暂存文件用文件名兜底，登记后替换系统 ID
      status,
      question,
      factItems,
      evidence,
      answerStatements,
      intents,
      transitions,
      ...(meta.created_at ? { createdAt: meta.created_at } : {}),
      ...(meta.source_file ? { sourceFile: meta.source_file } : {}),
      ...(metadata ? { metadata } : {}),
    },
    issues,
  }
}

/** 引擎写回（frontmatter + status/metadata + 问题 + 事实/证据 + 回答/策略 + 演化记录；roundtrip） */
export function serializeInterviewQa(q: InterviewQa): string {
  const facts = q.factItems.map((f) => `| ${f.id} | ${f.statement} | ${f.type} | ${f.evidenceRefs.length > 0 ? f.evidenceRefs.join(', ') : '-'} |`).join('\n')
  const evs = q.evidence
    .map((e) => `| ${e.id} | ${e.type} | ${e.location} | ${e.metadata ? Object.entries(e.metadata).map(([k, v]) => `${k}=${v}`).join('；') : '-'} |`)
    .join('\n')
  const answers = q.answerStatements
    .map((s) => `- ${s.id}（text: "${s.text}"；facts: ${s.factRefs.join(', ')}）`)
    .join('\n')
  const intents = q.intents.map((i) => `- ${i.id}（statement: "${i.statement}"）`).join('\n')
  const trans = q.transitions.map((t) => `| ${t.from || '-'} | ${t.to} | ${t.at} | ${t.via ?? '-'} |`).join('\n')
  return `---
id: ${q.id}
created_at: ${q.createdAt ?? ''}
source_file: ${q.sourceFile ?? ''}
---

> status: ${q.status}
${q.metadata ? `> metadata: ${Object.entries(q.metadata).map(([k, v]) => `${k}=${v}`).join('；')}` : ''}

## 问题

${q.question}

## 事实

| id | statement | type | evidence |
|----|-----------|------|----------|
${facts}

## 证据资产

| id | type | location | metadata |
|----|------|----------|----------|
${evs}

## 回答

${answers}

## 策略

${intents}

## 演化记录

| from | to | at | via |
|------|----|----|-----|
${trans}
`
}

// ─── Interview Proposal ──────────────────────────────────────────────────

export interface ParsedInterviewProposal {
  sourceFile: string
  record: InterviewProposal
  issues: { path: string; reason: string; severity: 'warn' | 'error' }[]
}

/** `## 提案摘要` 表（Interview 自己的摘要协议——不复用 Resume/Portfolio 段头） */
function parseSummaryTable(md: string): Record<string, string> | undefined {
  const rows = parseTableRows(md, /##\s*提案摘要/)
  if (rows.length === 0) return undefined
  const fields: Record<string, string> = {}
  for (const row of rows) {
    const [k = '', v = ''] = row
    if (k) fields[k] = v
  }
  return fields
}

/** `## 变更建议` 段：`- ans_001（type: rewrite；old: "..."；new: "..."；reason: "..."）` */
function parseProposalChanges(md: string): { changes: InterviewProposalChange[]; issues: { path: string; reason: string; severity: 'warn' | 'error' }[] } {
  const issues: { path: string; reason: string; severity: 'warn' | 'error' }[] = []
  const changes: InterviewProposalChange[] = []
  for (const line of sectionLines(md, /##\s*变更建议/)) {
    const m = line.match(/^\s*[-*]\s*([\w-]+)（(.+)）\s*$/)
    if (!m) continue
    const change: InterviewProposalChange = { type: 'rewrite', statementId: m[1], old: '', new: '', reason: '' }
    for (const kv of splitRespectingQuotes(m[2], '；')) {
      const idx = kv.indexOf(':')
      if (idx <= 0) continue
      const k = kv.slice(0, idx).trim()
      let v = kv.slice(idx + 1).trim()
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1)
      if (k === 'type') {
        if (CHANGE_TYPES.includes(v as 'rewrite')) change.type = v as 'rewrite'
        else issues.push({ path: m[1], reason: `非法变更类型 ${JSON.stringify(v)}（v0.1 仅 rewrite——禁止触碰 FactLayer）`, severity: 'warn' })
      } else if (k === 'old') change.old = v
      else if (k === 'new') change.new = v
      else if (k === 'reason') change.reason = v
    }
    changes.push(change)
  }
  return { changes, issues }
}

/** `## 验证` 快照段（引擎写回；占位行 normalize 为 no issue——Empty Validation Representation Rule） */
function parseInterviewValidation(md: string): InterviewValidation | undefined {
  const lines = sectionLines(md, /##\s*验证/)
  if (lines.length === 0) return undefined
  const issues: InterviewValidationIssue[] = []
  let status: InterviewValidation['status'] | undefined
  for (const line of lines) {
    const m = line.match(/^\s*-\s*(valid|warning|invalid)\s*\|\s*([^|]*)\s*\|\s*([^|]*)\s*\|\s*(.*?)\s*$/)
    if (!m) continue
    status ??= m[1] as InterviewValidation['status']
    if (m[2].trim() === '-' || m[2].trim() === '') continue
    issues.push({ code: m[2].trim(), message: m[3].trim(), target: m[4].trim() })
  }
  return status ? { status, issues } : undefined
}

/** InterviewProposal → 存储 md（roundtrip：parseInterviewProposal(serialize(p)) 还原全部字段） */
export function serializeInterviewProposal(p: InterviewProposal): string {
  const rows = [
    `| type | interview_proposal |`,
    `| qa_id | ${p.qaId} |`,
    `| status | ${p.status} |`,
    `| created_by | ${p.createdBy} |`,
    ...(p.createdAt ? [`| created_at | ${p.createdAt} |`] : []),
    ...(p.decidedAt ? [`| decided_at | ${p.decidedAt} |`] : []),
    ...(p.acceptReason ? [`| accept_reason | ${p.acceptReason} |`] : []),
    ...(p.rejectReason ? [`| reject_reason | ${p.rejectReason} |`] : []),
  ].join('\n')
  const changes = p.changes.map((c) => `- ${c.statementId}（type: ${c.type}；old: "${c.old}"；new: "${c.new}"；reason: "${c.reason}"）`).join('\n')
  const validation = p.validation
    ? `## 验证\n\n${p.validation.issues.map((i) => `- ${p.validation!.status} | ${i.code} | ${i.message} | ${i.target}`).join('\n') || `- ${p.validation.status} | - | - | -`}\n`
    : ''

  return `# ${p.id}

## 提案摘要

| 字段 | 值 |
|------|-----|
${rows}

## 变更建议

${changes}
${validation ? `\n${validation}` : ''}`
}

/** 单个 proposal md → IR（摘要表 + 变更段 + 验证快照） */
export function parseInterviewProposal(md: string, sourceFile: string): ParsedInterviewProposal {
  const { meta, body } = splitFrontmatter(md)
  const issues: { path: string; reason: string; severity: 'warn' | 'error' }[] = []
  const fields = parseSummaryTable(body)
  if (!fields) {
    issues.push({ path: sourceFile, reason: '未找到 `## 提案摘要` 表格', severity: 'error' })
    return { sourceFile, record: { id: meta.id ?? sourceFile.replace(/\.md$/, ''), qaId: '', changes: [], status: 'pending', createdBy: 'ai' }, issues }
  }
  if (!fields.qa_id || fields.qa_id === '-') issues.push({ path: 'qa_id', reason: '缺失（摘要表未填）', severity: 'error' })
  if (fields.type && fields.type !== 'interview_proposal') {
    issues.push({ path: 'type', reason: `非法值 ${JSON.stringify(fields.type)}（合法值：interview_proposal）`, severity: 'warn' })
  }
  const status = fields.status as InterviewProposalStatus
  if (fields.status && !PROPOSAL_STATUSES.includes(status)) {
    issues.push({ path: 'status', reason: `非法值 ${JSON.stringify(fields.status)}（合法值：${PROPOSAL_STATUSES.join('/')}）`, severity: 'warn' })
  }
  const { changes, issues: changeIssues } = parseProposalChanges(body)
  issues.push(...changeIssues)
  const validation = parseInterviewValidation(body)

  const record: InterviewProposal = {
    id: meta.id ?? sourceFile.replace(/\.md$/, ''),
    qaId: fields.qa_id ?? '',
    changes,
    status: PROPOSAL_STATUSES.includes(status) ? status : 'pending',
    createdBy: 'ai',
    ...(fields.created_at ? { createdAt: fields.created_at } : {}),
    ...(fields.decided_at ? { decidedAt: fields.decided_at } : {}),
    ...(fields.accept_reason ? { acceptReason: fields.accept_reason } : {}),
    ...(fields.reject_reason ? { rejectReason: fields.reject_reason } : {}),
    ...(validation ? { validation } : {}),
  }
  return { sourceFile, record, issues }
}

// ─── 验证（I-01~I-08 纯函数，注册/扫描/accept 共用）──

const PROPOSAL_ERROR_CODES = new Set(['I-01', 'I-02', 'I-03', 'I-04', 'I-05', 'I-08', 'NO_CHANGES'])

/** 登记前校验（含 apply 可行性）；error 码 → invalid，其余 warn → warning */
export function validateInterviewProposal(p: InterviewProposal, qa: InterviewQa | undefined): InterviewValidation {
  const issues: InterviewValidationIssue[] = []
  if (!qa) {
    issues.push({ code: 'I-01', message: `QA 不存在：${p.qaId}`, target: p.qaId })
    return { status: 'invalid', issues }
  }
  if (p.changes.length === 0) issues.push({ code: 'NO_CHANGES', message: '变更建议为空', target: p.id })
  for (const c of p.changes) {
    const stmt = qa.answerStatements.find((s) => s.id === c.statementId)
    if (!stmt) {
      issues.push({ code: 'I-02', message: `AnswerStatement 不存在：${c.statementId}`, target: c.statementId })
      continue
    }
    if (stmt.factRefs.length === 0) {
      issues.push({ code: 'I-08', message: '目标 statement 无事实锚点（factRefs 为空）——无锚点陈述不可改写', target: c.statementId })
    }
    if (normalizeSpace(stmt.text) !== normalizeSpace(c.old)) {
      issues.push({ code: 'I-03', message: 'old 与 AnswerStatement.text 不匹配（防幻觉）', target: c.statementId })
    }
    if (!c.new || c.new.trim().length === 0) issues.push({ code: 'I-04', message: 'new 为空', target: c.statementId })
    if (c.type !== 'rewrite') {
      issues.push({ code: 'I-05', message: `非法变更类型 ${JSON.stringify(c.type)}（v0.1 仅 rewrite——禁止触碰 FactLayer/Intent）`, target: c.statementId })
    }
    if (!c.reason || c.reason.trim().length === 0) issues.push({ code: 'I-06', message: 'reason 为空（建议不可解释）', target: c.statementId })
  }
  const seen = new Set<string>()
  for (const c of p.changes) {
    if (seen.has(c.statementId)) issues.push({ code: 'I-07', message: `同 statement 重复变更：${c.statementId}`, target: c.statementId })
    seen.add(c.statementId)
  }
  const status = issues.some((i) => PROPOSAL_ERROR_CODES.has(i.code)) ? 'invalid' : issues.length > 0 ? 'warning' : 'valid'
  return { status, issues }
}

// ─── 扫描 / 登记 ─────────────────────────────────────────────────────────

/** 已登记判定：frontmatter id 为系统 ID 格式（登记时引擎注入） */
function isQaRegistered(md: string): boolean {
  const id = splitFrontmatter(md).meta.id
  return id !== undefined && QA_ID_RE.test(id)
}

/** 已登记判定：摘要表显式含 status 行（parse 默认 'pending' 不代表已登记） */
function isProposalRegistered(md: string): boolean {
  return parseSummaryTable(md)?.status !== undefined
}

function findQa(ws: Workspace, qaId: string): InterviewQa | undefined {
  return scanInterviewQas(ws).find((q) => q.record.id === qaId)?.record
}

export function scanInterviewQas(ws: Workspace): ParsedQa[] {
  return ws.listMarkdown('interviews').sort().map((f) => {
    const md = ws.read(`interviews/${f}`)
    return parseInterviewQaMarkdown(md, f)
  })
}

export function scanInterviewProposals(ws: Workspace): ParsedInterviewProposal[] {
  return ws.listMarkdown('interviews/proposals').sort().map((f) => {
    const md = ws.read(`interviews/proposals/${f}`)
    const parsed = parseInterviewProposal(md, f)
    const record = isProposalRegistered(md)
      ? parsed.record
      : { ...parsed.record, validation: validateInterviewProposal(parsed.record, findQa(ws, parsed.record.qaId)) }
    return { sourceFile: f, record, issues: parsed.issues }
  })
}

/** 单个 QA 文件登记：marker + 有问题 → 系统 ID + 初始化 draft + 演化记录首行（status 引擎单方管理） */
export function registerInterviewQaFile(ws: Workspace, fileName: string, now: Date = new Date()): boolean {
  const md = ws.read(`interviews/${fileName}`)
  if (!INTERVIEW_SPEC.marker.test(md)) return false // 非 QA 格式不赋予系统身份
  if (isQaRegistered(md)) return false
  const parsed = parseInterviewQaMarkdown(md, fileName)
  if (parsed.record.question.trim().length === 0) return false // 无问题的 QA 不登记
  const systemId = nextArtifactId(ws, INTERVIEW_SPEC, now)
  const record: InterviewQa = {
    ...parsed.record,
    id: systemId,
    status: 'draft',
    createdAt: now.toISOString().slice(0, 10),
    sourceFile: fileName.replace(/\.md$/, ''),
    transitions: [{ from: '', to: 'draft', at: now.toISOString() }],
  }
  ws.write(`interviews/${systemId}.md`, serializeInterviewQa(record))
  ws.delete(`interviews/${fileName}`)
  return true
}

/** 启动补登：引擎离线期间用户写入的 QA（幂等——已登记跳过） */
export function registerPendingInterviewQas(ws: Workspace, now: Date = new Date()): number {
  let registered = 0
  for (const f of ws.listMarkdown('interviews')) {
    if (registerInterviewQaFile(ws, f, now)) registered++
  }
  return registered
}

/** 单个提案文件登记：marker + 非 invalid → 系统 ID + 引擎字段写回（invalid 不登记，AI 修正后 change 重试） */
export function registerInterviewProposalFile(ws: Workspace, fileName: string, now: Date = new Date()): boolean {
  const md = ws.read(`interviews/proposals/${fileName}`)
  if (!INTERVIEW_PROPOSAL_SPEC.marker.test(md)) return false // 非提案格式不赋予系统身份
  if (isProposalRegistered(md)) return false // 已登记（引擎字段已写回）
  const parsed = parseInterviewProposal(md, fileName)
  const validation = validateInterviewProposal(parsed.record, findQa(ws, parsed.record.qaId))
  if (validation.status === 'invalid') return false
  const systemId = nextArtifactId(ws, INTERVIEW_PROPOSAL_SPEC, now)
  const { body } = splitFrontmatter(md)
  const fm = ['---', `id: ${systemId}`, `created_at: ${now.toISOString().slice(0, 10)}`, `source_file: ${fileName.replace(/\.md$/, '')}`, '---', ''].join('\n')
  ws.write(`interviews/proposals/${systemId}.md`, fm + body)
  ws.delete(`interviews/proposals/${fileName}`)
  const record: InterviewProposal = {
    ...parsed.record,
    id: systemId,
    status: 'pending',
    createdBy: 'ai',
    createdAt: now.toISOString(),
    validation,
  }
  ws.write(`interviews/proposals/${systemId}.md`, serializeInterviewProposal(record))
  return true
}

/** 启动补登：引擎离线期间 AI 写入的提案（幂等——已登记跳过） */
export function registerPendingInterviewProposals(ws: Workspace, now: Date = new Date()): number {
  let registered = 0
  for (const f of ws.listMarkdown('interviews/proposals')) {
    if (registerInterviewProposalFile(ws, f, now)) registered++
  }
  return registered
}

/** interviews/ 监听：add → 登记 + 重扫；change/unlink → 重扫 */
export function watchInterviews(ws: Workspace, onChanged: () => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.interviews, { ignoreInitial: true })
  const rescan = (): void => onChanged()
  watcher.on('add', (p: string) => {
    if (!p.endsWith('.md')) return
    // Windows：chokidar 路径为反斜杠，统一转正斜杠再取文件名/子目录
    const norm = p.replace(/\\/g, '/')
    const name = norm.split('/').pop() ?? p
    if (norm.includes('/proposals/')) registerInterviewProposalFile(ws, name)
    else registerInterviewQaFile(ws, name)
    rescan()
  })
  watcher.on('change', () => rescan())
  watcher.on('unlink', () => rescan())
  return { close: () => watcher.close() }
}

// ─── State Machine（单向；ready 不可回退）──

/** 单向状态机：draft→reviewed→ready；reviewed→draft 打回允许；ready 无出口（修改必须走 Proposal → draft） */
const ALLOWED_TRANSITIONS: Record<InterviewStatus, InterviewStatus[]> = {
  draft: ['reviewed'],
  reviewed: ['draft', 'ready'],
  ready: [],
}

export class InterviewTransitionError extends Error {}

/** transition：status 变化 + 演化记录追加（ready 不可直接回退——Proposal 应用产生新的 draft 演化事件） */
export function transitionInterviewQa(ws: Workspace, id: string, target: InterviewStatus, now: Date = new Date()): InterviewQa {
  const entry = scanInterviewQas(ws).find((q) => q.record.id === id)
  if (!entry) throw new InterviewTransitionError(`QA 不存在：${id}`)
  const q = entry.record
  if (!ALLOWED_TRANSITIONS[q.status].includes(target)) {
    throw new InterviewTransitionError(`非法状态转移：${q.status} → ${target}（ready 不可直接回退；修改必须走 Proposal → draft 演化事件）`)
  }
  const updated: InterviewQa = {
    ...q,
    status: target,
    transitions: [...q.transitions, { from: q.status, to: target, at: now.toISOString() }],
  }
  ws.write(`interviews/${entry.sourceFile}`, serializeInterviewQa(updated))
  return updated
}

// ─── 决策（accept → apply / reject，单向不 reopen；AI 不能自批）──

export interface ApplyInterviewResult {
  qa: InterviewQa
  proposal: InterviewProposal
}

/** accept：I-01~I-08 重校验 → AnswerStatement.text 改写 + status=draft + transitions 追加（永不覆盖历史）。
 *  reason 可选（Human Preference Signal——"为什么成功"，与 rejectReason 对称） */
export function acceptInterviewProposal(ws: Workspace, id: string, reason?: string, now: Date = new Date()): ApplyInterviewResult {
  const entry = scanInterviewProposals(ws).find((p) => p.record.id === id)
  if (!entry) throw new InterviewTransitionError(`提案不存在：${id}`)
  const p = entry.record
  if (p.status !== 'pending') throw new InterviewTransitionError(`只能接受 pending 提案（当前状态 ${p.status}）`)
  const qaEntry = scanInterviewQas(ws).find((x) => x.record.id === p.qaId)
  if (!qaEntry) throw new InterviewTransitionError(`QA 不存在：${p.qaId}`)
  const qa = qaEntry.record
  const validation = validateInterviewProposal(p, qa)
  if (validation.status === 'invalid') {
    throw new InterviewTransitionError(`提案校验失败（${validation.issues.map((i) => i.code).join('/')}）——状态不变，请重新提案`)
  }
  const updated: InterviewQa = {
    ...qa,
    status: 'draft', // apply 后重置 draft：ready 修改必须产生新的 draft 演化事件
    answerStatements: qa.answerStatements.map((s) => {
      const change = p.changes.find((c) => c.statementId === s.id)
      return change ? { ...s, text: change.new } : s
    }),
    transitions: [...qa.transitions, { from: qa.status, to: 'draft', at: now.toISOString(), via: p.id }],
  }
  ws.write(`interviews/${qaEntry.sourceFile}`, serializeInterviewQa(updated))
  const updatedProposal: InterviewProposal = {
    ...p,
    status: 'accepted',
    decidedAt: now.toISOString(),
    ...(reason && reason.trim().length > 0 ? { acceptReason: reason.replace(/\|/g, '／') } : {}),
  }
  ws.write(`interviews/proposals/${entry.sourceFile}`, serializeInterviewProposal(updatedProposal))
  return { qa: updated, proposal: updatedProposal }
}

/** reject：pending → rejected（保留审计；重新建议 = 写新 Proposal） */
export function rejectInterviewProposal(ws: Workspace, id: string, reason?: string, now: Date = new Date()): InterviewProposal {
  const entry = scanInterviewProposals(ws).find((p) => p.record.id === id)
  if (!entry) throw new InterviewTransitionError(`提案不存在：${id}`)
  const p = entry.record
  if (p.status !== 'pending') throw new InterviewTransitionError(`只能拒绝 pending 提案（当前状态 ${p.status}）`)
  const updated: InterviewProposal = {
    ...p,
    status: 'rejected',
    decidedAt: now.toISOString(),
    ...(reason && reason.trim().length > 0 ? { rejectReason: reason.replace(/\|/g, '／') } : {}),
  }
  ws.write(`interviews/proposals/${entry.sourceFile}`, serializeInterviewProposal(updated))
  return updated
}

// ─── Read Projection（引擎确定性聚合；不成为事实存储）──

export function buildInterviewContext(ws: Workspace): InterviewContext {
  return { qas: scanInterviewQas(ws).map((q) => q.record) }
}
