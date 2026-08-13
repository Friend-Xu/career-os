/**
 * proposal-watcher（M3.5.6）：AI 建议层——AI 写 proposals/*.md，引擎登记 + 校验 + 状态机。
 * - 契约：PROPOSAL-LAYER-M3-v0.1（AI 只能写 Proposal，不能写 ResumeDocument）
 * - 登记：marker + 校验非 invalid → 系统 ID + 引擎字段写回（status/created_at/checksum/validation）；
 *   invalid 不登记（文件保留，AI 修正后 change 重试）
 * - accept：checksum 强校验 → 确定性生成 Draft Manifest（override_source=proposal）→ 复用
 *   assembleResumeFromDraft → 新版本（lineage.parent + ai_revision + apply_proposal 审计）
 * - reject：pending → rejected（单向不 reopen；审计保留）
 */
import { createHash, randomUUID } from 'node:crypto'
import { watch } from 'chokidar'
import type { CareerClaim, EvidenceItem, JobRecord, Validation } from '../ir/schema.ts'
import type { CareerContext } from '../ir/context.ts'
import type {
  DraftClaimRef,
  ProposalChange,
  ProposalStatus,
  ProposalType,
  ResumeDocument,
  ResumeDraftManifest,
  ResumeProposal,
  ResumeSectionType,
  ResumeValidation,
  ResumeValidationIssue,
} from '../ir/resume.ts'
import { finalize, type Validated } from '../ir/validator.ts'
import type { Workspace } from './workspace.ts'
import { splitFrontmatter, nextArtifactId, registerArtifacts, type ArtifactSpec } from './artifact-registry.ts'
import { parseSummaryTable } from '../ir/summary-table.ts'
import { indexEvidence, canUseClaim } from './claim-policy.ts'
import { scanClaims } from './claim-watcher.ts'
import { scanEvidence } from './evidence-watcher.ts'
import { scanJobs } from './job-watcher.ts'
import { scanResumes, parseResumeMarkdown, serializeResumeDocument, parseValidation, RESUME_SPEC } from './resume-watcher.ts'
import { assembleResumeFromDraft } from './resume-draft.ts'
import { selectExpressionCandidates } from '../runtime/claim-selector.ts'

export const PROPOSAL_SPEC: ArtifactSpec = {
  type: 'proposal',
  dir: 'proposals',
  idPrefix: 'proposal_',
  marker: /##\s*分析摘要/,
  passthroughFields: [],
}

const PROPOSAL_TYPES: ProposalType[] = ['improve', 'adapt_jd', 'replace_sentence']
const PROPOSAL_STATUSES: ProposalStatus[] = ['pending', 'accepted', 'rejected']
const SUGGESTED_SOURCES = ['ai', 'standard_rule', 'user'] as const
const SECTION_TYPES: ResumeSectionType[] = ['summary', 'experience', 'projects', 'skills', 'education']

/** 源版本内容快照（sha256 of sections——生命周期字段流转不影响，内容变更即失效；
 *  条目化段（Entry Contract v0.1）含 entries[].bullets） */
export function checksumOf(d: ResumeDocument): string {
  const content = d.sections
    .map((s) => {
      const bullets = [...s.bullets, ...(s.entries ?? []).flatMap((e) => e.bullets)]
        .map((b) => `${s.type}|${b.claimId}|${b.sentence}|${b.metadata?.expectationId ?? ''}`)
        .join('\n')
      const assets = (s.assetRefs ?? []).map((a) => `asset|${a}`).join('\n')
      return `${s.type}|${s.title}\n${bullets}${assets ? `\n${assets}` : ''}`
    })
    .join('\n--section--\n')
  return createHash('sha256').update(content).digest('hex')
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

/** `## 变更建议` 段：`- {claimId}（section: x；old: "..."；new: "..."；reason: "..."；expectation: y；source: ai）` */
function parseChanges(md: string): { changes: ProposalChange[]; issues: ResumeValidationIssue[] } {
  const parts = md.split(/##\s*变更建议/, 2)
  const issues: ResumeValidationIssue[] = []
  if (parts.length < 2) return { changes: [], issues }
  const section = parts[1].split(/\n##\s+/)[0]
  const changes: ProposalChange[] = []
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*[-*]\s*(claim_\d{8}_\d{5})（(.+)）\s*$/)
    if (!m) continue
    const change: ProposalChange = { targetClaimId: m[1], section: 'experience', oldSentence: '', suggestedSentence: '', reason: '' }
    for (const kv of splitRespectingQuotes(m[2], '；')) {
      const idx = kv.indexOf(':')
      if (idx <= 0) continue
      const k = kv.slice(0, idx).trim()
      let v = kv.slice(idx + 1).trim()
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1)
      if (k === 'section') {
        if (SECTION_TYPES.includes(v as ResumeSectionType)) change.section = v as ResumeSectionType
        else issues.push({ code: 'BAD_SECTION', message: `非法章节类型 ${JSON.stringify(v)}`, target: m[1] })
      } else if (k === 'old') change.oldSentence = v
      else if (k === 'new') change.suggestedSentence = v
      else if (k === 'reason') change.reason = v
      else if (k === 'expectation') change.expectationId = v
      else if (k === 'source') {
        if (SUGGESTED_SOURCES.includes(v as 'ai' | 'standard_rule' | 'user')) change.suggestedSource = v as 'ai' | 'standard_rule' | 'user'
        else issues.push({ code: 'BAD_SUGGESTED_SOURCE', message: `非法 source ${JSON.stringify(v)}（合法值：ai/standard_rule/user）`, target: m[1] })
      }
    }
    changes.push(change)
  }
  return { changes, issues }
}

/** ResumeProposal → 存储 md（roundtrip：parseProposalMarkdown(serialize(p)) 还原全部字段） */
export function serializeResumeProposal(p: ResumeProposal): string {
  const rows = [
    `| type | resume_proposal |`,
    `| source_resume_id | ${p.sourceResumeId} |`,
    `| proposal_type | ${p.type} |`,
    ...(p.targetJobId ? [`| target_job_id | ${p.targetJobId} |`] : []),
    `| status | ${p.status} |`,
    `| created_by | ${p.createdBy} |`,
    ...(p.createdAt ? [`| created_at | ${p.createdAt} |`] : []),
    ...(p.sourceChecksum ? [`| source_checksum | ${p.sourceChecksum} |`] : []),
    ...(p.decidedAt ? [`| decided_at | ${p.decidedAt} |`] : []),
    ...(p.acceptReason ? [`| accept_reason | ${p.acceptReason} |`] : []),
    ...(p.rejectReason ? [`| reject_reason | ${p.rejectReason} |`] : []),
    ...(p.resultResumeId ? [`| result_resume_id | ${p.resultResumeId} |`] : []),
  ].join('\n')
  const changes = p.changes
    .map((c) => {
      const kvs = [
        `section: ${c.section}`,
        `old: "${c.oldSentence}"`,
        `new: "${c.suggestedSentence}"`,
        `reason: "${c.reason}"`,
        ...(c.expectationId ? [`expectation: ${c.expectationId}`] : []),
        ...(c.suggestedSource ? [`source: ${c.suggestedSource}`] : []),
      ]
      return `- ${c.targetClaimId}（${kvs.join('；')}）`
    })
    .join('\n')
  const validation = p.validation
    ? `## 验证\n\n${p.validation.issues.map((i) => `- ${p.validation!.status} | ${i.code} | ${i.message} | ${i.target}`).join('\n') || `- ${p.validation.status} | - | - | -`}\n`
    : ''

  return `# ${p.id}

## 分析摘要

| 字段 | 值 |
|------|-----|
${rows}

## 变更建议

${changes}
${validation ? `\n${validation}` : ''}`
}

/** 单个 proposal md → IR（摘要表 + 变更段 + 验证快照；枚举/必填校验） */
export function parseProposalMarkdown(md: string, sourceFile: string): Validated<ResumeProposal> {
  const { meta, body } = splitFrontmatter(md)
  const fields = parseSummaryTable(body)
  if (!fields) {
    return finalize({} as ResumeProposal, [{ path: sourceFile, reason: '未找到 `## 分析摘要` 表格', severity: 'error' }])
  }
  const checks: { path: string; reason: string; severity: 'warn' | 'error' }[] = []
  for (const f of ['source_resume_id', 'proposal_type'] as const) {
    if (!fields[f] || fields[f] === '-') checks.push({ path: f, reason: '缺失（摘要表未填）', severity: 'error' })
  }
  if (fields.type && fields.type !== 'resume_proposal') {
    checks.push({ path: 'type', reason: `非法值 ${JSON.stringify(fields.type)}（合法值：resume_proposal）`, severity: 'warn' })
  }
  const type = fields.proposal_type as ProposalType
  if (fields.proposal_type && !PROPOSAL_TYPES.includes(type)) {
    checks.push({ path: 'proposal_type', reason: `非法值 ${JSON.stringify(fields.proposal_type)}（合法值：${PROPOSAL_TYPES.join('/')}）`, severity: 'warn' })
  }
  const status = fields.status as ProposalStatus
  if (fields.status && !PROPOSAL_STATUSES.includes(status)) {
    checks.push({ path: 'status', reason: `非法值 ${JSON.stringify(fields.status)}（合法值：${PROPOSAL_STATUSES.join('/')}）`, severity: 'warn' })
  }
  const { changes, issues } = parseChanges(body)
  for (const i of issues) checks.push({ path: i.target, reason: `${i.code}: ${i.message}`, severity: 'warn' })
  const validation = parseValidation(body)

  const record: ResumeProposal = {
    id: meta.id ?? sourceFile.replace(/\.md$/, ''),
    sourceResumeId: fields.source_resume_id ?? '',
    ...(fields.source_checksum ? { sourceChecksum: fields.source_checksum } : {}),
    type: type as ProposalType, // 缺失/非法由 validateProposal 判 invalid（此处不默认）
    ...(fields.target_job_id ? { targetJobId: fields.target_job_id } : {}),
    changes,
    status: PROPOSAL_STATUSES.includes(status) ? status : 'pending',
    createdBy: 'ai', // 本层固定：Proposal 是 AI 建议的唯一通道
    ...(fields.created_at ? { createdAt: fields.created_at } : {}),
    ...(fields.decided_at ? { decidedAt: fields.decided_at } : {}),
    ...(fields.accept_reason ? { acceptReason: fields.accept_reason } : {}),
    ...(fields.reject_reason ? { rejectReason: fields.reject_reason } : {}),
    ...(fields.result_resume_id ? { resultResumeId: fields.result_resume_id } : {}),
    ...(validation ? { validation } : {}),
  }
  return finalize(record, checks)
}

// ─── 验证（三态复用 ResumeValidation；validateProposal 纯函数，注册/扫描共用）──

export interface ProposalContext {
  source?: ResumeDocument // 源版本（sourceResumeId 命中）
  anchorJob?: JobRecord // 期望锚点空间：adapt_jd → 提案目标岗位；其余 → 源版本目标岗位
  claims: CareerClaim[]
  evidence: EvidenceItem[]
}

const PROPOSAL_ERROR_CODES = new Set([
  'SOURCE_NOT_FOUND',
  'PROPOSAL_TYPE_INVALID',
  'TARGET_JOB_MISSING',
  'NO_CHANGES',
  'CLAIM_NOT_FOUND',
  'OLD_SENTENCE_MISMATCH',
  'NEW_SENTENCE_EMPTY',
  'EXPECTATION_NOT_FOUND',
])

export function buildProposalContext(ws: Workspace, p: ResumeProposal): ProposalContext {
  const source = scanResumes(ws).find((r) => r.record.id === p.sourceResumeId)?.record
  const anchorJobId = p.type === 'adapt_jd' ? p.targetJobId : source?.targetJobId
  const anchorJob = anchorJobId ? scanJobs(ws).find((j) => j.record.id === anchorJobId)?.record : undefined
  return { source, anchorJob, claims: scanClaims(ws).map((c) => c.record), evidence: scanEvidence(ws).map((e) => e.record) }
}

/** 登记前校验（含 apply 可行性）；错误码 → invalid，其余 warn → warning */
export function validateProposal(p: ResumeProposal, ctx: ProposalContext): ResumeValidation {
  const issues: ResumeValidationIssue[] = []
  const evidenceById = indexEvidence(ctx.evidence)
  const claimsById = new Map(ctx.claims.map((c) => [c.id, c]))
  const expectations = new Set((ctx.anchorJob?.responsibilities ?? []).flatMap((r) => r.evidenceExpectations.map((e) => e.patternId)))
  if (!ctx.source || ctx.source.id !== p.sourceResumeId) issues.push({ code: 'SOURCE_NOT_FOUND', message: `源版本不存在：${p.sourceResumeId}`, target: p.sourceResumeId })
  if (!PROPOSAL_TYPES.includes(p.type)) issues.push({ code: 'PROPOSAL_TYPE_INVALID', message: `非法提案类型 ${JSON.stringify(p.type)}`, target: p.id })
  if (p.type === 'adapt_jd' && !p.targetJobId) issues.push({ code: 'TARGET_JOB_MISSING', message: 'adapt_jd 必须声明 target_job_id', target: p.id })
  if (p.changes.length === 0) issues.push({ code: 'NO_CHANGES', message: '变更建议为空', target: p.id })
  for (const c of p.changes) {
    const claim = claimsById.get(c.targetClaimId)
    if (!claim) {
      issues.push({ code: 'CLAIM_NOT_FOUND', message: `表述不存在：${c.targetClaimId}`, target: c.targetClaimId })
      continue
    }
    if (!canUseClaim(claim, evidenceById)) issues.push({ code: 'CLAIM_NOT_USABLE', message: '表述不可消费（证据未通过可信校验）', target: c.targetClaimId })
    if (c.expectationId && expectations.size > 0 && !expectations.has(c.expectationId)) {
      issues.push({ code: 'EXPECTATION_NOT_FOUND', message: `期望锚点不存在：${c.expectationId}`, target: c.targetClaimId })
    }
    if (ctx.source && !bulletMatches(ctx.source, c)) issues.push({ code: 'OLD_SENTENCE_MISMATCH', message: 'oldSentence 与源版本 bullet 不匹配（防幻觉）', target: c.targetClaimId })
    if (!c.suggestedSentence || c.suggestedSentence.trim().length === 0) issues.push({ code: 'NEW_SENTENCE_EMPTY', message: 'suggestedSentence 为空', target: c.targetClaimId })
    if (!c.reason || c.reason.trim().length === 0) issues.push({ code: 'REASON_EMPTY', message: 'reason 为空（建议不可解释）', target: c.targetClaimId })
  }
  const status = issues.some((i) => PROPOSAL_ERROR_CODES.has(i.code)) ? 'invalid' : issues.length > 0 ? 'warning' : 'valid'
  return { status, issues }
}

/** identity = claimId + sentence（+ expectationId 若给）——oldSentence 必须来自源版本原文（含条目化段 bullets） */
function bulletMatches(d: ResumeDocument, c: ProposalChange): boolean {
  const sec = d.sections.find((s) => s.type === c.section)
  if (!sec) return false
  return [...sec.bullets, ...(sec.entries ?? []).flatMap((e) => e.bullets)].some(
    (b) => b.claimId === c.targetClaimId && b.sentence === c.oldSentence && (c.expectationId === undefined || b.metadata?.expectationId === c.expectationId),
  )
}

/** parse 级校验（summary 表必填/枚举）→ ResumeValidation（与 validateProposal 合并用） */
function parseValidationOf(v: Validation | undefined): ResumeValidation | undefined {
  if (!v || v.issues.length === 0) return undefined
  const issues: ResumeValidationIssue[] = v.issues.map((i) => ({ code: 'PARSE', message: i.reason, target: i.path }))
  const status: ResumeValidation['status'] = v.issues.some((i) => i.severity === 'error') ? 'invalid' : 'warning'
  return { status, issues }
}

function mergeValidation(a: ResumeValidation | undefined, b: ResumeValidation | undefined): ResumeValidation | undefined {
  if (!a) return b
  if (!b) return a
  const status: ResumeValidation['status'] = a.status === 'invalid' || b.status === 'invalid' ? 'invalid' : a.status === 'warning' || b.status === 'warning' ? 'warning' : 'valid'
  return { status, issues: [...a.issues, ...b.issues] }
}

// ─── 扫描 / 登记 ──

export interface ParsedProposal {
  sourceFile: string
  record: ResumeProposal
  validation?: Validation
}

/** 已登记判定：摘要表显式含 status 行（parse 默认 'pending' 不代表已登记） */
function isRegistered(md: string): boolean {
  return parseSummaryTable(md)?.status !== undefined
}

/** proposals/ 全量扫描：已登记（摘要表 status 行存在）用文件快照；未登记实时计算验证（AI 修正后自动通过） */
export function scanProposals(ws: Workspace): ParsedProposal[] {
  return ws.listMarkdown('proposals').sort().map((f) => {
    const md = ws.read(`proposals/${f}`)
    const parsed = parseProposalMarkdown(md, f)
    const record = isRegistered(md)
      ? parsed.value
      : { ...parsed.value, validation: mergeValidation(parseValidationOf(parsed.validation), validateProposal(parsed.value, buildProposalContext(ws, parsed.value))) }
    return { sourceFile: f, record, validation: parsed.validation }
  })
}

/**
 * 单个文件登记：marker + 非 invalid → 系统 ID + 重命名 + 引擎字段写回。
 * invalid 不登记（文件保留在暂存名，AI 修正后 change 重试）；返回是否登记。
 */
export function registerProposalFile(ws: Workspace, fileName: string, now: Date = new Date()): boolean {
  const md = ws.read(`proposals/${fileName}`)
  if (!PROPOSAL_SPEC.marker.test(md)) return false // 非提案格式不赋予系统身份
  if (isRegistered(md)) return false // 已登记（引擎字段已写回）
  const parsed = parseProposalMarkdown(md, fileName)
  const validation = mergeValidation(parseValidationOf(parsed.validation), validateProposal(parsed.value, buildProposalContext(ws, parsed.value)))
  if (validation?.status === 'invalid') return false
  const systemId = nextArtifactId(ws, PROPOSAL_SPEC, now)
  const { body } = splitFrontmatter(md)
  const fm = ['---', `id: ${systemId}`, `created_at: ${now.toISOString().slice(0, 10)}`, `source_file: ${fileName.replace(/\.md$/, '')}`, '---', ''].join('\n')
  ws.write(`proposals/${systemId}.md`, fm + body)
  ws.delete(`proposals/${fileName}`)
  const source = buildProposalContext(ws, parsed.value).source
  const record: ResumeProposal = {
    ...parsed.value,
    id: systemId,
    status: 'pending',
    createdBy: 'ai',
    createdAt: now.toISOString(),
    ...(source ? { sourceChecksum: checksumOf(source) } : {}),
    validation,
  }
  ws.write(`proposals/${systemId}.md`, serializeResumeProposal(record))
  return true
}

/** 启动补登：引擎离线期间 AI 写入的提案（幂等——已登记跳过） */
export function registerPendingProposals(ws: Workspace, now: Date = new Date()): number {
  let registered = 0
  for (const f of ws.listMarkdown('proposals')) {
    if (registerProposalFile(ws, f, now)) registered++
  }
  return registered
}

/** proposals/ 监听：add → 登记 + 重扫；change/unlink → 重扫 */
export function watchProposals(ws: Workspace, onChanged: (parsed: ParsedProposal[]) => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.proposals, { ignoreInitial: true })
  const rescan = (): void => onChanged(scanProposals(ws))
  watcher.on('add', (p: string) => {
    if (!p.endsWith('.md')) return
    // Windows：chokidar 路径为反斜杠，统一转正斜杠再取文件名
    registerProposalFile(ws, p.replace(/\\/g, '/').split('/').pop() ?? p)
    rescan()
  })
  watcher.on('change', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  watcher.on('unlink', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  return { close: () => watcher.close() }
}

// ─── M3.5.7：Proposal Feedback Projection（决策反馈——Evolution Evidence）──

/**
 * 决策反馈投影（纯函数）：proposals/ 即 append-only 决策历史（不 reopen 不删除）——
 * 不建存储目录，仅作为 CareerContext 的确定性投影（契约 PROPOSAL-FEEDBACK-M3-v0.1）。
 * 引擎只给事实 + 统计；语义模式（"避免无 evidence 的量化收益"）由 AI 消费时自行归纳。
 */
export function buildProposalFeedback(ws: Workspace): Pick<CareerContext, 'proposalHistory' | 'proposalInsights'> {
  const decided = scanProposals(ws)
    .map((p) => p.record)
    .filter((p): p is ResumeProposal & { decidedAt: string } => p.status !== 'pending' && p.decidedAt !== undefined)
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt)) // 降序：近期信号优先

  const proposalHistory: CareerContext['proposalHistory'] = decided.map((p) => ({
    proposalId: p.id,
    action: p.status === 'accepted' ? 'accepted' : 'rejected',
    ...(p.status === 'accepted' ? (p.acceptReason ? { reason: p.acceptReason } : {}) : p.rejectReason ? { reason: p.rejectReason } : {}),
    actor: 'user', // 决策仅由用户经 RPC 触发（AI 不能自批）
    at: p.decidedAt,
  }))

  const byType: CareerContext['proposalInsights']['byType'] = {}
  const byExpectation: CareerContext['proposalInsights']['byExpectation'] = {}
  for (const p of decided) {
    const key = p.status === 'accepted' ? 'accepted' : 'rejected'
    byType[p.type] ??= { accepted: 0, rejected: 0 }
    byType[p.type][key]++
    for (const c of p.changes) {
      if (!c.expectationId) continue
      byExpectation[c.expectationId] ??= { accepted: 0, rejected: 0 }
      byExpectation[c.expectationId][key]++
    }
  }
  const accepted = decided.filter((p) => p.status === 'accepted')
  const rejected = decided.filter((p) => p.status === 'rejected')

  return {
    proposalHistory,
    proposalInsights: {
      stats: {
        total: decided.length,
        accepted: accepted.length,
        rejected: rejected.length,
        acceptRate: decided.length === 0 ? 0 : accepted.length / decided.length,
      },
      byType,
      byExpectation,
      rejectedReasons: rejected.map((p) => p.rejectReason).filter((r): r is string => r !== undefined && r.length > 0),
      acceptedReasons: accepted.map((p) => p.acceptReason).filter((r): r is string => r !== undefined && r.length > 0),
    },
  }
}

// ─── 状态机（pending → accepted | rejected，单向；AI 不能自批）──

export class ProposalTransitionError extends Error {}

export interface ApplyProposalResult {
  document: ResumeDocument
  proposal: ResumeProposal
}

/** accept：checksum 强校验 → 确定性生成 Draft Manifest → 复用 Assembler → 新版本（永不覆盖源）。
 *  reason 可选（M3.5.7：Human Preference Signal——"为什么成功"，写回 accept_reason 与 rejectReason 对称） */
export function acceptProposalFile(ws: Workspace, id: string, reason?: string, now: Date = new Date()): ApplyProposalResult {
  const entry = scanProposals(ws).find((p) => p.record.id === id)
  if (!entry) throw new ProposalTransitionError(`提案不存在：${id}`)
  const p = entry.record
  if (p.status !== 'pending') throw new ProposalTransitionError(`只能接受 pending 提案（当前状态 ${p.status}）`)
  const source = scanResumes(ws).find((r) => r.record.id === p.sourceResumeId)?.record
  if (!source) throw new ProposalTransitionError(`源版本不存在：${p.sourceResumeId}`)
  if (p.sourceChecksum && checksumOf(source) !== p.sourceChecksum) {
    throw new ProposalTransitionError('源版本内容已变化（checksum 不匹配）——请基于当前版本重新提案')
  }
  for (const c of p.changes) {
    if (!bulletMatches(source, c)) throw new ProposalTransitionError(`change 的 oldSentence 与源版本不匹配：${c.targetClaimId}`)
  }
  const manifest = buildProposalManifest(source, p, now)
  const claims = scanClaims(ws).map((x) => x.record)
  const evidence = scanEvidence(ws).map((x) => x.record)
  const jobId = p.targetJobId ?? source.targetJobId
  const job = jobId ? scanJobs(ws).find((j) => j.record.id === jobId)?.record : undefined
  const candidates = job ? selectExpressionCandidates(job, evidence, claims).flatMap((r) => r.candidates.map((c) => c.claimId)) : []
  const { document, validation } = assembleResumeFromDraft({ manifest, claims, evidence, selectorCandidates: candidates, now })
  if (validation.status === 'invalid') throw new ProposalTransitionError(`组装校验失败（${validation.issues.map((i) => i.code).join('/')}）——状态不变，请重新提案`)
  const docId = manifest.id
  const finalDoc: ResumeDocument = {
    ...document,
    validation,
    operations: [
      ...(document.operations ?? []),
      { id: `operation_${randomUUID().slice(0, 8)}`, actor: 'system', action: 'apply_proposal', note: p.id, at: now.toISOString() },
    ],
  }
  ws.write(`resumes/documents/${docId}.md`, serializeResumeDocument(finalDoc))
  // 登记系统 ID（返回规范 id，resultResumeId 引用登记后 id）
  const before = new Set(ws.listMarkdown('resumes/documents'))
  registerArtifacts(ws, RESUME_SPEC, now)
  const registeredFile = ws.listMarkdown('resumes/documents').find((f) => !before.has(f))
  const canonical = registeredFile ? parseResumeMarkdown(ws.read(`resumes/documents/${registeredFile}`), registeredFile).value : finalDoc
  const updated: ResumeProposal = {
    ...p,
    status: 'accepted',
    decidedAt: now.toISOString(),
    ...(reason && reason.trim().length > 0 ? { acceptReason: reason.replace(/\|/g, '／') } : {}),
    resultResumeId: canonical.id,
  }
  ws.write(`proposals/${entry.sourceFile}`, serializeResumeProposal(updated))
  return { document: canonical, proposal: updated }
}

/** reject：pending → rejected（保留审计；重新建议 = 写新 Proposal） */
export function rejectProposalFile(ws: Workspace, id: string, reason?: string, now: Date = new Date()): ResumeProposal {
  const entry = scanProposals(ws).find((p) => p.record.id === id)
  if (!entry) throw new ProposalTransitionError(`提案不存在：${id}`)
  const p = entry.record
  if (p.status !== 'pending') throw new ProposalTransitionError(`只能拒绝 pending 提案（当前状态 ${p.status}）`)
  const updated: ResumeProposal = {
    ...p,
    status: 'rejected',
    decidedAt: now.toISOString(),
    ...(reason && reason.trim().length > 0 ? { rejectReason: reason.replace(/\|/g, '／') } : {}),
  }
  ws.write(`proposals/${entry.sourceFile}`, serializeResumeProposal(updated))
  return updated
}

/** Proposal → Draft Manifest（确定性：源版本全部 bullet + 被替换 N 条 override_source=proposal；
 *  条目化段 bullets 平铺进 claims——Manifest 无条目结构，派生版本经历段回平铺（Entry Contract 已知缺口）） */
export function buildProposalManifest(source: ResumeDocument, p: ResumeProposal, now: Date): ResumeDraftManifest {
  const date = now.toISOString().slice(0, 10)
  const docId = `${date}-${source.id}-proposal-${p.id.slice(-6)}`
  const claims: DraftClaimRef[] = []
  for (const s of source.sections) {
    for (const b of [...s.bullets, ...(s.entries ?? []).flatMap((e) => e.bullets)]) {
      const ref: DraftClaimRef = { claimId: b.claimId, section: s.type, ...(b.metadata?.expectationId ? { expectationId: b.metadata.expectationId } : {}) }
      const change = p.changes.find(
        (c) => c.section === s.type && c.targetClaimId === b.claimId && b.sentence === c.oldSentence && (c.expectationId === undefined || c.expectationId === b.metadata?.expectationId),
      )
      if (change) {
        ref.sentenceOverride = change.suggestedSentence
        ref.overrideSource = 'proposal'
      }
      claims.push(ref)
    }
  }
  const skillsSection = source.sections.find((s) => s.type === 'skills')
  return {
    id: docId,
    type: 'resume_draft',
    person: source.person, // 继承源版本归属人（防组装版本 person 缺失标 invalid）
    ...(p.targetJobId ? { targetJobId: p.targetJobId } : source.targetJobId ? { targetJobId: source.targetJobId } : {}),
    templateId: source.templateId,
    ...(source.templateVersion ? { templateVersion: source.templateVersion } : {}),
    parentResumeId: source.id,
    derivationType: 'ai_revision',
    claims,
    skills: skillsSection?.assetRefs ?? [],
  }
}
