/**
 * claim-proposal-registry（ADR-022 Part 4 / claim-registration-contract v0.1，P1.1）：
 * Claim 生产的唯一入口——Claim Producer Boundary = Agent 提案 + User 决定 + Engine 登记。
 * - create：只登记不生成（evidenceRefs + proposedClaim 由 Producer 提供，Engine 只 validate + store；
 *   不暴露 claims/write——registerClaim 只被 approve 触发）
 * - approve：二次校验（evidenceRefs 仍 active + 锚点仍成立）→ registerClaim 写 claims/{id}.md
 * - reject：pending → rejected（单向不 reopen，审计保留）
 * - 锚点校验（Claim Strength ≤ Evidence Strength）：statement 中数字须在证据文本有锚点
 */
import type { CareerClaim, ClaimProvenance, EvidenceItem } from '../ir/schema.ts'
import type { Workspace } from './workspace.ts'
import { nextArtifactId, splitFrontmatter, type ArtifactSpec } from './artifact-registry.ts'
import { scanEvidence } from './evidence-watcher.ts'
import { canConsumeEvidence } from './evidence-policy.ts'
import { parseSummaryTable } from '../ir/summary-table.ts'
import { CLAIM_SPEC } from './claim-watcher.ts'

export const CLAIM_PROPOSAL_SPEC: ArtifactSpec = {
  type: 'claim_proposal',
  dir: 'claim-proposals',
  idPrefix: 'claim_proposal_',
  marker: /##\s*分析摘要/,
  passthroughFields: [],
}

export type ClaimProposalSource = 'star_reconstructor' | 'user_edit' | 'interview_agent' | 'opportunity_bridge'
export type ClaimProposalStatus = 'pending' | 'approved' | 'rejected' | 'invalid'

/** 派生元数据（Engine 推导，Producer 不提供）——Evidence → Provenance → Claim 链 */
export interface ProvenanceSummary {
  level: 'high' | 'medium' | 'low'
  derivedFrom: string[] // evidence verification type 集合
}

export interface ClaimProposal {
  id: string // claim_proposal_{YYYYMMDD}_{NNNNN}（artifact-registry 登记）
  source: ClaimProposalSource
  evidenceRefs: string[]
  proposedClaim: {
    statement: string
    section?: string
    expectationId?: string
  }
  explanation: string
  provenanceSummary: ProvenanceSummary
  status: ClaimProposalStatus
  createdAt: string
  decidedAt?: string
  opportunityId?: string // P5.3——Bridge 提案携带机会关联（UI 卡片归属 + 审计追溯；旧提案无）
}

export interface ClaimProposalInput {
  source: ClaimProposalSource
  evidenceRefs: string[]
  proposedClaim: { statement: string; section?: string; expectationId?: string }
  explanation: string
  opportunityId?: string // P5.3——机会 → Claim 资产化桥（Asset Bridge）关联
}

export class ClaimProposalError extends Error {
  constructor(message: string) {
    super(`❌ claim-proposal：${message}`)
    this.name = 'ClaimProposalError'
  }
}

const SOURCES: ClaimProposalSource[] = ['star_reconstructor', 'user_edit', 'interview_agent', 'opportunity_bridge']
const SECTIONS = ['summary', 'experience', 'projects', 'skills', 'education']

/** statement 中的数字 token（锚点比对用——数字须能在证据文本找到，防 AI 编造指标） */
export function numbersOf(s: string): string[] {
  return [...new Set(s.match(/\d+(?:\.\d+)?/g) ?? [])]
}

/** evidence 全文本（title + role + contribution + 各维度内容——锚点比对语料）——opportunity-proposal FACT_GROUNDING 复用 */
export function evidenceText(e: EvidenceItem): string {
  const dims = Object.values(e.evidence)
    .flat()
    .map((v) => v.content)
    .join(' ')
  return `${e.event.title} ${e.role} ${e.contribution} ${dims}`
}

/** 锚点校验（Claim Strength ≤ Evidence Strength）：statement 数字须在证据文本中有锚——opportunity-proposal numeric_anchor 复用 */
export function anchorCheck(statement: string, items: EvidenceItem[]): string[] {
  const nums = numbersOf(statement)
  if (nums.length === 0) return []
  const corpus = items.map(evidenceText).join(' ')
  return nums.filter((n) => !corpus.includes(n))
}

/** 证据校验：非空 + 存在 + active + trusted（可消费）；返回 issues 或合法 items */
function resolveEvidence(evidenceRefs: string[], evidenceById: Map<string, EvidenceItem>): { items: EvidenceItem[]; issues: string[] } {
  const issues: string[] = []
  const items: EvidenceItem[] = []
  for (const ref of evidenceRefs) {
    const item = evidenceById.get(ref)
    if (!item) issues.push(`证据不存在：${ref}`)
    else if (item.lifecycle === 'legacy') issues.push(`legacy 证据不可生产：${ref}`)
    else if (!canConsumeEvidence(item, 'resume')) issues.push(`证据不可消费（非 trusted）：${ref}`)
    else items.push(item)
  }
  if (evidenceRefs.length === 0) issues.push('evidenceRefs 为空——证据前置强制')
  return { items, issues }
}

/** ProvenanceSummary 派生：全部 user_confirmed/document_supported → high；含 imported → medium；无 verification → low */
function deriveProvenance(items: EvidenceItem[]): ProvenanceSummary {
  const types = [...new Set(items.map((e) => e.verification?.type).filter((t): t is NonNullable<typeof t> => Boolean(t)))]
  if (types.length === 0) return { level: 'low', derivedFrom: [] }
  const level = types.some((t) => t === 'imported') ? 'medium' : 'high'
  return { level, derivedFrom: types }
}

/** 输入校验（create 与 approve 二次校验共用——approve 时证据可能已变化） */
export function validateClaimProposalInput(input: ClaimProposalInput, evidenceById: Map<string, EvidenceItem>): { issues: string[]; items: EvidenceItem[] } {
  const issues: string[] = []
  if (!SOURCES.includes(input.source)) issues.push(`非法 source：${JSON.stringify(input.source)}`)
  if (!input.proposedClaim.statement?.trim() || input.proposedClaim.statement.trim().length < 6) issues.push('statement 缺失或过短（≥6 字）')
  if (input.proposedClaim.section && !SECTIONS.includes(input.proposedClaim.section)) issues.push(`非法 section：${input.proposedClaim.section}`)
  const { items, issues: evIssues } = resolveEvidence(input.evidenceRefs, evidenceById)
  issues.push(...evIssues)
  if (issues.length === 0) {
    const unanchored = anchorCheck(input.proposedClaim.statement.trim(), items)
    if (unanchored.length > 0) issues.push(`statement 数字无证据锚点（Claim Strength ≤ Evidence Strength）：${unanchored.join('、')}`)
  }
  return { issues, items }
}

/** create：只登记不生成（Producer 提供 evidenceRefs + proposedClaim；Engine validate + store） */
export function createClaimProposal(ws: Workspace, input: ClaimProposalInput, now: Date = new Date()): ClaimProposal {
  const evidenceById = new Map(scanEvidence(ws).map((p) => [p.record.id, p.record]))
  const { issues, items } = validateClaimProposalInput(input, evidenceById)
  if (issues.length > 0) throw new ClaimProposalError(issues.join('；'))

  const id = nextArtifactId(ws, CLAIM_PROPOSAL_SPEC, now)
  const proposal: ClaimProposal = {
    id,
    source: input.source,
    evidenceRefs: [...input.evidenceRefs],
    proposedClaim: {
      statement: input.proposedClaim.statement.trim(),
      ...(input.proposedClaim.section ? { section: input.proposedClaim.section } : {}),
      ...(input.proposedClaim.expectationId ? { expectationId: input.proposedClaim.expectationId } : {}),
    },
    explanation: input.explanation ?? '',
    provenanceSummary: deriveProvenance(items),
    status: 'pending',
    createdAt: now.toISOString(),
    ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
  }
  ws.write(`claim-proposals/${id}.md`, serializeClaimProposal(proposal))
  return proposal
}

function serializeClaimProposal(p: ClaimProposal): string {
  const meta = [
    `id: ${p.id}`,
    `created_at: ${p.createdAt.slice(0, 10)}`,
    `source: ${p.source}`,
    `status: ${p.status}`,
    ...(p.opportunityId ? [`opportunity_id: ${p.opportunityId}`] : []),
    ...(p.decidedAt ? [`decided_at: ${p.decidedAt}`] : []),
  ]
  const fields = [
    ['statement', p.proposedClaim.statement],
    ['source', p.source],
    ...(p.proposedClaim.section ? [['section', p.proposedClaim.section] as [string, string]] : []),
    ...(p.proposedClaim.expectationId ? [['expectation', p.proposedClaim.expectationId] as [string, string]] : []),
    ['explanation', p.explanation],
  ]
  const table = [
    '| 字段 | 值 |',
    '|------|-----|',
    ...fields.map(([k, v]) => `| ${k} | ${v} |`),
  ]
  return `---\n${meta.join('\n')}\n---\n# ${p.proposedClaim.statement}\n\n## 分析摘要\n\n${table.join('\n')}\n\n## 证据来源\n\n${p.evidenceRefs.map((e) => `- ${e}`).join('\n')}\n`
}

/** 全量扫描（claim-proposals/ 目录） */
export function scanClaimProposals(ws: Workspace): ClaimProposal[] {
  return ws.listMarkdown('claim-proposals').map((f) => parseClaimProposalMarkdown(ws.read(`claim-proposals/${f}`), f))
}

export function parseClaimProposalMarkdown(md: string, sourceFile: string): ClaimProposal {
  const { meta, body } = splitFrontmatter(md)
  const fields = parseSummaryTable(body)
  const id = meta.id ?? sourceFile.replace(/\.md$/, '')
  const evidenceRefs = [...md.matchAll(/^\s*[-*]\s*(evidence_\d{8}_\d{5})\s*$/gm)].map((m) => m[1])
  const status = (meta.status as ClaimProposalStatus) ?? 'pending'
  return {
    id,
    source: (meta.source as ClaimProposalSource) ?? 'user_edit',
    evidenceRefs,
    proposedClaim: {
      statement: fields?.statement ?? '',
      ...(fields?.section ? { section: fields.section } : {}),
      ...(fields?.expectation ? { expectationId: fields.expectation } : {}),
    },
    explanation: fields?.explanation ?? '',
    provenanceSummary: { level: 'low', derivedFrom: [] },
    status,
    createdAt: meta.created_at ? new Date(`${meta.created_at}T00:00:00Z`).toISOString() : new Date(0).toISOString(),
    ...(meta.decided_at ? { decidedAt: meta.decided_at } : {}),
    ...(meta.opportunity_id ? { opportunityId: meta.opportunity_id } : {}),
  }
}

function updateProposalStatus(ws: Workspace, id: string, status: ClaimProposalStatus, now: Date): ClaimProposal {
  const file = `claim-proposals/${id}.md`
  if (!ws.exists(file)) throw new ClaimProposalError(`提案不存在：${id}`)
  const md = ws.read(file)
  const { meta, body } = splitFrontmatter(md)
  meta.status = status
  meta.decided_at = now.toISOString()
  ws.write(file, `---\n${Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---${body}`)
  return parseClaimProposalMarkdown(ws.read(file), `${id}.md`)
}

/** approve：二次校验（evidenceRefs 仍 active + 锚点仍成立）→ registerClaim（Engine 单方写 claims/） */
export function approveClaimProposal(ws: Workspace, id: string, now: Date = new Date()): { claimId: string } {
  const file = `claim-proposals/${id}.md`
  if (!ws.exists(file)) throw new ClaimProposalError(`提案不存在：${id}`)
  const proposal = parseClaimProposalMarkdown(ws.read(file), `${id}.md`)
  if (proposal.status !== 'pending') throw new ClaimProposalError(`仅 pending 可 approve（当前 ${proposal.status}）`)

  const evidenceById = new Map(scanEvidence(ws).map((p) => [p.record.id, p.record]))
  const { issues, items } = validateClaimProposalInput(
    { source: proposal.source, evidenceRefs: proposal.evidenceRefs, proposedClaim: proposal.proposedClaim, explanation: proposal.explanation },
    evidenceById,
  )
  if (issues.length > 0) {
    updateProposalStatus(ws, id, 'invalid', now)
    throw new ClaimProposalError(`二次校验未通过（提案已标记 invalid）：${issues.join('；')}`)
  }

  const claimId = nextArtifactId(ws, CLAIM_SPEC, now)
  const provenance: ClaimProvenance[] = proposal.evidenceRefs.map((evidenceId) => ({ evidenceId }))
  const claim: CareerClaim = {
    id: claimId,
    owner: undefined,
    lifecycle: 'active',
    claimType: 'fact',
    source: 'agent_generated',
    statement: proposal.proposedClaim.statement,
    provenance,
    created_at: now.toISOString().slice(0, 10),
  }
  ws.write(`claims/${claimId}.md`, serializeClaim(claim, deriveProvenance(items)))
  updateProposalStatus(ws, id, 'approved', now)
  return { claimId }
}

/** registerClaim 落盘格式（仿 claim-watcher 契约：frontmatter + H1 + 分析摘要 + 证据来源） */
function serializeClaim(c: CareerClaim, summary: ProvenanceSummary): string {
  const meta = [
    `id: ${c.id}`,
    `created_at: ${c.created_at}`,
    `origin: claim_proposal`,
    `lifecycle: active`,
    `owner: ${c.owner ?? ''}`,
  ]
  const table = [
    '| 字段 | 值 |',
    '|------|-----|',
    `| statement | ${c.statement} |`,
    `| claim_type | ${c.claimType} |`,
    `| source | ${c.source} |`,
    `| captured_at | ${c.created_at} |`,
    `| provenance_level | ${summary.level} |`,
  ]
  return `---\n${meta.join('\n')}\n---\n# ${c.statement}\n\n## 分析摘要\n\n${table.join('\n')}\n\n## 证据来源\n\n${c.provenance.map((p) => `- ${p.evidenceId}`).join('\n')}\n`
}

/** reject：pending → rejected（单向不 reopen，审计保留） */
export function rejectClaimProposal(ws: Workspace, id: string, _reason?: string, now: Date = new Date()): ClaimProposal {
  const file = `claim-proposals/${id}.md`
  if (!ws.exists(file)) throw new ClaimProposalError(`提案不存在：${id}`)
  const proposal = parseClaimProposalMarkdown(ws.read(file), `${id}.md`)
  if (proposal.status !== 'pending') throw new ClaimProposalError(`仅 pending 可 reject（当前 ${proposal.status}）`)
  return updateProposalStatus(ws, id, 'rejected', now)
}
