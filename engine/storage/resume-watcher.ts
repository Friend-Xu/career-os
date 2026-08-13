/**
 * resume-watcher（M3.5.3）：简历版本管理——documents/（登记 IR）+ drafts/（AI 暂存 → 自动组装）。
 * - 存储契约（RESUME-VERSION-M3 v0.2）：frontmatter（引擎登记）+ `## 分析摘要`（status/person/template/
 *   lineage 字段）+ `## 章节`（### type | title + bullet（claim: x；expectation: y）+ asset）+ `## 操作记录`
 * - RESUME_SPEC：artifact 登记（id 系统生成，复用 artifact-registry）
 * - drafts/ watcher：AI 写 resume-draft-*.md → assembleResumeFromDraft → 写 documents/ 暂存 → 登记 → 清理源
 * - Lifecycle：transitionResumeStatusFile（状态机 draft→review→archived；exported 仅 export 链）+ operations 审计
 * - clone：lineage.parent + createdBy=user + status=draft（不复制 status/operations）
 * - diff：ResumeBulletIdentity（sentence+claimId+expectationId，不丢 provenance）
 */
import type { ResumeBullet, ResumeDocument, ResumeLineage, ResumeOperation, ResumeSection, ResumeStatus } from '../ir/resume.ts'
import type { EvidenceItem } from '../ir/schema.ts'
import type { CareerClaim } from '../ir/schema.ts'
import { finalize, type Validated } from '../ir/validator.ts'
import type { Workspace } from './workspace.ts'
import { watch } from 'chokidar'
import { registerArtifacts, splitFrontmatter, type ArtifactSpec } from './artifact-registry.ts'
import { parseSummaryTable } from '../ir/summary-table.ts'
import { parseDraftManifest, assembleResumeFromDraft } from './resume-draft.ts'
import { selectExpressionCandidates } from '../runtime/claim-selector.ts'
import { scanJobs } from './job-watcher.ts'
import { scanClaims } from './claim-watcher.ts'
import { scanEvidence } from './evidence-watcher.ts'
import { randomUUID } from 'node:crypto'

export const RESUME_SPEC: ArtifactSpec = {
  type: 'resume',
  dir: 'resumes/documents',
  idPrefix: 'resume_',
  marker: /##\s*分析摘要/,
  passthroughFields: [],
}

const STATUSES: ResumeStatus[] = ['draft', 'review', 'exported', 'archived']
const SECTION_TYPES = ['summary', 'experience', 'projects', 'skills', 'education', 'profile', 'target_intent']
const DERIVATIONS: ResumeLineage['derivationType'][] = ['jd_generate', 'clone', 'user_edit', 'ai_revision']
const ACTORS: ResumeOperation['actor'][] = ['ai', 'user', 'system']
const ACTIONS: ResumeOperation['action'][] = ['create', 'clone', 'submit_review', 'export', 'archive', 'attempt_change_status', 'apply_proposal']

// ─── 章节解析（与 M3.5.2 resume-draft 同格式：### type | title；bullet（claim/expectation）；asset）──

function parseSections(md: string): { sections: ResumeSection[]; issues: { path: string; reason: string; severity: 'warn' | 'error' }[] } {
  const parts = md.split(/##\s*章节/, 2)
  const issues: { path: string; reason: string; severity: 'warn' | 'error' }[] = []
  if (parts.length < 2) return { sections: [], issues }
  const section = parts[1].split(/\n##\s+/)[0]
  const sections: ResumeSection[] = []
  let current: ResumeSection | null = null
  for (const line of section.split('\n')) {
    const sec = line.match(/^###\s*(\S+)\s*\|\s*(.+)$/)
    if (sec) {
      if (!SECTION_TYPES.includes(sec[1])) {
        issues.push({ path: sec[1], reason: `非法章节类型 ${JSON.stringify(sec[1])}（合法值：${SECTION_TYPES.join('/')}）`, severity: 'warn' })
        current = null
        continue
      }
      current = { type: sec[1] as ResumeSection['type'], title: sec[2].trim(), bullets: [] }
      sections.push(current)
      continue
    }
    const content = line.match(/^\s*[-*]\s*(.+)$/)
    if (!content || !current) continue
    // bullet 行：- {sentence}（claim: {claimId}；expectation: {eid}）；asset 行：- {name}（asset）；
    // identity 行：- {label} | {body}（identity）（M5.2 G6）；条目头行：- {title} | {role} | {period}（entry）（Entry Contract v0.1）
    const bulletOpen = content[1].indexOf('（claim: ')
    const asset = content[1].match(/^(.*?)（asset）$/)
    const identity = content[1].match(/^(.*?)（identity）$/)
    const entryHead = content[1].match(/^(.*?)（entry）$/)
    if (entryHead) {
      const parts = entryHead[1].split('|').map((p) => p.trim())
      const dash = (v: string): string | undefined => (v === '' || v === '-' ? undefined : v)
      const role = dash(parts[1] ?? '')
      const period = dash(parts[2] ?? '')
      ;(current.entries ??= []).push({
        title: parts[0] ?? '',
        ...(role ? { role } : {}),
        ...(period ? { period } : {}),
        bullets: [],
      })
    } else if (bulletOpen >= 0) {
      const sentence = content[1].slice(0, bulletOpen).trim()
      const inner = content[1].slice(bulletOpen + '（claim: '.length).replace(/）$/, '')
      const [claimId, ...pairs] = inner.split('；')
      const expectation = pairs.find((p) => p.startsWith('expectation: '))?.slice('expectation: '.length)
      const bullet: ResumeBullet = {
        sentence,
        claimId: claimId.trim(),
        ...(expectation ? { metadata: { expectationId: expectation.trim() } } : {}),
      }
      const entry = current.entries?.[current.entries.length - 1]
      if (entry) entry.bullets.push(bullet)
      else current.bullets.push(bullet)
    } else if (asset) {
      ;(current.assetRefs ??= []).push(asset[1].trim())
    } else if (identity) {
      const raw = identity[1].trim()
      const sep = raw.indexOf('|')
      ;(current.identity ??= []).push(sep > 0 ? { label: raw.slice(0, sep).trim(), body: raw.slice(sep + 1).trim() } : { body: raw })
    } else {
      issues.push({ path: `section:${current.title}`, reason: `无法解析行：${content[1].slice(0, 40)}…`, severity: 'warn' })
    }
  }
  return { sections, issues }
}

/** `## 操作记录` 段：`- {id} | {actor} | {action} | {at}（| note: {note}）（| rejected:true）` */
function parseOperations(md: string): ResumeOperation[] {
  const parts = md.split(/##\s*操作记录/, 2)
  if (parts.length < 2) return []
  const section = parts[1].split(/\n##\s+/)[0]
  const ops: ResumeOperation[] = []
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*[-*]\s*(.+)$/)
    if (!m) continue
    const parts = m[1].split(/\s*\|\s*/).map((s) => s.trim())
    if (parts.length < 4) continue
    const op: ResumeOperation = { id: parts[0], actor: parts[1] as ResumeOperation['actor'], action: parts[2] as ResumeOperation['action'], at: parts[3] }
    for (const extra of parts.slice(4)) {
      if (extra === 'rejected:true') op.rejected = true
      else if (extra.startsWith('note: ')) op.note = extra.slice('note: '.length)
    }
    ops.push(op)
  }
  return ops
}

/** `## 验证` 段：`- {status} | {code} | {message} | {target}` → ResumeValidation 快照（占位行 `- | - | -` 跳过，不产生假 issue） */
export function parseValidation(md: string): ResumeDocument['validation'] {
  const parts = md.split(/##\s*验证/, 2)
  if (parts.length < 2) return undefined
  const section = parts[1].split(/\n##\s+/)[0]
  const issues: import('../ir/resume.ts').ResumeValidationIssue[] = []
  let status: 'valid' | 'warning' | 'invalid' = 'valid'
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*[-*]\s*(valid|warning|invalid)\s*\|\s*(\S+)\s*\|\s*(.+?)\s*\|\s*(\S+)\s*$/)
    if (m) {
      status = m[1] as 'valid' | 'warning' | 'invalid'
      if (m[2] !== '-') issues.push({ code: m[2], message: m[3], target: m[4] })
    }
  }
  return { status, issues }
}

/** ResumeDocument → 存储 md（roundtrip：parseResumeMarkdown(serialize(d)) 还原全部字段） */
export function serializeResumeDocument(d: ResumeDocument): string {
  const rows = [
    `| status | ${d.status} |`,
    `| person | ${d.person} |`,
    ...(d.targetId ? [`| target_id | ${d.targetId} |`] : []),
    ...(d.targetJobId ? [`| target_job_id | ${d.targetJobId} |`] : []),
    `| template_id | ${d.templateId} |`,
    `| template_version | ${d.templateVersion} |`,
    `| generated_at | ${d.generatedAt} |`,
    ...(d.lineage?.parentResumeId ? [`| parent_resume_id | ${d.lineage.parentResumeId} |`] : []),
    ...(d.lineage ? [`| derivation_type | ${d.lineage.derivationType} |`, `| created_by | ${d.lineage.createdBy} |`] : []),
  ].join('\n')
  const sections = d.sections.map((s) => {
    const bullets = s.bullets.map((b) => `- ${b.sentence}（claim: ${b.claimId}${b.metadata?.expectationId ? `；expectation: ${b.metadata.expectationId}` : ''}）`).join('\n')
    // 条目化段（Resume Entry Contract v0.1）：条目头行 + 条目下 bullet（round-trip 同 parseSections）
    const entries = (s.entries ?? [])
      .map((e) => {
        const head = `- ${[e.title, e.role ?? '', e.period ?? ''].join(' | ')}（entry）`
        const eb = e.bullets.map((b) => `- ${b.sentence}（claim: ${b.claimId}${b.metadata?.expectationId ? `；expectation: ${b.metadata.expectationId}` : ''}）`).join('\n')
        return [head, eb].filter(Boolean).join('\n')
      })
      .join('\n')
    const identity = (s.identity ?? []).map((e) => `- ${e.label ? `${e.label} | ${e.body ?? ''}` : (e.body ?? '')}（identity）`).join('\n')
    const assets = (s.assetRefs ?? []).map((a) => `- ${a}（asset）`).join('\n')
    return `### ${s.type} | ${s.title}\n\n${[entries, bullets, identity, assets].filter(Boolean).join('\n')}`
  }).join('\n\n')
  const ops = (d.operations ?? [])
    .map((o) => `- ${o.id} | ${o.actor} | ${o.action} | ${o.at}${o.note ? ` | note: ${o.note}` : ''}${o.rejected ? ' | rejected:true' : ''}`)
    .join('\n')
  const validation = d.validation
    ? `## 验证\n\n${d.validation.issues.map((i) => `- ${d.validation!.status} | ${i.code} | ${i.message} | ${i.target}`).join('\n') || `- ${d.validation.status} | - | - | -`}\n`
    : ''

  return `# ${d.id}

## 分析摘要

| 字段 | 值 |
|------|-----|
${rows}

## 章节

${sections}
${ops ? `\n## 操作记录\n\n${ops}\n` : ''}${validation ? `\n${validation}` : ''}`
}

/** 单个 resume md → IR（必填/枚举校验；lineage/operations 读回） */
export function parseResumeMarkdown(md: string, sourceFile: string): Validated<ResumeDocument> {
  const { meta, body } = splitFrontmatter(md)
  const fields = parseSummaryTable(body)
  if (!fields) {
    return finalize({} as ResumeDocument, [
      { path: sourceFile, reason: '未找到 `## 分析摘要` 表格', severity: 'error' },
    ])
  }
  const checks: { path: string; reason: string; severity: 'warn' | 'error' }[] = []
  for (const f of ['status', 'person', 'template_id', 'template_version', 'generated_at'] as const) {
    if (!fields[f] || fields[f] === '-') checks.push({ path: f, reason: '缺失（摘要表未填）', severity: 'error' })
  }
  const status = fields.status as ResumeStatus
  if (fields.status && !STATUSES.includes(status)) {
    checks.push({ path: 'status', reason: `非法值 ${JSON.stringify(fields.status)}（合法值：${STATUSES.join('/')}）`, severity: 'warn' })
  }
  if (fields.derivation_type && !DERIVATIONS.includes(fields.derivation_type as ResumeLineage['derivationType'])) {
    checks.push({ path: 'derivation_type', reason: `非法值 ${JSON.stringify(fields.derivation_type)}（合法值：${DERIVATIONS.join('/')}）`, severity: 'warn' })
  }

  const { sections, issues } = parseSections(body)
  checks.push(...issues)
  const operations = parseOperations(body)
  for (const op of operations) {
    if (!ACTORS.includes(op.actor)) checks.push({ path: op.id, reason: `非法 actor ${JSON.stringify(op.actor)}`, severity: 'warn' })
    if (!ACTIONS.includes(op.action)) checks.push({ path: op.id, reason: `非法 action ${JSON.stringify(op.action)}`, severity: 'warn' })
  }
  const validation = parseValidation(body)

  const record: ResumeDocument = {
    id: meta.id ?? sourceFile.replace(/\.md$/, ''),
    status: STATUSES.includes(status) ? status : 'draft',
    person: fields.person ?? '',
    ...(fields.target_id ? { targetId: fields.target_id } : {}),
    ...(fields.target_job_id ? { targetJobId: fields.target_job_id } : {}),
    templateId: fields.template_id ?? '',
    templateVersion: fields.template_version ?? '',
    sections,
    generatedAt: fields.generated_at ?? meta.created_at ?? '',
    ...(fields.parent_resume_id || fields.derivation_type
      ? {
          lineage: {
            ...(fields.parent_resume_id ? { parentResumeId: fields.parent_resume_id } : {}),
            derivationType: (fields.derivation_type as ResumeLineage['derivationType']) ?? 'jd_generate',
            createdBy: (fields.created_by as ResumeLineage['createdBy']) ?? 'ai',
          },
        }
      : {}),
    ...(operations.length > 0 ? { operations } : {}),
    ...(validation ? { validation } : {}),
  }
  return finalize(record, checks)
}

export interface ParsedResume {
  sourceFile: string
  record: ResumeDocument
  validation?: import('../ir/schema.ts').Validation
}

/** documents/ 全量扫描 */
export function scanResumes(ws: Workspace): ParsedResume[] {
  return ws.listMarkdown('resumes/documents').sort().map((f) => {
    const parsed = parseResumeMarkdown(ws.read(`resumes/documents/${f}`), f)
    return { sourceFile: f, record: parsed.value, validation: parsed.validation }
  })
}

/** drafts/ 文件 → 组装 → 写 documents/ 暂存 → 登记 → 清理源（AI 写文件即创建，与 evidence/claim 同模式） */
export function assembleDraftFile(ws: Workspace, draftFile: string, now: Date = new Date()): ResumeDocument | null {
  const md = ws.read(`resumes/drafts/${draftFile}`)
  const manifest = parseDraftManifest(md, draftFile).value
  const claims: CareerClaim[] = scanClaims(ws).map((p) => p.record)
  const evidence: EvidenceItem[] = scanEvidence(ws).map((p) => p.record)
  const job = manifest.targetJobId ? scanJobs(ws).find((j) => j.record.id === manifest.targetJobId)?.record : undefined
  const candidates = job
    ? selectExpressionCandidates(job, evidence, claims).flatMap((r) => r.candidates.map((c) => c.claimId))
    : []
  const { document, validation } = assembleResumeFromDraft({ manifest, claims, evidence, selectorCandidates: candidates, now })
  if (validation.status === 'invalid') return null // invalid 不落 documents/（文件保留在 drafts/ 供 AI 修正）
  ws.write(`resumes/documents/${draftFile}`, serializeResumeDocument({ ...document, validation }))
  registerArtifacts(ws, RESUME_SPEC, now)
  ws.delete(`resumes/drafts/${draftFile}`)
  return document
}

/** documents/ + drafts/ 监听：documents add 先登记再重扫；drafts add → 组装登记 */
export function watchResumes(ws: Workspace, onChanged: (parsed: ParsedResume[]) => void): { close: () => Promise<void> } {
  const watcher = watch([ws.paths.resumes, `${ws.paths.resumes}/drafts`], { ignoreInitial: true })
  const rescan = (): void => onChanged(scanResumes(ws))
  const handleDoc = (p: string): void => {
    if (!p.endsWith('.md')) return
    // Windows：chokidar 路径为反斜杠，统一转正斜杠再判断/取文件名
    const norm = p.replace(/\\/g, '/')
    if (norm.includes('/drafts/')) {
      const name = norm.split('/').pop() ?? norm
      if (assembleDraftFile(ws, name)) rescan()
      return
    }
    registerArtifacts(ws, RESUME_SPEC)
    rescan()
  }
  watcher.on('add', handleDoc)
  watcher.on('change', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  watcher.on('unlink', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  return { close: () => watcher.close() }
}

// ─── Lifecycle（M3.5.3b：状态机 + operations 审计）──

/** 合法转移表（exported 仅 export 链——transition 拒绝 exported；archived 不可逆，restore 未来引入） */
const TRANSITIONS: Record<ResumeStatus, ResumeStatus[]> = {
  draft: ['review', 'archived'],
  review: ['archived'],
  exported: ['archived'],
  archived: [],
}

export class ResumeTransitionError extends Error {}

/** 状态转移：读 → 校验合法 → 更新 status + 追加 operation → 写回（actor 记录审计） */
export function transitionResumeStatusFile(
  ws: Workspace,
  file: string,
  target: ResumeStatus,
  actor: ResumeOperation['actor'],
  now: Date = new Date(),
): ResumeDocument {
  const parsed = parseResumeMarkdown(ws.read(`resumes/documents/${file}`), file)
  const d = parsed.value
  if (target === 'exported') throw new ResumeTransitionError('exported 只能由导出成功链路产生（绑定 ExportRecord）')
  if (!TRANSITIONS[d.status].includes(target)) {
    throw new ResumeTransitionError(`非法转移：${d.status} → ${target}（合法：${TRANSITIONS[d.status].join('/') || '无'}）`)
  }
  const action = target === 'archived' ? 'archive' : 'submit_review'
  const op: ResumeOperation = { id: `operation_${randomUUID().slice(0, 8)}`, actor, action, at: now.toISOString() }
  const next = { ...d, status: target, operations: [...(d.operations ?? []), op] }
  ws.write(`resumes/documents/${file}`, serializeResumeDocument(next))
  return next
}

/** clone：新 draft，lineage.parent = 源，createdBy=user；不复制 status/operations（只复制内容引用/template） */
export function cloneResumeFile(ws: Workspace, source: ResumeDocument, now: Date = new Date()): ResumeDocument {
  const date = now.toISOString().slice(0, 10)
  const rel = `resumes/documents/${date}-${source.id}-clone.md`
  const clone: ResumeDocument = {
    ...source,
    id: rel.replace(/\.md$/, ''),
    status: 'draft',
    lineage: {
      parentResumeId: source.id,
      derivationType: 'clone',
      createdBy: 'user',
    },
    operations: [{ id: `operation_${randomUUID().slice(0, 8)}`, actor: 'user', action: 'clone', at: now.toISOString() }],
  }
  ws.write(rel, serializeResumeDocument(clone))
  registerArtifacts(ws, RESUME_SPEC, now)
  return clone
}

/** export 成功后的系统流转（仅 export 链可调——transition RPC 拒绝 exported；失败安全：绑定 ExportRecord 才置 exported） */
export function markResumeExported(ws: Workspace, file: string, now: Date = new Date()): ResumeDocument {
  const parsed = parseResumeMarkdown(ws.read(`resumes/documents/${file}`), file)
  const d = parsed.value
  if (!['draft', 'review'].includes(d.status)) throw new ResumeTransitionError(`无法导出：状态 ${d.status}（draft/review 才可导出）`)
  const op: ResumeOperation = { id: `operation_${randomUUID().slice(0, 8)}`, actor: 'system', action: 'export', at: now.toISOString() }
  const next: ResumeDocument = { ...d, status: 'exported', operations: [...(d.operations ?? []), op] }
  ws.write(`resumes/documents/${file}`, serializeResumeDocument(next))
  return next
}

// ─── Diff（M3.5.3d：identity 对比，不丢 provenance）──

export interface ResumeBulletIdentity {
  sentence: string
  claimId: string
  expectationId?: string
}

export interface ResumeDiff {
  added: ResumeBulletIdentity[]
  removed: ResumeBulletIdentity[]
  unchanged: ResumeBulletIdentity[]
}

const identityOf = (b: ResumeBullet): ResumeBulletIdentity => ({ sentence: b.sentence, claimId: b.claimId, ...(b.metadata?.expectationId ? { expectationId: b.metadata.expectationId } : {}) })
const keyOf = (i: ResumeBulletIdentity): string => `${i.claimId}|${i.sentence}|${i.expectationId ?? ''}`
/** 章节全部 bullet（条目化段含 entries[].bullets——Entry Contract v0.1） */
const allBullets = (s: ResumeSection): ResumeBullet[] => [...s.bullets, ...(s.entries ?? []).flatMap((e) => e.bullets)]

export function diffResumes(a: ResumeDocument, b: ResumeDocument): ResumeDiff {
  const aIds = new Set(a.sections.flatMap((s) => allBullets(s).map(identityOf)).map(keyOf))
  const bList = b.sections.flatMap((s) => allBullets(s).map(identityOf))
  return {
    added: bList.filter((i) => !aIds.has(keyOf(i))),
    removed: [...aIds].filter((k) => !bList.some((i) => keyOf(i) === k)).map((k) => {
      const [claimId, sentence, expectationId] = k.split('|')
      return { sentence, claimId, ...(expectationId ? { expectationId } : {}) }
    }),
    unchanged: bList.filter((i) => aIds.has(keyOf(i))),
  }
}
