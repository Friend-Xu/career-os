/**
 * Phase 4B ToolStats 统一指标板：computeToolStats 聚合测试
 * （工具级 tool-*.jsonl + 会话命名空间 web_search/nbs/nbs_profile/exa）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeToolStats } from '../health/tool-stats.ts'

/** 写一条 trace（模拟 logger.trace 一次调用一文件一行；同文件可多行；坏行 = 字符串） */
function writeTrace(dir: string, file: string, lines: Array<Record<string, unknown> | string>): string {
  const p = join(dir, file)
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  return p
}

const line = (entry: Record<string, unknown>): Record<string, unknown> => ({ time: '2026-08-23T10:00:00.000Z', ...entry })

test('computeToolStats：工具级聚合（byTool 计数/错误/平均耗时；bySource 汇总）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-tool-stats-'))
  writeTrace(dir, 'tool-a.jsonl', [
    line({ event: 'tool_start', name: 'QueryMacroStats', source: 'data', egress: 'external', provider: 'nbs' }),
    line({ event: 'tool_done', name: 'QueryMacroStats', source: 'data', egress: 'external', provider: 'nbs', durationMs: 300 }),
    line({ event: 'tool_start', name: 'QueryMacroStats', source: 'data', egress: 'external', provider: 'nbs' }),
    line({ event: 'tool_done', name: 'QueryMacroStats', source: 'data', egress: 'external', provider: 'nbs', durationMs: 500 }),
    line({ event: 'tool_start', name: 'WebSearch', source: 'hosted', egress: 'external', provider: 'hosted' }),
    line({ event: 'tool_error', name: 'WebSearch', source: 'hosted', egress: 'external', provider: 'hosted', durationMs: 60_000 }),
    line({ event: 'tool_done', name: 'Read', source: 'builtin', egress: 'local', durationMs: 2 }),
  ])
  const stats = computeToolStats(dir)
  const q = stats.byTool.find((t) => t.name === 'QueryMacroStats')
  assert.ok(q !== undefined)
  assert.equal(q.source, 'data')
  assert.equal(q.provider, 'nbs')
  assert.equal(q.calls, 2)
  assert.equal(q.errors, 0)
  assert.equal(q.avgDurationMs, 400, '平均 = (300+500)/2')
  assert.equal(q.maxDurationMs, 500)
  const w = stats.byTool.find((t) => t.name === 'WebSearch')
  assert.ok(w !== undefined)
  assert.equal(w.calls, 1)
  assert.equal(w.errors, 1, '工具失败计入 errors')
  assert.equal(w.avgDurationMs, 60_000, '错误事件耗时同样计入平均')
  const r = stats.byTool.find((t) => t.name === 'Read')
  assert.ok(r !== undefined)
  assert.equal(r.source, 'builtin')
  assert.equal(r.avgDurationMs, 2)
  const data = stats.bySource.find((s) => s.source === 'data')
  assert.ok(data !== undefined)
  assert.equal(data.calls, 2)
  const hosted = stats.bySource.find((s) => s.source === 'hosted')
  assert.ok(hosted !== undefined)
  assert.equal(hosted.calls, 1)
  assert.equal(hosted.errors, 1, 'bySource 含错误')
})

test('computeToolStats：会话命名空间计数（缓存/预算/降级/外呼）跨前缀统一', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-tool-stats-'))
  writeTrace(dir, 'web_search-1.jsonl', [
    line({ event: 'search_start' }),
    line({ event: 'cache_hit' }),
    line({ event: 'fallback' }),
    line({ event: 'budget_exhausted' }),
    line({ event: 'http_call', endpoint: 'websearch:responses', ok: true, attempts: 1, durationMs: 100 }),
  ])
  writeTrace(dir, 'nbs-1.jsonl', [
    line({ event: 'http_call', endpoint: 'nbs:esData', ok: true, attempts: 1, durationMs: 287 }),
    line({ event: 'cache_hit' }),
  ])
  writeTrace(dir, 'exa-1.jsonl', [line({ event: 'call_ok', toolName: 'web_search_exa', durationMs: 1742 })])
  const stats = computeToolStats(dir)
  assert.equal(stats.cacheHits, 2)
  assert.equal(stats.fallbacks, 1)
  assert.equal(stats.budgetExhausted, 1)
  assert.equal(stats.externalCalls, 2, 'http_call 跨命名空间计数')
  assert.ok(stats.since !== null && stats.lastAt !== null)
})

test('computeToolStats：目录不存在/为空 → 全 0 + 空数组 + null（诚实空态）', () => {
  const missing = computeToolStats(join(tmpdir(), 'cos-tool-stats-nonexistent-9f2a'))
  assert.equal(missing.byTool.length, 0)
  assert.equal(missing.bySource.length, 0)
  assert.equal(missing.externalCalls, 0)
  assert.equal(missing.cacheHits, 0)
  assert.equal(missing.budgetExhausted, 0)
  assert.equal(missing.fallbacks, 0)
  assert.equal(missing.since, null)
  assert.equal(missing.lastAt, null)
  const empty = computeToolStats(mkdtempSync(join(tmpdir(), 'cos-tool-stats-empty-')))
  assert.equal(empty.byTool.length, 0)
  assert.equal(empty.since, null)
})

test('computeToolStats：坏行/非 JSON 跳过，未知事件不计数；tool_denied 不计 calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-tool-stats-'))
  writeTrace(dir, 'tool-x.jsonl', [
    line({ event: 'tool_denied', name: 'Write', source: 'builtin', durationMs: 1 }),
    line({ event: 'tool_done', name: 'Read', source: 'builtin', durationMs: 3 }),
  ])
  writeTrace(dir, 'web_search-broken.jsonl', [
    'not json at all',
    line({ event: 'unknown_event' }),
    line({ event: 'cache_hit' }),
  ])
  const stats = computeToolStats(dir)
  const read = stats.byTool.find((t) => t.name === 'Read')
  assert.equal(read?.calls, 1)
  assert.equal(stats.byTool.find((t) => t.name === 'Write'), undefined, 'tool_denied 不计调用')
  assert.equal(stats.cacheHits, 1, '坏行跳过，有效行计数')
  assert.equal(stats.fallbacks, 0, '未知事件不计数')
})
