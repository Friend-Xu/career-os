/**
 * opportunity-proposal-registry（P3.3——契约 docs/domain/opportunity-proposal-contract-v0.1.md，FROZEN）：
 * 提案域登记通道——Opportunity「为什么改」→ OpportunityProposal「怎么改」→ ApplyTransaction「怎么落」→
 * OpportunityHistory「决策事件审计」（P4.1——契约 opportunity-history-contract-v0.1，FROZEN，同域聚合避免循环依赖）。
 * - Producer Boundary：Agent 提供 changes 内容，Engine 登记 + 确定性校验（FACT_GROUNDING），
 *   User decision 决定状态；Proposal 不拥有事实生产权（不产 Claim、不改 WorkingCopy——P3.4 才 apply）
 * - 校验：numeric_anchor（复用 claim-proposal anchorCheck）+ capability_anchor（级别词不高于证据）；
 *   entity/outcome 子锚 v0.2（需要语义规则——标准缺失先立标准，诚实标注）
 * - snapshot：生成时固化 wcRevision + evidenceHash + opportunityVersion + opportunitySnapshot（P4.1——
 *   Opportunity 是 derived projection，重诊断后消失；submit 时固化为不可变解释来源，apply/reject 不重算）
 * - approved ≠ applied：approve 只是用户同意（P3.3）；apply 成功才改 WorkingCopy（P3.4）
 * - history 不变式：条目不可变；只在用户决策终态登记（rejected/applied/conflict）；无快照旧提案不登记
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
import { anchorCheck, evidenceText, createClaimProposal, type ClaimProposal, type ClaimProposalInput } from './claim-proposal-registry.ts'
import { computeOpportunities, type Opportunity } from '../runtime/opportunity.ts'
import { computeResumeAlignment, type AlignmentState } from '../runtime/resume-alignment.ts'

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

/** submit 时固化的机会快照（P4.1——Opportunity 是 derived projection，重诊断后字段消失；快照是不可变解释来源，apply/reject 不重算） */
export interface OpportunitySnapshot {
  source: Opportunity['source']
  severity: Opportunity['severity']
  intent: Opportunity['intent']
  anchor: Opportunity['anchor']
  applyTarget?: Opportunity['applyTarget']
  reason: string
  suggestedAction: string
  refs: { evidenceIds: string[]; claimIds: string[] }
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
  opportunitySnapshot?: OpportunitySnapshot // P4.1——submit 时固化；旧格式文件 parse 后缺省（history 不登记）
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
    opportunitySnapshot: {
      source: opportunity.source,
      severity: opportunity.severity,
      intent: opportunity.intent,
      anchor: opportunity.anchor,
      ...(opportunity.applyTarget ? { applyTarget: opportunity.applyTarget } : {}),
      reason: opportunity.reason,
      suggestedAction: opportunity.suggestedAction,
      refs: opportunity.refs,
    },
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
  if (p.opportunitySnapshot) parts.push(serializeOpportunitySnapshotBlock(p.opportunitySnapshot))
  parts.push(...serializeChangeBlocks(p.changes))
  parts.push(`## 校验\n\n- status: ${v.status}\n- evaluated_at: ${v.evaluatedAt}`)
  return parts.join('\n\n')
}

// ─── 共享表格序列化/解析（proposal / apply_tx / history 三资产同构——变更块 + 机会快照块）──

/** 变更块序列化（`## 变更 N` 表格——三资产共用格式） */
export function serializeChangeBlocks(changes: ProposalChange[]): string[] {
  return changes.map((c, i) => {
    return (
      `## 变更 ${i + 1}\n\n| 字段 | 值 |\n|------|-----|\n` +
      `| block_id | ${c.blockId ?? ''} |\n` +
      `| section_id | ${c.sectionId ?? ''} |\n` +
      `| operation | ${c.operation} |\n` +
      `| before | ${c.before} |\n` +
      `| after | ${c.after} |\n`
    )
  })
}

/** 变更块解析（body 中全部 `## 变更 N` 段） */
export function parseChangeBlocks(body: string): ProposalChange[] {
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
  return changes
}

/** 机会快照块序列化（`## 机会快照` 表格——P4.1 submit 固化） */
export function serializeOpportunitySnapshotBlock(s: OpportunitySnapshot): string {
  const a = s.anchor
  const t = s.applyTarget
  const rows: [string, string][] = [
    ['source', s.source],
    ['severity', s.severity],
    ['intent', s.intent],
    ['anchor_kind', a.kind],
    ['anchor_job_id', a.jobId ?? ''],
    ['anchor_responsibility_id', a.responsibilityId ?? ''],
    ['anchor_state', a.state ?? ''],
    ['anchor_evidence_id', a.evidenceId ?? ''],
    ['anchor_claim_id', a.claimId ?? ''],
    ['apply_target_wc_id', t?.wcId ?? ''],
    ['apply_target_action', t?.action ?? ''],
    ['apply_target_block_id', t?.blockId ?? ''],
    ['reason', s.reason],
    ['suggested_action', s.suggestedAction],
    ['ref_evidence_ids', s.refs.evidenceIds.join('、')],
    ['ref_claim_ids', s.refs.claimIds.join('、')],
  ]
  return `## 机会快照\n\n| 字段 | 值 |\n|------|-----|\n` + rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')
}

/** 机会快照块解析（缺块 → undefined——旧格式 proposal 兼容，history 不登记） */
export function parseOpportunitySnapshotBlock(body: string): OpportunitySnapshot | undefined {
  const m = body.match(/##\s*机会快照([\s\S]*?)(?=\n##\s|$)/)
  if (!m) return undefined
  const cell = (k: string): string => m[1].match(new RegExp(`\\|\\s*${k}\\s*\\|\\s*([^|]*)\\s*\\|`))?.[1]?.trim() ?? ''
  const split = (s: string): string[] => (s ? s.split('、').filter(Boolean) : [])
  const anchor: Opportunity['anchor'] = { kind: cell('anchor_kind') as Opportunity['anchor']['kind'] }
  const jobId = cell('anchor_job_id')
  if (jobId) anchor.jobId = jobId
  const responsibilityId = cell('anchor_responsibility_id')
  if (responsibilityId) anchor.responsibilityId = responsibilityId
  const state = cell('anchor_state')
  if (state) anchor.state = state as Opportunity['anchor']['state']
  const evidenceId = cell('anchor_evidence_id')
  if (evidenceId) anchor.evidenceId = evidenceId
  const claimId = cell('anchor_claim_id')
  if (claimId) anchor.claimId = claimId
  const action = cell('apply_target_action') as NonNullable<Opportunity['applyTarget']>['action'] | ''
  const wcId = cell('apply_target_wc_id')
  const blockId = cell('apply_target_block_id')
  return {
    source: cell('source') as Opportunity['source'],
    severity: cell('severity') as Opportunity['severity'],
    intent: cell('intent') as Opportunity['intent'],
    anchor,
    ...(action
      ? {
          applyTarget: {
            wcId,
            action,
            ...(blockId ? { blockId } : {}),
          } as NonNullable<Opportunity['applyTarget']>,
        }
      : {}),
    reason: cell('reason'),
    suggestedAction: cell('suggested_action'),
    refs: { evidenceIds: split(cell('ref_evidence_ids')), claimIds: split(cell('ref_claim_ids')) },
  }
}

/** 全量扫描（opportunity-proposals/ 目录） */
export function scanOpportunityProposals(ws: Workspace): OpportunityProposal[] {
  if (!ws.exists('opportunity-proposals')) return []
  return ws.listMarkdown('opportunity-proposals').sort().map((f) => parseOpportunityProposalMarkdown(ws.read(`opportunity-proposals/${f}`), f))
}

export function parseOpportunityProposalMarkdown(md: string, sourceFile: string): OpportunityProposal {
  const { meta, body } = splitFrontmatter(md)
  const id = meta.id ?? sourceFile.replace(/\.md$/, '')
  const opportunitySnapshot = parseOpportunitySnapshotBlock(body)
  return {
    id,
    opportunityId: meta.opportunity_id ?? '',
    wcId: meta.wc_id ?? '',
    changes: parseChangeBlocks(body),
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
    ...(opportunitySnapshot ? { opportunitySnapshot } : {}),
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

/** reject：pending → rejected（单向不 reopen，审计保留）。P4.1 审计先行——历史登记（决策事件）成功后再写状态 */
export function rejectOpportunityProposal(ws: Workspace, id: string, _reason?: string, now: Date = new Date()): OpportunityProposal {
  const file = `opportunity-proposals/${id}.md`
  if (!ws.exists(file)) throw new OpportunityProposalError(`提案不存在：${id}`)
  const proposal = parseOpportunityProposalMarkdown(ws.read(file), `${id}.md`)
  if (proposal.status !== 'pending') throw new OpportunityProposalError(`仅 pending 可 reject（当前 ${proposal.status}）`)
  const wc = scanWorkingCopies(ws).find((w) => w.id === proposal.wcId)!
  recordOpportunityHistory(
    ws,
    {
      proposalId: proposal.id,
      opportunityId: proposal.opportunityId,
      wcId: proposal.wcId,
      decision: 'rejected',
      outcome: 'rejected',
      opportunitySnapshot: proposal.opportunitySnapshot,
      changesSnapshot: proposal.changes,
      beforeRevision: wc.revision,
      decidedAt: now.toISOString(),
    },
    now,
  )
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

/** 块文本规范化：剥离行首 `- `/`* ` 前缀（Agent 从 wc 原文读到带前缀行——块文本规范不含前缀，Engine 边界校验） */
function normalizeBlockText(t: string): string {
  return t.trim().replace(/^[-*]\s+/, '')
}

/** 应用 changes（纯函数——构造新 sections；原子性靠一次写盘）。
 *  表达锚（P4.1/P4.2 闭环收敛——ApplyTransaction 契约 §5 invariant）：rewrite/insert 均写入
 *  块.expectationId（对应机会锚定 responsibility 的首个期望模式）——重诊断据此判定「表达已写入」，
 *  四态从 expressive_gap 收敛（rewrite → unsupported_claim 红线 / insert → 同上）；delete 无锚（块消失） */
function applyChanges(wc: WorkingCopy, changes: ProposalChange[], patternId?: string): WorkingCopy {
  const sections = wc.sections.map((s) => ({ ...s, blocks: [...s.blocks] }))
  for (const c of changes) {
    if (c.operation === 'rewrite' || c.operation === 'delete') {
      const sec = sections.find((s) => s.blocks.some((b) => b.id === c.blockId))
      if (!sec) throw new OpportunityProposalError(`${c.operation} 目标块不存在：${c.blockId}`)
      if (c.operation === 'rewrite') {
        const i = sec.blocks.findIndex((b) => b.id === c.blockId)
        const existing = sec.blocks[i]
        sec.blocks[i] = { ...existing, text: normalizeBlockText(c.after), ...(patternId && !existing.expectationId ? { expectationId: patternId } : {}) }
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
      target.blocks.push({ id: `blk_${maxSeq + 1}`, text: normalizeBlockText(c.after), provenanceLinks: [], ...(patternId ? { expectationId: patternId } : {}) })
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
    ...serializeChangeBlocks(tx.changes),
  ]
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
  return {
    id,
    proposalId: meta.proposal_id ?? '',
    wcId: meta.wc_id ?? '',
    beforeRevision: Number(meta.before_revision ?? 0),
    afterRevision: Number(meta.after_revision ?? 0),
    changes: parseChangeBlocks(body),
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

/** apply 事务内重诊断（P4.2 校准 4——基于内存 next wc 纯投影，无落盘 IO）：
 *  机会锚定 responsibility 的 afterState = 状态迁移轨迹终点（事务内部计算值，非独立事件） */
function computeAfterState(ws: Workspace, next: WorkingCopy, jobId: string | null, respId?: string): AlignmentState | undefined {
  if (!jobId || !respId) return undefined
  const job = scanJobs(ws).find((j) => j.record.id === jobId)?.record
  if (!job) return undefined
  const alignment = computeResumeAlignment({
    job,
    evidenceItems: scanEvidence(ws).map((e) => e.record),
    claims: scanClaims(ws).map((c) => c.record),
    resumeDocument: workingCopyToDocument(next, ws),
  })
  return alignment.rows.find((r) => r.responsibilityId === respId)?.state
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
  // P4.1 审计先行：history（决策事件）→ apply_tx → wc 状态变更（契约 §5 写入顺序，失败抛错不允许静默成功）
  const expected = proposal.validation.sourceSnapshot.wcRevision
  if (expected !== wc.revision) {
    recordOpportunityHistory(
      ws,
      {
        proposalId: proposal.id,
        opportunityId: proposal.opportunityId,
        wcId: wc.id,
        decision: 'approved',
        outcome: 'conflict',
        opportunitySnapshot: proposal.opportunitySnapshot,
        changesSnapshot: proposal.changes,
        beforeRevision: wc.revision,
        expectedRevision: expected,
        currentRevision: wc.revision,
        decidedAt: proposal.decidedAt!,
      },
      now,
    )
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
  // 表达锚：机会锚定的 responsibility → 首个期望模式 patternId（重诊断闭环收敛；旧提案无快照 → 不打锚）
  const jobId = jobIdFromOpportunityId(proposal.opportunityId)
  const job = jobId ? scanJobs(ws).find((j) => j.record.id === jobId)?.record : undefined
  const respId = proposal.opportunitySnapshot?.anchor.responsibilityId
  const patternId = job && respId ? job.responsibilities.find((r) => r.id === respId)?.evidenceExpectations[0]?.patternId : undefined
  const next = applyChanges(wc, proposal.changes, patternId)
  const afterRevision = wc.revision + 1
  // P4.2 校准 4：afterState 是事务内部计算值（内存 next wc 重诊断）——与 history 一次写盘，防「history 成功 wc 失败」污染
  const afterState = computeAfterState(ws, next, jobId, respId)
  recordOpportunityHistory(
    ws,
    {
      proposalId: proposal.id,
      opportunityId: proposal.opportunityId,
      wcId: wc.id,
      decision: 'approved',
      outcome: 'applied',
      opportunitySnapshot: proposal.opportunitySnapshot,
      changesSnapshot: proposal.changes,
      beforeRevision: wc.revision,
      afterRevision,
      afterState,
      decidedAt: proposal.decidedAt!,
    },
    now,
  )
  const tx = registerTransaction(
    ws,
    { proposalId: proposal.id, wcId: wc.id, beforeRevision: wc.revision, afterRevision, changes: proposal.changes, status: 'applied', appliedAt: now.toISOString() },
    now,
  )
  ws.write(
    `resumes/working-copies/${wc.id}.md`,
    serializeWorkingCopy({ ...next, revision: afterRevision, updatedAt: now.toISOString() }),
  )
  return { status: 'applied', transactionId: tx.id, newRevision: afterRevision }
}

// ─── P5.2：Asset Bridge（契约 claim-asset-bridge-contract-v0.1，FROZEN——连接 Expression/Asset Loop）──

export interface AssetBridgeInput {
  opportunityId: string // Opportunity 是 authoritative source——responsibility/expectationId 均由 Engine resolve（校准 3）
  wcId: string
  evidenceCandidates: string[] // 用户选定（素材库）；无证据不资产化
}

/**
 * 装配（纯函数域——resolve opportunity + Bridge 特有校验；无写盘，Agent 构造 statement 后经 P1.1 登记）。
 * activation targets（实现前模型修正）：anchor.state = unsupported_claim 且 refs.evidenceIds 非空（红线型——
 * evdHit ✓ 被治理红线降级，资产化后恢复 covered）；原生型（!evdHit，refs 空）资产化无意义——绑定不改 evdHit。
 */
export function assembleAssetBridge(ws: Workspace, input: AssetBridgeInput, statement: string, explanation: string): ClaimProposalInput {
  const found = findOpportunity(ws, input.wcId, input.opportunityId)
  if (!found) throw new OpportunityProposalError(`OPPORTUNITY_REF——机会不存在或与工作副本不匹配：${input.opportunityId}`)
  const { opportunity, jobId } = found
  if (opportunity.anchor.state !== 'unsupported_claim' || opportunity.refs.evidenceIds.length === 0) {
    throw new OpportunityProposalError(
      `资产化 v0.1 仅支持红线型 unsupported_claim（state=${opportunity.anchor.state}，evidenceRefs=${opportunity.refs.evidenceIds.length}）`,
    )
  }
  if (input.evidenceCandidates.length === 0) throw new OpportunityProposalError('evidenceCandidates 为空——无证据不资产化')
  // expectationId 复用（校准 2：只复制不生成——防同责任多锚导致 Diagnosis 不收敛）
  const job = scanJobs(ws).find((j) => j.record.id === jobId)?.record
  const respId = opportunity.anchor.responsibilityId
  const expectationId = job && respId ? job.responsibilities.find((r) => r.id === respId)?.evidenceExpectations[0]?.patternId : undefined
  return {
    source: 'opportunity_bridge',
    evidenceRefs: input.evidenceCandidates,
    proposedClaim: { statement, ...(expectationId ? { expectationId } : {}) },
    explanation,
  }
}

export type BindClaimResult = {
  status: 'bound' | 'conflict' | 'failed'
  claimId: string
  wcRevisionBefore: number
  wcRevisionAfter?: number // status = bound（before + 1）
}

/** Claim Bridge Agent 输入上下文（P5.3——责任语句 + 候选证据详情；Agent 构造 statement 的消费结构，不读数据库） */
export interface ClaimBridgeContext {
  opportunity: Opportunity
  responsibilityStatement: string
  expectationId?: string
  evidence: { id: string; eventTitle: string; content: string; contribution: string; impact?: string; validation?: string }[]
}

/** Bridge context 组装（Agent 读——经 claim-bridge-context CLI/RPC；证据详情投影与 ProposalBridgeContext 同构） */
export function buildClaimBridgeContext(ws: Workspace, wcId: string, opportunityId: string, evidenceIds: string[]): ClaimBridgeContext {
  const found = findOpportunity(ws, wcId, opportunityId)
  if (!found) throw new OpportunityProposalError(`机会不存在或与工作副本不匹配：${opportunityId}`)
  const { opportunity, jobId } = found
  const job = scanJobs(ws).find((j) => j.record.id === jobId)?.record
  const respId = opportunity.anchor.responsibilityId
  const resp = job && respId ? job.responsibilities.find((r) => r.id === respId) : undefined
  const evidenceById = new Map(scanEvidence(ws).map((p) => [p.record.id, p.record]))
  const evidence = evidenceIds
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
  return {
    opportunity,
    responsibilityStatement: resp?.statement ?? '',
    expectationId: resp?.evidenceExpectations[0]?.patternId,
    evidence,
  }
}

/** Bridge 提交（P5.3——Agent 构造 statement 后一步登记：装配校验 + P1.1 createClaimProposal） */
export function submitClaimBridge(
  ws: Workspace,
  input: AssetBridgeInput & { statement: string; explanation: string },
  now: Date = new Date(),
): ClaimProposal {
  const bridge = assembleAssetBridge(ws, input, input.statement, input.explanation)
  return createClaimProposal(ws, { ...bridge, opportunityId: input.opportunityId }, now)
}

/** 绑定（校准 1：Claim 创建 ≠ 自动绑定成功——Claim 是资产事实、WC 是表达载体，两生命周期不构成假原子）。
 *  conflict（目标块不存在/漂移）不撤销 Claim——可重试；failed 为引擎异常路径（写盘失败抛错冒烟，不吞） */
export function bindClaimToBlock(ws: Workspace, wcId: string, blockId: string, claimId: string, now: Date = new Date()): BindClaimResult {
  const claim = scanClaims(ws).find((c) => c.record.id === claimId)
  if (!claim) throw new OpportunityProposalError(`Claim 不存在：${claimId}`)
  const wc = scanWorkingCopies(ws).find((w) => w.id === wcId)
  if (!wc) throw new OpportunityProposalError(`工作副本不存在：${wcId}`)
  const target = wc.sections.flatMap((s) => s.blocks).find((b) => b.id === blockId)
  if (!target) return { status: 'conflict', claimId, wcRevisionBefore: wc.revision }
  const links = [...new Set([...(target.provenanceLinks ?? []), claimId])]
  // 幂等（P5.2 评审回归）：锚已含 claimId → 不写盘、revision 不增加——高频路径防无意义版本膨胀
  if (target.provenanceLinks && links.length === target.provenanceLinks.length) {
    return { status: 'bound', claimId, wcRevisionBefore: wc.revision, wcRevisionAfter: wc.revision }
  }
  const next: WorkingCopy = {
    ...wc,
    sections: wc.sections.map((s) => ({
      ...s,
      blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, provenanceLinks: links } : b)),
    })),
    revision: wc.revision + 1,
    updatedAt: now.toISOString(),
  }
  ws.write(`resumes/working-copies/${wc.id}.md`, serializeWorkingCopy(next))
  return { status: 'bound', claimId, wcRevisionBefore: wc.revision, wcRevisionAfter: wc.revision + 1 }
}

// ─── P4.1：OpportunityHistory（契约 opportunity-history-contract-v0.1，FROZEN）──

export const OPPORTUNITY_HISTORY_SPEC: ArtifactSpec = {
  type: 'opportunity_history',
  dir: 'opportunity-history',
  idPrefix: 'oh_',
  marker: /##\s*机会快照/,
  passthroughFields: [],
}

/** 决策事件历史条目（不可变审计——Opportunity 是 derived projection，快照在 submit 时固化，apply/reject 不重算） */
export interface OpportunityHistoryEntry {
  id: string
  proposalId: string // 外部关联——history 不读取 proposal 作为解释来源（Proposal 删除 ≠ History 无效）
  opportunityId: string
  wcId: string
  decision: 'approved' | 'rejected' // 只记录用户决策终态（expired/abandoned 等投影生命周期失效不登记）
  outcome: 'applied' | 'conflict' | 'rejected'
  opportunitySnapshot: OpportunitySnapshot
  changesSnapshot: ProposalChange[] // 全文快照（自包含审计；与 proposal 文件内容一致）
  beforeRevision: number
  afterRevision?: number // outcome = applied（before + 1）
  expectedRevision?: number // outcome = conflict（快照值）
  currentRevision?: number // outcome = conflict（当前值）
  afterState?: AlignmentState // P4.2——仅 outcome = applied（apply 事务内重诊断固化；状态迁移轨迹）
  decidedAt: string
  recordedAt: string
}

export type OpportunityHistoryInput = Omit<OpportunityHistoryEntry, 'id' | 'recordedAt' | 'opportunitySnapshot'> & {
  opportunitySnapshot?: OpportunitySnapshot // 旧格式提案 parse 后缺省——record 内部按 Case 6 不登记
}

/**
 * 历史登记（审计先行——调用方在状态变更写盘前调用；失败抛错冒泡，不允许静默成功）。
 * 无快照的旧格式提案 → 不登记、不抛错（契约验证矩阵 Case 6——不制造数据）。
 */
export function recordOpportunityHistory(ws: Workspace, input: OpportunityHistoryInput, now: Date = new Date()): OpportunityHistoryEntry | null {
  if (!input.opportunitySnapshot) return null
  // 契约 Case 5（幂等）：一个提案 = 一条决策事件——apply 不改 proposal.status，重复 apply 不产生重复条目
  if (scanOpportunityHistory(ws).some((h) => h.proposalId === input.proposalId)) return null
  const entry: OpportunityHistoryEntry = {
    id: nextArtifactId(ws, OPPORTUNITY_HISTORY_SPEC, now),
    recordedAt: now.toISOString(),
    ...input,
    opportunitySnapshot: input.opportunitySnapshot,
  }
  ws.write(`opportunity-history/${entry.id}.md`, serializeOpportunityHistory(entry))
  return entry
}

function serializeOpportunityHistory(e: OpportunityHistoryEntry): string {
  const meta = [
    `id: ${e.id}`,
    `recorded_at: ${e.recordedAt}`,
    `proposal_id: ${e.proposalId}`,
    `opportunity_id: ${e.opportunityId}`,
    `wc_id: ${e.wcId}`,
    `decision: ${e.decision}`,
    `outcome: ${e.outcome}`,
    `before_revision: ${e.beforeRevision}`,
    ...(e.afterRevision !== undefined ? [`after_revision: ${e.afterRevision}`] : []),
    ...(e.expectedRevision !== undefined ? [`expected_revision: ${e.expectedRevision}`] : []),
    ...(e.currentRevision !== undefined ? [`current_revision: ${e.currentRevision}`] : []),
    ...(e.afterState ? [`after_state: ${e.afterState}`] : []),
    `decided_at: ${e.decidedAt}`,
  ]
  const parts = [
    `---\n${meta.join('\n')}\n---`,
    `# 机会历史：${e.opportunityId}`,
    serializeOpportunitySnapshotBlock(e.opportunitySnapshot),
    ...serializeChangeBlocks(e.changesSnapshot),
  ]
  return parts.join('\n\n')
}

/** 全量扫描（opportunity-history/ 目录——P4.2 Evaluation 消费入口） */
export function scanOpportunityHistory(ws: Workspace): OpportunityHistoryEntry[] {
  if (!ws.exists('opportunity-history')) return []
  return ws.listMarkdown('opportunity-history').sort().map((f) => parseOpportunityHistoryMarkdown(ws.read(`opportunity-history/${f}`), f))
}

export function parseOpportunityHistoryMarkdown(md: string, sourceFile: string): OpportunityHistoryEntry {
  const { meta, body } = splitFrontmatter(md)
  const id = meta.id ?? sourceFile.replace(/\.md$/, '')
  return {
    id,
    proposalId: meta.proposal_id ?? '',
    opportunityId: meta.opportunity_id ?? '',
    wcId: meta.wc_id ?? '',
    decision: (meta.decision as OpportunityHistoryEntry['decision']) ?? 'approved',
    outcome: (meta.outcome as OpportunityHistoryEntry['outcome']) ?? 'rejected',
    opportunitySnapshot: parseOpportunitySnapshotBlock(body)!,
    changesSnapshot: parseChangeBlocks(body),
    beforeRevision: Number(meta.before_revision ?? 0),
    ...(meta.after_revision !== undefined ? { afterRevision: Number(meta.after_revision) } : {}),
    ...(meta.expected_revision !== undefined ? { expectedRevision: Number(meta.expected_revision) } : {}),
    ...(meta.current_revision !== undefined ? { currentRevision: Number(meta.current_revision) } : {}),
    ...(meta.after_state ? { afterState: meta.after_state as AlignmentState } : {}),
    decidedAt: meta.decided_at ?? '',
    recordedAt: meta.recorded_at ?? '',
  }
}
