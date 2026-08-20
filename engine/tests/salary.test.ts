import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateBenchmarks,
  benchmarkGroupKey,
  buildSalaryValuationCard,
  buildValuationReason,
  computeVerdict,
  computeWorkYears,
  expTierLabel,
  mapExpTier,
  parseExpTier,
  parseSalaryRangeK,
} from '../ir/salary.ts'
import type { PersonSnapshot, SalaryBenchmarkEntry } from '../ir/schema.ts'

/** 契约 §7.3 规则模块（二期）：分位聚合 / 档位映射 / 三态估价——全部确定性，手算核对。 */

function entry(partial: Partial<SalaryBenchmarkEntry> & { role: string; city: string; expTier: SalaryBenchmarkEntry['expTier']; source: string }): SalaryBenchmarkEntry {
  return { id: 'benchmark_20260801_001', capturedAt: '2026-08-01', expiresAt: '2026-10-30', ...partial }
}

test('parseExpTier：中文标签/枚举归一；非法 → null（该条标缺不登记）', () => {
  assert.equal(parseExpTier('3-5'), '3-5')
  assert.equal(parseExpTier('3-5年'), '3-5')
  assert.equal(parseExpTier('10+年'), '10+')
  assert.equal(parseExpTier('不限'), 'any')
  assert.equal(parseExpTier('不限经验'), 'any')
  assert.equal(parseExpTier('any'), 'any')
  assert.equal(parseExpTier('乱写'), null)
  assert.equal(parseExpTier(''), null)
  assert.equal(expTierLabel('3-5'), '3-5年')
  assert.equal(expTierLabel('any'), '不限')
})

test('computeWorkYears：最早 start 到最晚 end 的跨度（end 缺失视为至今）；无经历/无 start → null', () => {
  assert.equal(computeWorkYears(undefined), null)
  assert.equal(computeWorkYears([]), null)
  // 2021-07-01 → 2024-06-30 = 3 年（差 1 天，四舍五入 3.0）
  assert.equal(
    computeWorkYears([{ company: '公司A', start: '2021-07-01', end: '2024-06-30', status: 'confirmed' }]),
    3,
  )
  // 两条经历重叠：2020-01-01~2021-01-01 与 2021-06-01~2023-01-01 → 跨度 3 年（不重复计重叠）
  assert.equal(
    computeWorkYears([
      { company: '公司A', start: '2020-01-01', end: '2021-01-01', status: 'confirmed' },
      { company: '公司B', start: '2021-06-01', end: '2023-01-01', status: 'confirmed' },
    ]),
    3,
  )
  // 无 start 的条目跳过；有 start 无 end 的至今 → 非 null
  assert.equal(computeWorkYears([{ company: '公司A', status: 'confirmed' }]), null)
  assert.ok((computeWorkYears([{ company: '公司A', start: '2020-01-01', status: 'confirmed' }]) ?? 0) >= 6)
})

test('mapExpTier：边界 <3/<6/<11/≥11（确定性分档）', () => {
  assert.equal(mapExpTier(0), '0-2')
  assert.equal(mapExpTier(2.9), '0-2')
  assert.equal(mapExpTier(3), '3-5')
  assert.equal(mapExpTier(5.9), '3-5')
  assert.equal(mapExpTier(6), '6-10')
  assert.equal(mapExpTier(10.9), '6-10')
  assert.equal(mapExpTier(11), '10+')
})

test('parseSalaryRangeK：「11-13K」「11K」「13-11」→ 区间；「11-13K/月」剥单位；非法 → null', () => {
  assert.deepEqual(parseSalaryRangeK('11-13K'), { min: 11, max: 13 })
  assert.deepEqual(parseSalaryRangeK('11-13K/月'), { min: 11, max: 13 }) // 画像真实格式（preference_constraints）
  assert.deepEqual(parseSalaryRangeK('9-13K·13薪'), { min: 9, max: 13 }) // JD 真实格式（jobs 摘要表）
  assert.deepEqual(parseSalaryRangeK('8-15k·15薪'), { min: 8, max: 15 }) // 小写 k + 薪后缀
  assert.deepEqual(parseSalaryRangeK('12K/月'), { min: 12, max: 12 })
  assert.deepEqual(parseSalaryRangeK('11k'), { min: 11, max: 11 })
  assert.deepEqual(parseSalaryRangeK('11 - 13'), { min: 11, max: 13 })
  assert.deepEqual(parseSalaryRangeK('13-11'), { min: 11, max: 13 }) // 乱序归一
  assert.equal(parseSalaryRangeK('面议'), null)
  assert.equal(parseSalaryRangeK(''), null)
  assert.equal(parseSalaryRangeK('0-13'), null) // 非法值不兜底
  assert.equal(parseSalaryRangeK('15-25w'), null) // 年薪口径不在此解析（Agent 换算月薪后登记）
})

test('aggregateBenchmarks：加权最近秩分位（手算核对）+ 样本和 + 过期标记', () => {
  const entries = [
    entry({ role: '岗位X', city: '城市A', expTier: '3-5', salary: 8, source: 'https://s/1' }),
    entry({ role: '岗位X', city: '城市A', expTier: '3-5', salary: 10, source: 'https://s/2' }),
    entry({ role: '岗位X', city: '城市A', expTier: '3-5', salary: 12, sampleN: 3, source: 'https://s/3' }),
  ]
  const [stats] = aggregateBenchmarks(entries, '2026-08-15')
  assert.ok(stats)
  // 排序后 [8(w1),10(w1),12(w3)]，N=5：P25=ceil(1.25)=2 → 10；P50=ceil(2.5)=3 → 12；P75=ceil(3.75)=4 → 12
  assert.equal(stats.p25, 10)
  assert.equal(stats.p50, 12)
  assert.equal(stats.p75, 12)
  assert.equal(stats.sampleN, 5)
  assert.equal(stats.stale, false) // 2026-10-30 过期 < 2026-08-15 今日？否 → 未过期
  assert.deepEqual(stats.sources, ['https://s/1', 'https://s/2', 'https://s/3'])
  assert.equal(stats.latestCapturedAt, '2026-08-01')

  // 过期：now 推到过期日之后 → stale
  const stale = aggregateBenchmarks(entries, '2027-01-01')[0]!
  assert.equal(stale.stale, true)

  // 区间中点参与聚合：{10-14} 中点 12；手算 N=4 [8(w1),10(w1),12(w2)] → P25=1st=8，P50=2nd=10，P75=3rd=12
  const ranged = [
    entry({ role: '岗位X', city: '城市A', expTier: '3-5', salary: 8, source: 'https://s/1' }),
    entry({ role: '岗位X', city: '城市A', expTier: '3-5', salary: 10, source: 'https://s/2' }),
    entry({ role: '岗位X', city: '城市A', expTier: '3-5', salaryRange: { min: 10, max: 14 }, sampleN: 2, source: 'https://s/3' }),
  ]
  const rs = aggregateBenchmarks(ranged, '2026-08-15')[0]!
  assert.equal(rs.p25, 8)
  assert.equal(rs.p50, 10)
  assert.equal(rs.p75, 12)
  assert.equal(rs.sampleN, 4)

  // 分组隔离：不同档位/城市各成一组
  const mixed = [
    ...entries,
    entry({ role: '岗位X', city: '城市A', expTier: '0-2', salary: 5, source: 'https://s/4' }),
  ]
  assert.equal(aggregateBenchmarks(mixed, '2026-08-15').length, 2)
})

test('computeVerdict：三态判定（各 ≥1 例手算核对，边界不误判）', () => {
  const band = { role: '岗位X', city: '城市A', expTier: '3-5' as const, p25: 9, p50: 12, p75: 14, sampleN: 30, stale: false, sources: [], latestCapturedAt: '2026-08-01' }
  assert.equal(computeVerdict({ min: 11, max: 13 }, band), '合理') // 与市场带重叠
  assert.equal(computeVerdict({ min: 6, max: 8 }, band), '偏低') // E2=8 < P25=9
  assert.equal(computeVerdict({ min: 15, max: 18 }, band), '偏高') // E1=15 > P75=14
  assert.equal(computeVerdict({ min: 9, max: 9 }, band), '合理') // E2=9 不小于 9
  assert.equal(computeVerdict({ min: 14, max: 14 }, band), '合理') // E1=14 不大于 14
})

test('buildValuationReason：一句话依据模板（城市/岗位/档位/P50/样本/日期/结论短语）', () => {
  const band = { role: '岗位X', city: '城市A', expTier: '3-5' as const, p25: 9, p50: 12, p75: 14, sampleN: 30, stale: false, sources: [], latestCapturedAt: '2026-08-01' }
  const reason = buildValuationReason('合理', { min: 11, max: 13 }, band)
  assert.match(reason, /你的期望 11-13K 落在 城市A·岗位X·3-5年 市场带 9-14K/)
  assert.match(reason, /P50 12K，样本 30，2026-08-01/)
  assert.match(reason, /与市场中枢一致/)
})

function person(overrides: Partial<PersonSnapshot>): PersonSnapshot {
  return {
    personId: 'person_test',
    name: '测试',
    status: 'active',
    manifestPath: 'persons/person_test/manifest.md',
    eventCount: 0,
    careerProfile: { currentRole: '岗位X' },
    preference: { city: '城市A', salaryRange: '11-13K' },
    experiences: [{ company: '公司A', start: '2023-01-01', end: '2026-01-01', status: 'confirmed' }],
    ...overrides,
  }
}

test('buildSalaryValuationCard：全状态分支显式（三态结论 / 档位未知 / 无基准 / 无期望）', () => {
  const entries = [
    entry({ role: '岗位X', city: '城市A', expTier: '3-5', salary: 10, sampleN: 20, source: 'https://s/1' }),
    entry({ role: '岗位X', city: '城市A', expTier: '3-5', salary: 14, sampleN: 20, source: 'https://s/2' }),
  ]
  // 完整链路：画像（岗位/城市/经历 3 年→3-5 档/期望 11-13K）+ 基准 → 三态 + 依据
  const full = buildSalaryValuationCard(person({}), entries)
  assert.equal(full.role, '岗位X')
  assert.equal(full.city, '城市A')
  assert.equal(full.tier, '3-5')
  assert.deepEqual(full.expectation, { min: 11, max: 13 })
  assert.ok(full.stats)
  assert.equal(full.stats.p50, 10) // [10(w20),14(w20)] N=40 → P50=ceil(20)=20 → 第一个样本 10
  assert.equal(full.verdict, '合理')
  assert.ok(full.reason)

  // 档位未知（无经历）→ stats/verdict/reason 全 null（无三态结论，§7.5）
  const noTier = buildSalaryValuationCard(person({ experiences: undefined }), entries)
  assert.equal(noTier.tier, null)
  assert.equal(noTier.stats, null)
  assert.equal(noTier.verdict, null)

  // 无基准（该组无条目）→ stats null
  const noBench = buildSalaryValuationCard(person({}), [])
  assert.equal(noBench.stats, null)
  assert.equal(noBench.verdict, null)

  // 无期望（salaryRange 缺）→ verdict null（stats 照给）
  const noExp = buildSalaryValuationCard(person({ preference: { city: '城市A' } }), entries)
  assert.ok(noExp.stats)
  assert.equal(noExp.verdict, null)

  // Person 形输入（无 careerProfile，顶层 targetRoles）→ 岗位解析兜住（引擎投影 store 是 Person 形）
  const personShaped = buildSalaryValuationCard(
    { targetRoles: ['岗位X'], preference: { city: '城市A', salaryRange: '11-13K' }, experiences: [{ company: '公司A', start: '2023-01-01', end: '2026-01-01', status: 'confirmed' }] },
    entries,
  )
  assert.equal(personShaped.role, '岗位X')
  assert.equal(personShaped.tier, '3-5')
  assert.equal(personShaped.verdict, '合理')
})

test('benchmarkGroupKey：role+city+tier 三元组唯一键', () => {
  assert.notEqual(benchmarkGroupKey('岗位X', '城市A', '3-5'), benchmarkGroupKey('岗位X', '城市A', '0-2'))
  assert.notEqual(benchmarkGroupKey('岗位X', '城市A', '3-5'), benchmarkGroupKey('岗位X', '城市B', '3-5'))
  assert.equal(benchmarkGroupKey('岗位X', '城市A', '3-5'), benchmarkGroupKey('岗位X', '城市A', '3-5'))
})
