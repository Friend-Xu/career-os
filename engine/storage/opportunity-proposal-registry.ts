/**
 * opportunity-proposal-registry（P3.3——契约 docs/domain/opportunity-proposal-contract-v0.1.md，FROZEN）：
 * Proposal Bridge 登记通道——Opportunity「为什么改」→ OpportunityProposal「怎么改」。
 * - Producer Boundary：Agent 提供 changes 内容，Engine 登记 + 确定性校验（FACT_GROUNDING），
 *   User decision 决定状态；Proposal 不拥有事实生产权（不产 Claim、不改 WorkingCopy——P3.4 才 apply）
 * - 校验：numeric_anchor（复用 claim-proposal anchorCheck）+ capability_anchor（级别词不高于证据）；
 *   entity/outcome 子锚 v0.2（需要语义规则——标准缺失先立标准，诚实标注）
 * - snapshot：生成时固化 wcRevision + evidenceHash + opportunityVersion——P3.4 apply 防过期覆盖
 * - approved ≠ applied：approve 只是用户同意（P3.3）；apply 成功才改 WorkingCopy（P3.4）
 */
import { createHash } from 'node:crypto'
import type { EvidenceItem } from '../ir/schema.ts'
import type { WorkingCopy } from '../ir/resume.ts'
import type { Workspace } from './workspace.ts'
import { nextArtifactId, splitFrontmatter, type ArtifactSpec } from './artifact-registry.ts'
import { scanEvidence } from './evidence-watcher.ts'
import { scanJobs } from './job-watcher.ts'
import { scanClaims } from './claim-watcher.ts'
import { scanWorkingCopies, workingCopyToDocument } from './working-copy-registry.ts'
import { anchorCheck, evidenceText } from './claim-proposal-registry.ts'
import { computeOpportunities, type Opportunity } from '../runtime/opportunity.ts'

export const OPPORTUNITY_PROPOSAL_SPEC: ArtifactSpec = {
  type: 'opportunity_proposal',
  dir: 'opportunity-proposals',
  idPrefix: 'opportunity_proposal_',
  marker: /##\s*变更 \d+/,
  passthroughFields: [],
}

export type OpportunityProposalStatus = 'pending' | 'approved' | 'rejected'

export interface ProposalChange {
  blockId?: string // rewrite/delete = 目标块；insert 缺省（追加到编辑上下文段）
  before: string
  after: string
  operation: 'rewrite' | 'insert' | 'delete'
}

export interface SourceSnapshot {
  opportunityId: string
  opportunityVersion: string // 机会投影指纹（job + wc + updatedAt 派生 sha1）——apply 时重算比对
  wcRevision: number
  evidenceHash: string
}

export interface ProposalValidation {
  status: 'valid' | 'invalid'
  evaluatedAt: string
  sourceSnapshot: SourceSnapshot
  issues: { code: string; message: string }[]
}

export interface OpportunityProposal {
  id: string
  opportunityId: string
  wcId: string
  changes: ProposalChange[]
  validation: ProposalValidation
  status: OpportunityProposalStatus
  createdAt: string
  decidedAt?: string
}

export interface OpportunityProposalInput {
  opportunityId: string
  wcId: string
  changes: ProposalChange[]
}

/** Bridge 输入上下文（契约 §2.1——Engine 组装，Agent 只消费此结构，不读数据库） */
export interface ProposalBridgeContext {
  opportunity: Opportunity
  responsibilityStatement: string
  evidence: { id: string; eventTitle: string; contribution: string }[]
  currentBlockText?: string
}

const OPERATIONS = ['rewrite', 'insert', 'delete'] as const

/** 能力级别升级词——after 出现而证据全文无 → 能力声明高于证据（capability_anchor） */
const LEVEL_UP_WORDS = ['主导', '架构', '独立负责', '全权']

export class OpportunityProposalError extends Error {
  constructor(message: string) {
    super(`❌ opportunity-proposal：${message}`)
    this.name = 'OpportunityProposalError'
  }
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12)
}

/** 机会投影指纹（job + wc + updatedAt）——重建=重算，apply 时比对快照 */
function opportunityVersion(jobId: string, wc: WorkingCopy): string {
  return sha1(`${jobId}:${wc.id}:${wc.updatedAt}`)
}

/** 从确定性机会 id 解析 jobId（alignment 模式 `alignment:{jobId}:{respId}`；material 机会不建 Proposal——契约 §8） */
function jobIdFromOpportunityId(opportunityId: string): string | null {
  const m = opportunityId.match(/^alignment:(.+):(.+)$/)
  return m ? m[1] : null
}

function findOpportunity(ws: Workspace, wcId: string, opportunityId: string): { opportunity: Opportunity; jobId: string } | null {
  const wc = scanWorkingCopies(ws).find((w) => w.id === wcId)
  const jobId = jobIdFromOpportunityId(opportunityId)
  if (!wc || !jobId) return null
  const job = scanJobs(ws).find((j) => j.record.id === jobId)
  if (!job) return null
  const ops = computeOpportunities({
    job: job.record,
    evidenceItems: scanEvidence(ws).map((e) => e.record),
    claims: scanClaims(ws).map((c) => c.record),
    resumeDocument: workingCopyToDocument(wc, ws),
    wc,
  })
  const opp = ops.find((o) => o.id === opportunityId)
  return opp ? { opportunity: opp, jobId: job.record.id } : null
}

/** FACT_GROUNDING v0.1：numeric_anchor（数字在证据有锚）+ capability_anchor（级别不高于证据）；
 *  entity/outcome 子锚 v0.2（语义规则——标准缺失先立标准） */
function factGrounding(after: string, evidence: EvidenceItem[]): string[] {
  const issues: string[] = []
  const unanchored = anchorCheck(after, evidence)
  if (unanchored.length > 0) issues.push(`numeric_anchor 失败——after 数字无证据锚点：${unanchored.join('、')}`)
  const corpus = evidence.map(evidenceText).join(' ')
  for (const w of LEVEL_UP_WORDS) {
    if (after.includes(w) && !corpus.includes(w)) {
      issues.push(`capability_anchor 失败——after 含升级词「${w}」但证据无（能力声明高于证据）`)
      break
    }
  }
  return issues
}

/** changes 结构校验（非空 + 操作合法 + EMPTY_EDIT） */
function validateChanges(changes: ProposalChange[]): string[] {
  const issues: string[] = []
  if (changes.length === 0) issues.push('changes 为空——候选必须包含至少一个变更')
  for (const c of changes) {
    if (!OPERATIONS.includes(c.operation as (typeof OPERATIONS)[number])) issues.push(`非法 operation：${c.operation}`)
    if ((c.operation === 'rewrite' || c.operation === 'delete') && !c.blockId) issues.push(`${c.operation} 必须指定 blockId`)
    if (c.operation === 'insert' && !c.after?.trim()) issues.push('insert 必须提供 after 文本')
    if (c.before?.trim() || c.after?.trim()) {
      // 有实际改动
    } else {
      issues.push('EMPTY_EDIT——变更无实际改动（before 与 after 均空）')
    }
  }
  return issues
}

/** Bridge context 组装（契约 §2.1——Agent 读，经 opportunity-proposals/context RPC） */
export function buildBridgeContext(ws: Workspace, wcId: string, opportunityId: string): ProposalBridgeContext {
  const found = findOpportunity(ws, wcId, opportunityId)
  if (!found) throw new OpportunityProposalError(`机会不存在或与工作副本不匹配：${opportunityId}`)
  const { opportunity, jobId } = found
  const wc = scanWorkingCopies(ws).find((w) => w.id === wcId)!
  const job = scanJobs(ws).find((j) => j.record.id === jobId)!
  const evidenceById = new Map(scanEvidence(ws).map((p) => [p.record.id, p.record]))

  const responsibilityStatement =
    opportunity.anchor.kind === 'alignment'
      ? job.record.responsibilities.find((r) => r.id === opportunity.anchor.responsibilityId)?.statement ?? ''
      : ''
  const evidence = opportunity.refs.evidenceIds
    .map((id) => evidenceById.get(id))
    .filter((e): e is EvidenceItem => Boolean(e))
    .map((e) => ({ id: e.id, eventTitle: e.event.title, contribution: e.contribution }))
  const currentBlockText =
    opportunity.applyTarget?.blockId
      ? wc.sections.flatMap((s) => s.blocks).find((b) => b.id === opportunity.applyTarget!.blockId)?.text
      : undefined

  return { opportunity, responsibilityStatement, evidence, currentBlockText }
}

/** 提交候选（generate——Agent 提供 changes；Engine 校验 + 登记 pending） */
export function submitOpportunityProposal(ws: Workspace, input: OpportunityProposalInput, now: Date = new Date()): OpportunityProposal {
  const found = findOpportunity(ws, input.wcId, input.opportunityId)
  if (!found) throw new OpportunityProposalError(`OPPORTUNITY_REF——机会不存在或与工作副本不匹配：${input.opportunityId}`)
  const { opportunity, jobId } = found
  const wc = scanWorkingCopies(ws).find((w) => w.id === input.wcId)!

  const issues: string[] = []
  issues.push(...validateChanges(input.changes))

  const refEvidence = scanEvidence(ws)
    .map((p) => p.record)
    .filter((e) => opportunity.refs.evidenceIds.includes(e.id))
  if (issues.length === 0) {
    for (const c of input.changes) {
      const grounding = factGrounding(c.after, refEvidence)
      issues.push(...grounding.map((m) => `[${c.operation}] ${m}`))
    }
  }
  if (issues.length > 0) throw new OpportunityProposalError(issues.join('；'))

  const validation: ProposalValidation = {
    status: 'valid',
    evaluatedAt: now.toISOString(),
    sourceSnapshot: {
      opportunityId: opportunity.id,
      opportunityVersion: opportunityVersion(jobId, wc),
      wcRevision: wc.revision,
      evidenceHash: sha1(refEvidence.map(evidenceText).join('|')),
    },
    issues: [],
  }

  const id = nextArtifactId(ws, OPPORTUNITY_PROPOSAL_SPEC, now)
  const proposal: OpportunityProposal = {
    id,
    opportunityId: opportunity.id,
    wcId: wc.id,
    changes: input.changes,
    validation,
    status: 'pending',
    createdAt: now.toISOString(),
  }
  ws.write(`opportunity-proposals/${id}.md`, serializeOpportunityProposal(proposal))
  return proposal
}

function serializeOpportunityProposal(p: OpportunityProposal): string {
  const v = p.validation
  const meta = [
    `id: ${p.id}`,
    `created_at: ${p.createdAt}`,
    `opportunity_id: ${p.opportunityId}`,
    `wc_id: ${p.wcId}`,
    `wc_revision: ${v.sourceSnapshot.wcRevision}`,
    `opportunity_version: ${v.sourceSnapshot.opportunityVersion}`,
    `evidence_hash: ${v.sourceSnapshot.evidenceHash}`,
    `status: ${p.status}`,
    ...(p.decidedAt ? [`decided_at: ${p.decidedAt}`] : []),
  ]
  const parts = [`---\n${meta.join('\n')}\n---`, `# 候选：${p.changes[0]?.after.slice(0, 40) ?? ''}`]
  p.changes.forEach((c, i) => {
    parts.push(
      `## 变更 ${i + 1}\n\n| 字段 | 值 |\n|------|-----|\n` +
        `| block_id | ${c.blockId ?? ''} |\n` +
        `| operation | ${c.operation} |\n` +
        `| before | ${c.before} |\n` +
        `| after | ${c.after} |\n`,
    )
  })
  parts.push(`## 校验\n\n- status: ${v.status}\n- evaluated_at: ${v.evaluatedAt}`)
  return parts.join('\n\n')
}

/** 全量扫描（opportunity-proposals/ 目录） */
export function scanOpportunityProposals(ws: Workspace): OpportunityProposal[] {
  if (!ws.exists('opportunity-proposals')) return []
  return ws.listMarkdown('opportunity-proposals').sort().map((f) => parseOpportunityProposalMarkdown(ws.read(`opportunity-proposals/${f}`), f))
}

export function parseOpportunityProposalMarkdown(md: string, sourceFile: string): OpportunityProposal {
  const { meta, body } = splitFrontmatter(md)
  const id = meta.id ?? sourceFile.replace(/\.md$/, '')
  const changes: ProposalChange[] = []
  for (const m of body.matchAll(/##\s*变更 (\d+)([\s\S]*?)(?=\n##\s|$)/g)) {
    const section = m[2]
    const blockId = section.match(/\|\s*block_id\s*\|\s*([^|]*)\s*\|/)?.[1]?.trim()
    const operation = section.match(/\|\s*operation\s*\|\s*([^|]*)\s*\|/)?.[1]?.trim() as ProposalChange['operation']
    const before = section.match(/\|\s*before\s*\|\s*([^|]*)\s*\|/)?.[1]?.trim() ?? ''
    const after = section.match(/\|\s*after\s*\|\s*([^|]*)\s*\|/)?.[1]?.trim() ?? ''
    changes.push({ ...(blockId ? { blockId } : {}), before, after, operation })
  }
  return {
    id,
    opportunityId: meta.opportunity_id ?? '',
    wcId: meta.wc_id ?? '',
    changes,
    validation: {
      status: (body.match(/status:\s*(valid|invalid)/)?.[1] as 'valid' | 'invalid') ?? 'valid',
      evaluatedAt: body.match(/evaluated_at:\s*(\S+)/)?.[1] ?? '',
      sourceSnapshot: {
        opportunityId: meta.opportunity_id ?? '',
        opportunityVersion: meta.opportunity_version ?? '',
        wcRevision: Number(meta.wc_revision ?? 0),
        evidenceHash: meta.evidence_hash ?? '',
      },
      issues: [],
    },
    status: (meta.status as OpportunityProposalStatus) ?? 'pending',
    createdAt: meta.created_at ?? '',
    ...(meta.decided_at ? { decidedAt: meta.decided_at } : {}),
  }
}

function updateStatus(ws: Workspace, id: string, status: OpportunityProposalStatus, now: Date): OpportunityProposal {
  const file = `opportunity-proposals/${id}.md`
  if (!ws.exists(file)) throw new OpportunityProposalError(`提案不存在：${id}`)
  const md = ws.read(file)
  const { meta, body } = splitFrontmatter(md)
  meta.status = status
  meta.decided_at = now.toISOString()
  ws.write(file, `---\n${Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---${body}`)
  return parseOpportunityProposalMarkdown(ws.read(file), `${id}.md`)
}

/** approve：pending → approved——只是用户同意（P3.3）；apply 在 P3.4（快照过期检查也在 apply 时） */
export function approveOpportunityProposal(ws: Workspace, id: string, now: Date = new Date()): OpportunityProposal {
  const file = `opportunity-proposals/${id}.md`
  if (!ws.exists(file)) throw new OpportunityProposalError(`提案不存在：${id}`)
  const proposal = parseOpportunityProposalMarkdown(ws.read(file), `${id}.md`)
  if (proposal.status !== 'pending') throw new OpportunityProposalError(`仅 pending 可 approve（当前 ${proposal.status}）`)
  return updateStatus(ws, id, 'approved', now)
}

/** reject：pending → rejected（单向不 reopen，审计保留） */
export function rejectOpportunityProposal(ws: Workspace, id: string, _reason?: string, now: Date = new Date()): OpportunityProposal {
  const file = `opportunity-proposals/${id}.md`
  if (!ws.exists(file)) throw new OpportunityProposalError(`提案不存在：${id}`)
  const proposal = parseOpportunityProposalMarkdown(ws.read(file), `${id}.md`)
  if (proposal.status !== 'pending') throw new OpportunityProposalError(`仅 pending 可 reject（当前 ${proposal.status}）`)
  return updateStatus(ws, id, 'rejected', now)
}
