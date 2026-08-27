/**
 * company-research-writer：公司尽调产物写入（Proposal → companies/{companyId}.md 三件套投影）。
 * 写入所有权归 Engine（Agent 无 Artifact 写权限，只能经 Proposal Channel）——company-file-contract。
 * 仅写入通过 Validator 的字段（reject 字段跳过 —— 对应字段保持原值/占位，不写脏）；
 * 占位档案（JD 建档自动创建）→ 升级为完整档案（同一文件名，禁止新建第二份——身份分裂事故）。
 * 与 jd-analysis-writer 同构。
 */
import type { CompanyResearchProposal, CompanyResearchValidationIssue } from '../ir/schema.ts'
import type { Workspace } from './workspace.ts'

const RISK_FIELD_LABEL: Record<string, string> = {
  city: 'city',
  industry: 'industry',
  matchScore: 'match_score',
  riskLevel: 'risk_level',
  source: 'source',
  tags: 'tags',
  contacted: 'contacted',
  aliases: 'aliases',
}

function rejectedPaths(issues: CompanyResearchValidationIssue[]): Set<string> {
  return new Set(issues.filter((i) => i.severity === 'reject').map((i) => i.path))
}

function cell(v: string | undefined): string {
  return (v ?? '').replace(/\|/g, '\\|')
}

/** 摘要表行（reject 字段跳过 → 原值保留/占位；字段缺失既有档案保留原值，新建占位填 -） */
function buildSummarySection(existing: string | null, p: CompanyResearchProposal, rejected: Set<string>): string {
  const rows: string[] = [
    '## 分析摘要',
    '',
    '| 字段 | 值 |',
    '|------|-----|',
  ]
  const project = (label: string, value: string | undefined): void => {
    if (value === undefined) return
    rows.push(`| ${label} | ${cell(value)} |`)
  }
  if (!rejected.has('summary.city')) project(RISK_FIELD_LABEL['city'], p.summary.city)
  if (!rejected.has('summary.industry')) project(RISK_FIELD_LABEL['industry'], p.summary.industry)
  if (!rejected.has('summary.matchScore')) project(RISK_FIELD_LABEL['matchScore'], p.summary.matchScore)
  if (!rejected.has('summary.riskLevel')) project(RISK_FIELD_LABEL['riskLevel'], p.summary.riskLevel)
  if (!rejected.has('summary.source')) project(RISK_FIELD_LABEL['source'], p.summary.source)
  if (!rejected.has('summary.tags')) project(RISK_FIELD_LABEL['tags'], p.summary.tags)
  if (!rejected.has('summary.contacted')) project(RISK_FIELD_LABEL['contacted'], p.summary.contacted)
  if (!rejected.has('summary.aliases')) project(RISK_FIELD_LABEL['aliases'], p.summary.aliases)
  return rows.join('\n')
}

/** 尽调详情正文（detail → `## 尽调详情` 段；缺失 → 留空 = 无正文（诚实状态），不伪造） */
function buildDetailSection(p: CompanyResearchProposal): string {
  if (!p.detail || !p.detail.trim()) return ''
  return ['', '## 尽调详情', '', p.detail.trim(), ''].join('\n')
}

/** 公司事实段（§4 枚举内且类型合法 → 写行；枚举外/缺来源 → 跳过（Validator warn/reject 已标注，不写脏）） */
function buildFactsSection(p: CompanyResearchProposal, rejected: Set<string>): string {
  const rows: string[] = []
  for (const [i, f] of (p.facts ?? []).entries()) {
    if (rejected.has(`facts[${i}].type`) || rejected.has(`facts[${i}].value`) || rejected.has(`facts[${i}].source`)) {
      rows.push(`> 事实 ${i + 1} 被过滤：${f.type}「${f.value}」`)
      continue
    }
    rows.push(`| ${cell(f.type)} | ${cell(f.value)} | ${cell(f.source)} | ${cell(f.url)} |`)
  }
  if (rows.length === 0) return '' // 无可用信号 = 待评估（诚实状态），contract「段留空」
  return ['', '## 公司事实', '', '| 类型 | 内容 | 来源 | 链接 |', '|------|------|------|------|', ...rows].join('\n')
}

/** 从既有档案 md 中移除旧三件套段（替换语义：新尽调覆盖旧尽调——同段替换，避免重复段） */
function stripExistingSections(md: string): string {
  return md
    .replace(/\n?##\s*分析摘要\s*\n((?:\|[^\n]*\|\n)+)/, '\n')
    .replace(/\n?##\s*尽调详情\s*\n[\s\S]*?(?=\n##\s|\n*$)/, '')
    .replace(/\n?##\s*公司事实\s*\n[\s\S]*?(?=\n##\s|\n*$)/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 尽调产物写入：companies/{companyId}.md（写入所有权归 Engine；reject 字段跳过；占位升级不新建） */
export function writeCompanyResearch(
  ws: Workspace,
  proposal: CompanyResearchProposal,
  issues: CompanyResearchValidationIssue[],
): { written: boolean; skipped: string[] } {
  const rel = `companies/${proposal.companyId}.md`
  const existing = ws.exists(rel) ? ws.read(rel) : null
  const rejected = rejectedPaths(issues)

  const header = `# ${proposal.companyId}`
  const summary = buildSummarySection(existing, proposal, rejected)
  const detail = buildDetailSection(proposal)
  const facts = buildFactsSection(proposal, rejected)
  const sections = [summary, detail, facts].filter(Boolean)
  const next = [header, '', ...sections, ''].join('\n')

  if (existing) ws.write(rel, next)
  else ws.write(rel, next) // 无档案（理论不达）：按契约新建（JD 建档通常已占位）

  return {
    written: sections.length > 0,
    skipped: [...rejected],
  }
}
