/**
 * derivation-proposal-registry：简历派生提案（优化空间 · 派生模式——整份派生走提案通道）。
 * - Agent 经引擎 CLI 桥提交（--derive-submit {json}）→ pending 候选（源副本 × JD → 整份派生内容）
 * - 用户 decide（RPC）：accept → 引擎创建新工作副本（Engine Registration Owner——Agent 不能直接建副本）；
 *   reject → 审计保留（拒绝理由 = Human Preference Signal）
 * - AI 直接写工作副本 = 越权：整份派生是候选，建副本必须用户接受后由引擎完成
 */
import { watch } from 'chokidar'
import { splitFrontmatter, nextArtifactId, type ArtifactSpec } from './artifact-registry.ts'
import type { WorkingCopy, WorkingSection } from '../ir/resume.ts'
import type { Workspace } from './workspace.ts'
import { parseWorkingCopyMarkdown, parseWorkingSections, serializeWorkingCopy, serializeWorkingSections, WORKING_COPY_SPEC } from './working-copy-registry.ts'
import { scanClaims } from './claim-watcher.ts'
import { scanEvidence } from './evidence-watcher.ts'
import { canUseClaim, indexEvidence } from './claim-policy.ts'
import { scanJobs } from './job-watcher.ts'
import { parseStrengthLines } from './person-watcher.ts'
import type { SummaryStrength } from '../ir/schema.ts'

export const DERIVATION_PROPOSAL_SPEC: ArtifactSpec = {
  type: 'derivation_proposal',
  dir: 'derivation-proposals',
  idPrefix: 'derivation_',
  marker: /##\s*变更说明/,
  passthroughFields: [],
}

export type DerivationProposalStatus = 'pending' | 'accepted' | 'rejected'

export interface DerivationProposal {
  id: string
  owner: string
  sourceWcId: string
  jobId: string
  sections: WorkingSection[]
  changeNotes: string[]
  status: DerivationProposalStatus
  createdAt: string
  decidedAt?: string
  rejectReason?: string
  /** accept 时引擎登记的新副本 id（创建副本 = Engine Registration） */
  acceptedWcId?: string
}

export interface DerivationProposalInput {
  owner: string
  sourceWcId: string
  jobId: string
  sections: WorkingSection[]
  changeNotes: string[]
}

/** 段内块引用的 claim 全部存在且可消费（promote 消费策略同源校验——派生锚定必须此刻成立） */
function validateSectionAnchors(ws: Workspace, sections: WorkingSection[]): void {
  const claims = scanClaims(ws).map((p) => p.record)
  const evidenceById = indexEvidence(scanEvidence(ws).map((e) => e.record))
  const usableIds = new Set(claims.filter((c) => canUseClaim(c, evidenceById)).map((c) => c.id))
  const blocks = sections.flatMap((s) => [...(s.blocks ?? []), ...(s.entries ?? []).flatMap((e) => e.blocks ?? [])])
  for (const b of blocks) {
    for (const cid of b.provenanceLinks ?? []) {
      if (!usableIds.has(cid)) throw new Error(`claim 不可消费：${cid}`)
    }
  }
}

export function serializeDerivationProposal(p: DerivationProposal): string {
  return [
    '---',
    `id: ${p.id}`,
    `owner: ${p.owner}`,
    `source_wc_id: ${p.sourceWcId}`,
    `job_id: ${p.jobId}`,
    `status: ${p.status}`,
    `created_at: ${p.createdAt}`,
    ...(p.decidedAt ? [`decided_at: ${p.decidedAt}`] : []),
    ...(p.rejectReason ? [`reject_reason: ${p.rejectReason}`] : []),
    ...(p.acceptedWcId ? [`accepted_wc_id: ${p.acceptedWcId}`] : []),
    '---',
    '# 派生提案',
    '',
    '## 变更说明',
    '',
    ...p.changeNotes.map((n) => `- ${n}`),
    '',
    '## 派生内容',
    '',
    serializeWorkingSections(p.sections),
    '',
  ].join('\n')
}

export function parseDerivationProposalMarkdown(md: string, sourceFile: string): DerivationProposal | null {
  const { meta, body } = splitFrontmatter(md)
  if (!meta.owner || !meta.source_wc_id || !meta.job_id) return null
  const notesM = body.match(/##\s*变更说明\s*\n([\s\S]*?)(?=\n##\s+派生内容|$)/)
  const changeNotes = notesM
    ? notesM[1]
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('- '))
        .map((l) => l.slice(2).trim())
    : []
  const sectionsM = body.match(/##\s*派生内容\s*\n?([\s\S]*)$/)
  const sections = sectionsM ? parseWorkingSections(sectionsM[1] ?? '') : []
  const status = meta.status === 'accepted' || meta.status === 'rejected' ? meta.status : 'pending'
  return {
    id: meta.id ?? sourceFile.replace(/\.md$/, ''),
    owner: meta.owner,
    sourceWcId: meta.source_wc_id,
    jobId: meta.job_id,
    sections,
    changeNotes,
    status,
    createdAt: meta.created_at ?? '',
    ...(meta.decided_at ? { decidedAt: meta.decided_at } : {}),
    ...(meta.reject_reason ? { rejectReason: meta.reject_reason } : {}),
    ...(meta.accepted_wc_id ? { acceptedWcId: meta.accepted_wc_id } : {}),
  }
}

/** 提案扫描（owner/sourceWcId/jobId 可选过滤——UI 按当前人 × 源副本拉取） */
export function scanDerivationProposals(ws: Workspace, filter?: { owner?: string; sourceWcId?: string; jobId?: string }): DerivationProposal[] {
  let files: string[]
  try {
    files = ws.listMarkdown(DERIVATION_PROPOSAL_SPEC.dir)
  } catch {
    return []
  }
  return files
    .sort()
    .map((f) => parseDerivationProposalMarkdown(ws.read(`${DERIVATION_PROPOSAL_SPEC.dir}/${f}`), f))
    .filter((p): p is DerivationProposal => p !== null)
    .filter((p) => !filter || ((!filter.owner || p.owner === filter.owner) && (!filter.sourceWcId || p.sourceWcId === filter.sourceWcId) && (!filter.jobId || p.jobId === filter.jobId)))
}

/** Agent 提交（CLI 桥 --derive-submit）：边界校验 → pending 提案落盘。校验失败 throw（错误给 Agent 看拦截原因） */
export function submitDerivationProposal(ws: Workspace, input: DerivationProposalInput, now: Date = new Date()): DerivationProposal {
  if (!input.owner?.trim()) throw new Error('owner 必填')
  if (!input.sourceWcId) throw new Error('sourceWcId 必填')
  if (!input.jobId) throw new Error('jobId 必填')
  if (!Array.isArray(input.sections) || input.sections.length === 0) throw new Error('sections 必填且非空')
  if (!Array.isArray(input.changeNotes) || input.changeNotes.length === 0) throw new Error('changeNotes 必填且非空')
  // owner 是系统身份字段：必须已登记 persons/{id}
  const registered = ws.listDirs('persons')
  if (!registered.includes(input.owner)) {
    throw new Error(`owner 非登记人：${input.owner}${registered.length > 0 ? `（登记人：${registered.join('、')}）` : '（无登记人）'}`)
  }
  // 源副本存在且归属 owner
  const sourceFile = `resumes/working-copies/${input.sourceWcId}.md`
  if (!ws.exists(sourceFile)) throw new Error(`源副本不存在：${input.sourceWcId}`)
  const source = parseWorkingCopyMarkdown(ws.read(sourceFile), `${input.sourceWcId}.md`)
  if (source.owner !== input.owner) throw new Error(`源副本归属不符：${input.sourceWcId}`)
  // JD 已建档
  if (!scanJobs(ws).some((j) => j.record.id === input.jobId)) throw new Error(`JD 不存在：${input.jobId}`)
  validateSectionAnchors(ws, input.sections)
  const id = nextArtifactId(ws, DERIVATION_PROPOSAL_SPEC, now)
  const proposal: DerivationProposal = {
    id,
    owner: input.owner,
    sourceWcId: input.sourceWcId,
    jobId: input.jobId,
    sections: input.sections,
    changeNotes: input.changeNotes,
    status: 'pending',
    createdAt: now.toISOString(),
  }
  ws.write(`${DERIVATION_PROPOSAL_SPEC.dir}/${id}.md`, serializeDerivationProposal(proposal))
  return proposal
}

/** 用户裁决：accept → 引擎创建新工作副本（名称 = 公司 · 岗位，挂接 targetContext）；
 *  reject → 审计保留。单向不 reopen */
export function decideDerivationProposal(
  ws: Workspace,
  id: string,
  action: 'accept' | 'reject',
  reason?: string,
  now: Date = new Date(),
): DerivationProposal {
  const file = `${DERIVATION_PROPOSAL_SPEC.dir}/${id}.md`
  if (!ws.exists(file)) throw new Error(`提案不存在：${id}`)
  const proposal = parseDerivationProposalMarkdown(ws.read(file), `${id}.md`)
  if (!proposal) throw new Error(`提案解析失败：${id}`)
  if (proposal.status !== 'pending') throw new Error(`提案已裁决：${proposal.status}`)

  let acceptedWcId: string | undefined
  if (action === 'accept') {
    const job = scanJobs(ws).find((j) => j.record.id === proposal.jobId)
    if (!job) throw new Error(`JD 不存在：${proposal.jobId}（提案已过期，请重新派生）`)
    const wcId = nextArtifactId(ws, WORKING_COPY_SPEC, now)
    const copy: WorkingCopy = {
      id: wcId,
      owner: proposal.owner,
      name: `${job.record.company} · ${job.record.title}`,
      sections: proposal.sections,
      targetContext: { jobId: proposal.jobId },
      status: 'active',
      revision: 0,
      updatedAt: now.toISOString(),
    }
    ws.write(`resumes/working-copies/${wcId}.md`, serializeWorkingCopy(copy))
    acceptedWcId = wcId
  }

  const decided: DerivationProposal = {
    ...proposal,
    status: action === 'accept' ? 'accepted' : 'rejected',
    decidedAt: now.toISOString(),
    ...(acceptedWcId ? { acceptedWcId } : {}),
    ...(action === 'reject' && reason ? { rejectReason: reason } : {}),
  }
  ws.write(file, serializeDerivationProposal(decided))
  return decided
}

/** Agent 上下文（CLI 桥 --derive-context）：源副本 + JD + 可用表达资产 + 可信事实 + 已有优势——Agent 只消费此结构 */
export function buildDeriveContext(
  ws: Workspace,
  wcId: string,
  jobId: string,
): {
  wcId: string
  jobId: string
  source: WorkingCopy
  job: { id: string; company: string; title: string; responsibilities: string[]; jd?: string }
  claims: { id: string; statement: string; evidenceTitles: string[] }[]
  evidence: { id: string; title: string; contribution: string }[]
  strengths: SummaryStrength[]
} {
  const sourceFile = `resumes/working-copies/${wcId}.md`
  if (!ws.exists(sourceFile)) throw new Error(`源副本不存在：${wcId}`)
  const source = parseWorkingCopyMarkdown(ws.read(sourceFile), `${wcId}.md`)
  const job = scanJobs(ws).find((j) => j.record.id === jobId)
  if (!job) throw new Error(`JD 不存在：${jobId}`)
  const evidence = scanEvidence(ws).map((p) => p.record).filter((e) => e.status === 'trusted' && e.owner === source.owner)
  const evidenceById = indexEvidence(evidence)
  const claims = scanClaims(ws).map((p) => p.record).filter((c) => c.owner === source.owner && canUseClaim(c, evidenceById))
  const strengthRel = `persons/${source.owner}/snapshot/current/summary_strengths.md`
  const strengths = ws.exists(strengthRel) ? parseStrengthLines(ws.read(strengthRel)) : []
  return {
    wcId,
    jobId,
    source,
    job: {
      id: job.record.id,
      company: job.record.company,
      title: job.record.title,
      responsibilities: job.record.responsibilities.map((r) => r.statement),
      ...(job.record.jd ? { jd: job.record.jd } : {}),
    },
    claims: claims.map((c) => ({
      id: c.id,
      statement: c.statement,
      evidenceTitles: c.provenance.map((p) => evidenceById.get(p.evidenceId)?.event.title ?? p.evidenceId),
    })),
    evidence: evidence.map((e) => ({ id: e.id, title: e.event.title, contribution: e.contribution })),
    strengths,
  }
}

/** derivation-proposals/ 目录监听：变更 → 广播（UI 拉取提案） */
export function watchDerivationProposals(ws: Workspace, onChanged: (parsed: DerivationProposal[]) => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.derivationProposals, { ignoreInitial: true })
  const rescan = (): void => onChanged(scanDerivationProposals(ws))
  watcher.on('add', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  watcher.on('change', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  watcher.on('unlink', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  return { close: () => watcher.close() }
}
