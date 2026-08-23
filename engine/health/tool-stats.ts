/**
 * ToolStats 指标投影（Phase 4B 统一指标板）：logs/traces 聚合 → ToolStats。
 * 纯读派生零写入（同 Health 惯例：Detect ≠ Fix）；只输出计数/耗时聚合与时间戳——
 * trace 文件含任务原文，本投影永不回传查询内容（隐私红线）。
 * 空数据源诚实处理：traces 目录缺失/空 → 全 0 + 空数组 + null。
 *
 * 聚合源（统一命名空间，替换 P3 单一 web_search 投影）：
 * - tool-*.jsonl：工具级审计事件（tool_start/tool_done/tool_error——含 name/source/
 *   provider/durationMs；executeGuarded 生产，全工具统一）
 * - 会话命名空间（web_search / nbs / nbs_profile / exa）：cache_hit / budget_exhausted /
 *   fallback / http_call（Provider Stability v0.1 外部调用 trace）
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolSource, ToolStatEntry, ToolStats } from '../ir/schema.ts'

export const TOOL_TRACE_PREFIX = 'tool-'
/** 会话命名空间（logger.trace 首参 = 文件名前缀；新增外部源时同步此白名单） */
const SESSION_TRACE_PREFIXES = ['web_search', 'nbs', 'nbs_profile', 'exa'] as const

/** 会话级事件白名单（跨命名空间统一计数；未知事件不计数） */
const SESSION_EVENT_KEY: Record<string, 'cacheHits' | 'budgetExhausted' | 'fallbacks' | 'externalCalls'> = {
  cache_hit: 'cacheHits',
  budget_exhausted: 'budgetExhausted',
  fallback: 'fallbacks',
  http_call: 'externalCalls',
}

interface TraceEntry {
  time?: unknown
  event?: unknown
  name?: unknown
  source?: unknown
  provider?: unknown
  durationMs?: unknown
}

/** 聚合工具指标（唯一入口；tracesDir 可注入供单测，实际传 config.paths.logs/traces） */
export function computeToolStats(tracesDir: string): ToolStats {
  const stats: ToolStats = {
    byTool: [],
    bySource: [],
    externalCalls: 0,
    cacheHits: 0,
    budgetExhausted: 0,
    fallbacks: 0,
    since: null,
    lastAt: null,
  }
  let files: string[]
  try {
    files = readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return stats // traces 目录不存在 → 诚实空态
  }

  const toolMap = new Map<string, ToolStatEntry>()
  const sourceMap = new Map<ToolSource, { calls: number; errors: number; durationSum: number; durationN: number }>()

  for (const file of files) {
    let content: string
    try {
      content = readFileSync(join(tracesDir, file), 'utf8')
    } catch {
      continue // 单文件读失败（轮转竞态）→ 跳过不中断
    }
    const isToolTrace = file.startsWith(TOOL_TRACE_PREFIX)
    const isSessionTrace = SESSION_TRACE_PREFIXES.some((p) => file.startsWith(p))
    // logger.trace 一次调用一文件一行；仍按行解析（换行残留/异常写法）
    for (const raw of content.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      let entry: TraceEntry
      try {
        entry = JSON.parse(line) as TraceEntry
      } catch {
        continue // 坏行跳过（外部写入竞争/截断）
      }
      const time = typeof entry.time === 'string' ? entry.time : null
      if (time !== null) {
        stats.since = stats.since === null || time < stats.since ? time : stats.since
        stats.lastAt = stats.lastAt === null || time > stats.lastAt ? time : stats.lastAt
      }
      const event = typeof entry.event === 'string' ? entry.event : ''
      if (event === '') continue

      if (isToolTrace && (event === 'tool_done' || event === 'tool_error')) {
        const name = typeof entry.name === 'string' ? entry.name : ''
        const source = typeof entry.source === 'string' ? entry.source : ''
        if (name === '' || (source !== 'builtin' && source !== 'hosted' && source !== 'mcp' && source !== 'data')) continue
        const provider = typeof entry.provider === 'string' ? entry.provider : undefined
        let e = toolMap.get(name)
        if (e === undefined) {
          e = {
            name,
            source: source as ToolSource,
            ...(provider !== undefined ? { provider } : {}),
            calls: 0,
            errors: 0,
            avgDurationMs: null,
            maxDurationMs: null,
          }
          toolMap.set(name, e)
        }
        e.calls += 1
        if (event === 'tool_error') e.errors += 1
        if (typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)) {
          e.avgDurationMs = e.avgDurationMs === null ? entry.durationMs : e.avgDurationMs + entry.durationMs
          e.maxDurationMs = e.maxDurationMs === null ? entry.durationMs : Math.max(e.maxDurationMs, entry.durationMs)
        }
        let s = sourceMap.get(source as ToolSource)
        if (s === undefined) {
          s = { calls: 0, errors: 0, durationSum: 0, durationN: 0 }
          sourceMap.set(source as ToolSource, s)
        }
        s.calls += 1
        if (event === 'tool_error') s.errors += 1
        if (typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)) {
          s.durationSum += entry.durationMs
          s.durationN += 1
        }
        continue
      }

      if (isSessionTrace) {
        const key = SESSION_EVENT_KEY[event]
        if (key !== undefined) stats[key]++
      }
    }
  }

  // 最终化：avgDurationMs 期间值为累加和——除以样本数（executeGuarded 保证 done/error 均带
  // durationMs，样本数 = calls），round 到整数毫秒；无样本保持 null
  for (const e of toolMap.values()) {
    if (e.avgDurationMs !== null) e.avgDurationMs = Math.round(e.avgDurationMs / e.calls)
  }
  stats.byTool = [...toolMap.values()]
  stats.bySource = [...sourceMap.entries()].map(([source, s]) => ({
    source,
    calls: s.calls,
    errors: s.errors,
    avgDurationMs: s.durationN > 0 ? Math.round(s.durationSum / s.durationN) : null,
  }))
  return stats
}
