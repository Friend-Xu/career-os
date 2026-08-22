/**
 * WebSearch 指标投影（P3 指标板）：logs/traces/web_search-*.jsonl 聚合。
 * 纯读派生零写入（同 Health 惯例：Detect ≠ Fix）；只输出计数与时间戳——
 * trace 文件含任务原文，本投影永不回传查询内容（隐私红线）。
 * 空数据源诚实处理：traces 目录缺失/空 → 全 0 + null。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SearchStats } from '../ir/schema.ts'

export const WEB_SEARCH_TRACE_PREFIX = 'web_search-'

/** web_search trace 事件白名单（web-search.ts trace('web_search', { event, ... })） */
const EVENT_COUNT_KEY: Record<string, keyof Omit<SearchStats, 'since' | 'lastAt'>> = {
  search_start: 'searches',
  cache_hit: 'cacheHits',
  fallback: 'fallbacks',
  search_error: 'errors',
  budget_exhausted: 'budgetExhausted',
}

interface TraceEntry {
  time?: unknown
  event?: unknown
}

/** 聚合 web_search trace（唯一入口；tracesDir 可注入供单测，实际传 config.paths.logs/traces） */
export function computeSearchStats(tracesDir: string): SearchStats {
  const stats: SearchStats = {
    searches: 0,
    cacheHits: 0,
    fallbacks: 0,
    errors: 0,
    budgetExhausted: 0,
    since: null,
    lastAt: null,
  }
  let files: string[]
  try {
    files = readdirSync(tracesDir).filter((f) => f.startsWith(WEB_SEARCH_TRACE_PREFIX) && f.endsWith('.jsonl'))
  } catch {
    return stats // traces 目录不存在 → 诚实空态
  }
  for (const file of files) {
    let content: string
    try {
      content = readFileSync(join(tracesDir, file), 'utf8')
    } catch {
      continue // 单文件读失败（轮转竞态）→ 跳过不中断
    }
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
      const key = typeof entry.event === 'string' ? EVENT_COUNT_KEY[entry.event] : undefined
      if (key !== undefined) stats[key]++
    }
  }
  return stats
}
