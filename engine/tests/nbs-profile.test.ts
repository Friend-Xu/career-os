/**
 * NBS 区域经济画像（Phase 3C）测试：
 * 矩阵组装（分组批量/单元格状态/覆盖）、行归属防串行、会话治理（预算=API请求/缓存/隐私）、
 * 工具元数据、T1 认知面隔离、canonical 回显（含复合地名文档化语义）。
 * 测试注入：fake ProfileConnector（窄接口）——不 mock fetch、不真连。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findRegion, findRegionCode, regionLevelLabel } from '../agent/tools/nbs/regions.ts'
import { URBAN_ECONOMY_V1 } from '../agent/tools/nbs/profile.ts'
import type { ResolveResult } from '../agent/tools/nbs/resolver.ts'
import type { ProfileConnector, ProfileRows } from '../agent/tools/nbs/profile.ts'
import {
  buildNbsProfileTools,
  createNbsProfileSession,
  NBS_PROFILE_SESSION_MAX_REQUESTS,
  NBS_PROFILE_TOOL_META,
  NbsPolicyError,
} from '../agent/tools/nbs/index.ts'
import { KNOWN_TOOL_NAMES } from '../agent/tools/tool-assembly.ts'

/** 测试指标（与 URBAN_ECONOMY_V1 的 4 条对应；GDP/人均同分类 c1——分组批量场景） */
const IND = {
  gdp: { indicatorId: 'g1', catalogId: 'c1', name: '国内生产总值', path: '国民经济核算 > 国内生产总值', confidence: 0.95 },
  pgdp: { indicatorId: 'g2', catalogId: 'c1', name: '人均国内生产总值', path: '国民经济核算 > 国内生产总值', confidence: 0.95 },
  ind: { indicatorId: 'g3', catalogId: 'c2', name: '工业增加值', path: '国民经济核算 > 分行业增加值', confidence: 1 },
  income: { indicatorId: 'g4', catalogId: 'c3', name: '居民人均可支配收入', path: '人民生活 > 全国居民人均收入情况', confidence: 1 },
}
const resolved = (i: (typeof IND)[keyof typeof IND]): ResolveResult => ({ kind: 'resolved', indicator: { ...i } })

const row = (indicatorName: string, year: string, value: string, unit: string): ProfileRows => ({
  indicatorName,
  year,
  value,
  unit,
})

interface FakeProfile {
  connector: ProfileConnector
  batchCalls: Array<{ indicatorIds: string[]; regionName: string }>
  resolveCalls: string[]
}

/** fake 连接器：resolves 按关键词返回（缺省 miss）；rowsByIndicatorId 批量返回；单一解析名可注入 */
function fakeProfile(opts: {
  resolves?: Record<string, ResolveResult>
  rowsByIndicatorId?: Record<string, ProfileRows[]>
}): FakeProfile {
  const batchCalls: FakeProfile['batchCalls'] = []
  const resolveCalls: string[] = []
  return {
    batchCalls,
    resolveCalls,
    connector: {
      async resolveIndicator(keyword) {
        resolveCalls.push(keyword)
        return opts.resolves?.[keyword] ?? { kind: 'miss' }
      },
      async querySeriesBatch(q) {
        batchCalls.push({ indicatorIds: q.indicatorIds, regionName: q.regionName })
        const out: ProfileRows[] = []
        for (const id of q.indicatorIds) out.push(...(opts.rowsByIndicatorId?.[id] ?? []))
        return out
      },
    },
  }
}

const ALL_RESOLVES: Record<string, ResolveResult> = {
  'GDP': resolved(IND.gdp),
  '人均GDP': resolved(IND.pgdp),
  '工业增加值': resolved(IND.ind),
  '居民人均可支配收入': resolved(IND.income),
}

function happyRows(): Record<string, ProfileRows[]> {
  return {
    g1: [row('国内生产总值 (亿元)', '2024年', '24653.4', '亿元'), row('国内生产总值 (亿元)', '2023年', '23500.2', '亿元')],
    g2: [row('人均国内生产总值 (元)', '2024年', '120000', '元')],
    g3: [row('规模以上工业增加值 (亿元)', '2024年', '49299.5', '亿元')],
    g4: [row('居民人均可支配收入 (元)', '2024年', '57971', '元')],
  }
}

// ─── 矩阵组装（纯逻辑层，经会话执行）───────────────────────────────────────

test('分组批量：同分类指标一次 esData（GDP+人均同一 cid → 每区域 3 次请求）', async () => {
  const f = fakeProfile({ resolves: ALL_RESOLVES, rowsByIndicatorId: happyRows() })
  const session = createNbsProfileSession({ connector: f.connector, budget: 12, cacheTtlMs: 0, throttleMs: 0 })
  const out = await session.execute(['苏州'])
  assert.equal(f.batchCalls.length, 3, 'c1(2指标)+c2+c3 = 3 次 esData')
  assert.deepEqual(f.batchCalls[0].indicatorIds, ['g1', 'g2'], '同分类聚合批量')
  assert.ok(out.includes('苏州'), 'canonical 名回显')
  assert.ok(out.includes('地级市'), '级别回显')
  assert.ok(out.includes('24653.4 亿元'), 'GDP 值')
})

test('行归属防串行：人均行归人均单元格（不因含「国内生产总值」归 GDP）', async () => {
  const f = fakeProfile({ resolves: ALL_RESOLVES, rowsByIndicatorId: happyRows() })
  const session = createNbsProfileSession({ connector: f.connector, budget: 12, cacheTtlMs: 0, throttleMs: 0 })
  const out = await session.execute(['苏州'])
  const gdpLine = out.split('\n').find((l) => l.startsWith('- GDP（')) ?? ''
  const pgdpLine = out.split('\n').find((l) => l.startsWith('- 人均GDP（')) ?? ''
  assert.ok(gdpLine.includes('24653.4'), 'GDP 行只带 GDP 值')
  assert.ok(!gdpLine.includes('120000'), 'GDP 行不得混入人均值')
  assert.ok(pgdpLine.includes('120000'), '人均行带人均值')
})

test('诚实覆盖：no_data 单元格不补值 + coverage 计算（available 计入 ambiguity 不含）', async () => {
  const rows = happyRows()
  delete rows.g2 // 人均无数据（空响应）
  const f = fakeProfile({ resolves: ALL_RESOLVES, rowsByIndicatorId: rows })
  const session = createNbsProfileSession({ connector: f.connector, budget: 12, cacheTtlMs: 0, throttleMs: 0 })
  const out = await session.execute(['苏州'])
  assert.ok(out.includes('人均GDP：无此口径数据'), 'no_data 诚实呈现（不补数）')
  assert.ok(out.includes('覆盖：3/4 指标可用'), '覆盖率工具计算')
  assert.ok(out.includes('矩阵总覆盖：3/4 指标可用'), '矩阵级覆盖汇总')
})

test('歧义单元格：candidates → 不查询不静默选（该指标无外部请求）', async () => {
  const f = fakeProfile({
    resolves: {
      ...ALL_RESOLVES,
      '工业增加值': {
        kind: 'candidates',
        options: [
          { indicatorId: 'x1', catalogId: 'c9', name: '工业产品产量', path: '工业 > 产品产量', confidence: 0.7 },
          { indicatorId: 'x2', catalogId: 'c9', name: '工业销售产值', path: '工业 > 销售产值', confidence: 0.5 },
        ],
      },
    },
    rowsByIndicatorId: happyRows(),
  })
  const session = createNbsProfileSession({ connector: f.connector, budget: 12, cacheTtlMs: 0, throttleMs: 0 })
  const out = await session.execute(['苏州'])
  assert.ok(out.includes('歧义未选'), '歧义显式化')
  assert.ok(out.includes('indicatorId'), '候选带 id')
  assert.ok(!f.batchCalls.some((c) => c.indicatorIds.includes('g3')), '歧义指标不发外部查询')
})

test('未识别地区：error 行 + 不参与覆盖；指标 miss → not_supported 单元格', async () => {
  const f = fakeProfile({ resolves: { 'GDP': resolved(IND.gdp) }, rowsByIndicatorId: happyRows() })
  const session = createNbsProfileSession({ connector: f.connector, budget: 12, cacheTtlMs: 0, throttleMs: 0 })
  const out = await session.execute(['火星', '苏州'])
  assert.ok(out.includes('未识别地区「火星」'), '未识别诚实报错')
  assert.ok(out.includes('未匹配到统计指标'), 'miss → not_supported（不猜指标）')
  assert.equal(f.batchCalls.length, 1, '只有苏州的 GDP 分组发起外部请求')
})

test('单组失败容忍：一个分类请求失败 → 该组单元格 error，其余不受影响', async () => {
  const connector: ProfileConnector = {
    async resolveIndicator(kw) {
      return ALL_RESOLVES[kw] ?? { kind: 'miss' }
    },
    async querySeriesBatch(q) {
      if (q.indicatorIds.includes('g3')) throw new Error('WAF 挑战页')
      const out: ProfileRows[] = []
      for (const id of q.indicatorIds) out.push(...happyRows()[id])
      return out
    },
  }
  const session = createNbsProfileSession({ connector, budget: 12, cacheTtlMs: 0, throttleMs: 0 })
  const out = await session.execute(['苏州'])
  assert.ok(out.includes('工业增加值：查询失败'), '失败单元格诚实呈现')
  assert.ok(out.includes('WAF 挑战页'), '原因文本带出')
  assert.ok(out.includes('24653.4'), '无失败单元格数据保留')
})

// ─── 会话治理（预算/缓存/隐私）──────────────────────────────────────────────

test('预算 = API 请求口径：本地校验不消耗；批量请求消耗；耗尽 → budget_exhausted（重抛不吞）', async () => {
  const f = fakeProfile({ resolves: ALL_RESOLVES, rowsByIndicatorId: happyRows() })
  const session = createNbsProfileSession({ connector: f.connector, budget: 2, cacheTtlMs: 0, throttleMs: 0 })
  await assert.rejects(() => session.execute(['苏州', '上海']), (err: unknown) => {
    assert.ok(err instanceof NbsPolicyError)
    assert.equal((err as NbsPolicyError).code, 'budget_exhausted')
    return true
  })
  assert.equal(f.batchCalls.length, 2, '恰好消耗 2 次后拒绝第 3 次')
})

test('预算注入缺口：预算 0 → fail fast', () => {
  assert.throws(
    () => createNbsProfileSession({ connector: fakeProfile({}).connector, budget: 0, cacheTtlMs: 0 }),
    /budget 应为正整数/,
  )
})

test('缓存：同参数命中不重复外发 + 提示；不同 regions 不串扰', async () => {
  const f = fakeProfile({ resolves: ALL_RESOLVES, rowsByIndicatorId: happyRows() })
  const session = createNbsProfileSession({ connector: f.connector, budget: 12, cacheTtlMs: 60_000, throttleMs: 0 })
  const first = await session.execute(['苏州'])
  const second = await session.execute(['苏州'])
  assert.ok(second.includes('统计缓存'), '缓存命中提示')
  assert.equal(f.batchCalls.length, 3, '命中后不再外发')
  assert.ok(first.includes('24653.4'))
  const other = await session.execute(['上海', '苏州'])
  assert.ok(other.includes('上海市') && other.includes('苏州市'), '不同 regions key 独立（新查询）')
})

test('隐私红线：regions 含手机号 → privacy 拒绝（不外发）', async () => {
  const f = fakeProfile({ resolves: ALL_RESOLVES, rowsByIndicatorId: happyRows() })
  const session = createNbsProfileSession({ connector: f.connector, budget: 12, cacheTtlMs: 0, throttleMs: 0 })
  const phone = '13' + '812345678' // 拼接构造（合成号码；对齐既有测试惯例）
  await assert.rejects(() => session.execute(['苏州', `联系${phone}`]), (err: unknown) => {
    assert.ok(err instanceof NbsPolicyError)
    assert.equal((err as NbsPolicyError).code, 'privacy')
    return true
  })
  assert.equal(f.batchCalls.length, 0, '拒绝后不外发')
})

// ─── 工具包装与元数据 ─────────────────────────────────────────────────────

test('T1 认知面隔离：CompareRegionProfiles 描述无协议/供应商标识，有权威定位', () => {
  const session = createNbsProfileSession({ connector: fakeProfile({}).connector, budget: 12, cacheTtlMs: 0 })
  const tools = buildNbsProfileTools(session)
  const t = tools.CompareRegionProfiles
  assert.ok(t !== undefined)
  const desc = String(t.description)
  assert.ok(!/easyquery|esData|nbs|exa|mcp/i.test(desc), '描述无协议/供应商标识（T1）')
  assert.ok(desc.includes('权威统计'), '权威定位')
})

test('工具错误语义：空 regions → 错误文本；预算耗尽 → 策略文本（不抛穿）', async () => {
  const session = createNbsProfileSession({ connector: fakeProfile({}).connector, budget: 12, cacheTtlMs: 0 })
  const tools = buildNbsProfileTools(session)
  const exec = tools.CompareRegionProfiles.execute
  assert.ok(exec !== undefined)
  const empty = await exec({ regions: [] }, { toolCallId: 'x', messages: [] } as never)
  assert.ok(typeof empty === 'string' && empty.includes('至少需要 1 个地区'))
  // 预算 1：第一组批量消耗后第二次触发 → 策略错误 → 工具层转文本（单元格容错不吞策略错误）
  const f = fakeProfile({ resolves: ALL_RESOLVES, rowsByIndicatorId: happyRows() })
  const tight = createNbsProfileSession({ connector: f.connector, budget: 1, cacheTtlMs: 0, throttleMs: 0 })
  const tightTools = buildNbsProfileTools(tight)
  const tightExec = tightTools.CompareRegionProfiles.execute
  assert.ok(tightExec !== undefined)
  const out = await tightExec({ regions: ['苏州'] }, { toolCallId: 'x', messages: [] } as never)
  assert.ok(typeof out === 'string' && out.startsWith('CompareRegionProfiles 已停用'), `应返回策略文本，实际 ${out}`)
})

test('治理元数据保真：NBS_PROFILE_TOOL_META = data 源 / external / 预算 12 / trace nbs_profile / provider nbs', () => {
  assert.deepEqual(NBS_PROFILE_TOOL_META.CompareRegionProfiles, {
    source: 'data',
    egress: 'external',
    budget: NBS_PROFILE_SESSION_MAX_REQUESTS,
    traceScope: 'nbs_profile',
    provider: 'nbs',
  })
})

test('KNOWN_TOOL_NAMES 含 CompareRegionProfiles（装配注册表同步）', () => {
  assert.ok(KNOWN_TOOL_NAMES.includes('CompareRegionProfiles'))
  assert.equal(KNOWN_TOOL_NAMES.length, 10)
})

// ─── 地区解析（canonical + 复合地名文档化语义）─────────────────────────────

test('findRegion：canonical 名/级别回显；复合地名现行语义 = 命中省级（文档化）', () => {
  const sz = findRegion('苏州')
  assert.equal(sz?.name, '苏州市')
  assert.equal(sz?.level, 'city')
  assert.equal(findRegionCode('苏州'), sz?.code)
  const comp = findRegion('江苏苏州')
  assert.equal(comp?.name, '江苏省', '复合地名按现行包含语义先命中省级（错位由 canonical 回显暴露）')
  assert.equal(regionLevelLabel('city'), '地级市')
  assert.equal(regionLevelLabel('province'), '省级')
  assert.equal(regionLevelLabel('nation'), '全国')
})

test('画像定义：urban_economy_v1 含 4 指标（GDP/人均GDP/工业增加值/居民收入——curator 真机验证集）', () => {
  assert.equal(URBAN_ECONOMY_V1.id, 'urban_economy_v1')
  assert.deepEqual(
    URBAN_ECONOMY_V1.indicators.map((i) => i.keyword),
    ['GDP', '人均GDP', '工业增加值', '居民人均可支配收入'],
  )
})
