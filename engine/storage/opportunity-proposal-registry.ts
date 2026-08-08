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
import { scanWorkingCopies, workingCopyToDocument, serializeWorkingCopy } from './working-copy-registry.ts'
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
  blockId?: string // rewrite/delete = 目标块；insert 缺省
  sectionId?: string // insert 定位口（契约 ApplyTransaction §2——Agent 可提供；v0.1 缺省 = 引擎默认段）
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

/** Bridge 输入上下文（契约 §2.1——Engine 组装，Agent 只消费此结构，不读数据库；EvidenceContextProjection v0.2） */
export interface ProposalBridgeContext {
  opportunity: Opportunity
  responsibilityStatement: string
  evidence: { id: string; eventTitle: string; content: string; contribution: string; impact?: string; validation?: string }[]
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
    .map((e) => ({
      id: e.id,
      eventTitle: e.event.title,
      content: evidenceText(e),
      contribution: e.contribution,
      ...(e.evidence.impact?.length ? { impact: e.evidence.impact.map((v) => v.content).join('；') } : {}),
      ...(e.evidence.validation?.length ? { validation: e.evidence.validation.map((v) => v.content).join('；') } : {}),
    }))
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
        `| section_id | ${c.sectionId ?? ''} |\n` +
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
    const sectionId = section.match(/\|\s*section_id\s*\|\s*([^|]*)\s*\|/)?.[1]?.trim()
    const operation = section.match(/\|\s*operation\s*\|\s*([^|]*)\s*\|/)?.[1]?.trim() as ProposalChange['operation']
    const before = section.match(/\|\s*before\s*\|\s*([^|]*)\s*\|/)?.[1]?.trim() ?? ''
    const after = section.match(/\|\s*after\s*\|\s*([^|]*)\s*\|/)?.[1]?.trim() ?? ''
    changes.push({ ...(blockId ? { blockId } : {}), ...(sectionId ? { sectionId } : {}), before, after, operation })
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

// ─── P3.4：ApplyTransaction（契约 apply-transaction-contract-v0.1，FROZEN）──

export const APPLY_TX_SPEC: ArtifactSpec = {
  type: 'apply_transaction',
  dir: 'apply-transactions',
  idPrefix: 'apply_tx_',
  marker: /##\s*变更 1/,
  passthroughFields: [],
}

export interface ApplyTransaction {
  id: string
  proposalId: string
  wcId: string
  beforeRevision: number
  afterRevision: number
  changes: ProposalChange[]
  status: 'applied' | 'failed' | 'conflict'
  createdAt: string
  appliedAt?: string
  conflict?: { reason: 'WORKING_COPY_CHANGED'; expectedRevision: number; currentRevision: number }
}

export type ApplyResult =
  | { status: 'applied'; transactionId: string; newRevision: number }
  | { status: 'conflict'; transactionId: string; reason: 'WORKING_COPY_CHANGED'; expectedRevision: number; currentRevision: number }

/** 应用 changes（纯函数——构造新 sections；原子性靠一次写盘） */
function applyChanges(wc: WorkingCopy, changes: ProposalChange[]): WorkingCopy {
  const sections = wc.sections.map((s) => ({ ...s, blocks: [...s.blocks] }))
  for (const c of changes) {
    if (c.operation === 'rewrite' || c.operation === 'delete') {
      const sec = sections.find((s) => s.blocks.some((b) => b.id === c.blockId))
      if (!sec) throw new OpportunityProposalError(`${c.operation} 目标块不存在：${c.blockId}`)
      if (c.operation === 'rewrite') {
        const i = sec.blocks.findIndex((b) => b.id === c.blockId)
        sec.blocks[i] = { ...sec.blocks[i], text: c.after }
      } else {
        sec.blocks = sec.blocks.filter((b) => b.id !== c.blockId)
      }
    } else if (c.operation === 'insert') {
      const target = c.sectionId ? sections.find((s) => s.id === c.sectionId) : sections[0]
      if (!target) throw new OpportunityProposalError(`insert 目标段不存在：${c.sectionId ?? '(默认段)'}`)
      const maxSeq = target.blocks.reduce((m, b) => {
        const n = /^blk_(\d+)$/.exec(b.id)
        return n ? Math.max(m, Number(n[1])) : m
      }, 0)
      target.blocks.push({ id: `blk_${maxSeq + 1}`, text: c.after, provenanceLinks: [] })
    }
  }
  return { ...wc, sections }
}

function registerTransaction(
  ws: Workspace,
  t: Omit<ApplyTransaction, 'id' | 'createdAt'>,
  now: Date,
): ApplyTransaction {
  const tx: ApplyTransaction = { id: nextArtifactId(ws, APPLY_TX_SPEC, now), createdAt: now.toISOString(), ...t }
  ws.write(`apply-transactions/${tx.id}.md`, serializeApplyTransaction(tx))
  return tx
}

function serializeApplyTransaction(tx: ApplyTransaction): string {
  const meta = [
    `id: ${tx.id}`,
    `created_at: ${tx.createdAt}`,
    `proposal_id: ${tx.proposalId}`,
    `wc_id: ${tx.wcId}`,
    `before_revision: ${tx.beforeRevision}`,
    `after_revision: ${tx.afterRevision}`,
    `status: ${tx.status}`,
    ...(tx.appliedAt ? [`applied_at: ${tx.appliedAt}`] : []),
  ]
  const parts = [
    `---\n${meta.join('\n')}\n---`,
    `# 应用事务：${tx.proposalId}`,
    ...(tx.conflict
      ? [`## 冲突信息\n\n- reason: ${tx.conflict.reason}\n- expected_revision: ${tx.conflict.expectedRevision}\n- current_revision: ${tx.conflict.currentRevision}`]
      : []),
  ]
  tx.changes.forEach((c, i) => {
    parts.push(
      `## 变更 ${i + 1}\n\n| 字段 | 值 |\n|------|-----|\n` +
        `| block_id | ${c.blockId ?? ''} |\n` +
        `| section_id | ${c.sectionId ?? ''} |\n` +
        `| operation | ${c.operation} |\n` +
        `| before | ${c.before} |\n` +
        `| after | ${c.after} |\n`,
    )
  })
  return parts.join('\n\n')
}

/** 全量扫描（apply-transactions/ 目录） */
export function scanApplyTransactions(ws: Workspace): ApplyTransaction[] {
  if (!ws.exists('apply-transactions')) return []
  return ws.listMarkdown('apply-transactions').sort().map((f) => parseApplyTransactionMarkdown(ws.read(`apply-transactions/${f}`), f))
}

export function parseApplyTransactionMarkdown(md: string, sourceFile: string): ApplyTransaction {
  const { meta, body } = splitFrontmatter(md)
  const id = meta.id ?? sourceFile.replace(/\.md$/, '')
  const changes: ProposalChange[] = []
  for (const m of body.matchAll(/##\s*变更 (\d+)([\s\S]*?)(?=\n##\s|$)/g)) {
    const section = m[2]
    const blockId = section.match(/\|\s*block_id\s*\|\s*([^|]*)\s*\|/)?.[1]?.trim()
    const sectionId = section.match(/\|\s*section_id\s*\|\s*([^|]*)\s*\|/)?.[1]?.trim()
    const operation = section.match(/\|\s*operation\s*\|\s*([^|]*)\s*\|/)?.[1]?.trim() as ProposalChange['operation']
    const before = section.match(/\|\s*before\s*\|\s*([^|]*)\s*\|/)?.[1]?.trim() ?? ''
    const after = section.match(/\|\s*after\s*\|\s*([^|]*)\s*\|/)?.[1]?.trim() ?? ''
    changes.push({ ...(blockId ? { blockId } : {}), ...(sectionId ? { sectionId } : {}), before, after, operation })
  }
  return {
    id,
    proposalId: meta.proposal_id ?? '',
    wcId: meta.wc_id ?? '',
    beforeRevision: Number(meta.before_revision ?? 0),
    afterRevision: Number(meta.after_revision ?? 0),
    changes,
    status: (meta.status as ApplyTransaction['status']) ?? 'failed',
    createdAt: meta.created_at ?? '',
    ...(meta.applied_at ? { appliedAt: meta.applied_at } : {}),
    ...(body.includes('WORKING_COPY_CHANGED')
      ? {
          conflict: {
            reason: 'WORKING_COPY_CHANGED' as const,
            expectedRevision: Number(body.match(/expected_revision:\s*(\d+)/)?.[1] ?? 0),
            currentRevision: Number(body.match(/current_revision:\s*(\d+)/)?.[1] ?? 0),
          },
        }
      : {}),
  }
}

/** apply：approved → revision check → 应用 changes（原子写盘）→ 事务登记 → revision+1。
 *  conflict 是正常协作冲突不是失败（不抛错）——返回 expected/current 供 UI 提示重新分析 */
export function applyOpportunityProposal(ws: Workspace, id: string, now: Date = new Date()): ApplyResult {
  const file = `opportunity-proposals/${id}.md`
  if (!ws.exists(file)) throw new OpportunityProposalError(`提案不存在：${id}`)
  const proposal = parseOpportunityProposalMarkdown(ws.read(file), `${id}.md`)
  if (proposal.status !== 'approved') throw new OpportunityProposalError(`仅 approved 可 apply（当前 ${proposal.status}）`)

  const wc = scanWorkingCopies(ws).find((w) => w.id === proposal.wcId)
  if (!wc) throw new OpportunityProposalError(`工作副本不存在：${proposal.wcId}`)

  // 不变量 2：revision check——快照漂移 → conflict（不覆盖用户新内容）
  const expected = proposal.validation.sourceSnapshot.wcRevision
  if (expected !== wc.revision) {
    const tx = registerTransaction(
      ws,
      {
        proposalId: proposal.id,
        wcId: wc.id,
        beforeRevision: wc.revision,
        afterRevision: wc.revision,
        changes: proposal.changes,
        status: 'conflict',
        conflict: { reason: 'WORKING_COPY_CHANGED', expectedRevision: expected, currentRevision: wc.revision },
      },
      now,
    )
    return {
      status: 'conflict',
      transactionId: tx.id,
      reason: 'WORKING_COPY_CHANGED',
      expectedRevision: expected,
      currentRevision: wc.revision,
    }
  }

  // 不变量 1：apply 不重新生成——直接采用 Proposal.changes
  const next = applyChanges(wc, proposal.changes)
  const afterRevision = wc.revision + 1
  ws.write(
    `resumes/working-copies/${wc.id}.md`,
    serializeWorkingCopy({ ...next, revision: afterRevision, updatedAt: now.toISOString() }),
  )
  const tx = registerTransaction(
    ws,
    { proposalId: proposal.id, wcId: wc.id, beforeRevision: wc.revision, afterRevision, changes: proposal.changes, status: 'applied', appliedAt: now.toISOString() },
    now,
  )
  return { status: 'applied', transactionId: tx.id, newRevision: afterRevision }
}
