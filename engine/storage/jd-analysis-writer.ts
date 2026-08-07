/**
 * jd-analysis-writer：JD 分析产物写入（Proposal → jobs/{id}.md 三段式 Markdown 投影）。
 * 写入所有权归 Engine（契约 v0.1 冻结：Agent 无 Artifact 写权限，只能经 Proposal Channel）。
 * 仅写入通过 Validator 的字段（reject 字段跳过）；已有分析段整体替换（v1 岗位智能段兼容：同段落替换）。
 */
import type { JDAnalysisProposal, JDAnalysisValidationIssue } from '../ir/schema.ts'
import type { Workspace } from './workspace.ts'

const CONTEXT_DIM_LABEL: Record<string, string> = {
  workMode: 'work_mode',
  careerPath: 'career_path',
  industry: 'industry',
}
const CONSTRAINT_DIM_LABEL: Record<string, string> = {
  education: 'education',
  major: 'major',
  experience: 'experience',
}

/** 从 jobs md 中移除既有分析段（岗位理解/岗位门槛/岗位智能——替换语义，避免重复段） */
function stripAnalysisSections(md: string): string {
  return md
    .replace(/\n?##\s*岗位理解\s*\n((?:\|[^\n]*\|\n)+)/, '\n')
    .replace(/\n?##\s*岗位门槛\s*\n((?:\|[^\n]*\|\n)+)/, '\n')
    .replace(/\n?##\s*岗位智能\s*\n((?:\|[^\n]*\|\n)+)/, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function rejectedPaths(issues: JDAnalysisValidationIssue[]): Set<string> {
  return new Set(issues.filter((i) => i.severity === 'reject').map((i) => i.path))
}

function buildContextSection(p: JDAnalysisProposal, rejected: Set<string>): string {
  const rows: string[] = []
  for (const [key, label] of Object.entries(CONTEXT_DIM_LABEL)) {
    const fields = p.context?.[key as keyof typeof p.context] ?? []
    if (fields.length === 0) continue
    for (const f of fields) {
      const pth = `context.${key}.value`
      if (rejected.has(pth) || rejected.has(`context.${key}.source`)) continue
      rows.push(`| ${label} | ${f.value.replace(/\|/g, '\\|')} | ${f.source.replace(/\|/g, '\\|')} |`)
    }
  }
  if (rows.length === 0) return ''
  return [
    '## 岗位理解',
    '',
    '| 维度 | 值 | 来源 |',
    '|------|-----|------|',
    ...rows,
  ].join('\n')
}

function buildConstraintSection(p: JDAnalysisProposal, rejected: Set<string>): string {
  const rows: string[] = []
  for (const [key, label] of Object.entries(CONSTRAINT_DIM_LABEL)) {
    const c = p.constraints?.[key as keyof typeof p.constraints]
    if (!c) continue
    const pth = `constraints.${key}.values`
    if (rejected.has(pth) || rejected.has(`constraints.${key}.source`)) continue
    // 模式列（exact/related/preferred/inferred；缺省 exact）——语义状态标记，Writer 不生成推理
    const mode = c.matchMode ?? 'exact'
    rows.push(`| ${label} | ${c.values.join(';')} | ${c.source.replace(/\|/g, '\\|')} | ${c.confidence} | ${mode} |`)
  }
  if (rows.length === 0) return ''
  return [
    '## 岗位门槛',
    '',
    '| 维度 | 值 | 来源 | 置信度 | 模式 |',
    '|------|-----|------|--------|------|',
    ...rows,
  ].join('\n')
}

function buildIntelligenceSection(p: JDAnalysisProposal, rejected: Set<string>): string {
  const rows: string[] = []
  for (const [i, cap] of (p.capabilities ?? []).entries()) {
    const base = `capabilities[${i}]`
    if (rejected.has(`${base}.responsibility`) || rejected.has(`${base}.category`) || rejected.has(`${base}.capabilities`)) continue
    rows.push(
      `| ${cap.responsibility.replace(/\|/g, '\\|')} | ${cap.priority} | ${cap.category} | ${cap.capabilities.join(';')} | ${cap.evidencePatterns.join(';')} | ${cap.questions.join(';')} |`,
    )
  }
  if (rows.length === 0) return ''
  return [
    '## 岗位智能',
    '',
    '| Responsibility | Priority | Category | Capabilities | Evidence Patterns | Questions |',
    '|----------------|----------|-----------|--------------|-------------------|-----------|',
    ...rows,
  ].join('\n')
}

/** 分析产物写入：jobs/{id}.md 三段式（写入所有权归 Engine；reject 字段跳过） */
export function writeJDAnalysis(
  ws: Workspace,
  proposal: JDAnalysisProposal,
  issues: JDAnalysisValidationIssue[],
): { written: boolean; skipped: string[] } {
  const rel = `jobs/${proposal.jobId}.md`
  if (!ws.exists(rel)) throw new Error(`岗位不存在：${proposal.jobId}`)
  const rejected = rejectedPaths(issues)
  const sections = [buildContextSection(proposal, rejected), buildConstraintSection(proposal, rejected), buildIntelligenceSection(proposal, rejected)].filter(Boolean)
  const existing = stripAnalysisSections(ws.read(rel))
  const next = sections.length > 0 ? `${existing}\n\n${sections.join('\n\n')}\n` : `${existing}\n`
  ws.write(rel, next)
  return {
    written: sections.length > 0,
    skipped: [...rejected],
  }
}
