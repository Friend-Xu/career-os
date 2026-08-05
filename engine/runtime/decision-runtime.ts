/**
 * decision-runtime：决策历史投影（ADR-008 语义降级）
 *
 * computeHistory 是纯投影派生视图，不落盘——真相源是 decisions/*.md，
 * 从 DecisionRecord 集合幂等重算（决策记录的 14 字段摘要表）。
 *
 * 规则：
 * 1. 决策按 type 分组（decisionTypeOf 映射：skill 值域 → DecisionType 标签），
 *    仅输出已有合法决策的类型（无决策类型不输出空组）
 * 2. 每条合法决策（validation 非 invalid）计入对应组
 * 3. direction/city 随最新合法决策更新（非空值合并，部分更新不覆盖），挂在组上
 * 4. updatedAt = 组内最近一条合法决策的 createdAt
 */
import type { DecisionHistory, DecisionHistoryGroup, DecisionRecord, DecisionType, Validation } from '../ir/schema.ts'

export type { DecisionType }

export const DECISION_TYPE_ORDER: readonly DecisionType[] = [
  'direction',
  'city',
  'company',
  'jd',
  'resume',
]

export const DECISION_TYPE_LABEL: Record<DecisionType, string> = {
  direction: '方向探索',
  city: '城市评估',
  company: '公司筛选',
  jd: 'JD分析',
  resume: '简历定制',
}

/** skill 精确映射（skill 生态协议规范名；转行评估并入 direction——方向级评估） */
const SKILL_TYPE_EXACT: Record<string, DecisionType> = {
  'career-path': 'direction',
  'career-transition': 'direction',
  'city-advisor': 'city',
  'company-screener': 'company',
  'jd-analysis': 'jd',
  'resume-writing': 'resume',
}

/**
 * 关键词推断：skill 值域非封闭（各 skill 自填 skill 字段），规范名之外还有
 * 原型变体（direction-explore/city-eval/transfer-eval/city-compare）。
 * 逆序匹配（后段优先），避免交叉命中（如 city 先于 direction 命中）。
 */
const SKILL_TYPE_KEYWORDS: readonly { type: DecisionType; keywords: readonly string[] }[] = [
  { type: 'resume', keywords: ['resume', '简历'] },
  { type: 'jd', keywords: ['jd', '职位'] },
  { type: 'company', keywords: ['company', '公司'] },
  { type: 'city', keywords: ['city', '城市'] },
  { type: 'direction', keywords: ['transfer', 'transition', '转行', 'direction', 'path', 'explore', '方向'] },
]

/** skill → 决策类型：精确映射 → 关键词推断 → 归入 direction（未知决策标签化） */
export function decisionTypeOf(skill: string | undefined): DecisionType {
  if (!skill) return 'direction'
  const exact = SKILL_TYPE_EXACT[skill]
  if (exact) return exact
  const s = skill.toLowerCase()
  for (const { type, keywords } of SKILL_TYPE_KEYWORDS) {
    if (keywords.some((k) => s.includes(k))) return type
  }
  return 'direction'
}

/** validation 由 projection 附加在 record 上（DecisionView = DecisionRecord & { validation? }） */
type ValidatedDecision = DecisionRecord & { validation?: Validation }

export class DecisionRuntime {
  /** 从决策记录集合计算某人的决策历史（投影派生视图，幂等纯函数） */
  computeHistory(decisions: DecisionRecord[], person: string): DecisionHistory {
    // 按人过滤 + 排除 invalid（degraded 保留参与）+ 按时间升序（参数取最新值用）
    const own = decisions
      .filter((d) => d.profile === person)
      .filter((d) => (d as ValidatedDecision).validation?.status !== 'invalid')
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))

    const groups = new Map<DecisionType, DecisionHistoryGroup>()
    for (const d of own) {
      const type = decisionTypeOf(d.skill)
      let group = groups.get(type)
      if (!group) {
        group = { type, label: DECISION_TYPE_LABEL[type], decisionIds: [], updatedAt: '' }
        groups.set(type, group)
      }
      group.decisionIds.push(d.id)
      if (d.direction) group.direction = d.direction
      if (d.city) group.city = d.city
      group.updatedAt = d.createdAt
    }

    return {
      person,
      groups: DECISION_TYPE_ORDER.filter((t) => groups.has(t)).map((t) => groups.get(t)!),
    }
  }
}
