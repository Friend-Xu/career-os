/**
 * 薪资基准规则模块（Company-Leaderboard-Contract-v0.1 §7.3，二期）。
 * 纯函数、无 IO、确定性——分位聚合 / 档位映射 / 三态估价全部 Engine 计算，
 * Agent 只登记单来源条目（样本点模式，§7.2）。
 * 纯 TS 无 node 依赖：UI 可直接 import（榜行市场对照复用同一计算源）。
 */
import type { PersonWorkExperience, SalaryBenchmarkEntry, SalaryExpTier } from './schema.ts'

// ─── 档位（§7.2.1 枚举 + §7.3.2 映射）──

/** 来源/表头档位表述 → 枚举（「3-5」「3-5年」「不限」「不限经验」）；非法 → null（该条标缺不登记） */
export function parseExpTier(s: string): SalaryExpTier | null {
  const t = s.trim().replace(/年$/, '').replace(/经验$/, '')
  if (t === '0-2') return '0-2'
  if (t === '3-5') return '3-5'
  if (t === '6-10') return '6-10'
  if (t === '10+') return '10+'
  if (t === 'any' || t === '不限') return 'any'
  return null
}

/** 枚举 → 落盘/展示中文标签（引擎写文件用） */
export function expTierLabel(tier: SalaryExpTier): string {
  switch (tier) {
    case '0-2': return '0-2年'
    case '3-5': return '3-5年'
    case '6-10': return '6-10年'
    case '10+': return '10+年'
    case 'any': return '不限'
  }
}

/**
 * 经历 → 工作年限（年，1 位小数）：最早 start 到最晚 end 的跨度（end 缺失视为至今；
 * 跨度口径不重复计重叠经历）。无法计算（无任何 start）→ null = 档位未知（显式状态，非兜底）。
 */
export function computeWorkYears(experiences: PersonWorkExperience[] | undefined): number | null {
  if (!experiences || experiences.length === 0) return null
  let minStart: number | null = null
  let maxEnd: number | null = null
  const now = Date.now()
  for (const e of experiences) {
    const start = Date.parse(e.start ?? '')
    if (Number.isNaN(start)) continue
    const end = Date.parse(e.end ?? '')
    const endMs = Number.isNaN(end) ? now : end
    if (minStart === null || start < minStart) minStart = start
    if (maxEnd === null || endMs > maxEnd) maxEnd = endMs
  }
  if (minStart === null || maxEnd === null || maxEnd < minStart) return null
  return Math.round(((maxEnd - minStart) / (365.25 * 24 * 3600 * 1000)) * 10) / 10
}

/** 年限 → 档位（边界：<3 → 0-2；<6 → 3-5；<11 → 6-10；≥11 → 10+） */
export function mapExpTier(years: number): SalaryExpTier {
  if (years < 3) return '0-2'
  if (years < 6) return '3-5'
  if (years < 11) return '6-10'
  return '10+'
}

// ─── 分位聚合（§7.3.1）──

/** 一组（role+city+expTier）的聚合投影：Engine 计算，不落盘 */
export interface SalaryBenchmarkStats {
  role: string
  city: string
  expTier: SalaryExpTier
  p25: number
  p50: number
  p75: number
  sampleN: number // Σ sample_n（缺省条目按 1 计）
  stale: boolean // 组内存在过期条目（>90 天）——照显 + 标「数据较旧」
  sources: string[]
  latestCapturedAt: string
}

export function benchmarkGroupKey(role: string, city: string, tier: SalaryExpTier): string {
  return `${role}\u0000${city}\u0000${tier}`
}

/** 每条目取中点（单点 = 自身），权重 = sample_n（缺省 1） */
function midpoint(e: SalaryBenchmarkEntry): { value: number; weight: number } {
  const value = e.salary ?? (e.salaryRange!.min + e.salaryRange!.max) / 2
  return { value, weight: e.sampleN ?? 1 }
}

/** 加权最近秩分位（权重展开等价实现，无大数展开） */
function weightedPercentile(points: { value: number; weight: number }[], p: number): number {
  const total = points.reduce((s, x) => s + x.weight, 0)
  const target = Math.ceil((p / 100) * total) // 最近秩（1 起）
  const sorted = [...points].sort((a, b) => a.value - b.value)
  let acc = 0
  for (const x of sorted) {
    acc += x.weight
    if (acc >= target) return x.value
  }
  return sorted[sorted.length - 1]!.value
}

/** 条目聚合 → 分组统计（同组条目按 key 归并；组内存在过期条目 → stale=true） */
export function aggregateBenchmarks(entries: SalaryBenchmarkEntry[], now?: string): SalaryBenchmarkStats[] {
  const groups = new Map<string, { entries: SalaryBenchmarkEntry[]; role: string; city: string; tier: SalaryExpTier }>()
  for (const e of entries) {
    const key = benchmarkGroupKey(e.role, e.city, e.expTier)
    const g = groups.get(key)
    if (g) g.entries.push(e)
    else groups.set(key, { entries: [e], role: e.role, city: e.city, tier: e.expTier })
  }
  const today = now ?? new Date().toISOString().slice(0, 10)
  const out: SalaryBenchmarkStats[] = []
  for (const { entries: es, role, city, tier } of groups.values()) {
    const points = es.map(midpoint)
    out.push({
      role,
      city,
      expTier: tier,
      p25: weightedPercentile(points, 25),
      p50: weightedPercentile(points, 50),
      p75: weightedPercentile(points, 75),
      sampleN: points.reduce((s, x) => s + x.weight, 0),
      stale: es.some((e) => e.expiresAt < today),
      sources: [...new Set(es.map((e) => e.source))],
      latestCapturedAt: es.reduce((a, b) => (b.capturedAt > a ? b.capturedAt : a), es[0]!.capturedAt),
    })
  }
  return out.sort((a, b) =>
    benchmarkGroupKey(a.role, a.city, a.expTier).localeCompare(benchmarkGroupKey(b.role, b.city, b.expTier)),
  )
}

// ─── 三态估价（§7.3.3）──

/** preference.salaryRange / JD 薪资文本 → 数值区间（「11-13K」「11-13K/月」「9-13K·13薪」「11K」）；无法解析 → null */
export function parseSalaryRangeK(s: string): { min: number; max: number } | null {
  const t = s
    .trim()
    .replace(/k/gi, '')
    .replace(/\/月/g, '')
    .replace(/[·x×]\d+\s*薪/g, '')
    .replace(/\s+/g, '')
  if (!t) return null
  const parts = t.split(/[-–~～—]/).map((x) => Number(x))
  if (parts.some((n) => Number.isNaN(n) || n <= 0)) return null
  if (parts.length === 1) return { min: parts[0]!, max: parts[0]! }
  if (parts.length === 2) {
    const [a, b] = parts as [number, number]
    return { min: Math.min(a, b), max: Math.max(a, b) }
  }
  return null
}

export type SalaryVerdict = '合理' | '偏低' | '偏高'

/**
 * 三态判定（确定性）：E2 < P25 → 偏低；E1 > P75 → 偏高；其余（与市场带重叠）→ 合理。
 * 只对照、不定价——期望仍归用户（preference 流程编辑）。
 */
export function computeVerdict(expectation: { min: number; max: number }, stats: SalaryBenchmarkStats): SalaryVerdict {
  if (expectation.max < stats.p25) return '偏低'
  if (expectation.min > stats.p75) return '偏高'
  return '合理'
}

const VERDICT_PHRASE: Record<SalaryVerdict, string> = {
  偏低: '低于市场低四分位，报价空间可上调',
  偏高: '高于市场高四分位，需以经历/成果支撑溢价',
  合理: '与市场中枢一致',
}

/** 一句话依据（§7.3.3 模板） */
export function buildValuationReason(
  verdict: SalaryVerdict,
  expectation: { min: number; max: number },
  stats: SalaryBenchmarkStats,
): string {
  const range = expectation.min === expectation.max ? `${expectation.min}K` : `${expectation.min}-${expectation.max}K`
  return `你的期望 ${range} 落在 ${stats.city}·${stats.role}·${expTierLabel(stats.expTier)} 市场带 ${fmt(stats.p25)}-${fmt(stats.p75)}K（P50 ${fmt(stats.p50)}K，样本 ${stats.sampleN}，${stats.latestCapturedAt}）——${VERDICT_PHRASE[verdict]}`
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

// ─── 个人估价卡投影（§7.5 输入：画像 → 状态分支，全显式无兜底）──

/** 估价卡输入的最小画像形状（PersonSnapshot 与 Person 两形均满足——岗位解析兼容两处：
 *  PersonSnapshot.careerProfile（currentRole ?? targetRoles[0]）与 Person 顶层 targetRoles[0]） */
export interface SalaryValuationPersonInput {
  careerProfile?: { currentRole?: string; targetRoles?: string[] }
  targetRoles?: string[]
  preference?: { salaryRange?: string; city?: string }
  experiences?: PersonWorkExperience[]
}

/** 估价卡（Engine 投影）：各缺数据状态显式 null，UI 按 §7.5 分支渲染 */
export interface SalaryValuationCard {
  role: string | null // 画像岗位（currentRole ?? targetRoles[0]）
  city: string | null // preference.city
  tier: SalaryExpTier | null // 档位未知（无经历）→ null
  expectation: { min: number; max: number } | null // preference.salaryRange 未解析 → null
  stats: SalaryBenchmarkStats | null // 该 city×role×tier 无基准 → null
  verdict: SalaryVerdict | null // 档位未知 / 无基准 / 无期望 → null（无三态结论）
  reason: string | null
}

export function buildSalaryValuationCard(person: SalaryValuationPersonInput, entries: SalaryBenchmarkEntry[]): SalaryValuationCard {
  const role = person.careerProfile?.currentRole ?? person.careerProfile?.targetRoles?.[0] ?? person.targetRoles?.[0] ?? null
  const city = person.preference?.city ?? null
  const tier = person.experiences ? (() => {
    const years = computeWorkYears(person.experiences)
    return years === null ? null : mapExpTier(years)
  })() : null
  const expectation = person.preference?.salaryRange ? parseSalaryRangeK(person.preference.salaryRange) : null

  let stats: SalaryBenchmarkStats | null = null
  if (role !== null && city !== null && tier !== null) {
    const key = benchmarkGroupKey(role, city, tier)
    stats = aggregateBenchmarks(entries).find((s) => benchmarkGroupKey(s.role, s.city, s.expTier) === key) ?? null
  }

  let verdict: SalaryVerdict | null = null
  let reason: string | null = null
  if (stats !== null && expectation !== null) {
    verdict = computeVerdict(expectation, stats)
    reason = buildValuationReason(verdict, expectation, stats)
  }

  return { role, city, tier, expectation, stats, verdict, reason }
}
