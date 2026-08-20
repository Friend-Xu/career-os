import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { parseSalaryBenchmarksMarkdown, scanSalaryBenchmarks, upsertSalaryBenchmarks } from '../storage/salary-benchmarks.ts'

function setup(): ReturnType<typeof initWorkspace> {
  return initWorkspace(mkdtempSync(join(tmpdir(), 'cos-salary-')))
}

const BENCH_MD = `# 薪资基准：城市A · 岗位X · 3-5年

> 口径：月薪 K（税前）；年薪来源已换算并在备注留原始口径。

## 薪资基准

| 来源 | 薪资(K) | 区间(K) | 样本 | 备注 | 抓取日期 |
|------|---------|---------|------|------|----------|
| https://s/1 | 10 | - | 20 | - | 2026-08-01 |
| https://s/2 | - | 12-16 | - | 报告口径 | 2026-08-02 |
`

test('解析基准表：表头定组 + 行 → 条目（id/expiresAt 派生，90 天过期；档位中文标签归一）', () => {
  const { entries, validation } = parseSalaryBenchmarksMarkdown(BENCH_MD, '薪资基准-城市A-岗位X-3-5年.md')
  assert.equal(validation, undefined)
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.id, 'benchmark_20260801_001')
  assert.equal(entries[0]!.role, '岗位X')
  assert.equal(entries[0]!.city, '城市A')
  assert.equal(entries[0]!.expTier, '3-5')
  assert.equal(entries[0]!.salary, 10)
  assert.equal(entries[0]!.sampleN, 20)
  assert.equal(entries[0]!.source, 'https://s/1')
  assert.equal(entries[0]!.expiresAt, '2026-10-30') // +90 天
  assert.deepEqual(entries[1]!.salaryRange, { min: 12, max: 16 })
  assert.equal(entries[1]!.salary, undefined)
  assert.equal(entries[1]!.sampleN, undefined)
  assert.equal(entries[1]!.note, '报告口径')
})

test('行级校验：来源/薪资/日期缺失或数值非法 → 跳过 + degraded warn', () => {
  const md = BENCH_MD
    .replace('| https://s/2 | - | 12-16 | - | 报告口径 | 2026-08-02 |\n', '| - | 10 | - | - | - | 2026-08-02 |\n')
    .replace('| https://s/1 | 10 | - | 20 | - | 2026-08-01 |', '| https://s/1 | - | - | - | - | 2026-08-01 |')
  const { entries, validation } = parseSalaryBenchmarksMarkdown(md, '薪资基准-城市A-岗位X-3-5年.md')
  assert.equal(validation?.status, 'degraded')
  assert.equal(entries.length, 0) // 两行均缺失必填 → 跳过
})

test('表头缺失/档位非法 → 文件跳过 + degraded warn', () => {
  const noHeader = parseSalaryBenchmarksMarkdown('## 薪资基准\n\n| 来源 | 薪资(K) | 区间(K) | 样本 | 备注 | 抓取日期 |\n', '薪资基准-城市A-岗位X-3-5年.md')
  assert.equal(noHeader.entries.length, 0)
  assert.equal(noHeader.validation?.status, 'degraded')

  const badTier = parseSalaryBenchmarksMarkdown('# 薪资基准：城市A · 岗位X · 5-8年\n', '薪资基准-城市A-岗位X-5-8年.md')
  assert.equal(badTier.entries.length, 0)
  assert.equal(badTier.validation?.status, 'degraded')
})

test('upsertSalaryBenchmarks：一次一组 + 全量覆盖（刷新语义）；非法输入 fail fast', () => {
  const ws = setup()
  try {
    const out = upsertSalaryBenchmarks(ws, [
      { role: '岗位X', city: '城市A', expTier: '3-5年', salary: 10, sampleN: 20, source: 'https://s/1' },
      { role: '岗位X', city: '城市A', expTier: '3-5', salaryRange: { min: 12, max: 16 }, source: 'https://s/2', note: '报告口径' },
    ])
    assert.equal(out.length, 2)
    assert.match(out[0]!.id, /^benchmark_\d{8}_\d{3}$/)
    assert.equal(out[0]!.expTier, '3-5')
    assert.ok(ws.exists('knowledge/薪资基准-城市A-岗位X-3-5年.md'))

    // 全量覆盖：第二次只写 1 条 → 文件只剩 1 条
    const again = upsertSalaryBenchmarks(ws, [{ role: '岗位X', city: '城市A', expTier: '3-5', salary: 9, source: 'https://s/3' }])
    assert.equal(again.length, 1)
    assert.equal(scanSalaryBenchmarks(ws).length, 1)

    assert.throws(() => upsertSalaryBenchmarks(ws, []), /entries 非空数组/)
    assert.throws(() => upsertSalaryBenchmarks(ws, [{ role: ' ', city: '城市A', expTier: '3-5', salary: 10, source: 'https://s' }]), /role 非空/)
    assert.throws(() => upsertSalaryBenchmarks(ws, [{ role: '岗位X', city: '城市A', expTier: '5-8', salary: 10, source: 'https://s' }]), /档位非法值/)
    assert.throws(() => upsertSalaryBenchmarks(ws, [{ role: '岗位X', city: '城市A', expTier: '3-5', source: 'https://s' }]), /至少其一/)
    assert.throws(() => upsertSalaryBenchmarks(ws, [{ role: '岗位X', city: '城市A', expTier: '3-5', salary: -1, source: 'https://s' }]), /salary 非法值/)
    assert.throws(() => upsertSalaryBenchmarks(ws, [{ role: '岗位X', city: '城市A', expTier: '3-5', salaryRange: { min: 15, max: 10 }, source: 'https://s' }]), /salaryRange 非法/)
    assert.throws(() => upsertSalaryBenchmarks(ws, [{ role: '岗位X', city: '城市A', expTier: '3-5', salary: 10, sampleN: 0, source: 'https://s' }]), /sampleN 非法值/)
    // 跨组混批 → fail fast（一次调用一组）
    assert.throws(
      () => upsertSalaryBenchmarks(ws, [
        { role: '岗位X', city: '城市A', expTier: '3-5', salary: 10, source: 'https://s/1' },
        { role: '岗位X', city: '城市B', expTier: '3-5', salary: 11, source: 'https://s/2' },
      ]),
      /一次调用一组/,
    )
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('scanSalaryBenchmarks：knowledge/ 前缀过滤（资质名单不混入）+ 稳定排序；无文件 → 空数组', () => {
  const ws = setup()
  try {
    assert.deepEqual(scanSalaryBenchmarks(ws), [])
    // 非基准文件不混入
    ws.write('knowledge/资质名单-城市A-2026.md', '# 资质名单：城市A（2026）\n\n| 公司 | 城市 | 资质类型 | 公示来源链接 | 批次年份 |\n|------|------|---------|-------------|---------|\n')
    assert.deepEqual(scanSalaryBenchmarks(ws), [])
    upsertSalaryBenchmarks(ws, [{ role: '岗位B', city: '城市B', expTier: '0-2', salary: 6, source: 'https://b' }])
    upsertSalaryBenchmarks(ws, [{ role: '岗位A', city: '城市A', expTier: '3-5', salary: 10, source: 'https://a' }])
    const all = scanSalaryBenchmarks(ws)
    assert.deepEqual(all.map((e) => e.role), ['岗位A', '岗位B']) // 按文件名排序
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})
