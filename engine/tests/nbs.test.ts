/**
 * NBS 数据能力（Tool Runtime 第二阶段 P3）测试：
 * 地区解析、指标索引、连接器（幂等/fail-safe）、会话治理（预算/缓存/隐私）、
 * 认知面隔离（T1）、来源标注。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '../logger.ts'
import { initWorkspace } from '../storage/workspace.ts'
import { buildToolSources, type AgentDefaults } from '../runtime/agent-runtime.ts'
import { findRegionCode } from '../agent/tools/nbs/regions.ts'
import { searchIndicator, type NbsIndicatorIndex } from '../agent/tools/nbs/api.ts'
import type { ResolverTreeDeps } from '../agent/tools/nbs/resolver.ts'
import {
  buildNbsTools,
  createNbsSession,
  NBS_SESSION_BUDGET,
  NBS_TOOL_META,
  NbsConnector,
  NbsPolicyError,
} from '../agent/tools/nbs/index.ts'

const fakeLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} }

// ─── 地区解析（国标区划码）─────────────────────────────────────────────────

test('findRegionCode：全名/短名/直辖市/城市/全国；未知 → undefined', () => {
  assert.equal(findRegionCode('苏州'), '320500000000')
  assert.equal(findRegionCode('苏州市'), '320500000000')
  assert.equal(findRegionCode('江苏'), '320000000000')
  assert.equal(findRegionCode('上海'), '310000000000')
  assert.equal(findRegionCode('全国'), '000000000000')
  assert.equal(findRegionCode(''), undefined)
  assert.equal(findRegionCode('不存在的城市'), undefined)
})

// ─── 指标索引搜索（纯函数）─────────────────────────────────────────────────

const idx: NbsIndicatorIndex = {
  entries: [
    { name: '规模以上工业增加值', id: 'a1', cid: 'c1' },
    { name: '地区生产总值', id: 'a2', cid: 'c1' },
  ],
  builtAt: Date.now(),
}

test('searchIndicator：包含匹配取第一个；空关键词/未命中 → undefined', () => {
  assert.deepEqual(searchIndicator(idx, '工业增加值'), { name: '规模以上工业增加值', id: 'a1', cid: 'c1' })
  assert.equal(searchIndicator(idx, 'GDP'), undefined)
  assert.equal(searchIndicator(idx, '  '), undefined)
})

// ─── NbsConnector：索引预热（幂等/fail-safe）+ 序列查询 ─────────────────────

test('NbsConnector.ensureIndex：幂等（并发共享一次预热）；失败 → null 不抛（fail-safe）', async () => {
  let builds = 0
  const c = new NbsConnector({
    logger: fakeLogger,
    indexBuilder: async () => {
      builds += 1
      return idx
    },
  })
  const [a, b] = await Promise.all([c.ensureIndex(), c.ensureIndex()])
  assert.equal(a, idx)
  assert.equal(b, idx)
  assert.equal(builds, 1, '并发只预热一次')

  const bad = new NbsConnector({
    logger: fakeLogger,
    indexBuilder: async () => {
      throw new Error('网络不可达')
    },
  })
  assert.equal(await bad.ensureIndex(), null, '失败返回 null 不抛')
})

test('NbsConnector.querySeries：esData 响应 → 年份序列（值/单位/指标名）', async () => {
  const body = {
    success: true,
    data: [
      {
        code: '2024YY',
        name: '2024年',
        values: [{ i_showname: '规模以上工业增加值 (亿元)', value: '40123.5', du_name: '亿元', da_name: '江苏' }],
      },
      { code: '2023YY', name: '2023年', values: [{ i_showname: '规模以上工业增加值 (亿元)', value: '38000', du_name: '亿元', da_name: '江苏' }] },
    ],
  }
  const calls: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push(String(url))
    assert.equal(init?.method, 'POST')
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  try {
    const c = new NbsConnector({ logger: fakeLogger, indexBuilder: async () => idx })
    const rows = await c.querySeries({
      cid: 'c1',
      indicatorId: 'a1',
      regionCode: '320000000000',
      regionName: '江苏',
      years: ['2021YY-2025YY'],
    })
    assert.equal(rows.length, 2)
    assert.deepEqual(rows[0], { year: '2024年', value: '40123.5', unit: '亿元', indicatorName: '规模以上工业增加值 (亿元)' })
    assert.ok(calls[0].includes('/stream/esData'), '打到 esData 端点')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ─── NbsSession：治理面（预算/缓存/隐私/输出格式）──────────────────────────

function makeConnector(treeDeps?: ResolverTreeDeps, http?: { timeoutMs?: number; retries?: number; retryBackoffMs?: number }): NbsConnector {
  // treeDeps 缺省 = 空树（单测不真连；curator 命中不依赖树）
  return new NbsConnector({
    logger: fakeLogger,
    indexBuilder: async () => idx,
    ...(http !== undefined ? { http } : {}),
    treeDeps:
      treeDeps ?? {
        topCategories: async () => [],
        childrenOf: async () => [],
        indicatorsOf: async () => [],
      },
  })
}

const SERIES_BODY = {
  success: true,
  data: [
    { code: '2024YY', name: '2024年', values: [{ i_showname: '规模以上工业增加值 (亿元)', value: '40123.5', du_name: '亿元', da_name: '江苏' }] },
  ],
}

test('会话全链：本地解析 → 外部查询 → 结构化输出（权威统计 + 指标路径 + 来源标注）', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify(SERIES_BODY), { status: 200 })) as typeof fetch
  try {
    const session = createNbsSession({ connector: makeConnector(), budget: 3, cacheTtlMs: 0 })
    const out = await session.execute({ indicator: '工业增加值', region: '江苏' })
    assert.ok(out.includes('【权威统计数据】'), '结构化块头')
    assert.ok(out.includes('规模以上工业增加值'), '指标名')
    assert.ok(out.includes('40123.5 亿元'), '数值+单位')
    assert.ok(out.includes('指标路径'), '证据可追溯（指标路径行）')
    assert.ok(out.includes('国家统计局'), '来源标注')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('预算（API 请求口径）：本地校验失败不消耗；外部查询消耗；耗尽 → budget_exhausted', async () => {
  let external = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    external += 1
    return new Response(JSON.stringify(SERIES_BODY), { status: 200 })
  }) as typeof fetch
  try {
    const session = createNbsSession({ connector: makeConnector(), budget: 1, cacheTtlMs: 0 })
    // 本地校验失败：不消耗预算
    const badRegion = await session.execute({ indicator: '工业增加值', region: '不存在城市' })
    assert.ok(badRegion.includes('未识别地区'))
    const badInd = await session.execute({ indicator: '不存在的指标', region: '江苏' })
    assert.ok(badInd.includes('未找到指标'))
    assert.equal(external, 0, '本地校验失败不发起外部查询')
    // 首次外部查询成功
    const ok = await session.execute({ indicator: '工业增加值', region: '江苏' })
    assert.ok(ok.includes('40123.5'))
    assert.equal(external, 1)
    // 预算耗尽
    await assert.rejects(() => session.execute({ indicator: '工业增加值', region: '江苏', year: '2023' }), (err: unknown) => {
      assert.ok(err instanceof NbsPolicyError)
      assert.equal((err as NbsPolicyError).code, 'budget_exhausted')
      return true
    })
    assert.equal(external, 1, '预算耗尽后不再外发')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('隐私红线：查询含手机号 → privacy 拒绝（不外发）', async () => {
  const realFetch = globalThis.fetch
  let external = 0
  globalThis.fetch = (async () => {
    external += 1
    return new Response(JSON.stringify(SERIES_BODY), { status: 200 })
  }) as typeof fetch
  try {
    const session = createNbsSession({ connector: makeConnector(), budget: 3, cacheTtlMs: 0 })
    const phone = '13' + '812345678' // 拼接构造（合成号码；对齐 web-search/exa 测试惯例）
    await assert.rejects(() => session.execute({ indicator: `联系 ${phone}`, region: '江苏' }), (err: unknown) => {
      assert.ok(err instanceof NbsPolicyError)
      assert.equal((err as NbsPolicyError).code, 'privacy')
      return true
    })
    assert.equal(external, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('缓存：同参数命中 → 不重复外发 + 缓存提示；独立 key 不串扰', async () => {
  let external = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    external += 1
    return new Response(JSON.stringify(SERIES_BODY), { status: 200 })
  }) as typeof fetch
  try {
    const session = createNbsSession({ connector: makeConnector(), budget: 3, cacheTtlMs: 60_000 })
    const first = await session.execute({ indicator: '工业增加值', region: '江苏' })
    const second = await session.execute({ indicator: '工业增加值', region: '江苏' })
    assert.ok(second.includes('统计缓存'), '缓存命中提示')
    assert.equal(external, 1, '缓存命中不重复外发')
    assert.ok(first.includes('40123.5'))
  } finally {
    globalThis.fetch = realFetch
  }
})

// ─── 工具包装与元数据 ─────────────────────────────────────────────────────

test('T1 认知面隔离：QueryMacroStats 描述无协议/供应商标识（easyquery/esData/nbs），有权威定位', async () => {
  const session = createNbsSession({ connector: makeConnector(), budget: 3, cacheTtlMs: 0 })
  const tools = buildNbsTools(session)
  const t = tools.QueryMacroStats
  assert.ok(t !== undefined)
  const desc = String(t.description)
  assert.ok(!/easyquery|esData|nbs/i.test(desc), '描述无协议细节（T1）')
  assert.ok(desc.includes('权威统计'), '权威定位')
})

test('工具错误语义：外部失败 → 错误文本回给模型（不抛穿循环）', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('server error', { status: 500 })) as typeof fetch
  try {
    const session = createNbsSession({ connector: makeConnector(undefined, { retries: 0 }), budget: 3, cacheTtlMs: 0 })
    const tools = buildNbsTools(session)
    const exec = tools.QueryMacroStats.execute
    assert.ok(exec !== undefined)
    const out = await exec({ indicator: '工业增加值', region: '江苏' }, { toolCallId: 'x', messages: [] } as never)
    assert.ok(typeof out === 'string' && out.startsWith('QueryMacroStats 失败：'), `应返回错误文本，实际 ${out}`)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('超时归一：外部查询挂起 → 工具层错误文本含「超时」（不抛穿循环）', async () => {
  const realFetch = globalThis.fetch
  // mock 尊重 signal：真实 fetch 会因 AbortSignal.timeout 中止
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (signal != null) {
        if (signal.aborted) reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason))
      }
    })) as typeof fetch
  try {
    const session = createNbsSession({
      connector: makeConnector(undefined, { timeoutMs: 80, retries: 0 }),
      budget: 3,
      cacheTtlMs: 0,
    })
    const tools = buildNbsTools(session)
    const exec = tools.QueryMacroStats.execute
    assert.ok(exec !== undefined)
    const out = await exec({ indicator: '工业增加值', region: '江苏' }, { toolCallId: 'x', messages: [] } as never)
    assert.ok(typeof out === 'string' && out.startsWith('QueryMacroStats 失败：'), `应返回错误文本，实际 ${out}`)
    assert.match(out, /超时/, '错误归一消息含超时语义')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('治理元数据保真：NBS_TOOL_META = data 源 / external 出境 / 预算 3 / trace nbs / provider nbs', () => {
  assert.deepEqual(NBS_TOOL_META.QueryMacroStats, {
    source: 'data',
    egress: 'external',
    budget: NBS_SESSION_BUDGET,
    traceScope: 'nbs',
    provider: 'nbs',
  })
})

test('session budget 校验：非正整数 → fail fast', () => {
  assert.throws(() => createNbsSession({ connector: makeConnector(), budget: 0, cacheTtlMs: 0 }), /budget 应为正整数/)
})

// ─── 批次 B：消歧闭环与候选语义 ────────────────────────────────────────────

const AMBI_TREE = {
  topCategories: async () => [{ _id: 'x1', _name: '工业', isLeaf: false }],
  childrenOf: async () => [
    { _id: 'x2', _name: '工业产品产量', isLeaf: true },
    { _id: 'x3', _name: '工业销售产值', isLeaf: true },
  ],
  indicatorsOf: async (cid: string) =>
    cid === 'x2' ? [{ _id: 'a1', i_showname: '工业产品产量 (万吨)' }] : [{ _id: 'a2', i_showname: '工业销售产值 (万元)' }],
}

test('B2 歧义显式化：多候选 → 候选列表文本（含 indicatorId），不自动查询', async () => {
  const realFetch = globalThis.fetch
  let external = 0
  globalThis.fetch = (async () => {
    external += 1
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  try {
    const session = createNbsSession({ connector: makeConnector(AMBI_TREE), budget: 3, cacheTtlMs: 0 })
    const out = await session.execute({ indicator: '工业', region: '江苏' })
    assert.ok(out.includes('多个候选指标'), '歧义显式化')
    assert.ok(out.includes('indicatorId'), '候选带 id 供指认')
    assert.equal(external, 0, '歧义时不做外部查询')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('消歧闭环：indicatorId 指认 → 精确查询（esData body 携带该 id；跳过关键词解析）', async () => {
  const bodies: Record<string, unknown>[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify(SERIES_BODY), { status: 200 })
  }) as typeof fetch
  try {
    // curator 命中后 catalogOf 可查：用 curator 的 GDP id 指认
    const session = createNbsSession({ connector: makeConnector(), budget: 3, cacheTtlMs: 0 })
    const out = await session.execute({
      indicator: 'GDP',
      indicatorId: '7dc6a2ee6c614960b7059991e0cc4d96',
      region: '江苏',
    })
    assert.ok(out.includes('40123.5'))
    assert.deepEqual(bodies[0].indicatorIds, ['7dc6a2ee6c614960b7059991e0cc4d96'], 'esData 用指认 id')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('诚实边界：查询无数据 → 降级提示（含城市级口径提示）', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })) as typeof fetch
  try {
    const session = createNbsSession({ connector: makeConnector(), budget: 3, cacheTtlMs: 0 })
    const out = await session.execute({ indicator: '工业增加值', region: '苏州' })
    assert.ok(out.includes('无统计值'), '无数据提示')
    assert.ok(out.includes('GDP 无城市级口径'), '诚实口径提示（城市级 GDP 不存在于年度口径）')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ─── Tool Evidence Contract（Phase 3C）─────────────────────────────────────

test('证据：查询成功 → takeEvidence（data/nbs/citation=指标id/period=最新年份/confidence）；缓存命中复现；取即清', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify(SERIES_BODY), { status: 200 })) as typeof fetch
  try {
    const session = createNbsSession({ connector: makeConnector(), budget: 3, cacheTtlMs: 60_000 })
    await session.execute({ indicator: '工业增加值', region: '江苏' })
    const evs = session.takeEvidence()
    assert.equal(evs.length, 1)
    assert.equal(evs[0].source, 'data')
    assert.equal(evs[0].provider, 'nbs')
    assert.equal(evs[0].citation, '1e344d8fa0d040f88e80b5bf0b56dbac', 'citation = 指标 id')
    assert.equal(evs[0].period, '2024年', 'period = 最新数据年份')
    assert.equal(evs[0].producerConfidence, 1, 'producerConfidence = curator 精确分（生产方解析置信，非事实可信度）')
    assert.equal(session.takeEvidence().length, 0, '取即清')
    // 缓存命中：证据复现（fetchedAt = 首次获取时刻，period/confidence 不丢）
    await session.execute({ indicator: '工业增加值', region: '江苏' })
    const hitEvs = session.takeEvidence()
    assert.equal(hitEvs.length, 1)
    assert.equal(hitEvs[0].citation, '1e344d8fa0d040f88e80b5bf0b56dbac')
    assert.equal(hitEvs[0].period, '2024年')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ─── buildToolSources：data 源组装 ─────────────────────────────────────────

test('buildToolSources：NBS 启用 → data 源注入（QueryMacroStats + 元数据）；未启用 → 不注入', () => {
  const defaults: AgentDefaults = {
    permissionMode: 'bypassPermissions',
    allowedTools: ['Read', 'QueryMacroStats'],
    searchBudget: 2,
    searchCacheTtlMinutes: 1,
  }
  const base = {
    workspace: initWorkspace(mkdtempSync(join(tmpdir(), 'cos-nbs-src-'))),
    defaults,
    searchCache: new Map(),
    exaCache: new Map(),
    nbsCache: new Map(),
    logger: fakeLogger,
    apiKey: 'fake-key',
    model: 'fake-model',
  }
  const withNbs = buildToolSources({ ...base, nbsConnector: makeConnector() })
  assert.equal(withNbs.length, 2, 'builtin + data')
  assert.deepEqual(Object.keys(withNbs[1].tools), ['QueryMacroStats', 'CompareRegionProfiles'], 'data 源双工具')
  assert.equal(withNbs[1].meta.QueryMacroStats.source, 'data')
  assert.equal(withNbs[1].meta.QueryMacroStats.provider, 'nbs')
  assert.equal(withNbs[1].meta.CompareRegionProfiles.source, 'data')
  assert.equal(withNbs[1].meta.CompareRegionProfiles.traceScope, 'nbs_profile')
  const withoutNbs = buildToolSources(base)
  assert.equal(withoutNbs.length, 1, '仅 builtin')
})
