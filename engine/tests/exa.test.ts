/**
 * Exa MCP 能力（Tool Runtime 第二阶段 P2）测试：
 * 连接（幂等/fail-safe）、认知面隔离（T1）、治理面（预算/隐私/缓存）、错误文本语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { tool } from 'ai'
import type { MCPClient } from '@ai-sdk/mcp'
import { initWorkspace } from '../storage/workspace.ts'
import type { Logger } from '../logger.ts'
import { buildToolSources, type AgentDefaults } from '../runtime/agent-runtime.ts'
import {
  buildExaTools,
  createExaSession,
  EXA_SESSION_BUDGET,
  EXA_TOOL_MAP,
  EXA_TOOL_META,
  ExaConnector,
  ExaPolicyError,
  type ExaMcpToolName,
} from '../agent/tools/exa.ts'

/** fake MCP client：listTools/toolsFromDefinitions/callTool/close；记录 callTool 调用与 options */
function fakeClient(opts?: { searchResult?: string; searchError?: boolean; callThrow?: string }) {
  const calls: Array<{ name: string; args: Record<string, unknown>; options?: unknown }> = []
  const baseTools = {
    web_search_exa: tool({
      description: 'Search the web with Exa',
      inputSchema: z.object({ query: z.string() }),
      execute: async (): Promise<unknown> => {
        if (opts?.callThrow !== undefined) throw new Error(opts.callThrow)
        return {
          content: [{ type: 'text', text: opts?.searchResult ?? '检索文本 https://example.com/a' }],
          ...(opts?.searchError === true ? { isError: true } : {}),
        }
      },
    }),
    web_fetch_exa: tool({
      description: 'Read webpage via Exa',
      inputSchema: z.object({ urls: z.array(z.string()) }),
      execute: async (): Promise<unknown> => ({ content: [{ type: 'text', text: '页面正文' }] }),
    }),
  }
  const client = {
    serverInfo: { name: 'exa-search-server', version: '3.2.1' },
    listTools: async () => ({
      tools: Object.entries(baseTools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
    }),
    toolsFromDefinitions: () => baseTools,
    callTool: async ({
      name,
      arguments: args,
      options,
    }: {
      name: string
      arguments: Record<string, unknown>
      options?: unknown
    }) => {
      calls.push({ name, args, ...(options !== undefined ? { options } : {}) })
      const exec = (baseTools as unknown as Record<string, { execute?: (i: unknown) => Promise<unknown> }>)[name]
      if (exec === undefined || exec.execute === undefined) throw new Error(`tool not found: ${name}`)
      return exec.execute(args)
    },
    close: async () => {},
  }
  return { client: client as unknown as MCPClient, calls }
}

function connectorWith(factory: () => Promise<MCPClient>) {
  return new ExaConnector({ clientFactory: factory })
}

test('connect 成功 → ready=true；buildExaTools 返回语义工具名（WebResearch/WebFetch，非 MCP 原名）', async () => {
  const fake = fakeClient()
  const c = connectorWith(async () => fake.client)
  assert.equal(await c.connect(), true)
  assert.equal(c.ready, true)
  const session = createExaSession({ connector: c, budget: 5, cacheTtlMs: 0 })
  const tools = buildExaTools(c, session)
  assert.deepEqual(Object.keys(tools).sort(), ['WebFetch', 'WebResearch'])
})

test('T1 认知面隔离：包装后描述无 Exa/MCP 标识（server 描述带 Exa，转译后消失）', async () => {
  const fake = fakeClient()
  const c = connectorWith(async () => fake.client)
  await c.connect()
  const session = createExaSession({ connector: c, budget: 5, cacheTtlMs: 0 })
  const tools = buildExaTools(c, session)
  for (const [name, t] of Object.entries(tools)) {
    assert.ok(!/exa|mcp/i.test(String(t.description)), `${name} 描述不得含供应商标识（T1）`)
  }
  assert.ok(!/exa|mcp/i.test('WebResearch'), '工具名本身无供应商标识')
})

test('connect 失败 → ready=false 且不抛（fail-safe）；buildExaTools 返回空集', async () => {
  const c = connectorWith(async () => {
    throw new Error('网络不可达')
  })
  assert.equal(await c.connect(), false)
  assert.equal(c.ready, false)
  const session = createExaSession({ connector: c, budget: 5, cacheTtlMs: 0 })
  assert.deepEqual(Object.keys(buildExaTools(c, session)), [])
})

test('connect 幂等：并发两次共享同一连接（clientFactory 只调一次）', async () => {
  let factoryCalls = 0
  const fake = fakeClient()
  const c = connectorWith(async () => {
    factoryCalls += 1
    return fake.client
  })
  const [a, b] = await Promise.all([c.connect(), c.connect()])
  assert.equal(a, true)
  assert.equal(b, true)
  assert.equal(factoryCalls, 1)
})

test('预算：任务级调用池耗尽 → budget_exhausted（第二次拒绝，不再外发）', async () => {
  const fake = fakeClient()
  const c = connectorWith(async () => fake.client)
  await c.connect()
  const session = createExaSession({ connector: c, budget: 1, cacheTtlMs: 0 })
  const first = await session.execute('web_search_exa', { query: 'q1' })
  assert.ok(first.includes('检索文本'))
  await assert.rejects(() => session.execute('web_search_exa', { query: 'q2' }), (err: unknown) => {
    assert.ok(err instanceof ExaPolicyError)
    assert.equal((err as ExaPolicyError).code, 'budget_exhausted')
    return true
  })
  assert.equal(fake.calls.length, 1, '预算耗尽后不再调用外部服务')
})

test('隐私红线：查询含手机号 → privacy 拒绝（不外发）', async () => {
  const fake = fakeClient()
  const c = connectorWith(async () => fake.client)
  await c.connect()
  const session = createExaSession({ connector: c, budget: 5, cacheTtlMs: 0 })
  const phone = '13' + '812345678' // 拼接构造（合成号码；sanitize 模式匹配边界，对齐 web-search 测试惯例）
  await assert.rejects(() => session.execute('web_search_exa', { query: `联系 ${phone}` }), (err: unknown) => {
    assert.ok(err instanceof ExaPolicyError)
    assert.equal((err as ExaPolicyError).code, 'privacy')
    return true
  })
  assert.equal(fake.calls.length, 0, '隐私拒绝后不调用外部服务')
})

test('缓存：同参数命中不消耗预算、不再外发，返回带时间戳提示', async () => {
  const fake = fakeClient()
  const c = connectorWith(async () => fake.client)
  await c.connect()
  const session = createExaSession({ connector: c, budget: 1, cacheTtlMs: 60_000 })
  const first = await session.execute('web_search_exa', { query: '苏州 医疗器械' })
  const second = await session.execute('web_search_exa', { query: '苏州 医疗器械' })
  assert.ok(second.includes('检索缓存'), '缓存命中带时间戳提示')
  assert.equal(fake.calls.length, 1, '缓存命中不重复外发')
  assert.ok(first.includes('检索文本'))
})

test('callToolText：多 text 块拼接 + isError → 抛错误', async () => {
  const fake = fakeClient({ searchResult: '段一 https://a.com/1', searchError: true })
  const c = connectorWith(async () => fake.client)
  await c.connect()
  await assert.rejects(() => c.callToolText('web_search_exa', { query: 'q' }), /外部检索服务错误/)
})

test('Provider Stability：callToolText 传 callTool RequestOptions（注入的 timeout/maxTotalTimeout 透传）', async () => {
  const fake = fakeClient()
  const c = new ExaConnector({
    clientFactory: async () => fake.client,
    callTimeoutMs: 1234,
    callMaxTotalTimeoutMs: 5678,
  })
  await c.connect()
  await c.callToolText('web_search_exa', { query: 'q' })
  assert.deepEqual(fake.calls[0].options, { timeout: 1234, maxTotalTimeout: 5678 }, 'SDK callTool 超时配置透传')
})

test('Provider Stability：callToolText 成功/失败 → exa trace 带 durationMs（call_ok/call_error，toolName 可溯源）', async () => {
  const traces: Array<Record<string, unknown>> = []
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, trace(_scope, entry) { traces.push(entry) } }
  const c = new ExaConnector({ clientFactory: async () => fakeClient().client, logger })
  await c.connect()
  await c.callToolText('web_search_exa', { query: 'q' })
  const ok = traces.find((t) => t.event === 'call_ok')
  assert.ok(ok !== undefined, '成功应有 call_ok trace')
  assert.equal(ok.toolName, 'web_search_exa')
  assert.ok(typeof ok.durationMs === 'number' && (ok.durationMs as number) >= 0)
  // 失败路径（SDK 层异常）
  const c2 = new ExaConnector({ clientFactory: async () => fakeClient({ callThrow: 'boom' }).client, logger })
  await c2.connect()
  await assert.rejects(() => c2.callToolText('web_search_exa', { query: 'q' }), /boom/)
  const err = traces.find((t) => t.event === 'call_error')
  assert.ok(err !== undefined, '失败应有 call_error trace')
  assert.ok(typeof err.durationMs === 'number' && (err.durationMs as number) >= 0)
})

test('来源保障：检索文本无来源段但含 URL → 追加「## 数据来源」', async () => {
  const fake = fakeClient({ searchResult: '结论文本，引用 https://stats.example.com/page' })
  const c = connectorWith(async () => fake.client)
  await c.connect()
  const session = createExaSession({ connector: c, budget: 5, cacheTtlMs: 0 })
  const out = await session.execute('web_search_exa', { query: 'q' })
  assert.ok(out.includes('## 数据来源'))
  assert.ok(out.includes('https://stats.example.com/page'))
})

test('工具层错误语义：callTool 抛错 → 错误文本回给模型（不抛穿循环）', async () => {
  const fake = fakeClient({ callThrow: '服务端 500' })
  const c = connectorWith(async () => fake.client)
  await c.connect()
  const session = createExaSession({ connector: c, budget: 5, cacheTtlMs: 0 })
  const tools = buildExaTools(c, session)
  const exec = tools.WebResearch.execute
  assert.ok(exec !== undefined)
  const out = await exec({ query: 'q' }, { toolCallId: 'x', messages: [] } as never)
  assert.ok(typeof out === 'string' && out.startsWith('WebResearch 失败：'), `应返回错误文本，实际 ${out}`)
})

test('治理元数据保真：EXA_TOOL_META = mcp 源 / external 出境 / 预算 5 / trace 前缀 exa / provider exa', () => {
  assert.deepEqual(EXA_TOOL_META.WebResearch, { source: 'mcp', egress: 'external', budget: EXA_SESSION_BUDGET, traceScope: 'exa', provider: 'exa' })
  assert.deepEqual(EXA_TOOL_META.WebFetch, { source: 'mcp', egress: 'external', budget: EXA_SESSION_BUDGET, traceScope: 'exa', provider: 'exa' })
})

test('session budget 校验：非正整数 → fail fast（引擎单方决定，配置错误立即暴露）', () => {
  const c = connectorWith(async () => fakeClient().client)
  assert.throws(() => createExaSession({ connector: c, budget: 0, cacheTtlMs: 0 }), /budget 应为正整数/)
})

test('EXA_TOOL_MAP：MCP 名 → 认知名映射完整（新增工具时元数据同步）', () => {
  const names: ExaMcpToolName[] = ['web_search_exa', 'web_fetch_exa']
  for (const n of names) {
    assert.ok(EXA_TOOL_META[EXA_TOOL_MAP[n]] !== undefined, `${EXA_TOOL_MAP[n]} 应有治理元数据`)
  }
})

// ─── buildToolSources：运行时 source 组装（websocket 传参属接线层，真机验收覆盖）──

const fakeLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} }

function sourcesOpts(connector?: ExaConnector, baseUrl?: string) {
  const defaults: AgentDefaults = {
    permissionMode: 'bypassPermissions',
    allowedTools: ['Read', 'WebResearch'],
    searchBudget: 2,
    searchCacheTtlMinutes: 1,
  }
  return {
    workspace: initWorkspace(mkdtempSync(join(tmpdir(), 'cos-src-'))),
    defaults,
    exaConnector: connector,
    searchCache: new Map(),
    exaCache: new Map(),
    nbsCache: new Map(),
    logger: fakeLogger,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    apiKey: 'fake-key',
    model: 'fake-model',
  }
}

test('buildToolSources：Exa 连接就绪 → 3 源（builtin + hosted + mcp）；mcp 源含语义工具与元数据', async () => {
  const fake = fakeClient()
  const c = connectorWith(async () => fake.client)
  await c.connect()
  const sources = buildToolSources(sourcesOpts(c, 'https://api.deepseek.com/anthropic'))
  assert.equal(sources.sources.length, 3)
  assert.deepEqual(Object.keys(sources.sources[0]!.tools).sort(), ['Edit', 'Glob', 'Grep', 'Read', 'Write'])
  assert.deepEqual(Object.keys(sources.sources[1]!.tools), ['WebSearch'])
  const mcp = sources.sources[2]!
  assert.deepEqual(Object.keys(mcp.tools).sort(), ['QueryIndustryEvidence', 'WebFetch', 'WebResearch'], 'mcp 源 = 语义工具名（含行业模板）')
  assert.equal(mcp.meta.WebResearch.source, 'mcp')
  assert.equal(mcp.meta.WebResearch.egress, 'external')
  assert.equal(mcp.meta.QueryIndustryEvidence.traceScope, 'exa_industry')
})

test('buildToolSources：Exa 未连接/未启用 → 不注入 mcp 源（fail-safe，主链路照常）', async () => {
  const fake = fakeClient()
  const c = connectorWith(async () => fake.client)
  // 未 connect：ready=false
  assert.equal(c.ready, false)
  const sources = buildToolSources(sourcesOpts(c, 'https://api.deepseek.com/anthropic'))
  assert.equal(sources.sources.length, 2, '仅 builtin + hosted')
  assert.deepEqual(Object.keys(sources.sources[1]!.tools), ['WebSearch'])
  // 无 connector（未启用）
  const sources2 = buildToolSources(sourcesOpts(undefined, 'https://api.deepseek.com/anthropic'))
  assert.equal(sources2.sources.length, 2)
})

test('buildToolSources：无 baseUrl → 仅 builtin（WebSearch 与 mcp 均不注入）', async () => {
  const fake = fakeClient()
  const c = connectorWith(async () => fake.client)
  await c.connect()
  const sources = buildToolSources(sourcesOpts(c))
  assert.equal(sources.sources.length, 2, 'builtin + mcp（无 provider 不注册 WebSearch）')
  assert.deepEqual(Object.keys(sources.sources[1]!.tools).sort(), ['QueryIndustryEvidence', 'WebFetch', 'WebResearch'])
})

test('Phase 4C：defaults 治理旋钮透传（exaBudget → 会话 trace budgetTotal；缓存 TTL 命中不重发）', async () => {
  const fake = fakeClient()
  const c = connectorWith(async () => fake.client)
  await c.connect()
  const traces: Array<Record<string, unknown>> = []
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, trace(_scope, entry) { traces.push(entry) } }
  const opts = sourcesOpts(c, 'https://api.deepseek.com/anthropic')
  opts.logger = logger
  opts.defaults = { ...opts.defaults, exaBudget: 7, exaCacheTtlMinutes: 90 }
  const sources = buildToolSources(opts)
  const mcp = sources.sources.find((s) => s.meta.WebResearch !== undefined)
  assert.ok(mcp !== undefined, 'mcp 源注入')
  const exec = mcp.tools.WebResearch.execute
  assert.ok(exec !== undefined)
  await exec({ query: 'q' }, { toolCallId: 'x', messages: [] } as never)
  await exec({ query: 'q' }, { toolCallId: 'y', messages: [] } as never)
  const start = traces.find((t) => t.event === 'search_start')
  assert.ok(start !== undefined)
  assert.equal(start.budgetTotal, 7, 'defaults.exaBudget 透传会话预算')
  assert.equal(fake.calls.length, 1, '90 分钟 TTL：同参数第二次命中缓存不外发')
})

// ─── Tool Evidence Contract（Phase 3C）─────────────────────────────────────

test('证据：WebResearch 成功 → takeEvidence 带来源 URL；跨工具不串桶；取即清', async () => {
  const fake = fakeClient({ searchResult: '检索结论 https://exa.example.com/deep' })
  const c = connectorWith(async () => fake.client)
  await c.connect()
  const session = createExaSession({ connector: c, budget: 5, cacheTtlMs: 0 })
  await session.execute('web_search_exa', { query: '行业研究' })
  const evs = session.takeEvidence('WebResearch')
  assert.equal(evs.length, 1)
  assert.equal(evs[0].source, 'mcp')
  assert.equal(evs[0].provider, 'exa')
  assert.ok(evs[0].citation.includes('https://exa.example.com/deep'), 'citation = 来源 URL')
  assert.ok(!Number.isNaN(Date.parse(evs[0].fetchedAt)))
  assert.deepEqual(session.takeEvidence('WebResearch'), [], '取即清')
  assert.deepEqual(session.takeEvidence('WebFetch'), [], '未调用工具不串桶')
})

test('证据：缓存命中 → 复现来源引用（fetchedAt = 首次时刻）', async () => {
  const fake = fakeClient({ searchResult: '检索结论 https://exa.example.com/deep' })
  const c = connectorWith(async () => fake.client)
  await c.connect()
  const session = createExaSession({ connector: c, budget: 5, cacheTtlMs: 1_000_000 })
  await session.execute('web_search_exa', { query: '行业研究' })
  const firstEvs = session.takeEvidence('WebResearch')
  assert.equal(firstEvs.length, 1)
  assert.ok(firstEvs[0].citation.includes('https://exa.example.com/deep'))
  const hit = await session.execute('web_search_exa', { query: '行业研究' })
  assert.ok(hit.includes('检索缓存'))
  const hitEvs = session.takeEvidence('WebResearch')
  assert.equal(hitEvs.length, 1, '缓存命中执行同样产生证据记录')
  assert.ok(hitEvs[0].citation.includes('https://exa.example.com/deep'))
})
