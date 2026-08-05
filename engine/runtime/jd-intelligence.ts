/**
 * jd-intelligence：JD Intelligence 对齐 Decision Record Contract（M6.6.5 样板）。
 * 输入：JobRecord + Person Aggregate（技能/约束）→ 输出 DecisionAggregate 形态（type: jd）。
 *
 * 映射（Compatibility 五段式 → Contract）：
 * - computeGap.satisfied        → options[].support（匹配技能）
 * - computeGap.transferable/missing → options[].gap（缺口）
 * - 约束比对（location vs preference city）→ options[].risk
 * - JD 数据缺口（salary/location 未声明）→ unknowns（系统主动声明不知道什么）
 *
 * 不产生 user_decision（ADR-010：系统输出可能性空间，selected 只来自人）。
 * 引擎不自己打分——support/gap 是清单分类，risk 是约束比对，confidence 不产出（数据缺口由 unknowns 承载）。
 */
import type { DecisionInputs, JDIntelligenceOption, JDIntelligenceResult, JobRecord, PersonSnapshot, Skill } from '../ir/schema.ts'
import { computeGap } from './gap-calculator.ts'

export type { JDIntelligenceResult, JDIntelligenceOption } from '../ir/schema.ts'

/** 偏好城市（沪苏通勤圈，Phase 3 确认）；比对用包含匹配（苏州/上海任一命中即圈内） */
const HUSU_CITIES = ['苏州', '上海']

/** 约束比对：JD 地点 vs 偏好城市；数据缺口 → unknowns（薪资金额不解析——引擎不评分） */
function locationAssessment(location: string | undefined, prefCity: string | undefined): { risk?: string; unknown?: string } {
  if (!location) return { unknown: 'JD 未声明工作地点（实际以录用通知为准）' }
  if (prefCity && !HUSU_CITIES.some((c) => location.includes(c))) {
    return { risk: `工作地点 ${location} 不在沪苏通勤圈（偏好：${prefCity}）` }
  }
  return {}
}

/** JD 责任单元 → computeGap 的 Role 形态（capabilities 对齐源；迁移数据回退 statement，同 jobs/match） */
function roleFromJob(job: JobRecord): { id: string; name: string; company: string; skills: { name: string; essential: boolean; source: string }[] } {
  const seen = new Set<string>()
  return {
    id: job.id,
    name: job.title,
    company: job.company,
    skills: job.responsibilities.flatMap((r) =>
      (r.capabilities.length > 0 ? r.capabilities : [r.statement]).map((name) => ({
        name,
        essential: r.priority === 'must',
        source: 'JD',
      })),
    ).filter((s) => {
      if (seen.has(s.name)) return false
      seen.add(s.name)
      return true
    }),
  }
}

export function analyzeJob(opts: {
  job: JobRecord
  person: PersonSnapshot
  /** knowledge 词表（computeGap 别名归一化） */
  skills: Skill[]
}): JDIntelligenceResult {
  const { job, person, skills } = opts
  const gap = computeGap({ role: roleFromJob(job), person: person.name, personSkills: person.skills ?? [], skills })

  const support = gap.satisfied.map((s) => `${s.name}（声明 ${s.level} 级）`)
  const gapItems = [
    ...gap.transferable.map((t) => `${t.name}（有基础 ${t.level} 级，需补强）`),
    ...gap.missing.map((m) => m.name),
  ]

  const loc = locationAssessment(job.location, person.preference?.city)
  const unknowns: string[] = []
  if (loc.unknown) unknowns.push(loc.unknown)
  if (!job.salary) unknowns.push('JD 未声明薪资（实际薪资以 offer 为准）')

  const option: JDIntelligenceOption = {
    candidate: `${job.company} · ${job.title}`,
    status: 'candidate',
    support,
    gap: gapItems,
    risk: loc.risk ? [loc.risk] : [],
  }

  const inputs: DecisionInputs = {
    evidenceRefs: [],
    skillRefs: (person.skills ?? []).map((s) => ({
      id: s.skillId ?? s.name,
      version: person.skillInventoryVersion ?? 'v1',
    })),
    constraintRefs: person.preference ? [{ id: 'preference_constraints' }] : [],
    knowledgeRefs: [{ id: job.id }],
  }

  return {
    type: 'jd',
    question: `JD 分析：${job.company} · ${job.title}`,
    options: [option],
    analysis: { method: '技能矩阵 vs 岗位责任 + 约束比对' },
    unknowns,
    inputs,
  }
}
