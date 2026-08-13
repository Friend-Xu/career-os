/**
 * JD Match Score（岗位匹配度，契约 references/jd-match-score-contract-v0.1.md）：
 * 确定性计分核心——Agent 只产事实（capabilities/技能/门槛），Engine 只算分。
 * - 输入 = computeJobMatch（能力覆盖三元组）+ computeConstraintMatch（门槛四态）——由调用方注入，
 *   本模块不反向依赖 transport（runtime → storage → ir 单向依赖）
 * - 能力维度 1-5 规则行：状态向量有序求值（表 total——每个状态恰命中一行）
 * - 门槛维度：四态映射（MATCHED 5 / NEEDS_CONFIRMATION 3 / NOT_DECLARED 剔行 / NOT_MATCHED 一票否决）
 * - 上限口径：85 分制披露——未纳入维度（差异化优势 15%）与 NOT_DECLARED 行从分母剔除，未知 ≠ 满分
 */

import type { ConstraintMatchRow, GapResult } from '../ir/schema.ts'

export const JD_MATCH_RULE_VERSION = '2026-08-jd-match-v1'

/** 能力维度权重（硬技能 25 + 领域知识 15 + 软技能 15——领域知识已由 hard capabilities 承载） */
const CAPABILITY_WEIGHT = 55
/** 门槛维度权重（经验 20 + 学历/证书 10；三行等权 10+10+10——四态信息粒度粗于模型六维，等权更稳） */
const GATE_ROW_WEIGHT = 10
/** 未纳入维度（差异化优势——转行背景激活的 AI 判断维度，v1 不引擎化） */
const EXCLUDED_WEIGHT = 15

export interface JDMatchScoreInput {
  jobId: string
  personId: string
  gap: GapResult
  constraints: ConstraintMatchRow[]
  /** 岗位所在地（JobRecord.location——JD 建档原文；无 = 不参与城市判定） */
  jobLocation?: string
  /** 意向城市（Person.preference.city——用户偏好声明；无 = 不知道去哪，不提示） */
  preferredCity?: string
}

export interface JDMatchDimension {
  score: number | null
  weight: number
  detail: Record<string, unknown>
}

export interface JDMatchScore {
  jobId: string
  personId: string
  status: 'EVALUATED' | 'PARTIAL' | 'HARD_GATE_FAILED'
  /** 0-maxScore；HARD_GATE_FAILED / PARTIAL = null */
  score: number | null
  /** 有效分母（能力 55 + 门槛参与行 × 10；≤85）——UI 显示「62 / 85」 */
  maxScore: number
  dimensions: {
    capability: JDMatchDimension & {
      detail: {
        satisfied: string[]
        transferable: string[]
        missing: string[]
        mustMissing: string[]
      }
    }
    gate: JDMatchDimension & {
      detail: {
        rows: { dim: ConstraintMatchRow['dim']; status: ConstraintMatchRow['status']; requirement: string; person: string }[]
        excludedRows: ConstraintMatchRow['dim'][]
      }
    }
  }
  excluded: { label: string; weight: number }[]
  /** 城市意向冲突（FLAG 非否决）：偏好是软事实（会变/行为可能推翻声明）——只提示不扣分不出局。
   *  null = 无偏好数据或岗位无城市（不提示）；conflict = 意向城市与岗位所在地互不含 */
  city: { preferred: string; jobLocation: string; conflict: boolean } | null
  ruleVersion: string
  assessedAt: string
}

/** 城市冲突判定：偏好是软事实——互不含才提示；任一侧缺失 → 不判定（不知道去哪 = 不提示） */
export function cityConflictOf(preferredCity: string | undefined, jobLocation: string | undefined): { preferred: string; jobLocation: string; conflict: boolean } | null {
  if (!preferredCity || !jobLocation) return null
  const a = preferredCity.trim()
  const b = jobLocation.trim()
  if (a.length === 0 || b.length === 0) return null
  return { preferred: a, jobLocation: b, conflict: !(a.includes(b) || b.includes(a)) }
}

/** 能力覆盖三元组 → 维度分 1-5（有序求值，表 total；无硬能力声明 → null = 维度无数据） */
export function capabilityScore(gap: GapResult): number | null {
  const { satisfied, transferable, missing } = gap
  const total = satisfied.length + transferable.length + missing.length
  if (total === 0) return null
  const mustMissing = missing.filter((m) => m.essential).length
  if (missing.length === 0) {
    if (transferable.length === 0) return 5 // 全覆盖
    if (satisfied.length > 0) return 4 // 完全满足（核心全声明，边缘有基础）
    return 3 // 全为有基础（transferable）——差半级
  }
  if (mustMissing === 0) return 3 // 核心全覆盖，少量缺口
  if (missing.length <= 3) return 2 // 核心有缺口（差一级）
  return 1 // 核心大面积缺失
}

/** 门槛行四态 → 行分（NOT_DECLARED = 岗位未要求 → null 剔行；NOT_MATCHED → 调用方一票否决） */
function gateRowScore(status: ConstraintMatchRow['status']): number | null {
  switch (status) {
    case 'MATCHED':
      return 5
    case 'NEEDS_CONFIRMATION':
      return 3
    case 'NOT_DECLARED':
      return null
    case 'NOT_MATCHED':
      return 0
  }
}

/** JDMatchScore 纯投影（不落盘、不回写 markdown） */
export function computeJDMatchScore(input: JDMatchScoreInput, assessedAt = new Date().toISOString()): JDMatchScore {
  const { jobId, personId, gap, constraints, jobLocation, preferredCity } = input

  const rows = constraints.map((r) => ({
    dim: r.dim,
    status: r.status,
    requirement: r.requirement,
    person: r.person,
  }))
  const vetoRow = rows.find((r) => r.status === 'NOT_MATCHED')
  const capScore = capabilityScore(gap)
  const city = cityConflictOf(preferredCity, jobLocation)

  // 硬门槛一票否决（skill 模型规则：明确要求不满足 → 不计算综合分）——优先级最高
  if (vetoRow) {
    return {
      jobId,
      personId,
      status: 'HARD_GATE_FAILED',
      score: null,
      maxScore: 0,
      dimensions: {
        capability: {
          score: capScore,
          weight: CAPABILITY_WEIGHT,
          detail: {
            satisfied: gap.satisfied.map((s) => s.name),
            transferable: gap.transferable.map((s) => s.name),
            missing: gap.missing.map((m) => m.name),
            mustMissing: gap.missing.filter((m) => m.essential).map((m) => m.name),
          },
        },
        gate: { score: null, weight: 0, detail: { rows, excludedRows: [] } },
      },
      excluded: [{ label: '差异化优势', weight: EXCLUDED_WEIGHT }],
      city,
      ruleVersion: JD_MATCH_RULE_VERSION,
      assessedAt,
    }
  }

  // 能力维度无数据（岗位未分析）→ PARTIAL，分数不计算（未知 ≠ 中等）
  if (capScore === null) {
    return {
      jobId,
      personId,
      status: 'PARTIAL',
      score: null,
      maxScore: 0,
      dimensions: {
        capability: {
          score: null,
          weight: CAPABILITY_WEIGHT,
          detail: { satisfied: [], transferable: [], missing: [], mustMissing: [] },
        },
        gate: { score: null, weight: 0, detail: { rows, excludedRows: [] } },
      },
      excluded: [{ label: '差异化优势', weight: EXCLUDED_WEIGHT }],
      city,
      ruleVersion: JD_MATCH_RULE_VERSION,
      assessedAt,
    }
  }

  // 门槛维度：NOT_DECLARED 行剔出（岗位未要求——从分母剔除，不扣分不减分）
  const scoredRows = rows.filter((r) => r.status !== 'NOT_DECLARED')
  const excludedRows = rows.filter((r) => r.status === 'NOT_DECLARED').map((r) => r.dim)
  const gatePoints = scoredRows.reduce((sum, r) => sum + ((gateRowScore(r.status) ?? 0) / 5) * GATE_ROW_WEIGHT, 0)
  const capPoints = (capScore / 5) * CAPABILITY_WEIGHT
  const maxScore = CAPABILITY_WEIGHT + scoredRows.length * GATE_ROW_WEIGHT

  return {
    jobId,
    personId,
    status: 'EVALUATED',
    score: Math.round(capPoints + gatePoints),
    maxScore,
    dimensions: {
      capability: {
        score: capScore,
        weight: CAPABILITY_WEIGHT,
        detail: {
          satisfied: gap.satisfied.map((s) => s.name),
          transferable: gap.transferable.map((s) => s.name),
          missing: gap.missing.map((m) => m.name),
          mustMissing: gap.missing.filter((m) => m.essential).map((m) => m.name),
        },
      },
      gate: {
        score: scoredRows.length > 0 ? Math.round((gatePoints / (scoredRows.length * GATE_ROW_WEIGHT)) * 5) : null,
        weight: scoredRows.length * GATE_ROW_WEIGHT,
        detail: { rows, excludedRows },
      },
    },
    excluded: [{ label: '差异化优势', weight: EXCLUDED_WEIGHT }],
    city,
    ruleVersion: JD_MATCH_RULE_VERSION,
    assessedAt,
  }
}
