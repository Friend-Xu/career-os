/**
 * working-copy-registry（ADR-023 P2.2）：用户创作对象存储——resumes/working-copies/{id}.md。
 * - 双通道写入 + revision 协商：local.revision > engine → push；engine > local → conflict（询问合并）
 * - promoteToDocumentCandidate：WorkingCopy → ResumeDocument Candidate（用户主动「创建版本」）
 *   - bound 块 → bullet（claimId = 主 claim——provenanceLinks[0]，sentence = 用户文本）
 *   - unbound 块 → bullet（claimId 空）+ UNBOUND_BLOCK warning（不阻止——Progressive Trust）
 * - 层级：WorkingCopy → Section → Block（unbound 合法；provenance 是增强不是负担）
 */
import type { WorkingCopy, WorkingSection, ResumeDocument, ResumeSection, ResumeSectionType, ResumeValidation, ResumeValidationIssue } from '../ir/resume.ts'
import type { Workspace } from './workspace.ts'
import { watch } from 'chokidar'
import { nextArtifactId, splitFrontmatter, type ArtifactSpec } from './artifact-registry.ts'
import { scanClaims } from './claim-watcher.ts'
import { RESUME_SPEC, serializeResumeDocument } from './resume-watcher.ts'

export const WORKING_COPY_SPEC: ArtifactSpec = {
  type: 'working_copy',
  dir: 'resumes/working-copies',
  idPrefix: 'wc_',
  marker: /##\s+/,
  passthroughFields: [],
}

export class WorkingCopyError extends Error {
  constructor(message: string) {
    super(`❌ working-copy：${message}`)
    this.name = 'WorkingCopyError'
  }
}

export interface WorkingCopyInput {
  id?: string // 缺省 = 新建（引擎登记 id）
  owner: string
  sections: WorkingSection[]
  revision: number // 客户端当前 revision（协商基准）
  targetContext?: { jobId?: string }
}

export interface UpsertResult {
  status: 'ok' | 'conflict' | 'created'
  copy: WorkingCopy // conflict 时 = 引擎当前副本（UI 询问合并的依据）
}

// ─── 序列化（md：frontmatter + `## {title}` 段 + `- {text}` 块；块 claims 标注 `（claims: c1, c2）`）──

export function serializeWorkingCopy(wc: WorkingCopy): string {
  const meta = [
    `id: ${wc.id}`,
    `owner: ${wc.owner}`,
    `status: ${wc.status}`,
    `revision: ${wc.revision}`,
    `updated_at: ${wc.updatedAt}`,
    ...(wc.targetContext?.jobId ? [`target_job_id: ${wc.targetContext.jobId}`] : []),
  ]
  const body = wc.sections
    .map((s) => {
      const blocks = s.blocks
        .map((b) => {
          const suffix: string[] = []
          if (b.provenanceLinks && b.provenanceLinks.length > 0) suffix.push(`claims: ${b.provenanceLinks.join(', ')}`)
          if (b.expectationId) suffix.push(`expectation: ${b.expectationId}`)
          return `- ${b.text}${suffix.length > 0 ? `（${suffix.join('）（')}）` : ''}`
        })
        .join('\n')
      return `## ${s.title}\n\n${blocks}`
    })
    .join('\n\n')
  return `---\n${meta.join('\n')}\n---\n# 简历工作副本\n\n${body}\n`
}

export function parseWorkingCopyMarkdown(md: string, sourceFile: string): WorkingCopy {
  const { meta, body } = splitFrontmatter(md)
  const sections: WorkingSection[] = []
  let current: WorkingSection | null = null
  for (const line of body.split('\n')) {
    const sec = line.match(/^##\s+(.+)$/)
    if (sec) {
      current = { id: `sec_${sections.length + 1}`, title: sec[1].trim(), blocks: [] }
      sections.push(current)
      continue
    }
    const block = line.match(/^\s*[-*]\s*(.+)$/)
    if (block && current) {
      const raw = block[1].trim()
      const claimsM = raw.match(/（claims:\s*([^）]+)）/)
      const expM = raw.match(/（expectation:\s*([^）]+)）/)
      const text = raw.replace(/\s*（(?:claims|expectation):\s*[^）]*）/g, '').trim()
      const expectationId = expM?.[1].trim()
      current.blocks.push({
        id: `blk_${current.blocks.length + 1}`,
        text,
        ...(expectationId ? { expectationId } : {}),
        // 契约 ApplyTransaction §2：不制造第三种 undefined 态——unbound 块显式 provenanceLinks = []
        provenanceLinks: claimsM ? claimsM[1].split(',').map((c) => c.trim()) : [],
      })
    }
  }
  return {
    id: meta.id ?? sourceFile.replace(/\.md$/, ''),
    owner: meta.owner ?? '',
    sections,
    ...(meta.target_job_id ? { targetContext: { jobId: meta.target_job_id } } : {}),
    status: (meta.status as WorkingCopy['status']) ?? 'active',
    revision: Number(meta.revision ?? '0'),
    updatedAt: meta.updated_at ?? '',
  }
}

export function scanWorkingCopies(ws: Workspace): WorkingCopy[] {
  return ws.listMarkdown('resumes/working-copies').map((f) => parseWorkingCopyMarkdown(ws.read(`resumes/working-copies/${f}`), f))
}

// ─── upsert（双通道写入 + revision 协商）──

export function upsertWorkingCopy(ws: Workspace, input: WorkingCopyInput, now: Date = new Date()): UpsertResult {
  if (!input.owner?.trim()) throw new WorkingCopyError('owner 缺失')
  if (!Array.isArray(input.sections)) throw new WorkingCopyError('sections 必须为数组')

  if (input.id) {
    const file = `resumes/working-copies/${input.id}.md`
    if (ws.exists(file)) {
      const current = parseWorkingCopyMarkdown(ws.read(file), `${input.id}.md`)
      // revision 协商（ADR-023 §7）：engine > local → conflict（询问合并）；local >= engine → push
      if (current.revision > input.revision) {
        return { status: 'conflict', copy: current }
      }
      const next: WorkingCopy = {
        id: current.id,
        owner: input.owner,
        sections: input.sections,
        ...(input.targetContext ? { targetContext: input.targetContext } : {}),
        status: current.status,
        revision: current.revision + 1,
        updatedAt: now.toISOString(),
      }
      ws.write(file, serializeWorkingCopy(next))
      return { status: 'ok', copy: next }
    }
    // id 存在但文件缺失 → 视为新建
  }

  const id = input.id ?? nextArtifactId(ws, WORKING_COPY_SPEC, now)
  const copy: WorkingCopy = {
    id,
    owner: input.owner,
    sections: input.sections,
    ...(input.targetContext ? { targetContext: input.targetContext } : {}),
    status: 'active',
    revision: 1,
    updatedAt: now.toISOString(),
  }
  ws.write(`resumes/working-copies/${id}.md`, serializeWorkingCopy(copy))
  return { status: 'created', copy }
}

// ─── promote（用户主动「创建版本」→ ResumeDocument Candidate）──

const TITLE_TO_TYPE: [RegExp, ResumeSectionType][] = [
  [/个人信息|基本信息/, 'profile'],
  [/专业摘要|个人简介|自我介绍/, 'summary'],
  [/工作经历|实习经历/, 'experience'],
  [/项目经验|项目经历/, 'projects'],
  [/技能/, 'skills'],
  [/教育/, 'education'],
  [/目标意向|求职意向/, 'target_intent'],
]

function sectionTypeOf(title: string): ResumeSectionType | null {
  for (const [re, type] of TITLE_TO_TYPE) if (re.test(title)) return type
  return null
}

/** 纯组装：WorkingCopy → ResumeDocument Candidate（不写盘——promote 与 alignment 输入共用。
 *  bound 块锚主 claim；unbound 块 UNBOUND_BLOCK warning；未知段类型跳过 + invalid） */
export function workingCopyToDocument(wc: WorkingCopy, ws: Workspace, now: Date = new Date()): ResumeDocument {
  const claimsById = new Map(scanClaims(ws).map((c) => [c.record.id, c.record]))
  const issues: ResumeValidationIssue[] = []
  const sections: ResumeSection[] = []

  for (const s of wc.sections) {
    const type = sectionTypeOf(s.title)
    if (!type) {
      issues.push({ code: 'UNKNOWN_SECTION', message: `无法识别段类型（title=${s.title}）——该段未进入版本`, target: s.id })
      continue
    }
    const bullets = s.blocks.map((b): { bullet: ResumeDocument['sections'][number]['bullets'][number] | null; issue?: ResumeValidationIssue } => {
      const meta = b.expectationId ? { expectationId: b.expectationId } : undefined
      if (b.provenanceLinks && b.provenanceLinks.length > 0) {
        const main = b.provenanceLinks[0]
        const claim = claimsById.get(main)
        if (!claim) return { bullet: null, issue: { code: 'CLAIM_NOT_FOUND', message: `主 claim 不存在：${main}`, target: b.id } }
        return { bullet: { sentence: b.text, claimId: main, ...(meta ? { metadata: meta } : {}) } }
      }
      return {
        bullet: { sentence: b.text, claimId: '', ...(meta ? { metadata: meta } : {}) },
        issue: { code: 'UNBOUND_BLOCK', message: '未资产化块（无 claim 锚）——不参与对齐/证据投影', target: b.id },
      }
    })
    const sectionBullets = []
    for (const r of bullets) {
      if (r.issue) issues.push(r.issue)
      if (r.bullet) sectionBullets.push(r.bullet)
    }
    sections.push({ type, title: s.title, bullets: sectionBullets })
  }

  const validation: ResumeValidation = {
    status: issues.some((i) => i.code === 'CLAIM_NOT_FOUND' || i.code === 'UNKNOWN_SECTION') ? 'invalid' : issues.length > 0 ? 'warning' : 'valid',
    issues,
  }

  return {
    id: nextArtifactId(ws, RESUME_SPEC, now),
    status: 'draft',
    person: wc.owner,
    ...(wc.targetContext?.jobId ? { targetJobId: wc.targetContext.jobId } : {}),
    templateId: 'working-copy-v0.1',
    templateVersion: '0.1',
    sections,
    generatedAt: now.toISOString(),
    lineage: { derivationType: 'user_edit', createdBy: 'user' },
    operations: [{ id: `operation_${now.getTime().toString(36)}`, actor: 'user', action: 'create', at: now.toISOString() }],
    validation,
  }
}

/** promote：WorkingCopy → ResumeDocument Candidate（写 documents/ + wc 状态 promoted） */
export function promoteToDocumentCandidate(ws: Workspace, id: string, now: Date = new Date()): ResumeDocument {
  const file = `resumes/working-copies/${id}.md`
  if (!ws.exists(file)) throw new WorkingCopyError(`工作副本不存在：${id}`)
  const wc = parseWorkingCopyMarkdown(ws.read(file), `${id}.md`)
  const document = workingCopyToDocument(wc, ws, now)

  // 写 documents/（复用 resume-watcher 序列化）+ 更新 wc 状态（promoted——保留编辑态文件，记录已发布）
  ws.write(`resumes/documents/${document.id}.md`, serializeResumeDocument(document))
  const next = { ...wc, status: 'promoted' as const }
  ws.write(file, serializeWorkingCopy(next))
  return document
}

/** 目录变更监听（Agent 直接写 working-copies/ 时引擎广播） */
export function watchWorkingCopies(ws: Workspace, onChanged: (copies: WorkingCopy[]) => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.workingCopies)
  const notify = () => onChanged(scanWorkingCopies(ws))
  watcher.on('add', notify)
  watcher.on('change', notify)
  watcher.on('unlink', notify)
  return { close: () => watcher.close() }
}
