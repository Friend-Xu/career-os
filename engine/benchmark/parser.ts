/**
 * Benchmark parser（M3-3.3）：proposal_ai.md → ParseOutcome。
 * - 复用 M3.5.6 parseProposalMarkdown（finalize 容错：必填缺失 → invalid 而非异常）
 * - 解析失败不 throw：success=false + warnings（失败的 Proposal 本身就是 Benchmark 数据，不清洗）
 * - 宽松扫描未解析的 claim 引用行（非法 ID 格式如 claim_99999999）→ warning + rawRefs
 */
import { parseProposalMarkdown } from '../storage/proposal-watcher.ts'
import type { ParseOutcome, ParsedChange } from './report-types.ts'

export function parseProposalAi(md: string): ParseOutcome {
  const warnings: string[] = []
  const parsed = parseProposalMarkdown(md, 'proposal_ai.md')
  if (parsed.validation) {
    for (const issue of parsed.validation.issues) {
      warnings.push(`${issue.severity}: ${issue.path} — ${issue.reason}`)
    }
  }

  const changes: ParsedChange[] = parsed.value.changes.map((c, i) => ({
    changeId: `change${String(i + 1).padStart(3, '0')}`,
    targetClaimId: c.targetClaimId,
    section: c.section,
    oldSentence: c.oldSentence,
    suggestedSentence: c.suggestedSentence,
    reason: c.reason,
    ...(c.expectationId ? { expectationId: c.expectationId } : {}),
  }))

  // 宽松扫描：proposal 全文的 claim_/evidence_ 引用（含未被 change 解析器捕获的非法格式）
  const rawRefs: string[] = []
  for (const m of md.matchAll(/\b(claim_\w+|evidence_\w+)\b/g)) {
    if (!rawRefs.includes(m[1])) rawRefs.push(m[1])
  }
  const parsedClaimIds = new Set(parsed.value.changes.map((c) => c.targetClaimId))
  for (const ref of rawRefs) {
    if (ref.startsWith('claim_') && !parsedClaimIds.has(ref)) {
      warnings.push(`change 行引用未解析的 claim：${ref}（格式或内容异常——保留原样）`)
    }
  }

  if (changes.length === 0) warnings.push('未解析到任何 change（proposal 无法执行检查）')
  return {
    success: parsed.validation?.status !== 'invalid' && changes.length > 0,
    warnings,
    changes,
    rawRefs,
  }
}
