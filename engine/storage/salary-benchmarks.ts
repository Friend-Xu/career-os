/**
 * salary-benchmarks：薪资基准知识层（knowledge/薪资基准-{城市}-{岗位}-{档位}.md → SalaryBenchmarkEntry[]；
 * 契约 Company-Leaderboard-Contract-v0.1 §7.2，二期）。
 * - parseSalaryBenchmarksMarkdown：表头「# 薪资基准：{城市} · {岗位} · {档位}」定组 + 表格逐行解析（样本点模式）
 * - scanSalaryBenchmarks：knowledge/ 目录扫描（文件名前缀「薪资基准-」过滤，与资质名单同目录共存）
 * - upsertSalaryBenchmarks：Agent 输出 JSON → Engine 校验写文件（id/expiresAt 由 Engine 派生；
 *   一次调用一组（role+city+tier 全同），全量覆盖 = 刷新语义；Producer 边界同 job-leads）
 * - watchSalaryBenchmarks：knowledge/ 监听（前缀过滤）→ onChanged（不含数据，客户端重拉 salary-benchmarks/list）
 *
 * 行级校验：来源/(薪资|区间)/抓取日期缺失或数值非法 → 行跳过 + warn（不静默丢）。
 * 条目 = 单来源快照；分位不落盘（engine/ir/salary.ts 聚合）。
 */
import { watch } from 'chokidar'
import { basename } from 'node:path'
import type { SalaryBenchmarkEntry, Validation } from '../ir/schema.ts'
import { expTierLabel, parseExpTier } from '../ir/salary.ts'
import type { Workspace } from './workspace.ts'

const BENCHMARK_TTL_DAYS = 90 // 契约 §7.2.1：过期阈值（过期照显标「数据较旧」，不删）
const FILE_PREFIX = '薪资基准-'

function today(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  const dt = new Date(y, m - 1, d + days)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

export interface ParsedSalaryBenchmarks {
  sourceFile: string
  entries: SalaryBenchmarkEntry[]
  validation?: Validation
}

function parseNumber(cell: string): number | null {
  const t = cell.trim()
  if (!t || t === '-') return null
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 区间单元格「10-14」「10~14」「10 - 14」→ {min,max}；非法 → null */
function parseRange(cell: string): { min: number; max: number } | null {
  const t = cell.trim().replace(/\s+/g, '')
  if (!t || t === '-') return null
  const m = t.match(/^(\d+(?:\.\d+)?)[-–~～](\d+(?:\.\d+)?)$/)
  if (!m) return null
  const min = Number(m[1])
  const max = Number(m[2])
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || min > max) return null
  return { min, max }
}

/** 单个 薪资基准-*.md → SalaryBenchmarkEntry[]（表头定组；必填缺失/数值非法行跳过 + warn） */
export function parseSalaryBenchmarksMarkdown(md: string, sourceFile: string): ParsedSalaryBenchmarks {
  const issues: Validation['issues'] = []
  const entries: SalaryBenchmarkEntry[] = []

  const header = md.split('\n').find((l) => l.trim().startsWith('#')) ?? ''
  const hm = header.match(/^#\s*薪资基准：\s*(.+?)\s*·\s*(.+?)\s*·\s*(.+?)\s*$/)
  if (!hm) {
    issues.push({ path: sourceFile, reason: '未找到表头「# 薪资基准：{城市} · {岗位} · {档位}」→ 文件跳过', severity: 'warn' })
    return { sourceFile, entries, validation: { status: 'degraded', issues } }
  }
  const city = hm[1]!.trim()
  const role = hm[2]!.trim()
  const expTier = parseExpTier(hm[3]!.trim())
  if (!city || !role) {
    issues.push({ path: sourceFile, reason: `表头城市/岗位为空：${JSON.stringify({ city, role })} → 文件跳过`, severity: 'warn' })
    return { sourceFile, entries, validation: { status: 'degraded', issues } }
  }
  if (expTier === null) {
    issues.push({ path: sourceFile, reason: `档位非法值 ${JSON.stringify(hm[3]!.trim())}（合法：0-2/3-5/6-10/10+/不限，可带「年」）→ 文件跳过`, severity: 'warn' })
    return { sourceFile, entries, validation: { status: 'degraded', issues } }
  }

  const sec = md.split(/##\s*薪资基准/, 2)[1]
  if (sec) {
    const body = sec.split(/\n##\s+/)[0]
    let row = 0
    for (const line of body.split('\n')) {
      const m = line.match(/^\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/)
      if (!m) continue
      const source = m[1]!.trim()
      if (!source || source.startsWith('-') || source === '来源') continue // 表头/分隔行
      row++
      const rawSalary = m[2]!.trim()
      const rawRange = m[3]!.trim()
      const rawSample = m[4]!.trim()
      const note = m[5]!.trim()
      const capturedAt = m[6]!.trim()

      if (!source || source === '-') {
        issues.push({ path: `${sourceFile}#${row}`, reason: `基准行来源缺失 → 行跳过`, severity: 'warn' })
        continue
      }
      if (!capturedAt || capturedAt === '-') {
        issues.push({ path: `${sourceFile}#${row}`, reason: `基准行抓取日期缺失 → 行跳过`, severity: 'warn' })
        continue
      }
      const salary = parseNumber(rawSalary)
      const salaryRange = parseRange(rawRange)
      if (salary === null && salaryRange === null) {
        issues.push({ path: `${sourceFile}#${row}`, reason: `基准行薪资/区间缺失或非法：${JSON.stringify({ rawSalary, rawRange })} → 行跳过`, severity: 'warn' })
        continue
      }
      const sampleN = rawSample && rawSample !== '-' ? parseNumber(rawSample) : null
      if (rawSample && rawSample !== '-' && (sampleN === null || !Number.isInteger(sampleN))) {
        issues.push({ path: `${sourceFile}#${row}`, reason: `基准行样本量非法 ${JSON.stringify(rawSample)} → 按缺省（计 1）`, severity: 'warn' })
      }
      entries.push({
        id: `benchmark_${capturedAt.replace(/-/g, '')}_${String(row).padStart(3, '0')}`,
        role,
        city,
        expTier,
        ...(salary !== null ? { salary } : {}),
        ...(salaryRange !== null ? { salaryRange } : {}),
        ...(sampleN !== null && Number.isInteger(sampleN) ? { sampleN } : {}),
        source,
        ...(note && note !== '-' ? { note } : {}),
        capturedAt,
        expiresAt: addDays(capturedAt, BENCHMARK_TTL_DAYS),
      })
    }
  } else {
    issues.push({ path: sourceFile, reason: '未找到 `## 薪资基准` 表格', severity: 'warn' })
  }

  const out: ParsedSalaryBenchmarks = { sourceFile, entries }
  if (issues.length > 0) out.validation = { status: issues.some((i) => i.severity === 'error') ? 'invalid' : 'degraded', issues }
  return out
}

/** knowledge/ 扫描（前缀「薪资基准-」过滤）→ SalaryBenchmarkEntry[]；无目录/无文件 → 空数组 */
export function scanSalaryBenchmarks(ws: Workspace): SalaryBenchmarkEntry[] {
  if (!ws.exists('knowledge')) return []
  return ws
    .listMarkdown('knowledge')
    .filter((f) => f.startsWith(FILE_PREFIX))
    .sort()
    .flatMap((f) => parseSalaryBenchmarksMarkdown(ws.read(`knowledge/${f}`), f).entries)
}

export interface SalaryBenchmarkInput {
  role: string
  city: string
  expTier: string // 枚举或中文标签（「3-5」「3-5年」「不限」）——Engine parseExpTier 归一
  salary?: number
  salaryRange?: { min: number; max: number }
  sampleN?: number
  source: string
  note?: string
  capturedAt?: string
}

/** Agent 输出基准 JSON → Engine 校验写文件（fail fast 边界校验）。
 *  一次调用一组：所有条目 (role, city, 档位) 必须相同；全量覆盖该组文件（刷新语义）。
 *  返回落盘后的完整条目（含 Engine 派生的 id/expiresAt）。 */
export function upsertSalaryBenchmarks(ws: Workspace, entries: SalaryBenchmarkInput[]): SalaryBenchmarkEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('薪资基准登记：entries 非空数组')
  const normalized = entries.map((e) => {
    if (!e?.role?.trim()) throw new Error('薪资基准登记：role 非空')
    if (!e?.city?.trim()) throw new Error(`薪资基准登记：${e.role} city 非空`)
    const tier = parseExpTier(String(e.expTier ?? ''))
    if (tier === null) throw new Error(`薪资基准登记：${e.role} 档位非法值 ${JSON.stringify(e.expTier)}（合法：0-2/3-5/6-10/10+/不限）`)
    if (!e?.source?.trim()) throw new Error(`薪资基准登记：${e.role}「${e.source}」source 非空`)
    const salary = e.salary
    const salaryRange = e.salaryRange
    if (salary === undefined && salaryRange === undefined) throw new Error(`薪资基准登记：${e.role} salary/salaryRange 至少其一`)
    if (salary !== undefined && (!Number.isFinite(salary) || salary <= 0)) throw new Error(`薪资基准登记：${e.role} salary 非法值 ${salary}（正数，月薪 K）`)
    if (salaryRange !== undefined) {
      const { min, max } = salaryRange
      if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || min > max) {
        throw new Error(`薪资基准登记：${e.role} salaryRange 非法 ${JSON.stringify(salaryRange)}（min ≤ max 且为正数）`)
      }
    }
    if (e.sampleN !== undefined && (!Number.isInteger(e.sampleN) || e.sampleN <= 0)) {
      throw new Error(`薪资基准登记：${e.role} sampleN 非法值 ${e.sampleN}（正整数）`)
    }
    return { ...e, role: e.role.trim(), city: e.city.trim(), expTier: tier, source: e.source.trim() }
  })
  const first = normalized[0]!
  for (const e of normalized.slice(1)) {
    if (e.role !== first.role || e.city !== first.city || e.expTier !== first.expTier) {
      throw new Error(`薪资基准登记：一次调用一组（role+city+档位全同）——首条 ${first.role}/${first.city}/${first.expTier}，冲突条 ${e.role}/${e.city}/${e.expTier}`)
    }
  }
  const date = today()
  const path = `knowledge/${FILE_PREFIX}${first.city}-${first.role}-${expTierLabel(first.expTier)}.md`
  const rows = normalized
    .map((e) => {
      const salary = e.salary !== undefined ? String(e.salary) : '-'
      const range = e.salaryRange !== undefined ? `${e.salaryRange.min}-${e.salaryRange.max}` : '-'
      const sample = e.sampleN !== undefined ? String(e.sampleN) : '-'
      const note = e.note?.trim() || '-'
      const capturedAt = e.capturedAt?.trim() || date
      return `| ${e.source} | ${salary} | ${range} | ${sample} | ${note} | ${capturedAt} |`
    })
    .join('\n')
  const md = `# 薪资基准：${first.city} · ${first.role} · ${expTierLabel(first.expTier)}

> 口径：月薪 K（税前）；年薪来源已换算并在备注留原始口径。条目 = 单来源快照；分位由引擎聚合（契约 §7）。

## 薪资基准

| 来源 | 薪资(K) | 区间(K) | 样本 | 备注 | 抓取日期 |
|------|---------|---------|------|------|----------|
${rows}
`
  ws.write(path, md)
  return parseSalaryBenchmarksMarkdown(md, basename(path)).entries
}

/** knowledge/ 监听（文件名前缀「薪资基准-」过滤）：add/change/unlink → 全量重扫 → onChanged */
export function watchSalaryBenchmarks(ws: Workspace, onChanged: (entries: SalaryBenchmarkEntry[]) => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.knowledge, { ignoreInitial: true })
  const rescan = (): void => onChanged(scanSalaryBenchmarks(ws))
  const relevant = (p: string): boolean => p.endsWith('.md') && basename(p).startsWith(FILE_PREFIX)
  watcher.on('add', (p: string) => {
    if (relevant(p)) rescan()
  })
  watcher.on('change', (p: string) => {
    if (relevant(p)) rescan()
  })
  watcher.on('unlink', (p: string) => {
    if (relevant(p)) rescan()
  })
  return { close: () => watcher.close() }
}
