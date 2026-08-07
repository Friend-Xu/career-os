/**
 * constraint-matcher：JD Constraint Match Engine（契约 v0.2 冻结）——纯函数 Reasoner。
 * 输入：档案侧 PersonEducation[]（facts/education.md 派生）+ 门槛侧 JDConstraintEducationIR
 * （岗位门槛段 Parser 产物）→ 四态结果 + evidence 解释（UI 渲染原因，不自行解释）。
 * 纯派生：无副作用、不写 Artifact、不写事实；min_rank 匹配时派生（Derived Data，
 * 禁止写回 Artifact）。经验应届判定在 Policy 层（规则未来可变，不污染事实层）。
 */
import { DEGREE_RANK, type JDConstraintEducationIR } from './jd-constraint.ts'
import type { MatchStatus, PersonEducation } from '../ir/schema.ts'

export type { MatchStatus }

export interface EducationMatchResult {
  status: MatchStatus
  evidence: { person?: string; requirement: string }
}

/** 学历匹配（四态派生规则表，契约 §4）：
 *  - 无门槛维度 → NOT_DECLARED
 *  - 门槛无法归一化（'应届'/'不限'）→ NEEDS_CONFIRMATION
 *  - 档案 confirmed 集合为空（无条目/pending/rejected）→ NEEDS_CONFIRMATION（Unknown ≠ False）
 *  - confirmed 集合非空：max(rank) ≥ min_rank → MATCHED；< → NOT_MATCHED */
export function matchEducation(
  personEducation: PersonEducation[] | undefined,
  constraint: JDConstraintEducationIR | undefined,
): EducationMatchResult {
  if (!constraint) {
    return { status: 'NOT_DECLARED', evidence: { requirement: '岗位未声明学历要求' } }
  }
  const requirement = constraint.rawValues.join('、')
  if (constraint.normalizationStatus !== 'NORMALIZED' || !constraint.normalizedDegrees?.length) {
    return { status: 'NEEDS_CONFIRMATION', evidence: { requirement } }
  }
  const confirmed = (personEducation ?? []).filter(
    (e) => e.status === 'confirmed' && DEGREE_RANK[e.degree] !== undefined,
  )
  if (confirmed.length === 0) {
    return { status: 'NEEDS_CONFIRMATION', evidence: { requirement } }
  }
  const minRank = Math.min(...constraint.normalizedDegrees.map((d) => DEGREE_RANK[d] ?? Infinity))
  const best = confirmed.reduce((a, b) => (DEGREE_RANK[b.degree]! > DEGREE_RANK[a.degree]! ? b : a))
  const maxRank = DEGREE_RANK[best.degree]!
  return maxRank >= minRank
    ? { status: 'MATCHED', evidence: { person: best.degree, requirement } }
    : { status: 'NOT_MATCHED', evidence: { person: best.degree, requirement } }
}

export interface ExperienceMatchResult {
  status: MatchStatus
  evidence: { person?: string; requirement: string }
}

/** 经验匹配（Matcher Policy v0.1：仅应届判定——门槛含 fresh/应届 → 画像最近毕业年份 ≥ 当前年-1）。
 *  规则在 Policy 层（未来可变，不污染事实层）；非应届类要求（年限等）→ NEEDS_CONFIRMATION
 *  （规则未定义，不猜）；无 graduation_year → NEEDS_CONFIRMATION（Unknown ≠ False） */
export function matchExperience(
  personEducation: PersonEducation[] | undefined,
  constraint: { rawValue: string; confidence: 'high' | 'medium'; source: string } | undefined,
  now: Date = new Date(),
): ExperienceMatchResult {
  if (!constraint) {
    return { status: 'NOT_DECLARED', evidence: { requirement: '岗位未声明经验要求' } }
  }
  const requirement = constraint.rawValue
  if (!/fresh|应届/.test(requirement)) {
    return { status: 'NEEDS_CONFIRMATION', evidence: { requirement } }
  }
  const gradYears = (personEducation ?? [])
    .filter((e) => e.status === 'confirmed')
    .map((e) => e.graduationYear)
    .filter((y): y is number => y !== undefined)
  if (gradYears.length === 0) {
    return { status: 'NEEDS_CONFIRMATION', evidence: { requirement } }
  }
  const latest = Math.max(...gradYears)
  const fresh = latest >= now.getFullYear() - 1
  return fresh
    ? { status: 'MATCHED', evidence: { person: `${latest} 年毕业`, requirement } }
    : { status: 'NOT_MATCHED', evidence: { person: `${latest} 年毕业`, requirement } }
}
