import type { CompanyAssessment, CompanyDimension, CompanyFact, CompanyFactType, CompanySignal } from '../ir/schema.ts'
import { RULE_VERSION, pickHighest, ruleOf } from './company-assessment-rules.ts'

/**
 * Company Assessment 确定性核心（Company Intelligence Layer v0.1，契约 references/company-assessment-contract-v0.1.md）。
 * - Producer = Engine：CompanyFact[] → CompanyAssessment，纯函数无副作用
 * - 可解释分：基础分 50 + Σ维度贡献（status 门控——INSUFFICIENT_DATA → qualityScore null，未知 ≠ 中等）
 * - Group 去重：认证取最高级别 / 融资取最新最高轮 / 风险可叠加
 * - 枚举外 value / 缺 evidence → degraded 不计分（不影响其他事实计分）
 */

/** 输入事实（Agent 采集层形状；id 由 normalize 确定性生成） */
export interface RawCompanyFact {
  type: CompanyFactType
  value: string
  evidence?: { source?: string; url?: string }
  collectedAt?: string
}

export interface NormalizedFact {
  fact: CompanyFact
  degraded: boolean
  reason?: 'NO_EVIDENCE' | 'UNKNOWN_VALUE'
}

/** 稳定 factId（djb2 哈希 type+value+source——同 constraintRef 模式；事实内容不变 → 引用稳定） */
export function factIdOf(type: string, value: string, source: string): string {
  const s = `${type}:${value}:${source}`
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return `fact:${h.toString(16).padStart(8, '0')}`
}

/**
 * 规范化：缺 evidence / 空 source → NO_EVIDENCE；value 枚举外 → UNKNOWN_VALUE；同 type+value 去重（保留已确认）。
 * 返回 NormalizedFact[]（输入顺序稳定，degraded 与 confirmed 混排）。
 */
export function normalizeFacts(raw: RawCompanyFact[]): NormalizedFact[] {
  const seen = new Set<string>()
  const out: NormalizedFact[] = []
  for (const r of raw) {
    const source = r.evidence?.source?.trim()
    if (!source) {
      out.push({ fact: { id: factIdOf(r.type, r.value, ''), type: r.type, value: r.value, evidence: { source: '' } }, degraded: true, reason: 'NO_EVIDENCE' })
      continue
    }
    if (!ruleOf(r.type, r.value)) {
      out.push({ fact: { id: factIdOf(r.type, r.value, source), type: r.type, value: r.value, evidence: { source, ...(r.evidence?.url ? { url: r.evidence.url } : {}) } }, degraded: true, reason: 'UNKNOWN_VALUE' })
      continue
    }
    const key = `${r.type}:${r.value}`
    if (seen.has(key)) continue // 重复事实（同 type+value）→ 去重，保留首条
    seen.add(key)
    out.push({
      fact: {
        id: factIdOf(r.type, r.value, source),
        type: r.type,
        value: r.value,
        evidence: { source, ...(r.evidence?.url ? { url: r.evidence.url } : {}) },
        ...(r.collectedAt ? { collectedAt: r.collectedAt } : {}),
      },
      degraded: false,
    })
  }
  return out
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** CompanyFact[] → CompanyAssessment（normalize → Group 去重 → 规则匹配 → 维度聚合 → status/score） */
export function computeCompanyAssessment(raw: RawCompanyFact[], assessedAt = new Date().toISOString()): CompanyAssessment {
  const normalized = normalizeFacts(raw)
  const confirmed = normalized.filter((n) => !n.degraded).map((n) => n.fact)
  const degradedFacts = normalized
    .filter((n) => n.degraded)
    .map((n) => ({ factId: n.fact.id, value: n.fact.value, reason: n.reason! }))

  // Group 去重：认证/融资组内只保留优先级最高的一条；其余组（含 risk）全量
  const byGroup = new Map<string, CompanyFact[]>()
  for (const f of confirmed) {
    const rule = ruleOf(f.type, f.value)!
    const g = byGroup.get(rule.group) ?? []
    g.push(f)
    byGroup.set(rule.group, g)
  }
  const chosen: CompanyFact[] = []
  for (const [group, facts] of byGroup) {
    if (group === 'certification' || group === 'financing') chosen.push(pickHighest(facts))
    else chosen.push(...facts)
  }

  // 规则匹配 → 信号（引用 factId，不复制事实）
  const signals: CompanySignal[] = chosen.map((f) => {
    const rule = ruleOf(f.type, f.value)!
    return { factId: f.id, factType: f.type, value: f.value, points: rule.contribution, evidence: f.evidence }
  })

  // 维度聚合 → status → qualityScore
  const dimensions: Record<CompanyDimension, number> = { credibility: 0, growth: 0, technology: 0, opportunity: 0, stability: 0 }
  for (const s of signals) {
    for (const [dim, pts] of Object.entries(s.points)) dimensions[dim as CompanyDimension] += pts
  }
  const coveredDims = Object.values(dimensions).filter((v) => v !== 0).length
  const status = confirmed.length === 0 ? 'INSUFFICIENT_DATA' : coveredDims >= 3 ? 'EVALUATED' : 'PARTIAL'
  const total = Object.values(dimensions).reduce((a, b) => a + b, 0)
  const qualityScore = status === 'INSUFFICIENT_DATA' ? null : clamp(50 + total, 0, 100)

  return {
    version: 'v0.1',
    ruleVersion: RULE_VERSION,
    assessedAt,
    status,
    qualityScore,
    dimensions,
    signals,
    degradedFacts,
  }
}
