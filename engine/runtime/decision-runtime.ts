/**
 * decision-runtime：V1 决策链状态机（落地顺序第 5 步）
 *
 * 求职进程链 6 阶段（对齐原型 addDecision 行为，模型 B 人=角色）：
 *   方向探索 → 转行评估 → 城市评估 → 公司筛选 → JD分析 → 简历定制
 *
 * computeChain 是纯投影派生视图，不落盘——真相源是 decisions/*.md，
 * 从 DecisionRecord 集合幂等重算（决策记录的 14 字段摘要表）。
 *
 * 状态机规则：
 * 1. 链从 6 阶段全 pending 开始（方向探索 current）
 * 2. 每条合法决策（validation 非 invalid）按 skill 归属阶段（stageOfSkill 映射），
 *    该阶段置 completed；current 始终 = 首个未完成阶段（线性推进，不跳阶段）——
 *    跳阶段写入（如先写城市评估）只 backfill 该阶段 completed，不推进 current
 * 3. 全部完成 → 终态：currentStage 停在简历定制（无 current 状态阶段，调用方
 *    可用 stages.every(completed) 判定链完成）
 * 4. direction/city 随最新合法决策更新（非空值合并，部分更新不覆盖），挂在当前阶段上
 * 5. skipped 不建模（V1 不产出该状态，类型保留对齐 UI StageStatus 词汇）
 * 6. progressedAt = 最近一条合法决策的 createdAt（无合法决策为空串）
 *
 * 推进事件：computeChain 为纯函数，调用方保存旧链、新增决策后重算，
 * 用 stageProgressed(prev, next) diff currentStage 判定是否推进（toast 文案用）。
 */
import type { DecisionChain, DecisionRecord, PersonStage, StageId, StageStatus, Validation } from '../ir/schema.ts'

export const STAGE_ORDER: readonly StageId[] = [
  '方向探索',
  '转行评估',
  '城市评估',
  '公司筛选',
  'JD分析',
  '简历定制',
]

/** skill 精确映射（skill 生态协议规范名） */
const SKILL_STAGE_EXACT: Record<string, StageId> = {
  'career-path': '方向探索',
  'career-transition': '转行评估',
  'city-advisor': '城市评估',
  'company-screener': '公司筛选',
  'jd-analysis': 'JD分析',
  'resume-writing': '简历定制',
}

/**
 * 关键词推断：skill 值域非封闭（各 skill 自填 skill 字段），规范名之外还有
 * 原型变体（direction-explore/city-eval/transfer-eval/city-compare）。
 * 按链序逆序匹配（后段优先），避免交叉命中（如 city 先于 direction 命中）。
 */
const SKILL_STAGE_KEYWORDS: readonly { stage: StageId; keywords: readonly string[] }[] = [
  { stage: '简历定制', keywords: ['resume', '简历'] },
  { stage: 'JD分析', keywords: ['jd', '职位'] },
  { stage: '公司筛选', keywords: ['company', '公司'] },
  { stage: '城市评估', keywords: ['city', '城市'] },
  { stage: '转行评估', keywords: ['transfer', 'transition', '转行'] },
  { stage: '方向探索', keywords: ['direction', 'path', 'explore', '方向'] },
]

/** skill → 阶段：精确映射 → 关键词推断 → 归入方向探索（链首，未知决策不跳阶段） */
export function stageOfSkill(skill: string | undefined): StageId {
  if (!skill) return '方向探索'
  const exact = SKILL_STAGE_EXACT[skill]
  if (exact) return exact
  const s = skill.toLowerCase()
  for (const { stage, keywords } of SKILL_STAGE_KEYWORDS) {
    if (keywords.some((k) => s.includes(k))) return stage
  }
  return '方向探索'
}

/** validation 由 projection 附加在 record 上（DecisionView = DecisionRecord & { validation? }） */
type ValidatedDecision = DecisionRecord & { validation?: Validation }

export class DecisionRuntime {
  /** 从决策记录集合计算某人的决策链（投影派生视图，幂等纯函数） */
  computeChain(decisions: DecisionRecord[], person: string): DecisionChain {
    // 按人过滤 + 排除 invalid（degraded 保留参与推进）+ 按时间升序（参数取最新值用）
    const own = decisions
      .filter((d) => d.profile === person)
      .filter((d) => (d as ValidatedDecision).validation?.status !== 'invalid')
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))

    const completed = new Set<StageId>()
    const stageIds = new Map<StageId, string[]>()
    let direction: string | undefined
    let city: string | undefined
    for (const d of own) {
      const stage = stageOfSkill(d.skill)
      completed.add(stage)
      const ids = stageIds.get(stage)
      if (ids) ids.push(d.id)
      else stageIds.set(stage, [d.id])
      if (d.direction) direction = d.direction
      if (d.city) city = d.city
    }

    const stages: PersonStage[] = STAGE_ORDER.map((stage) => {
      const ids = stageIds.get(stage)
      return {
        stage,
        status: completed.has(stage) ? 'completed' : 'pending',
        ...(ids && ids.length > 0 ? { decisionIds: ids } : {}),
      }
    })
    // current = 首个未完成阶段（线性推进）；全部完成 → 终态，currentStage 停在最后一阶段
    const firstIncomplete = stages.find((s) => s.status === 'pending')
    const currentStage: StageId = firstIncomplete?.stage ?? '简历定制'
    if (firstIncomplete) firstIncomplete.status = 'current'

    // direction/city 随最新合法决策更新（非空值合并），挂在当前阶段上
    const current = stages.find((s) => s.stage === currentStage)!
    if (direction !== undefined) current.direction = direction
    if (city !== undefined) current.city = city

    return {
      person,
      stages,
      currentStage,
      progressedAt: own.length > 0 ? own[own.length - 1].createdAt : '',
    }
  }
}

export interface StageProgress {
  progressed: boolean
  from: StageId | null
  to: StageId | null
}

/** 决策链推进判定：diff 前后 currentStage（无推进时 from/to 为 null） */
export function stageProgressed(from: DecisionChain, to: DecisionChain): StageProgress {
  if (from.currentStage === to.currentStage) {
    return { progressed: false, from: null, to: null }
  }
  return { progressed: true, from: from.currentStage, to: to.currentStage }
}
