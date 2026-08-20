import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { parseCandidatePoolMarkdown, scanCandidatePool, upsertCandidatePool } from '../storage/candidate-pool.ts'

function setup(): ReturnType<typeof initWorkspace> {
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), 'cos-pool-')))
  return ws
}

const POOL_MD = `# 候选公司A

## 分析摘要

| 字段 | 值 |
|------|-----|
| id | candidate_20260816_001 |
| city | 城市X |
| industry | 医疗器械 / 机器人 |
| fit_stars | 4 |
| source | https://report.example/1 |
| captured_at | 2026-08-16 |

## 信号

| 信号 | 来源 | 日期 |
|------|------|------|
| 专精特新 | [工信部·2025] | 2025 |
| B轮融资 | [媒体报道·2026.01] | 2026.01 |
`

test('解析合法候选池文件：字段映射 + 信号表行解析 + 无 validation', () => {
  const { value, validation } = parseCandidatePoolMarkdown(POOL_MD, '候选公司A.md')
  assert.equal(validation, undefined)
  assert.equal(value.id, 'candidate_20260816_001')
  assert.equal(value.name, '候选公司A') // 文件名 = canonical 锚定名
  assert.equal(value.city, '城市X')
  assert.deepEqual(value.industry, ['医疗器械', '机器人']) // / 分隔拆分
  assert.equal(value.fitStars, 4)
  assert.equal(value.source, 'https://report.example/1')
  assert.equal(value.capturedAt, '2026-08-16')
  assert.deepEqual(value.signals, [
    { tag: '专精特新', source: '[工信部·2025]', date: '2025' },
    { tag: 'B轮融资', source: '[媒体报道·2026.01]', date: '2026.01' },
  ])
})

test('id/city/captured_at 缺失 → invalid；fit_stars 非法 → degraded 保留原值', () => {
  const bad = parseCandidatePoolMarkdown(
    POOL_MD.replace('| id | candidate_20260816_001 |\n', '').replace('| city | 城市X |\n', ''),
    '候选公司A.md',
  )
  assert.equal(bad.validation?.status, 'invalid')
  assert.ok(bad.validation!.issues.some((i) => i.path === 'id' && i.severity === 'error'))
  assert.ok(bad.validation!.issues.some((i) => i.path === 'city' && i.severity === 'error'))

  const degraded = parseCandidatePoolMarkdown(POOL_MD.replace('| fit_stars | 4 |', '| fit_stars | 6 |'), '候选公司A.md')
  assert.equal(degraded.validation?.status, 'degraded')
  assert.equal(degraded.value.fitStars, '6') // 保留原值
})

test('upsertCandidatePool：Engine 生成 id/capturedAt；同公司重写保留原 id；非法输入 fail fast', () => {
  const ws = setup()
  try {
    const out = upsertCandidatePool(ws, [
      {
        name: '候选公司A',
        city: '城市X',
        industry: ['医疗器械'],
        signals: [{ tag: '专精特新', source: '[工信部·2025]', date: '2025' }],
        fitStars: 4,
        source: 'https://report.example/1',
      },
    ])
    assert.equal(out.length, 1)
    assert.match(out[0]!.id, /^candidate_\d{8}_\d{3}$/)
    assert.equal(out[0]!.capturedAt.length, 10)
    assert.ok(ws.exists('company-pool/候选公司A.md'))
    const priorId = out[0]!.id

    // 同公司重写 → 保留原 id（upsert 幂等）
    const again = upsertCandidatePool(ws, [
      {
        name: '候选公司A',
        city: '城市X',
        industry: ['机器人'],
        signals: [],
        fitStars: 3,
        source: 'https://report.example/2',
      },
    ])
    assert.equal(again[0]!.id, priorId)
    assert.equal(again[0]!.fitStars, 3)

    // 非法输入 fail fast
    assert.throws(() => upsertCandidatePool(ws, [{ name: '', city: '城市X', industry: [], signals: [], fitStars: 1, source: '' }]), /name 非空/)
    assert.throws(() => upsertCandidatePool(ws, [{ name: '候选公司B', city: '城市X', industry: [], signals: [], fitStars: 0, source: '' }]), /fitStars/)
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('scanCandidatePool：目录扫描 + 稳定排序；无目录 → 空数组', () => {
  const ws = setup()
  try {
    assert.deepEqual(scanCandidatePool(ws), [])
    upsertCandidatePool(ws, [
      { name: '候选公司B', city: '城市Y', industry: ['自动化'], signals: [], fitStars: 2, source: '-' },
      { name: '候选公司A', city: '城市X', industry: ['医疗器械'], signals: [], fitStars: 4, source: '-' },
    ])
    const scanned = scanCandidatePool(ws)
    assert.deepEqual(scanned.map((p) => p.record.name), ['候选公司A', '候选公司B']) // 按文件名排序
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})
