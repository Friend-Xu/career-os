/**
 * P3 指标板：computeSearchStats 聚合测试（web_search trace → SearchStats）。
 * fixture 全部合成事件（时间戳独立构造），不触碰真实 logs/traces。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { computeSearchStats } from '../health/search-stats.ts'

function makeTracesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-search-stats-'))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 按 logger.trace 形状写一条事件（一文件一行） */
function writeTrace(dir: string, ts: number, event: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, `web_search-${ts}.jsonl`),
    JSON.stringify({ time: new Date(ts).toISOString(), event, ...extra }) + '\n',
    'utf8',
  )
}

test('computeSearchStats：多事件精确计数 + 时间边界（最早/最晚）', () => {
  const dir = makeTracesDir()
  try {
    writeTrace(dir, 1000, 'search_start', { budgetUsed: 1, budgetTotal: 8 })
    writeTrace(dir, 2000, 'cache_hit')
    writeTrace(dir, 1500, 'search_start', { budgetUsed: 1, budgetTotal: 8 })
    writeTrace(dir, 3000, 'fallback')
    writeTrace(dir, 4000, 'search_error')
    writeTrace(dir, 5000, 'budget_exhausted', { budgetUsed: 8, budgetTotal: 8 })
    const stats = computeSearchStats(dir)
    assert.equal(stats.searches, 2)
    assert.equal(stats.cacheHits, 1)
    assert.equal(stats.fallbacks, 1)
    assert.equal(stats.errors, 1)
    assert.equal(stats.budgetExhausted, 1)
    assert.equal(stats.since, new Date(1000).toISOString())
    assert.equal(stats.lastAt, new Date(5000).toISOString())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('computeSearchStats：目录不存在 → 全 0 + null（诚实空态）', () => {
  const stats = computeSearchStats(join(tmpdir(), 'cos-search-stats-nonexistent-9f2a'))
  assert.deepEqual(stats, {
    searches: 0,
    cacheHits: 0,
    fallbacks: 0,
    errors: 0,
    budgetExhausted: 0,
    since: null,
    lastAt: null,
  })
})

test('computeSearchStats：目录为空 → 全 0 + null', () => {
  const dir = makeTracesDir()
  try {
    const stats = computeSearchStats(dir)
    assert.equal(stats.searches, 0)
    assert.equal(stats.since, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('computeSearchStats：坏行/非 JSON 跳过，未知事件不计数', () => {
  const dir = makeTracesDir()
  try {
    writeFileSync(join(dir, 'web_search-1000.jsonl'), 'not json\n', 'utf8')
    writeTrace(dir, 2000, 'search_start')
    writeFileSync(join(dir, 'web_search-3000.jsonl'), '', 'utf8')
    writeTrace(dir, 4000, 'unknown_future_event')
    // 非 web_search 前缀文件不参与
    writeFileSync(join(dir, 'direct-5000.jsonl'), JSON.stringify({ time: new Date(5000).toISOString(), event: 'search_start' }) + '\n', 'utf8')
    const stats = computeSearchStats(dir)
    assert.equal(stats.searches, 1)
    assert.equal(stats.cacheHits, 0)
    // 时间边界取所有可解析行（未知事件行也带时间——时间戳不因事件不可识别而丢失）
    assert.equal(stats.since, new Date(2000).toISOString())
    assert.equal(stats.lastAt, new Date(4000).toISOString())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
