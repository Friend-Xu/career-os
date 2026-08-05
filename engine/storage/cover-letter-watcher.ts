/**
 * cover-letter-watcher（M4-3.2）：Cover Letter Artifact 存储服务。
 * - 契约：COVER-LETTER-ARTIFACT-M4-v0.1（第一个 Projection Artifact）
 * - Cover Letter：用户写叙述单元（cover-letters/暂存名.md）→ 引擎登记系统 ID + 初始化 draft + 演化记录
 * - 提案：AI 写（cover-letters/proposals/）→ 登记 pending → accept（CL-01~CL-07 校验 →
 *   NarrativeUnit.text 改写 + status=draft + transitions 追加）| reject（reason 写回，单向不 reopen）
 * - transition：draft→reviewed→ready 单向；ready 不可直接回退（修改必须 Proposal → draft）
 * - Source Fact Resolver：解析 sourceRefs → 事实快照（只读，不修改任何源 Artifact——单向依赖验证点）
 * - projection：buildCoverLetterContext（含 factStatement 快照；断链显式缺省）
 */
import { watch } from 'chokidar'
import type { Workspace } from './workspace.ts'
import { splitFrontmatter, nextArtifactId, type ArtifactSpec } from './artifact-registry.ts'
import type {
  CoverLetter,
  CoverLetterProposal,
  CoverLetterProposalChange,
  CoverLetterProposalStatus,
  CoverLetterStatus,
  CoverLetterTransitionRecord,
  CoverLetterValidation,
  CoverLetterValidationIssue,
  CoverLetterContext,
  DeliveryRecord,
  NarrativeSourceRef,
  NarrativeUnit,
  SourceArtifactType,
} from '../ir/cover-letter.ts'
import { scanClaims } from './claim-watcher.ts'
import { scanPortfolioProjects } from './portfolio-watcher.ts'
import { scanInterviewQas } from './interview-watcher.ts'

export const COVER_LETTER_SPEC: ArtifactSpec = {
  type: 'cover_letter',
  dir: 'cover-letters',
  idPrefix: 'cl_',
  marker: /##\s*叙述单元/,
  passthroughFields: [],
}

export const COVER_LETTER_PROPOSAL_SPEC: ArtifactSpec = {
  type: 'cover_letter_proposal',
  dir: 'cover-letters/proposals',
  idPrefix: 'clp_',
  marker: /##\s*提案摘要/,
  passthroughFields: [],
}

const CL_STATUSES: CoverLetterStatus[] = ['draft', 'reviewed', 'ready']
const PROPOSAL_STATUSES: CoverLetterProposalStatus[] = ['pending', 'accepted', 'rejected']
const ARTIFACT_TYPES: SourceArtifactType[] = ['resume', 'portfolio', 'interview']
const CHANGE_TYPES = ['adapt'] as const

const CL_ID_RE = /^cl_\d{8}_\d{5}$/

/** old 逐字匹配前的空格标准化（CL-03：空白差异不判漂移） */
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

/** `## 叙述单元` 行格式：`- nu_001（text: "..."；refs: resume.claim_xxx, portfolio.project_xxx.pf_001；intent: "..."）` */
function parseUnits(md: string): { units: NarrativeUnit[]; issues: { path: string; reason: string; severity: 'warn' | 'error' }[] } {
  const issues: { path: string; reason: string; severity: 'warn' | 'error' }[] = []
  const units: NarrativeUnit[] = []
  for (const line of sectionLines(md, /##\s*叙述单元/)) {
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
    const sourceRefs = parseRefs(kvs.refs ?? '')
    const missingArtifacts = sourceRefs.filter((r) => !ARTIFACT_TYPES.includes(r.artifact))
    for (const r of missingArtifacts) {
      issues.push({ path: m[1], reason: `非法源 Artifact 类型 ${JSON.stringify(r.artifact)}（合法值：${ARTIFACT_TYPES.join('/')}）`, severity: 'warn' })
    }
    if (sourceRefs.length === 0) {
      issues.push({ path: m[1], reason: 'unit 无来源引用（sourceRefs 必填，MUST ≥ 1）', severity: 'error' })
    }
    if (!kvs.text || kvs.text.trim().length === 0) {
      issues.push({ path: m[1], reason: 'unit 文本为空', severity: 'warn' })
    }
    units.push({
      id: m[1],
      text: kvs.text ?? '',
      sourceRefs: sourceRefs.filter((r) => ARTIFACT_TYPES.includes(r.artifact)),
      ...(kvs.intent && kvs.intent.trim().length > 0 ? { intent: kvs.intent } : {}),
    })
  }
  return { units, issues }
}

/** refs 列表解析：`resume.claim_xxx`（2 段）或 `portfolio.project_xxx.pf_001`（3 段，scopeId 必填） */
function parseRefs(raw: string): NarrativeSourceRef[] {
  if (raw === '-' || raw === '') return []
  const refs: NarrativeSourceRef[] = []
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const segs = part.split('.')
    if (segs.length === 2) {
      refs.push({ artifact: segs[0] as SourceArtifactType, factId: segs[1] })
    } else if (segs.length === 3) {
      refs.push({ artifact: segs[0] as SourceArtifactType, scopeId: segs[1], factId: segs[2] })
    } else {
      refs.push({ artifact: 'resume', factId: part }) // 非法格式——artifact 校验会标 warn
    }
  }
  return refs
}

/** refs 序列化：resume 2 段；portfolio/interview 3 段（scopeId） */
function serializeRefs(refs: NarrativeSourceRef[]): string {
  return refs.map((r) => (r.scopeId ? `${r.artifact}.${r.scopeId}.${r.factId}` : `${r.artifact}.${r.factId}`)).join(', ')
}

// ─── Cover Letter 文件 ───────────────────────────────────────────────────

export interface ParsedCoverLetter {
  sourceFile: string
  record: CoverLetter
  issues: { path: string; reason: string; severity: 'warn' | 'error' }[]
}

/** Cover Letter md → IR（`> status/target_*` 行 + 叙述单元行 + 投递/演化记录表） */
export function parseCoverLetterMarkdown(md: string, sourceFile: string): ParsedCoverLetter {
  const { meta, body } = splitFrontmatter(md)
  const issues: { path: string; reason: string; severity: 'warn' | 'error' }[] = []
  let status: CoverLetterStatus = 'draft'
  let targetCompany: string | undefined
  let targetJobId: string | undefined
  for (const line of body.split('\n')) {
    const m = line.match(/^>\s*(\w+):\s*(.+)$/)
    if (!m) continue
    if (m[1] === 'status') {
      if (CL_STATUSES.includes(m[2] as CoverLetterStatus)) status = m[2] as CoverLetterStatus
      else issues.push({ path: 'status', reason: `非法状态 ${JSON.stringify(m[2])}（合法值：${CL_STATUSES.join('/')}）`, severity: 'warn' })
    } else if (m[1] === 'target_company') targetCompany = m[2]
    else if (m[1] === 'target_job') targetJobId = m[2]
  }

  const { units, issues: unitIssues } = parseUnits(body)
  issues.push(...unitIssues)

  const deliveries: DeliveryRecord[] = []
  for (const row of parseTableRows(body, /##\s*投递记录/)) {
    const [company = '', job = '', at = ''] = row
    deliveries.push({ targetCompany: company, ...(job && job !== '-' ? { targetJobId: job } : {}), at })
  }

  const transitions: CoverLetterTransitionRecord[] = []
  for (const row of parseTableRows(body, /##\s*演化记录/)) {
    const [from = '', to = '', at = '', via = ''] = row
    transitions.push({ from: from === '-' ? '' : from, to, at, ...(via && via !== '-' ? { via } : {}) })
  }

  return {
    sourceFile,
    record: {
      id: meta.id ?? sourceFile.replace(/\.md$/, ''), // 暂存文件用文件名兜底，登记后替换系统 ID
      status,
      units,
      ...(targetCompany ? { targetCompany } : {}),
      ...(targetJobId ? { targetJobId } : {}),
      deliveries,
      transitions,
      ...(meta.created_at ? { createdAt: meta.created_at } : {}),
      ...(meta.source_file ? { sourceFile: meta.source_file } : {}),
    },
    issues,
  }
}

/** 引擎写回（frontmatter + status/target_* + 叙述单元 + 投递/演化记录；roundtrip） */
export function serializeCoverLetter(cl: CoverLetter): string {
  const units = cl.units
    .map((u) => `- ${u.id}（text: "${u.text}"；refs: ${serializeRefs(u.sourceRefs)}${u.intent ? `；intent: "${u.intent}"` : ''}）`)
    .join('\n')
  const deliveries = cl.deliveries.map((d) => `| ${d.targetCompany} | ${d.targetJobId ?? '-'} | ${d.at} |`).join('\n')
  const trans = cl.transitions.map((t) => `| ${t.from || '-'} | ${t.to} | ${t.at} | ${t.via ?? '-'} |`).join('\n')
  return `---
id: ${cl.id}
created_at: ${cl.createdAt ?? ''}
source_file: ${cl.sourceFile ?? ''}
---

> status: ${cl.status}
${cl.targetCompany ? `> target_company: ${cl.targetCompany}` : ''}
${cl.targetJobId ? `> target_job: ${cl.targetJobId}` : ''}

## 叙述单元

${units}

## 投递记录

| targetCompany | targetJob | at |
|---------------|-----------|-----|
${deliveries}

## 演化记录

| from | to | at | via |
|------|----|----|-----|
${trans}
`
}

// ─── Source Fact Resolver（只读——不修改任何源 Artifact）──

/** 解析单个引用 → 事实快照（不存在/歧义返回 undefined——断链显式可见） */
export function resolveSourceFact(ws: Workspace, ref: NarrativeSourceRef): string | undefined {
  if (ref.artifact === 'resume') {
    return scanClaims(ws).find((c) => c.record.id === ref.factId)?.record.statement
  }
  if (ref.artifact === 'portfolio') {
    if (!ref.scopeId) return undefined
    return scanPortfolioProjects(ws)
      .find((p) => p.record.id === ref.scopeId)
      ?.record.factItems.find((f) => f.id === ref.factId)?.statement
  }
  if (ref.artifact === 'interview') {
    if (!ref.scopeId) return undefined
    return scanInterviewQas(ws)
      .find((q) => q.record.id === ref.scopeId)
      ?.record.factItems.find((f) => f.id === ref.factId)?.statement
  }
  return undefined
}

/** 解析一组引用 → 成功快照 + 缺失列表（断链聚合） */
export function resolveSourceRefs(ws: Workspace, refs: NarrativeSourceRef[]): { resolved: (NarrativeSourceRef & { factStatement: string })[]; missing: NarrativeSourceRef[] } {
  const resolved: (NarrativeSourceRef & { factStatement: string })[] = []
  const missing: NarrativeSourceRef[] = []
  for (const ref of refs) {
    const statement = resolveSourceFact(ws, ref)
    if (statement === undefined) missing.push(ref)
    else resolved.push({ ...ref, factStatement: statement })
  }
  return { resolved, missing }
}

// ─── Cover Letter Proposal ───────────────────────────────────────────────

export interface ParsedCoverLetterProposal {
  sourceFile: string
  record: CoverLetterProposal
  issues: { path: string; reason: string; severity: 'warn' | 'error' }[]
}

/** `## 提案摘要` 表（Cover Letter 自己的摘要协议） */
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

/** `## 变更建议` 段：`- nu_001（type: adapt；old: "..."；new: "..."；reason: "..."）` */
function parseProposalChanges(md: string): { changes: CoverLetterProposalChange[]; issues: { path: string; reason: string; severity: 'warn' | 'error' }[] } {
  const issues: { path: string; reason: string; severity: 'warn' | 'error' }[] = []
  const changes: CoverLetterProposalChange[] = []
  for (const line of sectionLines(md, /##\s*变更建议/)) {
    const m = line.match(/^\s*[-*]\s*([\w-]+)（(.+)）\s*$/)
    if (!m) continue
    const change: CoverLetterProposalChange = { type: 'adapt', unitId: m[1], old: '', new: '', reason: '' }
    for (const kv of splitRespectingQuotes(m[2], '；')) {
      const idx = kv.indexOf(':')
      if (idx <= 0) continue
      const k = kv.slice(0, idx).trim()
      let v = kv.slice(idx + 1).trim()
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1)
      if (k === 'type') {
        if (CHANGE_TYPES.includes(v as 'adapt')) change.type = v as 'adapt'
        else issues.push({ path: m[1], reason: `非法变更类型 ${JSON.stringify(v)}（v0.1 仅 adapt——禁止触碰 sourceRefs/intent/新事实）`, severity: 'warn' })
      } else if (k === 'old') change.old = v
      else if (k === 'new') change.new = v
      else if (k === 'reason') change.reason = v
    }
    changes.push(change)
  }
  return { changes, issues }
}

/** `## 验证` 快照段（引擎写回；占位行 normalize 为 no issue——Empty Validation Representation Rule） */
function parseCoverLetterValidation(md: string): CoverLetterValidation | undefined {
  const lines = sectionLines(md, /##\s*验证/)
  if (lines.length === 0) return undefined
  const issues: CoverLetterValidationIssue[] = []
  let status: CoverLetterValidation['status'] | undefined
  for (const line of lines) {
    const m = line.match(/^\s*-\s*(valid|warning|invalid)\s*\|\s*([^|]*)\s*\|\s*([^|]*)\s*\|\s*(.*?)\s*$/)
    if (!m) continue
    status ??= m[1] as CoverLetterValidation['status']
    if (m[2].trim() === '-' || m[2].trim() === '') continue
    issues.push({ code: m[2].trim(), message: m[3].trim(), target: m[4].trim() })
  }
  return status ? { status, issues } : undefined
}

/** CoverLetterProposal → 存储 md（roundtrip：parseCoverLetterProposal(serialize(p)) 还原全部字段） */
export function serializeCoverLetterProposal(p: CoverLetterProposal): string {
  const rows = [
    `| type | cover_letter_proposal |`,
    `| cl_id | ${p.clId} |`,
    `| status | ${p.status} |`,
    `| created_by | ${p.createdBy} |`,
    ...(p.createdAt ? [`| created_at | ${p.createdAt} |`] : []),
    ...(p.decidedAt ? [`| decided_at | ${p.decidedAt} |`] : []),
    ...(p.acceptReason ? [`| accept_reason | ${p.acceptReason} |`] : []),
    ...(p.rejectReason ? [`| reject_reason | ${p.rejectReason} |`] : []),
  ].join('\n')
  const changes = p.changes.map((c) => `- ${c.unitId}（type: ${c.type}；old: "${c.old}"；new: "${c.new}"；reason: "${c.reason}"）`).join('\n')
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
export function parseCoverLetterProposal(md: string, sourceFile: string): ParsedCoverLetterProposal {
  const { meta, body } = splitFrontmatter(md)
  const issues: { path: string; reason: string; severity: 'warn' | 'error' }[] = []
  const fields = parseSummaryTable(body)
  if (!fields) {
    issues.push({ path: sourceFile, reason: '未找到 `## 提案摘要` 表格', severity: 'error' })
    return { sourceFile, record: { id: meta.id ?? sourceFile.replace(/\.md$/, ''), clId: '', changes: [], status: 'pending', createdBy: 'ai' }, issues }
  }
  if (!fields.cl_id || fields.cl_id === '-') issues.push({ path: 'cl_id', reason: '缺失（摘要表未填）', severity: 'error' })
  if (fields.type && fields.type !== 'cover_letter_proposal') {
    issues.push({ path: 'type', reason: `非法值 ${JSON.stringify(fields.type)}（合法值：cover_letter_proposal）`, severity: 'warn' })
  }
  const status = fields.status as CoverLetterProposalStatus
  if (fields.status && !PROPOSAL_STATUSES.includes(status)) {
    issues.push({ path: 'status', reason: `非法值 ${JSON.stringify(fields.status)}（合法值：${PROPOSAL_STATUSES.join('/')}）`, severity: 'warn' })
  }
  const { changes, issues: changeIssues } = parseProposalChanges(body)
  issues.push(...changeIssues)
  const validation = parseCoverLetterValidation(body)

  const record: CoverLetterProposal = {
    id: meta.id ?? sourceFile.replace(/\.md$/, ''),
    clId: fields.cl_id ?? '',
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

// ─── 验证（CL-01~CL-07 纯函数，resolveFact 依赖注入；注册/扫描/accept 共用）──

const PROPOSAL_ERROR_CODES = new Set(['CL-01', 'CL-02', 'CL-03', 'CL-04', 'CL-05', 'CL-08', 'NO_CHANGES'])

/** 登记前校验（含 apply 可行性）；error 码 → invalid，其余 warn → warning */
export function validateCoverLetterProposal(
  p: CoverLetterProposal,
  cl: CoverLetter | undefined,
  resolveFact: (ref: NarrativeSourceRef) => string | undefined,
): CoverLetterValidation {
  const issues: CoverLetterValidationIssue[] = []
  if (!cl) {
    issues.push({ code: 'CL-08', message: `Cover Letter 不存在：${p.clId}`, target: p.clId })
    return { status: 'invalid', issues }
  }
  if (p.changes.length === 0) issues.push({ code: 'NO_CHANGES', message: '变更建议为空', target: p.id })
  for (const c of p.changes) {
    const unit = cl.units.find((u) => u.id === c.unitId)
    if (!unit) {
      issues.push({ code: 'CL-02', message: `NarrativeUnit 不存在：${c.unitId}`, target: c.unitId })
      continue
    }
    for (const ref of unit.sourceRefs) {
      if (resolveFact(ref) === undefined) {
        const target = ref.scopeId ? `${ref.artifact}.${ref.scopeId}.${ref.factId}` : `${ref.artifact}.${ref.factId}`
        issues.push({ code: 'CL-01', message: `源引用不存在：${target}（断链——引用必须指向源 Artifact Fact Layer）`, target: target })
      }
    }
    if (normalizeSpace(unit.text) !== normalizeSpace(c.old)) {
      issues.push({ code: 'CL-03', message: 'old 与 NarrativeUnit.text 不匹配（防幻觉）', target: c.unitId })
    }
    if (!c.new || c.new.trim().length === 0) issues.push({ code: 'CL-04', message: 'new 为空', target: c.unitId })
    if (c.type !== 'adapt') {
      issues.push({ code: 'CL-05', message: `非法变更类型 ${JSON.stringify(c.type)}（v0.1 仅 adapt——禁止触碰 sourceRefs/intent/新事实）`, target: c.unitId })
    }
    if (!c.reason || c.reason.trim().length === 0) issues.push({ code: 'CL-06', message: 'reason 为空（建议不可解释）', target: c.unitId })
  }
  const seen = new Set<string>()
  for (const c of p.changes) {
    if (seen.has(c.unitId)) issues.push({ code: 'CL-07', message: `同 unit 重复变更：${c.unitId}`, target: c.unitId })
    seen.add(c.unitId)
  }
  const status = issues.some((i) => PROPOSAL_ERROR_CODES.has(i.code)) ? 'invalid' : issues.length > 0 ? 'warning' : 'valid'
  return { status, issues }
}

// ─── 扫描 / 登记 ─────────────────────────────────────────────────────────

/** 已登记判定：frontmatter id 为系统 ID 格式（登记时引擎注入） */
function isRegistered(md: string): boolean {
  const id = splitFrontmatter(md).meta.id
  return id !== undefined && CL_ID_RE.test(id)
}

/** 已登记判定：摘要表显式含 status 行（parse 默认 'pending' 不代表已登记） */
function isProposalRegistered(md: string): boolean {
  return parseSummaryTable(md)?.status !== undefined
}

function findCoverLetter(ws: Workspace, clId: string): CoverLetter | undefined {
  return scanCoverLetters(ws).find((c) => c.record.id === clId)?.record
}

export function scanCoverLetters(ws: Workspace): ParsedCoverLetter[] {
  return ws.listMarkdown('cover-letters').sort().map((f) => {
    const md = ws.read(`cover-letters/${f}`)
    return parseCoverLetterMarkdown(md, f)
  })
}

export function scanCoverLetterProposals(ws: Workspace): ParsedCoverLetterProposal[] {
  return ws.listMarkdown('cover-letters/proposals').sort().map((f) => {
    const md = ws.read(`cover-letters/proposals/${f}`)
    const parsed = parseCoverLetterProposal(md, f)
    const record = isProposalRegistered(md)
      ? parsed.record
      : { ...parsed.record, validation: validateCoverLetterProposal(parsed.record, findCoverLetter(ws, parsed.record.clId), (ref) => resolveSourceFact(ws, ref)) }
    return { sourceFile: f, record, issues: parsed.issues }
  })
}

/** 单个 Cover Letter 文件登记：marker + 有叙述单元 → 系统 ID + 初始化 draft + 演化记录首行 */
export function registerCoverLetterFile(ws: Workspace, fileName: string, now: Date = new Date()): boolean {
  const md = ws.read(`cover-letters/${fileName}`)
  if (!COVER_LETTER_SPEC.marker.test(md)) return false // 非 Cover Letter 格式不赋予系统身份
  if (isRegistered(md)) return false
  const parsed = parseCoverLetterMarkdown(md, fileName)
  if (parsed.record.units.length === 0) return false // 无叙述单元的 Cover Letter 不登记
  const systemId = nextArtifactId(ws, COVER_LETTER_SPEC, now)
  const record: CoverLetter = {
    ...parsed.record,
    id: systemId,
    status: 'draft',
    createdAt: now.toISOString().slice(0, 10),
    sourceFile: fileName.replace(/\.md$/, ''),
    transitions: [{ from: '', to: 'draft', at: now.toISOString() }],
  }
  ws.write(`cover-letters/${systemId}.md`, serializeCoverLetter(record))
  ws.delete(`cover-letters/${fileName}`)
  return true
}

/** 启动补登：引擎离线期间用户写入的 Cover Letter（幂等——已登记跳过） */
export function registerPendingCoverLetters(ws: Workspace, now: Date = new Date()): number {
  let registered = 0
  for (const f of ws.listMarkdown('cover-letters')) {
    if (registerCoverLetterFile(ws, f, now)) registered++
  }
  return registered
}

/** 单个提案文件登记：marker + 非 invalid → 系统 ID + 引擎字段写回（invalid 不登记，AI 修正后 change 重试） */
export function registerCoverLetterProposalFile(ws: Workspace, fileName: string, now: Date = new Date()): boolean {
  const md = ws.read(`cover-letters/proposals/${fileName}`)
  if (!COVER_LETTER_PROPOSAL_SPEC.marker.test(md)) return false // 非提案格式不赋予系统身份
  if (isProposalRegistered(md)) return false // 已登记（引擎字段已写回）
  const parsed = parseCoverLetterProposal(md, fileName)
  const validation = validateCoverLetterProposal(parsed.record, findCoverLetter(ws, parsed.record.clId), (ref) => resolveSourceFact(ws, ref))
  if (validation.status === 'invalid') return false
  const systemId = nextArtifactId(ws, COVER_LETTER_PROPOSAL_SPEC, now)
  const { body } = splitFrontmatter(md)
  const fm = ['---', `id: ${systemId}`, `created_at: ${now.toISOString().slice(0, 10)}`, `source_file: ${fileName.replace(/\.md$/, '')}`, '---', ''].join('\n')
  ws.write(`cover-letters/proposals/${systemId}.md`, fm + body)
  ws.delete(`cover-letters/proposals/${fileName}`)
  const record: CoverLetterProposal = {
    ...parsed.record,
    id: systemId,
    status: 'pending',
    createdBy: 'ai',
    createdAt: now.toISOString(),
    validation,
  }
  ws.write(`cover-letters/proposals/${systemId}.md`, serializeCoverLetterProposal(record))
  return true
}

/** 启动补登：引擎离线期间 AI 写入的提案（幂等——已登记跳过） */
export function registerPendingCoverLetterProposals(ws: Workspace, now: Date = new Date()): number {
  let registered = 0
  for (const f of ws.listMarkdown('cover-letters/proposals')) {
    if (registerCoverLetterProposalFile(ws, f, now)) registered++
  }
  return registered
}

/** cover-letters/ 监听：add → 登记 + 重扫；change/unlink → 重扫 */
export function watchCoverLetters(ws: Workspace, onChanged: () => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.coverLetters, { ignoreInitial: true })
  const rescan = (): void => onChanged()
  watcher.on('add', (p: string) => {
    if (!p.endsWith('.md')) return
    // Windows：chokidar 路径为反斜杠，统一转正斜杠再取文件名/子目录
    const norm = p.replace(/\\/g, '/')
    const name = norm.split('/').pop() ?? p
    if (norm.includes('/proposals/')) registerCoverLetterProposalFile(ws, name)
    else registerCoverLetterFile(ws, name)
    rescan()
  })
  watcher.on('change', () => rescan())
  watcher.on('unlink', () => rescan())
  return { close: () => watcher.close() }
}

// ─── State Machine（单向；ready 不可回退）──

/** 单向状态机：draft→reviewed→ready；reviewed→draft 打回允许；ready 无出口（修改必须走 Proposal → draft） */
const ALLOWED_TRANSITIONS: Record<CoverLetterStatus, CoverLetterStatus[]> = {
  draft: ['reviewed'],
  reviewed: ['draft', 'ready'],
  ready: [],
}

export class CoverLetterTransitionError extends Error {}

/** transition：status 变化 + 演化记录追加（ready 不可直接回退——Proposal 应用产生新的 draft 演化事件） */
export function transitionCoverLetter(ws: Workspace, id: string, target: CoverLetterStatus, now: Date = new Date()): CoverLetter {
  const entry = scanCoverLetters(ws).find((c) => c.record.id === id)
  if (!entry) throw new CoverLetterTransitionError(`Cover Letter 不存在：${id}`)
  const cl = entry.record
  if (!ALLOWED_TRANSITIONS[cl.status].includes(target)) {
    throw new CoverLetterTransitionError(`非法状态转移：${cl.status} → ${target}（ready 不可直接回退；修改必须走 Proposal → draft 演化事件）`)
  }
  const updated: CoverLetter = {
    ...cl,
    status: target,
    transitions: [...cl.transitions, { from: cl.status, to: target, at: now.toISOString() }],
  }
  ws.write(`cover-letters/${entry.sourceFile}`, serializeCoverLetter(updated))
  return updated
}

// ─── 决策（accept → apply / reject，单向不 reopen；AI 不能自批）──

export interface ApplyCoverLetterResult {
  coverLetter: CoverLetter
  proposal: CoverLetterProposal
}

/** accept：CL-01~CL-07 重校验 → NarrativeUnit.text 改写 + status=draft + transitions 追加（永不覆盖历史）。
 *  reason 可选（Human Preference Signal——"为什么成功"，与 rejectReason 对称） */
export function acceptCoverLetterProposal(ws: Workspace, id: string, reason?: string, now: Date = new Date()): ApplyCoverLetterResult {
  const entry = scanCoverLetterProposals(ws).find((p) => p.record.id === id)
  if (!entry) throw new CoverLetterTransitionError(`提案不存在：${id}`)
  const p = entry.record
  if (p.status !== 'pending') throw new CoverLetterTransitionError(`只能接受 pending 提案（当前状态 ${p.status}）`)
  const clEntry = scanCoverLetters(ws).find((x) => x.record.id === p.clId)
  if (!clEntry) throw new CoverLetterTransitionError(`Cover Letter 不存在：${p.clId}`)
  const cl = clEntry.record
  const validation = validateCoverLetterProposal(p, cl, (ref) => resolveSourceFact(ws, ref))
  if (validation.status === 'invalid') {
    throw new CoverLetterTransitionError(`提案校验失败（${validation.issues.map((i) => i.code).join('/')}）——状态不变，请重新提案`)
  }
  const updated: CoverLetter = {
    ...cl,
    status: 'draft', // apply 后重置 draft：ready 修改必须产生新的 draft 演化事件
    units: cl.units.map((u) => {
      const change = p.changes.find((c) => c.unitId === u.id)
      return change ? { ...u, text: change.new } : u
    }),
    transitions: [...cl.transitions, { from: cl.status, to: 'draft', at: now.toISOString(), via: p.id }],
  }
  ws.write(`cover-letters/${clEntry.sourceFile}`, serializeCoverLetter(updated))
  const updatedProposal: CoverLetterProposal = {
    ...p,
    status: 'accepted',
    decidedAt: now.toISOString(),
    ...(reason && reason.trim().length > 0 ? { acceptReason: reason.replace(/\|/g, '／') } : {}),
  }
  ws.write(`cover-letters/proposals/${entry.sourceFile}`, serializeCoverLetterProposal(updatedProposal))
  return { coverLetter: updated, proposal: updatedProposal }
}

/** reject：pending → rejected（保留审计；重新建议 = 写新 Proposal） */
export function rejectCoverLetterProposal(ws: Workspace, id: string, reason?: string, now: Date = new Date()): CoverLetterProposal {
  const entry = scanCoverLetterProposals(ws).find((p) => p.record.id === id)
  if (!entry) throw new CoverLetterTransitionError(`提案不存在：${id}`)
  const p = entry.record
  if (p.status !== 'pending') throw new CoverLetterTransitionError(`只能拒绝 pending 提案（当前状态 ${p.status}）`)
  const updated: CoverLetterProposal = {
    ...p,
    status: 'rejected',
    decidedAt: now.toISOString(),
    ...(reason && reason.trim().length > 0 ? { rejectReason: reason.replace(/\|/g, '／') } : {}),
  }
  ws.write(`cover-letters/proposals/${entry.sourceFile}`, serializeCoverLetterProposal(updated))
  return updated
}

// ─── Read Projection（Source Fact Projection——引擎确定性聚合 + 事实快照）──

export function buildCoverLetterContext(ws: Workspace): CoverLetterContext {
  return {
    coverLetters: scanCoverLetters(ws).map((c) => {
      const cl = c.record
      return {
        id: cl.id,
        status: cl.status,
        units: cl.units.map((u) => ({
          id: u.id,
          text: u.text,
          ...(u.intent ? { intent: u.intent } : {}),
          sourceRefs: u.sourceRefs.map((ref) => {
            const statement = resolveSourceFact(ws, ref)
            return {
              artifact: ref.artifact,
              ...(ref.scopeId ? { scopeId: ref.scopeId } : {}),
              factId: ref.factId,
              ...(statement !== undefined ? { factStatement: statement } : {}), // 断链缺省（显式可见）
            }
          }),
        })),
        deliveries: cl.deliveries,
        transitions: cl.transitions,
      }
    }),
  }
}
