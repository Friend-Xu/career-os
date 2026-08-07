import type { ConstraintMatchRow, DecisionCandidate, DecisionQuestion, GapActionCategory, GapRow, SkillGap } from '../ir/schema.ts'

/**
 * Career Decision Loop v0.1：DecisionCandidate 投影（Engine 纯函数，Producer = Engine）。
 * 契约：references/career-decision-loop-contract-v0.1.md
 * - 只引用不复制：GapRow.constraintRef 引用上游匹配行（门槛行 / 能力匹配行），不携带 requirement/status
 * - actionCategory = 维度级确定性映射（非职业判断）；「岗位偏差/是否值得」归 User 或 Career Ontology 冻结区
 * - question = status × dim 固定模板派生；NOT_MATCHED 事实明确 → 无确认问题
 */

/** 稳定 constraintRef（维度前缀 + 原文 djb2 哈希——确定性；JD 原文不可变 → 引用稳定） */
export function constraintRefOf(dim: string, requirement: string): string {
  let h = 5381
  for (let i = 0; i < requirement.length; i++) h = ((h << 5) + h + requirement.charCodeAt(i)) >>> 0
  return `${dim}:${h.toString(16).padStart(8, '0')}`
}

function actionCategoryOf(dim: string, status: string): GapActionCategory {
  if (dim === 'capability') return 'SKILL_GAP'
  if (status === 'NEEDS_CONFIRMATION' && dim === 'experience') return 'POLICY_UNDEFINED'
  return 'BACKGROUND_RISK'
}

function questionOf(dim: string, status: string, requirement: string, targetId: string): DecisionQuestion | undefined {
  if (status === 'NOT_DECLARED' && dim === 'capability') {
    return { type: 'CONFIRM_CAPABILITY', targetId, template: `是否具备「${requirement}」？` }
  }
  if (status === 'NEEDS_CONFIRMATION') {
    switch (dim) {
      case 'education':
        return { type: 'CONFIRM_BACKGROUND', targetId, template: '请确认学历情况' }
      case 'major':
        return { type: 'CONFIRM_BACKGROUND', targetId, template: `请确认「${requirement}」相关情况` }
      case 'experience':
        return { type: 'CONFIRM_EXPERIENCE', targetId, template: '请确认毕业年份/经验情况' }
    }
  }
  return undefined // NOT_MATCHED：事实明确，无确认问题
}

/** 门槛行 → GapRow（MATCHED 不产出——不是差距） */
function gapFromConstraint(row: ConstraintMatchRow): GapRow | undefined {
  if (row.status === 'MATCHED') return undefined
  const question = questionOf(row.dim, row.status, row.requirement, row.id)
  return { constraintRef: row.id, actionCategory: actionCategoryOf(row.dim, row.status), ...(question ? { question } : {}) }
}

/** 能力匹配行（computeJobMatch missing = 未声明）→ GapRow（SKILL_GAP + CONFIRM_CAPABILITY） */
function gapFromMissingSkill(m: SkillGap): GapRow {
  const ref = constraintRefOf('capability', m.name)
  return {
    constraintRef: ref,
    actionCategory: 'SKILL_GAP',
    question: { type: 'CONFIRM_CAPABILITY', targetId: ref, template: `是否具备「${m.name}」？` },
  }
}

/** DecisionCandidate 投影：门槛行（非 MATCHED）+ 能力未声明行 → 差距清单 */
export function buildDecisionCandidate(jobId: string, constraintRows: ConstraintMatchRow[], missingSkills: SkillGap[]): DecisionCandidate {
  const gaps: GapRow[] = []
  for (const row of constraintRows) {
    const g = gapFromConstraint(row)
    if (g) gaps.push(g)
  }
  for (const m of missingSkills) gaps.push(gapFromMissingSkill(m))
  return { jobId, gaps }
}
