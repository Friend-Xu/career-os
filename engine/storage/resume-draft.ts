/**
 * resume-draft（M3.5.2 纯函数闭环，watcher 最后接入）：Draft Manifest → ResumeDocument。
 * 管线：parseDraftManifest → resolve（ClaimResolver）→ validate（三态 + issues）→ assemble（Assembly，不含表达逻辑）
 * - Mode A：无 override → sentence = claim.statement（默认表达，未经改写）
 * - Mode B：override_source=user 才进入；ai/缺省 → 忽略 override（OVERRIDE_NOT_USER warning）
 * - 校验三态：claimId 不存在 → invalid；存在但不可消费 → warning；不在岗位候选集 → warning；
 *   skills 声明但无 assetRefs → invalid（沿用 renderer 拒绝）
 * - 组装产物：status=draft + lineage + operations（create 审计）
 */
import { randomUUID } from 'node:crypto'
import type { CareerClaim, EvidenceItem } from '../ir/schema.ts'
import type {
  ResumeDocument,
  ResumeDraftManifest,
  ResumeSection,
  ResumeSectionType,
  ResumeValidation,
  ResumeValidationIssue,
} from '../ir/resume.ts'
import { finalize, type Validated } from '../ir/validator.ts'
import { splitFrontmatter } from './artifact-registry.ts'
import { parseSummaryTable } from './report-watcher.ts'
import { canUseClaim, indexEvidence } from './claim-policy.ts'

// ─── 1. Draft Parser（md → manifest）──

const SECTION_TYPES: ResumeSectionType[] = ['summary', 'experience', 'projects', 'skills', 'education']
const IDENTITY_TYPES = ['profile', 'education', 'experience', 'target_intent'] as const
const OVERRIDE_SOURCES = ['user', 'ai', 'proposal'] as const // proposal = 用户已确认的 AI 建议（Proposal Layer 应用链）

/** `## Claims` 段：`- {claimId}（section: x；expectation: y；sentence_override: "..."；override_source: user）` */
function parseClaims(md: string): { claims: ResumeDraftManifest['claims']; issues: ResumeValidationIssue[] } {
  const parts = md.split(/##\s*Claims/, 2)
  const issues: ResumeValidationIssue[] = []
  if (parts.length < 2) return { claims: [], issues }
  const section = parts[1].split(/\n##\s+/)[0]
  const claims: ResumeDraftManifest['claims'] = []
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*[-*]\s*(claim_\d{8}_\d{5})（(.+)）$/)
    if (!m) continue
    const ref: ResumeDraftManifest['claims'][number] = { claimId: m[1], section: 'experience' }
    for (const kv of m[2].split('；')) {
      const [k, ...rest] = kv.split(':')
      const v = rest.join(':').trim()
      if (k === 'section') {
        if (SECTION_TYPES.includes(v as ResumeSectionType)) ref.section = v as ResumeSectionType
        else issues.push({ code: 'BAD_SECTION', message: `非法章节类型 ${JSON.stringify(v)}`, target: m[1] })
      } else if (k === 'expectation') ref.expectationId = v
      else if (k === 'sentence_override') ref.sentenceOverride = v.replace(/^"|"$/g, '')
      else if (k === 'override_source') {
        if (OVERRIDE_SOURCES.includes(v as 'user' | 'ai' | 'proposal')) ref.overrideSource = v as 'user' | 'ai' | 'proposal'
        else issues.push({ code: 'BAD_OVERRIDE_SOURCE', message: `非法 override_source ${JSON.stringify(v)}（合法值：user/ai/proposal）`, target: m[1] })
      }
    }
    claims.push(ref)
  }
  return { claims, issues }
}

/** `## Skills` 段：`- {name}（asset）` */
function parseSkills(md: string): string[] {
  const parts = md.split(/##\s*Skills/, 2)
  if (parts.length < 2) return []
  const section = parts[1].split(/\n##\s+/)[0]
  const out: string[] = []
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*[-*]\s*(.+?)\s*（asset）\s*$/)
    if (m) out.push(m[1].trim())
  }
  return out
}

/** `## 身份信息` 段（M5.2 G6）：`### {type} | {title}` 小节 + `- {label} | {body}` 行（无 | 则整行为 body） */
function parseIdentitySections(md: string): ResumeDraftManifest['identitySections'] {
  const parts = md.split(/##\s*身份信息/, 2)
  if (parts.length < 2) return undefined
  const section = parts[1].split(/\n##\s+/)[0]
  const out: NonNullable<ResumeDraftManifest['identitySections']> = []
  let current: (typeof out)[number] | null = null
  for (const line of section.split('\n')) {
    const head = line.match(/^###\s*(\w+)\s*\|\s*(.+)$/)
    if (head) {
      const t = head[1] as (typeof IDENTITY_TYPES)[number]
      if (IDENTITY_TYPES.includes(t)) {
        current = { type: t, title: head[2].trim(), entries: [] }
        out.push(current)
        continue
      }
      current = null
      continue
    }
    const item = line.match(/^\s*[-*]\s*(.+)$/)
    if (current && item) {
      const content = item[1].trim()
      if (!content || content === '-') continue
      const sep = content.indexOf('|')
      current.entries.push(sep > 0 ? { label: content.slice(0, sep).trim(), body: content.slice(sep + 1).trim() } : { body: content })
    }
  }
  return out.filter((s) => s.entries.length > 0)
}

export function parseDraftManifest(md: string, sourceFile: string): Validated<ResumeDraftManifest> {
  const { meta, body } = splitFrontmatter(md)
  const fields = parseSummaryTable(body)
  if (!fields) {
    return finalize({} as ResumeDraftManifest, [
      { path: sourceFile, reason: '未找到 `## 分析摘要` 表格', severity: 'error' },
    ])
  }
  const checks: { path: string; reason: string; severity: 'warn' | 'error' }[] = []
  for (const f of ['type', 'template_id'] as const) {
    if (!fields[f] || fields[f] === '-') checks.push({ path: f, reason: '缺失（摘要表未填）', severity: 'error' })
  }
  if (fields.type && fields.type !== 'resume_draft') {
    checks.push({ path: 'type', reason: `非法值 ${JSON.stringify(fields.type)}（合法值：resume_draft）`, severity: 'warn' })
  }
  const { claims, issues } = parseClaims(body)
  for (const i of issues) checks.push({ path: i.target, reason: `${i.code}: ${i.message}`, severity: 'warn' })
  const skills = parseSkills(body)
  const identitySections = parseIdentitySections(body)

  const record: ResumeDraftManifest = {
    id: meta.id ?? sourceFile.replace(/\.md$/, ''),
    type: 'resume_draft',
    ...(fields.person ? { person: fields.person } : {}),
    ...(fields.target_id ? { targetId: fields.target_id } : {}),
    ...(fields.target_job_id ? { targetJobId: fields.target_job_id } : {}),
    templateId: fields.template_id ?? '',
    ...(fields.template_version ? { templateVersion: fields.template_version } : {}),
    ...(fields.parent_resume_id ? { parentResumeId: fields.parent_resume_id } : {}),
    claims,
    skills,
    ...(identitySections ? { identitySections } : {}),
  }
  return finalize(record, checks)
}

// ─── 2. ClaimResolver + 3. Validation + 4. Assembly ──

export interface AssembleInput {
  manifest: ResumeDraftManifest
  claims: CareerClaim[] // 全量 Claim（engine 扫描）
  evidence: EvidenceItem[] // 全量 Evidence（canUseClaim 索引——Claim 没有可信度只有可消费性）
  selectorCandidates: string[] // 该岗位 claims/select 候选 claimId 集合（无 targetJobId 时为空——跳过候选校验）
  now?: Date
}

export interface AssembleResult {
  document: ResumeDocument
  validation: ResumeValidation
}

/** Draft → ResumeDocument（纯函数：不含表达逻辑——sentence 来自 claim.statement 或 user override） */
export function assembleResumeFromDraft(input: AssembleInput): AssembleResult {
  const { manifest, claims, evidence, selectorCandidates, now = new Date() } = input
  const byId = new Map(claims.map((c) => [c.id, c]))
  const evidenceById = indexEvidence(evidence)
  const issues: ResumeValidationIssue[] = []

  // 按 section 分组（保持 draft 声明顺序）
  const sections = new Map<ResumeSectionType, ResumeSection>()
  const skillSection: ResumeSection = { type: 'skills', title: '技能', bullets: [], assetRefs: [] }
  if (manifest.skills.length === 0 && manifest.claims.some((c) => c.section === 'skills')) {
    issues.push({ code: 'SKILL_NO_ASSET', message: 'Skills 章节缺少资产引用（assetRefs）', target: 'skills' })
  }

  for (const ref of manifest.claims) {
    const claim = byId.get(ref.claimId)
    if (!claim) {
      issues.push({ code: 'CLAIM_NOT_FOUND', message: `Claim 不存在：${ref.claimId}`, target: ref.claimId })
      continue
    }
    if (!canUseClaim(claim, evidenceById)) {
      issues.push({ code: 'CLAIM_NOT_USABLE', message: `Claim 不可消费（证据未 trusted）`, target: ref.claimId })
    }
    if (selectorCandidates.length > 0 && !selectorCandidates.includes(ref.claimId)) {
      issues.push({ code: 'CLAIM_NOT_IN_SELECTOR', message: 'Claim 不在该岗位表达候选集（claims/select）', target: ref.claimId })
    }
    let sentence = claim.statement
    if (ref.sentenceOverride) {
      if (ref.overrideSource === 'user' || ref.overrideSource === 'proposal') {
        sentence = ref.sentenceOverride
      } else {
        issues.push({ code: 'OVERRIDE_NOT_USER', message: 'AI 提供的 sentence 是 suggestion——必须经过 M3-1 Sentence Generator；override 仅 user/已确认 proposal 进入', target: ref.claimId })
      }
    }
    let target: ResumeSection
    if (ref.section === 'skills') {
      target = skillSection
    } else {
      target = sections.get(ref.section)!
      if (!target) {
        target = { type: ref.section, title: sectionTitle(ref.section), bullets: [] }
        sections.set(ref.section, target)
      }
    }
    target.bullets.push({
      sentence,
      claimId: ref.claimId,
      ...(ref.expectationId ? { metadata: { expectationId: ref.expectationId } } : {}),
    })
  }

  // M5.2 G6：身份段（非 claim 内容——profile/education/experience/target_intent，Assembly 只投影不校验 claim）
  // M6.3：identity body 尾缀（identity）防重复——AI 误写（draft 行自带标记）时剥离 + warning，防身份污染
  const identityList: ResumeSection[] = (manifest.identitySections ?? []).map((s) => ({
    type: s.type,
    title: s.title,
    bullets: [],
    identity: s.entries.map((e) => {
      if (e.body?.endsWith('（identity）')) {
        issues.push({ code: 'IDENTITY_MARKER_IN_BODY', message: '身份条目 body 含（identity）尾缀（draft 误写）——已剥离', target: `identity:${s.type}` })
        return { ...e, body: e.body.slice(0, -'（identity）'.length).trimEnd() }
      }
      return e
    }),
  }))

  const sectionList = [...identityList, ...sections.values()]
  if (manifest.skills.length > 0) {
    skillSection.assetRefs = [...manifest.skills]
    sectionList.push(skillSection)
  } else if (skillSection.bullets.length > 0) {
    sectionList.push(skillSection) // skills 有 claim bullet 但无 asset → 保持（invalid 已标）
  }

  const status: ResumeValidation['status'] = issues.some((i) => i.code === 'CLAIM_NOT_FOUND' || i.code === 'SKILL_NO_ASSET') ? 'invalid' : issues.length > 0 ? 'warning' : 'valid'

  const createdBy = 'ai' // v0.2：Draft 文件由 AI 写入；user 手工 Draft 未来经 manifest 声明
  const document: ResumeDocument = {
    id: manifest.id,
    status: 'draft',
    person: manifest.person ?? '',
    ...(manifest.targetId ? { targetId: manifest.targetId } : {}),
    ...(manifest.targetJobId ? { targetJobId: manifest.targetJobId } : {}),
    templateId: manifest.templateId,
    templateVersion: manifest.templateVersion ?? '1.0',
    sections: sectionList,
    generatedAt: now.toISOString(),
    lineage: {
      ...(manifest.parentResumeId ? { parentResumeId: manifest.parentResumeId } : {}),
      derivationType: manifest.derivationType ?? (manifest.parentResumeId ? 'clone' : 'jd_generate'),
      createdBy,
    },
    operations: [{ id: `operation_${randomUUID().slice(0, 8)}`, actor: createdBy, action: 'create', at: now.toISOString() }],
  }
  return { document, validation: { status, issues } }
}

const SECTION_TITLES: Record<ResumeSectionType, string> = {
  summary: '个人简介',
  experience: '工作经历',
  projects: '项目经历',
  skills: '技能',
  education: '教育背景',
  profile: '职业画像',
  target_intent: '目标意向',
}

function sectionTitle(type: ResumeSectionType): string {
  return SECTION_TITLES[type]
}
