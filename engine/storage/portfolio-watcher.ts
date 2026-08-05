/**
 * portfolio-watcher（M4-1.2）：Portfolio Artifact 存储服务。
 * - 契约：PORTFOLIO-ARTIFACT-M4-v0.1（三边界 + FactItem→Evidence + immutable published）
 * - 项目：用户写事实（portfolio/projects/暂存名.md）→ 引擎登记系统 ID + 初始化 draft/v1 + 演化记录
 * - 提案：AI 写（portfolio/proposals/）→ 登记 pending → accept（P-01~P-07 校验 → apply：
 *   statement 改写 + version+1 + status=draft + transitions 追加）| reject（reason 写回，单向不 reopen）
 * - transition：draft→reviewed→published 单向；published 不可回退（修改必须 draft(v+1)）
 * - projection：buildPortfolioContext（引擎确定性聚合，AI 读投影写提案）
 * - 独立性：不复用 Resume 摘要协议 / 校验码 / 模块（ADR-007）
 */
import { watch } from 'chokidar'
import type { Workspace } from './workspace.ts'
import { splitFrontmatter, nextArtifactId, type ArtifactSpec } from './artifact-registry.ts'
import type {
  PortfolioContext,
  PortfolioEvidence,
  PortfolioEvidenceType,
  PortfolioFactItem,
  PortfolioProject,
  PortfolioProposal,
  PortfolioProposalChange,
  PortfolioProposalStatus,
  PortfolioStatus,
  PortfolioTransitionRecord,
  PortfolioValidation,
  PortfolioValidationIssue,
} from '../ir/portfolio.ts'

export const PORTFOLIO_SPEC: ArtifactSpec = {
  type: 'portfolio_project',
  dir: 'portfolio/projects',
  idPrefix: 'project_',
  marker: /##\s*项目事实/,
  passthroughFields: [],
}

export const PORTFOLIO_PROPOSAL_SPEC: ArtifactSpec = {
  type: 'portfolio_proposal',
  dir: 'portfolio/proposals',
  idPrefix: 'pp_',
  marker: /##\s*提案摘要/,
  passthroughFields: [],
}

const PROJECT_STATUSES: PortfolioStatus[] = ['draft', 'reviewed', 'published']
const PROPOSAL_STATUSES: PortfolioProposalStatus[] = ['pending', 'accepted', 'rejected']
const EVIDENCE_TYPES: PortfolioEvidenceType[] = ['code', 'design', 'demo', 'result']
const CHANGE_TYPES = ['rewrite'] as const

const PROJECT_ID_RE = /^project_\d{8}_\d{5}$/

/** old 逐字匹配前的空格标准化（P-03：全角/半角空白差异不判漂移） */
function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 引号保护切分：分隔符在 "..." 内不生效（old/new/reason 句子可含 ；：） */
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

/** 表格行 → 单元格（变长列：摘要表 2 列 / 项目三表 4 列；不匹配返回 undefined） */
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

// ─── 项目文件 ─────────────────────────────────────────────────────────────

export interface ParsedProject {
  sourceFile: string
  record: PortfolioProject
  issues: { path: string; reason: string; severity: 'warn' | 'error' }[]
}

/** 项目 md → IR（`> status/version` 行 + 项目事实表 + 证据资产表 + 演化记录表；枚举/必填校验） */
export function parseProjectMarkdown(md: string, sourceFile: string): ParsedProject {
  const { meta, body } = splitFrontmatter(md)
  const issues: { path: string; reason: string; severity: 'warn' | 'error' }[] = []
  let status: PortfolioStatus = 'draft'
  let version = 1
  for (const line of body.split('\n')) {
    const m = line.match(/^>\s*(\w+):\s*(.+)$/)
    if (!m) continue
    if (m[1] === 'status') {
      if (PROJECT_STATUSES.includes(m[2] as PortfolioStatus)) status = m[2] as PortfolioStatus
      else issues.push({ path: 'status', reason: `非法状态 ${JSON.stringify(m[2])}（合法值：${PROJECT_STATUSES.join('/')}）`, severity: 'warn' })
    } else if (m[1] === 'version') {
      const v = Number(m[2])
      if (Number.isInteger(v) && v >= 1) version = v
      else issues.push({ path: 'version', reason: `非法版本号 ${JSON.stringify(m[2])}`, severity: 'warn' })
    }
  }
  const factItems: PortfolioFactItem[] = []
  for (const row of parseTableRows(body, /##\s*项目事实/)) {
    const [id = '', statement = '', type = '', evidence = ''] = row
    factItems.push({
      id,
      statement,
      type,
      evidenceRefs: evidence === '-' || evidence === '' ? [] : evidence.split(',').map((s) => s.trim()).filter(Boolean),
    })
  }
  const evidence: PortfolioEvidence[] = []
  for (const row of parseTableRows(body, /##\s*证据资产/)) {
    const [id = '', type = '', location = '', metadata = ''] = row
    if (!EVIDENCE_TYPES.includes(type as PortfolioEvidenceType)) {
      issues.push({ path: id, reason: `非法证据类型 ${JSON.stringify(type)}（合法值：${EVIDENCE_TYPES.join('/')}）`, severity: 'warn' })
    }
    const metaMap: Record<string, string> | undefined =
      metadata === '-' || metadata === ''
        ? undefined
        : Object.fromEntries(
            metadata.split('；').map((kv) => {
              const i = kv.indexOf('=')
              return i <= 0 ? [kv.trim(), ''] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]
            }),
          )
    evidence.push({ id, type: type as PortfolioEvidenceType, location, ...(metaMap ? { metadata: metaMap } : {}) })
  }
  const transitions: PortfolioTransitionRecord[] = []
  for (const row of parseTableRows(body, /##\s*演化记录/)) {
    const [v = '', from = '', to = '', at = '', via = ''] = row
    transitions.push({ version: Number(v), from: from === '-' ? '' : from, to, at, ...(via && via !== '-' ? { via } : {}) })
  }
  return {
    sourceFile,
    record: {
      id: meta.id ?? sourceFile.replace(/\.md$/, ''), // 暂存文件用文件名兜底，登记后替换系统 ID
      status,
      version,
      factItems,
      evidence,
      transitions,
      ...(meta.created_at ? { createdAt: meta.created_at } : {}),
      ...(meta.source_file ? { sourceFile: meta.source_file } : {}),
    },
    issues,
  }
}

/** 引擎写回（frontmatter + status/version + 三表；roundtrip：parse(serialize(p)) 还原） */
export function serializePortfolioProject(p: PortfolioProject): string {
  const facts = p.factItems.map((f) => `| ${f.id} | ${f.statement} | ${f.type} | ${f.evidenceRefs.length > 0 ? f.evidenceRefs.join(', ') : '-'} |`).join('\n')
  const evs = p.evidence
    .map((e) => `| ${e.id} | ${e.type} | ${e.location} | ${e.metadata ? Object.entries(e.metadata).map(([k, v]) => `${k}=${v}`).join('；') : '-'} |`)
    .join('\n')
  const trans = p.transitions.map((t) => `| ${t.version} | ${t.from || '-'} | ${t.to} | ${t.at} | ${t.via ?? '-'} |`).join('\n')
  return `---
id: ${p.id}
created_at: ${p.createdAt ?? ''}
source_file: ${p.sourceFile ?? ''}
---

> status: ${p.status}
> version: ${p.version}

## 项目事实

| id | statement | type | evidence |
|----|-----------|------|----------|
${facts}

## 证据资产

| id | type | location | metadata |
|----|------|----------|----------|
${evs}

## 演化记录

| version | from | to | at | via |
|---------|------|----|----|-----|
${trans}
`
}

// ─── Portfolio Proposal ───────────────────────────────────────────────────

export interface ParsedPortfolioProposal {
  sourceFile: string
  record: PortfolioProposal
  issues: { path: string; reason: string; severity: 'warn' | 'error' }[]
}

/** `## 提案摘要` 表（Portfolio 自己的摘要协议——不复用 Resume `## 分析摘要`） */
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

/** `## 变更建议` 段：`- pf_001（type: rewrite；old: "..."；new: "..."；reason: "..."）` */
function parseProposalChanges(md: string): { changes: PortfolioProposalChange[]; issues: { path: string; reason: string; severity: 'warn' | 'error' }[] } {
  const issues: { path: string; reason: string; severity: 'warn' | 'error' }[] = []
  const changes: PortfolioProposalChange[] = []
  for (const line of sectionLines(md, /##\s*变更建议/)) {
    const m = line.match(/^\s*[-*]\s*([\w-]+)（(.+)）\s*$/)
    if (!m) continue
    const change: PortfolioProposalChange = { type: 'rewrite', factId: m[1], old: '', new: '', reason: '' }
    for (const kv of splitRespectingQuotes(m[2], '；')) {
      const idx = kv.indexOf(':')
      if (idx <= 0) continue
      const k = kv.slice(0, idx).trim()
      let v = kv.slice(idx + 1).trim()
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1)
      if (k === 'type') {
        if (CHANGE_TYPES.includes(v as 'rewrite')) change.type = v as 'rewrite'
        else issues.push({ path: m[1], reason: `非法变更类型 ${JSON.stringify(v)}（v0.1 仅 rewrite）`, severity: 'warn' })
      } else if (k === 'old') change.old = v
      else if (k === 'new') change.new = v
      else if (k === 'reason') change.reason = v
    }
    changes.push(change)
  }
  return { changes, issues }
}

/** `## 验证` 快照段（引擎写回；`- {status} | {code} | {message} | {target}`） */
function parsePortfolioValidation(md: string): PortfolioValidation | undefined {
  const lines = sectionLines(md, /##\s*验证/)
  if (lines.length === 0) return undefined
  const issues: PortfolioValidationIssue[] = []
  let status: PortfolioValidation['status'] | undefined
  for (const line of lines) {
    const m = line.match(/^\s*-\s*(valid|warning|invalid)\s*\|\s*([^|]*)\s*\|\s*([^|]*)\s*\|\s*(.*?)\s*$/)
    if (!m) continue
    status ??= m[1] as PortfolioValidation['status']
    if (m[2].trim() === '-' || m[2].trim() === '') continue
    issues.push({ code: m[2].trim(), message: m[3].trim(), target: m[4].trim() })
  }
  return status ? { status, issues } : undefined
}

/** PortfolioProposal → 存储 md（roundtrip：parsePortfolioProposal(serialize(p)) 还原全部字段） */
export function serializePortfolioProposal(p: PortfolioProposal): string {
  const rows = [
    `| type | portfolio_proposal |`,
    `| project_id | ${p.projectId} |`,
    `| status | ${p.status} |`,
    `| created_by | ${p.createdBy} |`,
    ...(p.createdAt ? [`| created_at | ${p.createdAt} |`] : []),
    ...(p.decidedAt ? [`| decided_at | ${p.decidedAt} |`] : []),
    ...(p.acceptReason ? [`| accept_reason | ${p.acceptReason} |`] : []),
    ...(p.rejectReason ? [`| reject_reason | ${p.rejectReason} |`] : []),
    ...(p.resultVersion !== undefined ? [`| result_version | ${p.resultVersion} |`] : []),
  ].join('\n')
  const changes = p.changes.map((c) => `- ${c.factId}（type: ${c.type}；old: "${c.old}"；new: "${c.new}"；reason: "${c.reason}"）`).join('\n')
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
export function parsePortfolioProposal(md: string, sourceFile: string): ParsedPortfolioProposal {
  const { meta, body } = splitFrontmatter(md)
  const issues: { path: string; reason: string; severity: 'warn' | 'error' }[] = []
  const fields = parseSummaryTable(body)
  if (!fields) {
    issues.push({ path: sourceFile, reason: '未找到 `## 提案摘要` 表格', severity: 'error' })
    return { sourceFile, record: { id: meta.id ?? sourceFile.replace(/\.md$/, ''), projectId: '', changes: [], status: 'pending', createdBy: 'ai' }, issues }
  }
  if (!fields.project_id || fields.project_id === '-') issues.push({ path: 'project_id', reason: '缺失（摘要表未填）', severity: 'error' })
  if (fields.type && fields.type !== 'portfolio_proposal') {
    issues.push({ path: 'type', reason: `非法值 ${JSON.stringify(fields.type)}（合法值：portfolio_proposal）`, severity: 'warn' })
  }
  const status = fields.status as PortfolioProposalStatus
  if (fields.status && !PROPOSAL_STATUSES.includes(status)) {
    issues.push({ path: 'status', reason: `非法值 ${JSON.stringify(fields.status)}（合法值：${PROPOSAL_STATUSES.join('/')}）`, severity: 'warn' })
  }
  const { changes, issues: changeIssues } = parseProposalChanges(body)
  issues.push(...changeIssues)
  const validation = parsePortfolioValidation(body)

  const record: PortfolioProposal = {
    id: meta.id ?? sourceFile.replace(/\.md$/, ''),
    projectId: fields.project_id ?? '',
    changes,
    status: PROPOSAL_STATUSES.includes(status) ? status : 'pending',
    createdBy: 'ai',
    ...(fields.created_at ? { createdAt: fields.created_at } : {}),
    ...(fields.decided_at ? { decidedAt: fields.decided_at } : {}),
    ...(fields.accept_reason ? { acceptReason: fields.accept_reason } : {}),
    ...(fields.reject_reason ? { rejectReason: fields.reject_reason } : {}),
    ...(fields.result_version ? { resultVersion: Number(fields.result_version) } : {}),
    ...(validation ? { validation } : {}),
  }
  return { sourceFile, record, issues }
}

// ─── 验证（P-01~P-07 纯函数，注册/扫描/accept 共用）──

const PROPOSAL_ERROR_CODES = new Set(['P-01', 'P-02', 'P-03', 'P-04', 'P-05', 'NO_CHANGES'])

/** 登记前校验（含 apply 可行性）；error 码 → invalid，其余 warn → warning */
export function validatePortfolioProposal(p: PortfolioProposal, project: PortfolioProject | undefined): PortfolioValidation {
  const issues: PortfolioValidationIssue[] = []
  if (!project) {
    issues.push({ code: 'P-01', message: `项目不存在：${p.projectId}`, target: p.projectId })
    return { status: 'invalid', issues }
  }
  if (p.changes.length === 0) issues.push({ code: 'NO_CHANGES', message: '变更建议为空', target: p.id })
  for (const c of p.changes) {
    const fact = project.factItems.find((f) => f.id === c.factId)
    if (!fact) {
      issues.push({ code: 'P-02', message: `FactItem 不存在：${c.factId}`, target: c.factId })
      continue
    }
    if (normalizeSpace(fact.statement) !== normalizeSpace(c.old)) {
      issues.push({ code: 'P-03', message: 'old 与项目事实 statement 不匹配（防幻觉）', target: c.factId })
    }
    if (!c.new || c.new.trim().length === 0) issues.push({ code: 'P-04', message: 'new 为空', target: c.factId })
    if (c.type !== 'rewrite') {
      issues.push({ code: 'P-05', message: `非法变更类型 ${JSON.stringify(c.type)}（v0.1 仅 rewrite——禁止新增/删除 FactItem、触碰 evidenceRefs、改 Evidence）`, target: c.factId })
    }
    if (!c.reason || c.reason.trim().length === 0) issues.push({ code: 'P-06', message: 'reason 为空（建议不可解释）', target: c.factId })
  }
  const seen = new Set<string>()
  for (const c of p.changes) {
    if (seen.has(c.factId)) issues.push({ code: 'P-07', message: `同 fact 重复变更：${c.factId}`, target: c.factId })
    seen.add(c.factId)
  }
  const status = issues.some((i) => PROPOSAL_ERROR_CODES.has(i.code)) ? 'invalid' : issues.length > 0 ? 'warning' : 'valid'
  return { status, issues }
}

// ─── 扫描 / 登记 ──────────────────────────────────────────────────────────

/** 已登记判定：frontmatter id 为系统 ID 格式（登记时引擎注入） */
function isProjectRegistered(md: string): boolean {
  const id = splitFrontmatter(md).meta.id
  return id !== undefined && PROJECT_ID_RE.test(id)
}

/** 已登记判定：摘要表显式含 status 行（parse 默认 'pending' 不代表已登记） */
function isProposalRegistered(md: string): boolean {
  return parseSummaryTable(md)?.status !== undefined
}

function findProject(ws: Workspace, projectId: string): PortfolioProject | undefined {
  return scanPortfolioProjects(ws).find((p) => p.record.id === projectId)?.record
}

export function scanPortfolioProjects(ws: Workspace): ParsedProject[] {
  return ws.listMarkdown('portfolio/projects').sort().map((f) => {
    const md = ws.read(`portfolio/projects/${f}`)
    return parseProjectMarkdown(md, f)
  })
}

export function scanPortfolioProposals(ws: Workspace): ParsedPortfolioProposal[] {
  return ws.listMarkdown('portfolio/proposals').sort().map((f) => {
    const md = ws.read(`portfolio/proposals/${f}`)
    const parsed = parsePortfolioProposal(md, f)
    const record = isProposalRegistered(md)
      ? parsed.record
      : { ...parsed.record, validation: validatePortfolioProposal(parsed.record, findProject(ws, parsed.record.projectId)) }
    return { sourceFile: f, record, issues: parsed.issues }
  })
}

/** 单个项目文件登记：marker + 有事实 → 系统 ID + 初始化 draft/v1 + 演化记录首行（status/version 引擎单方管理） */
export function registerPortfolioProjectFile(ws: Workspace, fileName: string, now: Date = new Date()): boolean {
  const md = ws.read(`portfolio/projects/${fileName}`)
  if (!PORTFOLIO_SPEC.marker.test(md)) return false // 非项目格式不赋予系统身份
  if (isProjectRegistered(md)) return false
  const parsed = parseProjectMarkdown(md, fileName)
  if (parsed.record.factItems.length === 0) return false // 无事实的项目不登记
  const systemId = nextArtifactId(ws, PORTFOLIO_SPEC, now)
  const record: PortfolioProject = {
    ...parsed.record,
    id: systemId,
    status: 'draft',
    version: 1,
    createdAt: now.toISOString().slice(0, 10),
    sourceFile: fileName.replace(/\.md$/, ''),
    transitions: [{ version: 1, from: '', to: 'draft', at: now.toISOString() }],
  }
  ws.write(`portfolio/projects/${systemId}.md`, serializePortfolioProject(record))
  ws.delete(`portfolio/projects/${fileName}`)
  return true
}

/** 启动补登：引擎离线期间用户写入的项目（幂等——已登记跳过） */
export function registerPendingPortfolioProjects(ws: Workspace, now: Date = new Date()): number {
  let registered = 0
  for (const f of ws.listMarkdown('portfolio/projects')) {
    if (registerPortfolioProjectFile(ws, f, now)) registered++
  }
  return registered
}

/** 单个提案文件登记：marker + 非 invalid → 系统 ID + 引擎字段写回（invalid 不登记，AI 修正后 change 重试） */
export function registerPortfolioProposalFile(ws: Workspace, fileName: string, now: Date = new Date()): boolean {
  const md = ws.read(`portfolio/proposals/${fileName}`)
  if (!PORTFOLIO_PROPOSAL_SPEC.marker.test(md)) return false // 非提案格式不赋予系统身份
  if (isProposalRegistered(md)) return false // 已登记（引擎字段已写回）
  const parsed = parsePortfolioProposal(md, fileName)
  const validation = validatePortfolioProposal(parsed.record, findProject(ws, parsed.record.projectId))
  if (validation.status === 'invalid') return false
  const systemId = nextArtifactId(ws, PORTFOLIO_PROPOSAL_SPEC, now)
  const { body } = splitFrontmatter(md)
  const fm = ['---', `id: ${systemId}`, `created_at: ${now.toISOString().slice(0, 10)}`, `source_file: ${fileName.replace(/\.md$/, '')}`, '---', ''].join('\n')
  ws.write(`portfolio/proposals/${systemId}.md`, fm + body)
  ws.delete(`portfolio/proposals/${fileName}`)
  const record: PortfolioProposal = {
    ...parsed.record,
    id: systemId,
    status: 'pending',
    createdBy: 'ai',
    createdAt: now.toISOString(),
    validation,
  }
  ws.write(`portfolio/proposals/${systemId}.md`, serializePortfolioProposal(record))
  return true
}

/** 启动补登：引擎离线期间 AI 写入的提案（幂等——已登记跳过） */
export function registerPendingPortfolioProposals(ws: Workspace, now: Date = new Date()): number {
  let registered = 0
  for (const f of ws.listMarkdown('portfolio/proposals')) {
    if (registerPortfolioProposalFile(ws, f, now)) registered++
  }
  return registered
}

/** portfolio/ 监听：add → 登记 + 重扫；change/unlink → 重扫 */
export function watchPortfolio(ws: Workspace, onChanged: () => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.portfolio, { ignoreInitial: true })
  const rescan = (): void => onChanged()
  watcher.on('add', (p: string) => {
    if (!p.endsWith('.md')) return
    // Windows：chokidar 路径为反斜杠，统一转正斜杠再取文件名/子目录
    const norm = p.replace(/\\/g, '/')
    const name = norm.split('/').pop() ?? p
    if (norm.includes('/projects/')) registerPortfolioProjectFile(ws, name)
    if (norm.includes('/proposals/')) registerPortfolioProposalFile(ws, name)
    rescan()
  })
  watcher.on('change', () => rescan())
  watcher.on('unlink', () => rescan())
  return { close: () => watcher.close() }
}

// ─── State Machine（单向；published 不可回退）──

/** 单向状态机：draft→reviewed→published；reviewed→draft 打回允许（review 非 immutable）；published 无出口 */
const ALLOWED_TRANSITIONS: Record<PortfolioStatus, PortfolioStatus[]> = {
  draft: ['reviewed'],
  reviewed: ['draft', 'published'],
  published: [],
}

export class PortfolioTransitionError extends Error {}

/** transition：status 变化 + 演化记录追加（version 不变——版本是内容版本，apply 才递增） */
export function transitionPortfolioProject(ws: Workspace, id: string, target: PortfolioStatus, now: Date = new Date()): PortfolioProject {
  const entry = scanPortfolioProjects(ws).find((p) => p.record.id === id)
  if (!entry) throw new PortfolioTransitionError(`项目不存在：${id}`)
  const p = entry.record
  if (!ALLOWED_TRANSITIONS[p.status].includes(target)) {
    throw new PortfolioTransitionError(`非法状态转移：${p.status} → ${target}（published 不可回退；修改必须走 Proposal → draft(v+1)）`)
  }
  const updated: PortfolioProject = {
    ...p,
    status: target,
    transitions: [...p.transitions, { version: p.version, from: p.status, to: target, at: now.toISOString() }],
  }
  ws.write(`portfolio/projects/${entry.sourceFile}`, serializePortfolioProject(updated))
  return updated
}

// ─── 决策（accept → apply / reject，单向不 reopen；AI 不能自批）──

export interface ApplyPortfolioResult {
  project: PortfolioProject
  proposal: PortfolioProposal
}

/** accept：P-01~P-07 重校验 → statement 改写 + version+1 + status=draft + transitions 追加（永不覆盖历史）。
 *  reason 可选（Human Preference Signal——"为什么成功"，与 rejectReason 对称） */
export function acceptPortfolioProposal(ws: Workspace, id: string, reason?: string, now: Date = new Date()): ApplyPortfolioResult {
  const entry = scanPortfolioProposals(ws).find((p) => p.record.id === id)
  if (!entry) throw new PortfolioTransitionError(`提案不存在：${id}`)
  const p = entry.record
  if (p.status !== 'pending') throw new PortfolioTransitionError(`只能接受 pending 提案（当前状态 ${p.status}）`)
  const projectEntry = scanPortfolioProjects(ws).find((x) => x.record.id === p.projectId)
  if (!projectEntry) throw new PortfolioTransitionError(`项目不存在：${p.projectId}`)
  const project = projectEntry.record
  const validation = validatePortfolioProposal(p, project)
  if (validation.status === 'invalid') {
    throw new PortfolioTransitionError(`提案校验失败（${validation.issues.map((i) => i.code).join('/')}）——状态不变，请重新提案`)
  }
  const nextVersion = project.version + 1
  const updated: PortfolioProject = {
    ...project,
    version: nextVersion,
    status: 'draft', // apply 后重置 draft：published 修改必须 draft(v+1)（immutable published）
    factItems: project.factItems.map((f) => {
      const change = p.changes.find((c) => c.factId === f.id)
      return change ? { ...f, statement: change.new } : f
    }),
    transitions: [...project.transitions, { version: nextVersion, from: project.status, to: 'draft', at: now.toISOString(), via: p.id }],
  }
  ws.write(`portfolio/projects/${projectEntry.sourceFile}`, serializePortfolioProject(updated))
  const updatedProposal: PortfolioProposal = {
    ...p,
    status: 'accepted',
    decidedAt: now.toISOString(),
    ...(reason && reason.trim().length > 0 ? { acceptReason: reason.replace(/\|/g, '／') } : {}),
    resultVersion: nextVersion,
  }
  ws.write(`portfolio/proposals/${entry.sourceFile}`, serializePortfolioProposal(updatedProposal))
  return { project: updated, proposal: updatedProposal }
}

/** reject：pending → rejected（保留审计；重新建议 = 写新 Proposal） */
export function rejectPortfolioProposal(ws: Workspace, id: string, reason?: string, now: Date = new Date()): PortfolioProposal {
  const entry = scanPortfolioProposals(ws).find((p) => p.record.id === id)
  if (!entry) throw new PortfolioTransitionError(`提案不存在：${id}`)
  const p = entry.record
  if (p.status !== 'pending') throw new PortfolioTransitionError(`只能拒绝 pending 提案（当前状态 ${p.status}）`)
  const updated: PortfolioProposal = {
    ...p,
    status: 'rejected',
    decidedAt: now.toISOString(),
    ...(reason && reason.trim().length > 0 ? { rejectReason: reason.replace(/\|/g, '／') } : {}),
  }
  ws.write(`portfolio/proposals/${entry.sourceFile}`, serializePortfolioProposal(updated))
  return updated
}

// ─── Read Projection（引擎确定性聚合；不成为事实存储）──

export function buildPortfolioContext(ws: Workspace): PortfolioContext {
  return { projects: scanPortfolioProjects(ws).map((p) => p.record) }
}
