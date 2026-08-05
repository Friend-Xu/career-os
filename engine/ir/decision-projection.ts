/**
 * decision-projection：M7.3.2 DecisionProjection 独立 IR（Decision Changed Candidate Contract v1）。
 * 变化检测输入格式——与存储格式（DecisionRecord）解耦，Ledger 需要稳定语义，
 * 不绑定 markdown 排版变化。
 * 排除：confidence/score/risk/match/analysis——投影不含分析字段（结构保证，
 * Detector 无从检测 = 分析变化永不产生候选）。
 */
import { parseSummaryTable } from './summary-table.ts'

export type SelectedChangeUnit = 'direction_target' | 'city_constraint' | 'company_choice'

export interface DecisionSelectedChange {
  unit: SelectedChangeUnit
  from?: string
  to: string
}

export interface DecisionProjection {
  id: string
  /** 方向目标（摘要表 direction） */
  direction?: string
  /** 城市（摘要表 city） */
  city?: string
  /** 薪资可行性（摘要表 salary_feasible） */
  salaryFeasible?: boolean
  /** 用户主动选择变化（摘要表 selected_change，显式动作产生——selected 本身不是事件源） */
  selectedChange?: DecisionSelectedChange
  /** 决策问题（DecisionContext.question；jd_strategy 检测载体，v1 由调用方传入） */
  contextQuestion?: string
  updatedAt: string
}

const SELECTED_CHANGE_UNITS: readonly SelectedChangeUnit[] = ['direction_target', 'city_constraint', 'company_choice']

/** `{unit}:{from} → {to}`（from 可空：首选择 `direction_target:→ 工业软件工程师`）；格式非法 → undefined */
export function parseSelectedChange(v: string): DecisionSelectedChange | undefined {
  const m = v.match(/^([a-z_]+):(.*?)\s*→\s*(.+)$/)
  if (!m) return undefined
  const unit = m[1] as SelectedChangeUnit
  if (!SELECTED_CHANGE_UNITS.includes(unit)) return undefined
  const from = m[2]!.trim()
  return { unit, ...(from ? { from } : {}), to: m[3]!.trim() }
}

/** 决策文件 md → 变化检测投影（摘要表字段；缺表/缺字段 → 不产出；selected_change 非法 → 不产出） */
export function projectDecision(md: string, id: string, updatedAt: string): DecisionProjection {
  const fields = parseSummaryTable(md) ?? {}
  const out: DecisionProjection = { id, updatedAt }
  if (fields.direction) out.direction = fields.direction
  if (fields.city) out.city = fields.city
  if (fields.salary_feasible === 'true') out.salaryFeasible = true
  else if (fields.salary_feasible === 'false') out.salaryFeasible = false
  if (fields.selected_change) {
    const sc = parseSelectedChange(fields.selected_change)
    if (sc) out.selectedChange = sc
  }
  return out
}
