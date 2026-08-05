/**
 * decision-change-detector：M7.3.2 Detector（Decision Changed Candidate Contract v1 冻结）。
 * detectDecisionChange(before, after) → DecisionCandidate[]。
 * - 输入约束：必须 before/after 投影（禁止从覆盖后的单文件反推）
 * - 输出约束：只生成 Candidate，不写 Ledger（diff 是发现，不是事实）
 * - 排除（结构保证 + 规则）：投影不含 confidence/score/risk/match/analysis，
 *   record_status 不在检测范围（生命周期状态 ≠ 认知变化）
 * - selected 语义：user_decision.selected_change 是唯一用户选择变化入口；
 *   selected 本身是 snapshot 不是事件源（Detector 不推导 old ≠ new → change）
 */
import type { DecisionProjection } from '../ir/decision-projection.ts'

export type DecisionChangeUnit = 'direction_target' | 'city_constraint' | 'salary_constraint' | 'jd_strategy' | 'company_choice'

export interface DecisionCandidate {
  changeUnit: DecisionChangeUnit
  changeType: 'decision' | 'preference' | 'constraint'
  before?: string
  after: string
  /** 显式来源声明（仅 user_decision——AI 推荐永不产生） */
  source?: 'user_decision'
  confidence: 'high' | 'medium'
}

function sameSelectedChange(a: DecisionProjection['selectedChange'], b: DecisionProjection['selectedChange']): boolean {
  return a?.unit === b?.unit && a?.from === b?.from && a?.to === b?.to
}

/** before/after 投影对比 → 变化候选（Level A：方向/城市/薪资/selected_change；Level B：jd_strategy） */
export function detectDecisionChange(before: DecisionProjection, after: DecisionProjection): DecisionCandidate[] {
  const out: DecisionCandidate[] = []

  if (after.direction !== undefined && after.direction !== before.direction) {
    out.push({
      changeUnit: 'direction_target',
      changeType: 'decision',
      ...(before.direction !== undefined ? { before: before.direction } : {}),
      after: after.direction,
      confidence: 'medium',
    })
  }
  if (after.city !== undefined && after.city !== before.city) {
    out.push({
      changeUnit: 'city_constraint',
      changeType: 'preference',
      ...(before.city !== undefined ? { before: before.city } : {}),
      after: after.city,
      confidence: 'medium',
    })
  }
  if (after.salaryFeasible !== undefined && after.salaryFeasible !== before.salaryFeasible) {
    out.push({
      changeUnit: 'salary_constraint',
      changeType: 'constraint',
      ...(before.salaryFeasible !== undefined ? { before: String(before.salaryFeasible) } : {}),
      after: String(after.salaryFeasible),
      confidence: 'medium',
    })
  }
  // 显式 selected_change（用户主动选择变化——最高可信信号）；不推导 selected 本身
  if (after.selectedChange && !sameSelectedChange(before.selectedChange, after.selectedChange)) {
    const type = after.selectedChange.unit === 'city_constraint' ? 'preference' : 'decision'
    out.push({
      changeUnit: after.selectedChange.unit,
      changeType: type,
      ...(after.selectedChange.from ? { before: after.selectedChange.from } : {}),
      after: after.selectedChange.to,
      source: 'user_decision',
      confidence: 'high',
    })
  }
  // Level B：决策问题变化（jd_strategy——求职策略；v1 由调用方传入 contextQuestion）
  if (after.contextQuestion !== undefined && after.contextQuestion !== before.contextQuestion) {
    out.push({
      changeUnit: 'jd_strategy',
      changeType: 'decision',
      ...(before.contextQuestion !== undefined ? { before: before.contextQuestion } : {}),
      after: after.contextQuestion,
      confidence: 'medium',
    })
  }
  return out
}
