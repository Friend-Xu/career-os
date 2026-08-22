/**
 * constraint-matcher：JD Constraint Match Engine（契约 v0.2 冻结）——纯函数 Reasoner。
 * 输入：档案侧 PersonEducation[]（facts/education.md 派生）+ 门槛侧 JDConstraintEducationIR
 * （岗位门槛段 Parser 产物）→ 四态结果 + evidence 解释（UI 渲染原因，不自行解释）。
 * 纯派生：无副作用、不写 Artifact、不写事实；min_rank 匹配时派生（Derived Data，
 * 禁止写回 Artifact）。经验应届判定在 Policy 层（规则未来可变，不污染事实层）。
 */
import { DEGREE_RANK, type JDConstraintEducationIR } from './jd-constraint.ts'
import type { EvidenceRef, MatchStatus, PersonEducation, PersonWorkExperience } from '../ir/schema.ts'

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
  /** 证据引用（画像事实回源——应届类 = education 事实，年限类 = experience 事实；空 = 未登记） */
  personEvidence: EvidenceRef[]
  note?: string // 状态说明（NEEDS_CONFIRMATION 时解释缺什么——Engine 只说明缺件，不做匹配推理外的解释）
}

/** 起止字符串 → 年月（YYYY.MM / YYYY-MM / YYYY；非法或月份越界 → undefined） */
function parsePeriod(v: string | undefined): { y: number; m: number } | undefined {
  if (!v) return undefined
  const m = v.trim().match(/^(\d{4})(?:[.\-/年](\d{1,2}))?/)
  if (!m) return undefined
  const y = Number(m[1]!)
  const mo = m[2] ? Number(m[2]!) : 1
  // 月份越界（如 "2025-2025" 截出 m=20）→ 非法；否则静默接受会放大合并年限
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return undefined
  return { y, m: mo }
}

/** confirmed 经历行起止 → 合并年限（月精度区间并集；end 缺失 → 至今；start 缺失 → 行不参与）。
 *  无 confirmed 行或全无起止 → null（画像未登记——Unknown ≠ False） */
export function experienceYearsOf(experiences: PersonWorkExperience[] | undefined, now: Date = new Date()): number | null {
  const confirmed = (experiences ?? []).filter((e) => e.status === 'confirmed')
  const nowM = now.getFullYear() * 12 + now.getMonth()
  const intervals: { s: number; e: number }[] = []
  for (const row of confirmed) {
    const s = parsePeriod(row.start)
    if (!s) continue
    // end 语义三分：真缺失（undefined/''）→ 至今；声明但非法/越界（如 "2025-2025"）→ 行不参与（同「起>止」非法行）
    const endRaw = row.end !== undefined && row.end !== '' ? row.end : undefined
    const e = endRaw !== undefined ? parsePeriod(endRaw) : undefined
    if (endRaw !== undefined && e === undefined) continue
    const sm = s.y * 12 + s.m - 1
    const end = e ?? { y: now.getFullYear(), m: now.getMonth() + 1 }
    const em = Math.min(end.y * 12 + end.m - 1, nowM)
    if (em < sm) continue // 起 > 止（非法行不参与）
    intervals.push({ s: sm, e: em })
  }
  if (intervals.length === 0) return null
  intervals.sort((a, b) => a.s - b.s)
  let total = 0
  let cur = intervals[0]!
  for (let i = 1; i < intervals.length; i++) {
    const it = intervals[i]!
    if (it.s <= cur.e) cur = { s: cur.s, e: Math.max(cur.e, it.e) }
    else {
      total += cur.e - cur.s
      cur = it
    }
  }
  total += cur.e - cur.s
  return total
}

/** 年限类要求解析（rawValue → min/max）：区间 3-5 年 / 以上 / 以内 / 裸年限；无法归一化 → null */
function parseYearsRequirement(req: string): { min?: number; max?: number } | null {
  const range = req.match(/(\d+)\s*[-~—至]\s*(\d+)\s*年/)
  if (range) return { min: Number(range[1]!), max: Number(range[2]!) }
  const above = req.match(/(\d+)\s*年\s*(以上|及以上)/)
  if (above) return { min: Number(above[1]!) }
  const below = req.match(/(\d+)\s*年\s*(以内|以下|及以下)/)
  if (below) return { max: Number(below[1]!) }
  const bare = req.match(/(\d+)\s*年/)
  if (bare) return { min: Number(bare[1]!) }
  return null
}

/** 经验匹配（Matcher Policy v0.2——契约 references/person-experience-registration-contract.md §7）：
 *  应届类（fresh/应届）→ 画像最近毕业年份 ≥ 当前年-1；年限类 → 画像工作经历合并年限对比
 *  （< min → NOT_MATCHED 硬门槛；> max → NEEDS_CONFIRMATION 超上限不否决）。
 *  规则在 Policy 层（未来可变，不污染事实层）；其余 → NEEDS_CONFIRMATION（规则未定义，不猜） */
export function matchExperience(
  personEducation: PersonEducation[] | undefined,
  personExperiences: PersonWorkExperience[] | undefined,
  constraint: { rawValue: string; confidence: 'high' | 'medium'; source: string } | undefined,
  now: Date = new Date(),
): ExperienceMatchResult {
  if (!constraint) {
    return { status: 'NOT_DECLARED', evidence: { requirement: '岗位未声明经验要求' }, personEvidence: [] }
  }
  const requirement = constraint.rawValue
  if (/fresh|应届/.test(requirement)) {
    const eduConfirmed = (personEducation ?? []).filter((e) => e.status === 'confirmed')
    const gradYears = eduConfirmed.map((e) => e.graduationYear).filter((y): y is number => y !== undefined)
    if (gradYears.length === 0) {
      return { status: 'NEEDS_CONFIRMATION', evidence: { requirement }, personEvidence: [], note: '画像未登记毕业年份——需确认' }
    }
    const latest = Math.max(...gradYears)
    const personEvidence = eduConfirmed
      .filter((e) => e.graduationYear !== undefined)
      .map((e) => ({ source: 'education' as const, id: e.candidateId ?? `education:${e.school}` }))
    const fresh = latest >= now.getFullYear() - 1
    return fresh
      ? { status: 'MATCHED', evidence: { person: `${latest} 年毕业`, requirement }, personEvidence }
      : { status: 'NOT_MATCHED', evidence: { person: `${latest} 年毕业`, requirement }, personEvidence }
  }
  const range = parseYearsRequirement(requirement)
  if (range) {
    const expConfirmed = (personExperiences ?? []).filter((e) => e.status === 'confirmed')
    const personEvidence = expConfirmed.map((e) => ({ source: 'experience' as const, id: e.candidateId ?? `experience:${e.company}` }))
    const months = experienceYearsOf(personExperiences, now)
    if (months === null) {
      return { status: 'NEEDS_CONFIRMATION', evidence: { requirement }, personEvidence, note: '画像未登记工作经历——需确认' }
    }
    const years = Math.round((months / 12) * 10) / 10
    const label = `${years} 年经验`
    if (range.min !== undefined && years < range.min) {
      return { status: 'NOT_MATCHED', evidence: { person: label, requirement }, personEvidence }
    }
    if (range.max !== undefined && years > range.max) {
      return { status: 'NEEDS_CONFIRMATION', evidence: { person: label, requirement }, personEvidence, note: '超出年限上限——需确认（超年限可能是薪资错配，不是资格不符）' }
    }
    return { status: 'MATCHED', evidence: { person: label, requirement }, personEvidence }
  }
  return { status: 'NEEDS_CONFIRMATION', evidence: { requirement }, personEvidence: [], note: '经验要求无法归一化（非应届/年限类表述）——需确认' }
}
