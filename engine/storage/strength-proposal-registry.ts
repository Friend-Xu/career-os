/**
 * strength-proposal-registry：优势亮点提案（Person Summary Strength Contract v0.2 §3 AI 总结边界）。
 * - Agent 经引擎 CLI 桥提交（--strength-submit {json}）→ pending 候选
 * - 用户 decide（RPC）：accept → 引用校验 + 并入 summary_strengths.md（Engine Registration Owner）；
 *   reject → 审计保留（拒绝理由 = Human Preference Signal）
 * - AI 直接写优势条目 = 越权：提案是候选，登记必须用户确认
 */
import { watch } from 'chokidar'
import { splitFrontmatter, nextArtifactId, type ArtifactSpec } from './artifact-registry.ts'
import type { SummaryStrength } from '../ir/schema.ts'
import type { Workspace } from './workspace.ts'
import { scanClaims } from './claim-watcher.ts'
import { scanEvidence } from './evidence-watcher.ts'
import { canUseClaim, indexEvidence } from './claim-policy.ts'
import { parseStrengthLines, upsertSummaryStrengths, validateStrengthItems } from './person-watcher.ts'

export const STRENGTH_PROPOSAL_SPEC: ArtifactSpec = {
  type: 'strength_proposal',
  dir: 'strength-proposals',
  idPrefix: 'strength_proposal_',
  marker: /##\s*优势条目/,
  passthroughFields: [],
}

export type StrengthProposalStatus = 'pending' | 'accepted' | 'rejected'

export interface StrengthProposal {
  id: string
  personId: string
  items: SummaryStrength[]
  status: StrengthProposalStatus
  createdAt: string
  decidedAt?: string
  rejectReason?: string
}

export interface StrengthProposalInput {
  personId: string
  items: { text: string; claimIds: string[]; evidenceIds: string[] }[]
}

/** Agent 上下文（CLI 桥 --strength-context）：可用表述 + 可信证据 + 已有优势——Agent 只消费此结构 */
export function buildStrengthProposalContext(
  ws: Workspace,
  personId: string,
): { personId: string; claims: unknown[]; evidence: unknown[]; existingStrengths: SummaryStrength[] } {
  const evidence = scanEvidence(ws).map((p) => p.record).filter((e) => e.status === 'trusted' && e.owner === personId)
  const evidenceById = indexEvidence(evidence)
  const claims = scanClaims(ws).map((p) => p.record).filter((c) => c.owner === personId && canUseClaim(c, evidenceById))
  const strengthRel = `persons/${personId}/snapshot/current/summary_strengths.md`
  const existingStrengths = ws.exists(strengthRel) ? parseStrengthLines(ws.read(strengthRel)) : []
  return {
    personId,
    claims: claims.map((c) => ({
      id: c.id,
      statement: c.statement,
      evidenceTitles: c.provenance.map((p) => evidenceById.get(p.evidenceId)?.event.title ?? p.evidenceId),
    })),
    evidence: evidence.map((e) => ({ id: e.id, title: e.event.title, contribution: e.contribution })),
    existingStrengths,
  }
}

/** Agent 提交（CLI 桥 --strength-submit）：引用校验 → pending 提案落盘。校验失败 throw（错误给 Agent 看拦截原因） */
export function submitStrengthProposals(ws: Workspace, input: StrengthProposalInput, now: Date = new Date()): StrengthProposal {
  if (!input.personId) throw new Error('personId 必填')
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('items 必填且非空')
  const items = validateStrengthItems(ws, input.items)
  const id = nextArtifactId(ws, STRENGTH_PROPOSAL_SPEC, now)
  const proposal: StrengthProposal = {
    id,
    personId: input.personId,
    items,
    status: 'pending',
    createdAt: now.toISOString(),
  }
  ws.write(`${STRENGTH_PROPOSAL_SPEC.dir}/${id}.md`, serializeStrengthProposal(proposal))
  return proposal
}

export function serializeStrengthProposal(p: StrengthProposal): string {
  return [
    '---',
    `id: ${p.id}`,
    `person_id: ${p.personId}`,
    `status: ${p.status}`,
    `created_at: ${p.createdAt}`,
    ...(p.decidedAt ? [`decided_at: ${p.decidedAt}`] : []),
    ...(p.rejectReason ? [`reject_reason: ${p.rejectReason}`] : []),
    '---',
    '# 优势亮点提案',
    '',
    '## 优势条目',
    '',
    ...p.items.map((s) => {
      const anns: string[] = []
      if (s.claimIds.length > 0) anns.push(`（claims: ${s.claimIds.join(', ')}）`)
      if (s.evidenceIds.length > 0) anns.push(`（evidence: ${s.evidenceIds.join(', ')}）`)
      return `- ${s.text}${anns.length > 0 ? ` ${anns.join(' ')}` : ''}`
    }),
    '',
  ].join('\n')
}

export function parseStrengthProposalMarkdown(md: string, sourceFile: string): StrengthProposal | null {
  const { meta, body } = splitFrontmatter(md)
  const id = meta.id ?? sourceFile.replace(/\.md$/, '')
  if (!meta.person_id) return null
  const status = meta.status === 'accepted' || meta.status === 'rejected' ? meta.status : 'pending'
  return {
    id,
    personId: meta.person_id,
    items: parseStrengthLines(body),
    status,
    createdAt: meta.created_at ?? '',
    ...(meta.decided_at ? { decidedAt: meta.decided_at } : {}),
    ...(meta.reject_reason ? { rejectReason: meta.reject_reason } : {}),
  }
}

/** 提案扫描（personId 可选过滤——UI 按当前人拉取） */
export function scanStrengthProposals(ws: Workspace, personId?: string): StrengthProposal[] {
  let files: string[]
  try {
    files = ws.listMarkdown(STRENGTH_PROPOSAL_SPEC.dir)
  } catch {
    return []
  }
  return files
    .sort()
    .map((f) => parseStrengthProposalMarkdown(ws.read(`${STRENGTH_PROPOSAL_SPEC.dir}/${f}`), f))
    .filter((p): p is StrengthProposal => p !== null)
    .filter((p) => !personId || p.personId === personId)
}

/** 用户裁决：accept → 引用再校验 + 并入优势亮点（同文本去重）；reject → 审计保留。单向不 reopen */
export function decideStrengthProposal(
  ws: Workspace,
  id: string,
  action: 'accept' | 'reject',
  reason?: string,
  now: Date = new Date(),
): StrengthProposal {
  const file = `${STRENGTH_PROPOSAL_SPEC.dir}/${id}.md`
  if (!ws.exists(file)) throw new Error(`提案不存在：${id}`)
  const proposal = parseStrengthProposalMarkdown(ws.read(file), `${id}.md`)
  if (!proposal) throw new Error(`提案解析失败：${id}`)
  if (proposal.status !== 'pending') throw new Error(`提案已裁决：${proposal.status}`)

  if (action === 'accept') {
    const strengthRel = `persons/${proposal.personId}/snapshot/current/summary_strengths.md`
    const existing = ws.exists(strengthRel) ? parseStrengthLines(ws.read(strengthRel)) : []
    const merged = [...existing]
    for (const item of proposal.items) {
      if (!merged.some((s) => s.text === item.text)) merged.push(item)
    }
    // 引用再校验（提交后证据可能演化——accept 时点闭合锚定链）
    upsertSummaryStrengths(ws, proposal.personId, merged)
  }

  const decided: StrengthProposal = {
    ...proposal,
    status: action === 'accept' ? 'accepted' : 'rejected',
    decidedAt: now.toISOString(),
    ...(action === 'reject' && reason ? { rejectReason: reason } : {}),
  }
  ws.write(file, serializeStrengthProposal(decided))
  return decided
}

/** strength-proposals/ 目录监听：变更 → 广播（UI 拉取建议卡） */
export function watchStrengthProposals(ws: Workspace, onChanged: (parsed: StrengthProposal[]) => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.strengthProposals, { ignoreInitial: true })
  const rescan = (): void => onChanged(scanStrengthProposals(ws))
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
