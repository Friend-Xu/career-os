import type { CompanyDimension, CompanyFactType } from '../ir/schema.ts'

/**
 * Company Assessment 规则表（Company Intelligence Layer v0.1，契约 references/company-assessment-contract-v0.1.md §4）。
 * - Fact 不直接映射 points——经规则映射为多维贡献；调权重只改本表，不修改事实资产
 * - 规则 grounded：信号/分值/数据源对齐主流企业信用评价体系（启信分 6 大类 / GB/T 22120-2025 / 国务院 2026 信用评价方案）
 */

export interface AssessmentRule {
  group: 'certification' | 'financing' | 'patent' | 'industry' | 'opportunity' | 'risk'
  factType: CompanyFactType
  value: string
  contribution: Partial<Record<CompanyDimension, number>>
}

export const ASSESSMENT_RULES: AssessmentRule[] = [
  // 认证（Group 去重：取最高级别）
  { group: 'certification', factType: 'CERTIFICATION', value: '国家级专精特新小巨人', contribution: { growth: 5, credibility: 5 } },
  { group: 'certification', factType: 'CERTIFICATION', value: '省级专精特新 / 潜在独角兽', contribution: { credibility: 5 } },
  { group: 'certification', factType: 'CERTIFICATION', value: '高新技术企业', contribution: { credibility: 5 } },
  // 融资（Group 去重：取最新最高轮）
  { group: 'financing', factType: 'FINANCING', value: 'B 轮及以上（近 3 年）', contribution: { growth: 10 } },
  { group: 'financing', factType: 'FINANCING', value: 'A 轮（近 3 年）', contribution: { growth: 5 } },
  // 技术（同组不同 value 可并存）
  { group: 'patent', factType: 'PATENT', value: '核心专利（产品/工艺相关）', contribution: { technology: 5 } },
  { group: 'patent', factType: 'PATENT', value: '研发人员占比 ≥ 30%', contribution: { technology: 5 } },
  // 行业地位 / 职业机会（自然单条）
  { group: 'industry', factType: 'INDUSTRY_STATUS', value: '细分领域头部 / 市占率领先', contribution: { credibility: 5 } },
  { group: 'opportunity', factType: 'OPPORTUNITY', value: '招聘活跃（近 3 个月有岗位发布）', contribution: { opportunity: 5 } },
  // 风险（同组可叠加）
  { group: 'risk', factType: 'RISK', value: '经营异常', contribution: { stability: -20 } },
  { group: 'risk', factType: 'RISK', value: '失信 / 被执行人', contribution: { stability: -30 } },
  { group: 'risk', factType: 'RISK', value: '大额诉讼 / 劳动纠纷频繁', contribution: { stability: -10 } },
]

/** 规则表版本标识（评分规则变更时递增——历史分数经 ruleVersion 可审计） */
export const RULE_VERSION = '2026-08-company-quality-v1'

/** value 精确匹配（枚举外 → undefined，调用方标记 degraded） */
export function ruleOf(factType: CompanyFactType, value: string): AssessmentRule | undefined {
  return ASSESSMENT_RULES.find((r) => r.factType === factType && r.value === value)
}

/** 去重优先级（下标小 = 优先；仅 certification / financing 组参与） */
const GROUP_PRIORITY: Record<'certification' | 'financing', string[]> = {
  certification: ['国家级专精特新小巨人', '省级专精特新 / 潜在独角兽', '高新技术企业'],
  financing: ['B 轮及以上（近 3 年）', 'A 轮（近 3 年）'],
}

/** 组内保留优先级最高的 fact（认证取最高级别 / 融资取最新最高轮；风险不在此——可叠加） */
export function pickHighest<T extends { type: CompanyFactType; value: string }>(facts: T[]): T {
  const group = ruleOf(facts[0].type, facts[0].value)!.group
  const order = GROUP_PRIORITY[group as 'certification' | 'financing']
  if (!order) return facts[0]
  return facts.reduce((best, f) =>
    order.indexOf(f.value) < order.indexOf(best.value) ? f : best,
  )
}
