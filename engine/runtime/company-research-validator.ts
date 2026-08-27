/**
 * company-research-validator：公司尽调 Proposal Validator（company-file-contract + Company Assessment Contract v0.1）。
 * 只答「这个 Proposal 是否符合 Artifact Contract」——结构/值域/必填；
 * 不做「内容是否正确」（语义归 Agent 检索 + 评估契约计分）。
 * 校验结果按字段级分发：reject = 不写入 Artifact（Writer 跳过）；warn = 写入但记录。
 * 与 jd-analysis-validator 同构（submit_jd_analysis 模式的 Company 侧对应）。
 */
import type { CompanyResearchProposal, CompanyResearchValidationIssue } from '../ir/schema.ts'
export type { CompanyResearchValidationIssue }

/** 评估契约 §4 规则表 value 枚举（单一事实源 = company-assessment-contract-v0.1 §4；枚举外 → 不计分） */
export const COMPANY_FACT_VALUES = [
  '国家级专精特新小巨人',
  '省级专精特新 / 潜在独角兽',
  '高新技术企业',
  'B 轮及以上（近 3 年）',
  'A 轮（近 3 年）',
  '核心专利（产品/工艺相关）',
  '研发人员占比 ≥ 30%',
  '细分领域头部 / 市占率领先',
  '招聘活跃（近 3 个月有岗位发布）',
  '经营异常',
  '失信 / 被执行人',
  '大额诉讼 / 劳动纠纷频繁',
] as const

/** 事实类型枚举（CompanyFactType，ir/schema.ts） */
export const COMPANY_FACT_TYPES = ['CERTIFICATION', 'FINANCING', 'PATENT', 'INDUSTRY_STATUS', 'GROWTH', 'OPPORTUNITY', 'RISK'] as const

/** risk_level 合法值（company-file-contract：低/中/中高/高，英文 low/medium/high 亦可） */
const RISK_LEVELS = ['低', '中', '中高', '高', 'low', 'medium', 'high'] as const

/** match_score 严格格式：`85%` 或 `8.2/10`——只许数值+百分号，不许带括号注释/来源说明/日期 */
const MATCH_SCORE_RE = /^(?:\d{1,3}%|\d+(?:\.\d+)?\/10)$/

/** 摘要表必填字段（company-file-contract §字段与值格式） */
const REQUIRED_SUMMARY_FIELDS = ['city', 'industry', 'matchScore', 'riskLevel', 'source', 'tags', 'contacted'] as const

export function validateCompanyResearchProposal(p: CompanyResearchProposal): CompanyResearchValidationIssue[] {
  const issues: CompanyResearchValidationIssue[] = []
  if (!p.companyId?.trim()) issues.push({ path: 'companyId', reason: '缺失', severity: 'reject' })
  if (p.artifactVersion !== 2) {
    issues.push({ path: 'artifactVersion', reason: `必须为 2（当前 ${p.artifactVersion}）`, severity: 'reject' })
  }

  // 摘要表：必填 + 值域（company-file-contract §字段与值格式——引擎严格校验）
  for (const f of REQUIRED_SUMMARY_FIELDS) {
    const v = p.summary?.[f]
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      issues.push({ path: `summary.${f}`, reason: '缺失（company-file-contract 必填）', severity: 'reject' })
    }
  }
  if (p.summary?.matchScore !== undefined && p.summary.matchScore.trim() !== '' && !MATCH_SCORE_RE.test(p.summary.matchScore.trim())) {
    issues.push({
      path: 'summary.matchScore',
      reason: `非法值「${p.summary.matchScore}」（必须为 85% 或 8.2/10——只许数值+百分号，带注释/日期解析失败显示降级）`,
      severity: 'reject',
    })
  }
  if (p.summary?.riskLevel !== undefined && !(RISK_LEVELS as readonly string[]).includes(p.summary.riskLevel.trim())) {
    issues.push({ path: 'summary.riskLevel', reason: `非法值「${p.summary.riskLevel}」`, severity: 'reject' })
  }
  if (p.summary?.contacted !== undefined && p.summary.contacted !== '是' && p.summary.contacted !== '否') {
    issues.push({ path: 'summary.contacted', reason: `非法值「${p.summary.contacted}」（必须为 是/否）`, severity: 'reject' })
  }
  const inval = p.summary?.industry?.trim() ?? ''
  const cityV = p.summary?.city?.trim() ?? ''
  void inval
  void cityV

  // 公司事实段：类型 ∈ 7 枚举；value ∈ §4 规则表 value 枚举（枚举外 → 不计分，UI 标「待确认」）；
  // 来源必填（缺来源不计分）——与 contract §7.1 Producer 对齐，不静默写脏
  for (const [i, f] of (p.facts ?? []).entries()) {
    if (!(COMPANY_FACT_TYPES as readonly string[]).includes(f.type)) {
      issues.push({ path: `facts[${i}].type`, reason: `枚举外类型「${f.type}」（必须 ∈ CERTIFICATION/FINANCING/PATENT/INDUSTRY_STATUS/GROWTH/OPPORTUNITY/RISK）`, severity: 'reject' })
    }
    if (!f.value?.trim()) {
      issues.push({ path: `facts[${i}].value`, reason: '缺失', severity: 'reject' })
    } else if (!(COMPANY_FACT_VALUES as readonly string[]).includes(f.value.trim())) {
      issues.push({
        path: `facts[${i}].value`,
        reason: `枚举外值「${f.value}」（评估契约 §4 外 → 不计分，UI 标「待确认」；对契约 §4 存在语义相关值 → 用枚举值）`,
        severity: 'warn',
      })
    }
    if (!f.source?.trim()) {
      issues.push({ path: `facts[${i}].source`, reason: '缺失（来源必填，缺来源不计分）', severity: 'reject' })
    }
  }

  return issues
}
