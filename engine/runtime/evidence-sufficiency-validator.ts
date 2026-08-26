/**
 * Evidence Sufficiency Validator（契约 evidence-sufficiency-contract-v0.1 §I——全机械、无 LLM 判断）。
 * - 校验对象：Agent 最终回答末尾的 SUFFICIENCY_STATE 段（company_research 纯问答任务产物）。
 * - 输入：回答全文 + 执行上下文（启用的证据通道 + budget_exhausted 事实——trace 派生，调用方传入）。
 * - 输出：valid + issues（带 §I 编号）；偏离契约即违规，不做修复、不重跑（无 AI Judge）。
 * - 单一事实源：维度表/关键性/适用通道 = agent/context/task-protocol.ts 的
 *   COMPANY_RESEARCH_DIMENSIONS（契约 §B 的代码投影）。
 */
import { COMPANY_RESEARCH_DIMENSIONS, type CompanyResearchDimension } from '../agent/context/task-protocol.ts'

export type SufficiencyState = 'SUFFICIENT' | 'GAP' | 'CONFLICTED' | 'UNCERTAIN'
export type DimensionStatus = 'RESOLVED' | 'UNCERTAIN' | 'CONFLICTED' | 'UNCOVERED'
export type NextAction = 'stop' | 'continue' | 'finalize'
export type SourceTier = 'internal' | 'official' | 'statistics' | 'recruiting' | 'aggregator'
export type LimitationType = 'budget_exhausted' | 'gap' | 'conflict' | 'uncertainty'

export interface SufficiencySource {
  domain: string
  tier: SourceTier
}

export interface SufficiencyDimension {
  key: string
  status: DimensionStatus
  retries?: number
  sources?: SufficiencySource[]
  note?: string
}

export interface SufficiencyConflict {
  dimension: string
  note: string
}

export interface SufficiencyLimitation {
  type: LimitationType
  channel?: string
  dimension?: string
  note?: string
}

export interface SufficiencyAssessment {
  state: SufficiencyState
  dimensions: SufficiencyDimension[]
  conflicts: SufficiencyConflict[]
  limitations: SufficiencyLimitation[]
  nextAction: NextAction
}

export interface SufficiencyValidatorInput {
  /** Agent 最终回答全文（含 SUFFICIENCY_STATE 段） */
  text: string
  /** 本次执行允许工具集启用的证据通道（trace 命名空间子集；缺省 = 契约 §B 全部通道） */
  enabledChannels?: string[]
  /** budget_exhausted 事实（trace 派生；缺省 = 无） */
  exhaustedChannels?: string[]
}

export interface SufficiencyValidationResult {
  valid: boolean
  issues: string[]
  /** 解析成功时附上结构化声明（消费方投影用；违规时也保留原样） */
  assessment?: SufficiencyAssessment
}

const STATE_VALUES: readonly SufficiencyState[] = ['SUFFICIENT', 'GAP', 'CONFLICTED', 'UNCERTAIN']
const DIM_STATUS_VALUES: readonly DimensionStatus[] = ['RESOLVED', 'UNCERTAIN', 'CONFLICTED', 'UNCOVERED']
const TIER_VALUES: readonly SourceTier[] = ['internal', 'official', 'statistics', 'recruiting', 'aggregator']
const NEXT_ACTION_VALUES: readonly NextAction[] = ['stop', 'continue', 'finalize']
const LIMITATION_TYPES: readonly LimitationType[] = ['budget_exhausted', 'gap', 'conflict', 'uncertainty']
export const REQUIRED_DIMENSION_KEYS = COMPANY_RESEARCH_DIMENSIONS.map((d) => d.key)

const HEADER_RE = /^##\s*SUFFICIENCY_STATE\s*$/m
const FENCE_RE = /```json\s*\n([\s\S]*?)```/

/** 解析回答末尾的 SUFFICIENCY_STATE（取最后一次出现；要求 json 代码围栏——契约 §H） */
function parseAssessment(text: string): SufficiencyAssessment | undefined {
  const header = text.match(HEADER_RE)
  if (!header) return undefined
  const after = text.slice(header.index! + header[0].length)
  const fence = after.match(FENCE_RE)
  if (!fence) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(fence[1]!)
  } catch {
    return undefined
  }
  const s = (raw as { sufficiency?: unknown })?.sufficiency
  if (typeof s !== 'object' || s === null) return undefined
  const o = s as Record<string, unknown>
  if (typeof o.state !== 'string' || !Array.isArray(o.dimensions) || !Array.isArray(o.conflicts) || !Array.isArray(o.limitations) || typeof o.nextAction !== 'string') {
    return undefined
  }
  return o as unknown as SufficiencyAssessment
}

function dimensionOf(assessment: SufficiencyAssessment, key: string): SufficiencyDimension | undefined {
  return assessment.dimensions.find((d) => d.key === key)
}

function statusOf(assessment: SufficiencyAssessment, key: string): DimensionStatus | undefined {
  return dimensionOf(assessment, key)?.status
}

function retriesOf(assessment: SufficiencyAssessment, key: string): number {
  const r = dimensionOf(assessment, key)?.retries
  return typeof r === 'number' ? r : 0
}

export function applicableChannelsOf(dim: CompanyResearchDimension): string[] {
  return dim.channels.split('>').map((s) => s.trim()).filter(Boolean)
}

/** 本次校验上下文的启用通道集（缺省 = 契约 §B 全部通道；用于单测/无上下文场景） */
function enabledSet(conf: SufficiencyValidatorInput): string[] {
  const union = [...new Set(COMPANY_RESEARCH_DIMENSIONS.flatMap((d) => applicableChannelsOf(d)))]
  return conf.enabledChannels ?? union
}

/** §C.3 确定性折叠：只看 critical 维度（缺失 key 视作 UNCOVERED——I.4 会另行标记） */
export function foldState(assessment: SufficiencyAssessment): SufficiencyState {
  const critical = COMPANY_RESEARCH_DIMENSIONS.filter((d) => d.critical)
  if (critical.some((d) => statusOf(assessment, d.key) === 'CONFLICTED')) return 'CONFLICTED'
  if (critical.some((d) => statusOf(assessment, d.key) === 'UNCOVERED')) return 'GAP'
  if (critical.some((d) => statusOf(assessment, d.key) === 'UNCERTAIN')) return 'UNCERTAIN'
  return 'SUFFICIENT'
}

/** §D 确定性判定函数：nextAction = derive(state, unresolved, retries, availableChannels, budgetFacts) */
export function deriveNextAction(
  state: SufficiencyState,
  assessment: SufficiencyAssessment,
  conf: SufficiencyValidatorInput,
): NextAction {
  if (state === 'SUFFICIENT') return 'stop'
  const enabled = new Set(enabledSet(conf))
  const exhausted = new Set(conf.exhaustedChannels ?? [])
  const unresolved = (at: DimensionStatus): CompanyResearchDimension | undefined =>
    COMPANY_RESEARCH_DIMENSIONS.find(
      (d) => d.critical && statusOf(assessment, d.key) === at && retriesOf(assessment, d.key) < 1 &&
        applicableChannelsOf(d).some((c) => enabled.has(c) && !exhausted.has(c)),
    )
  if (state === 'GAP' && unresolved('UNCOVERED')) return 'continue'
  if (state === 'CONFLICTED' && unresolved('CONFLICTED')) return 'continue'
  if (state === 'UNCERTAIN' && unresolved('UNCERTAIN')) return 'continue'
  return 'finalize'
}

/** 某维度全部适用通道均不可用（未启用或已耗尽）——§I.11 用 */
function channelsUnavailable(key: string, conf: SufficiencyValidatorInput): boolean {
  const dim = COMPANY_RESEARCH_DIMENSIONS.find((d) => d.key === key)
  if (!dim) return true
  const enabled = new Set(enabledSet(conf))
  const exhausted = new Set(conf.exhaustedChannels ?? [])
  return !applicableChannelsOf(dim).some((c) => enabled.has(c) && !exhausted.has(c))
}

/** §I 全量机械校验（契约 evidence-sufficiency-contract-v0.1） */
export function validateEvidenceSufficiency(input: SufficiencyValidatorInput): SufficiencyValidationResult {
  const issues: string[] = []
  const parsed = parseAssessment(input.text)
  if (!parsed) {
    const header = input.text.match(HEADER_RE)
    const fence = header ? input.text.slice(header.index! + header[0].length).match(FENCE_RE) : undefined
    if (!header) issues.push('I.1 存在性：未找到 `## SUFFICIENCY_STATE` 段')
    else if (!fence) issues.push('I.1 存在性：状态段后缺少 json 代码围栏')
    else issues.push('I.2 解析：围栏内容非合法 JSON 或字段结构缺失（state/dimensions/conflicts/limitations/nextAction）')
    return { valid: false, issues }
  }
  const a = parsed
  const conf: SufficiencyValidatorInput = { text: input.text, enabledChannels: input.enabledChannels, exhaustedChannels: input.exhaustedChannels }

  // I.3 枚举合法性
  if (!STATE_VALUES.includes(a.state)) issues.push(`I.3 枚举：state=${String(a.state)} 非法`)
  if (!NEXT_ACTION_VALUES.includes(a.nextAction)) issues.push(`I.3 枚举：nextAction=${String(a.nextAction)} 非法`)
  for (const d of a.dimensions) {
    if (!DIM_STATUS_VALUES.includes(d.status)) issues.push(`I.3 枚举：维度 ${d.key} 状态 ${String(d.status)} 非法`)
    for (const s of d.sources ?? []) {
      if (!TIER_VALUES.includes(s.tier)) issues.push(`I.3 枚举：维度 ${d.key} 来源 tier=${String(s.tier)} 非法`)
    }
  }
  for (const l of a.limitations) {
    if (!LIMITATION_TYPES.includes(l.type)) issues.push(`I.3 枚举：limitation type=${String(l.type)} 非法`)
  }

  // I.4 完整性：key 集合 == 契约 §B 9 键
  const keys = a.dimensions.map((d) => d.key)
  for (const need of REQUIRED_DIMENSION_KEYS) {
    if (!keys.includes(need)) issues.push(`I.4 完整性：缺少维度 ${need}`)
  }
  for (const extra of keys.filter((k) => !REQUIRED_DIMENSION_KEYS.includes(k))) {
    issues.push(`I.4 完整性：多余维度 ${extra}`)
  }

  // I.5 来源规则
  for (const d of a.dimensions) {
    const sources = d.sources ?? []
    if (d.status !== 'UNCOVERED' && sources.length === 0) {
      issues.push(`I.5 来源：维度 ${d.key} 状态 ${d.status} 但无来源`)
    }
    for (const s of sources) {
      if (typeof s.domain !== 'string' || s.domain.trim() === '') {
        issues.push(`I.5 来源：维度 ${d.key} 存在空域来源`)
      }
    }
    if (d.status === 'UNCOVERED' && (sources.length > 0 || !d.note?.trim())) {
      issues.push(`I.5 来源：维度 ${d.key} 为 UNCOVERED（应无来源且 note 说明未获取什么）`)
    }
  }

  // I.6 再查配额：retries ∈ {0,1}
  for (const d of a.dimensions) {
    if (d.retries !== undefined && d.retries !== 0 && d.retries !== 1) {
      issues.push(`I.6 再查配额：维度 ${d.key} retries=${String(d.retries)} 非法（应 0 或 1）`)
    }
  }

  // I.7 冲突一致性
  for (const c of a.conflicts) {
    if (statusOf(a, c.dimension) !== 'CONFLICTED') {
      issues.push(`I.7 冲突一致性：conflicts 引用 ${c.dimension} 但该维度状态非 CONFLICTED`)
    }
  }

  // I.8 折叠一致性（SUFFICIENT 合法性的唯一来源）
  const folded = foldState(a)
  if (a.state !== folded) {
    issues.push(`I.8 折叠一致性：state=${a.state}，但按 §C.3 折叠应为 ${folded}`)
  }

  // I.9 下一动作一致性：全量 derive 校验
  const derived = deriveNextAction(a.state, a, conf)
  if (a.nextAction !== derived) {
    issues.push(`I.9 下一动作：nextAction=${a.nextAction}，derive(...) 应为 ${derived}`)
  }

  // I.10 预算事实记录义务（与"该通道是否仍相关"无关——事实透明）
  for (const ch of conf.exhaustedChannels ?? []) {
    if (!a.limitations.some((l) => l.type === 'budget_exhausted' && l.channel === ch)) {
      issues.push(`I.10 预算事实：通道 ${ch} 存在 budget_exhausted 但 limitations 未记录`)
    }
  }

  // I.11 陈述交叉一致性（限结构化段内部，纯枚举比对）
  for (const l of a.limitations) {
    if (l.type === 'conflict' && a.conflicts.length === 0) {
      issues.push('I.11 交叉一致：limitation=conflict 但 conflicts 为空')
    }
    if (l.type === 'uncertainty') {
      const dim = a.dimensions.find((d) => d.status === 'UNCERTAIN')
      if (!dim) issues.push('I.11 交叉一致：limitation=uncertainty 但无 UNCERTAIN 维度')
      else if (retriesOf(a, dim.key) < 1 && !channelsUnavailable(dim.key, conf)) {
        issues.push(`I.11 交叉一致：维度 ${dim.key} UNCERTAIN 未耗尽再查配额且通道可用，不应 finalize`)
      }
    }
    if (l.type === 'gap' && !a.dimensions.some((d) => d.status === 'UNCOVERED')) {
      issues.push('I.11 交叉一致：limitation=gap 但无 UNCOVERED 维度')
    }
  }

  return { valid: issues.length === 0, issues, assessment: a }
}
