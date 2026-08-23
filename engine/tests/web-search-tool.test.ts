import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWebSearchTool,
  createSearchSession,
  extractSourceUrls,
  hostedSearch,
  type SearchSessionOptions,
} from '../agent/tools/web-search.ts'

const provider = {
  baseUrl: 'https://api.deepseek.com/anthropic',
  apiKey: 'sk-test',
  model: 'deepseek-v4-flash',
  mode: 'responses' as const,
}

/** 文件级 fetch 还原锚（mockFetch 覆写全局；超时类用例自建 mock 后需还原） */
const realFetch = globalThis.fetch

function makeSession(extra: Partial<SearchSessionOptions> = {}): ReturnType<typeof createSearchSession> {
  return createSearchSession({ provider, budget: 8, cacheTtlMs: 30 * 60_000, ...extra })
}

/** 直调工具 execute（ai v7 Tool.execute 为可选 2 参签名；测试只关心入参→返回，第二参传空） */
function runTool(t: ReturnType<typeof buildWebSearchTool>, input: { query: string }): Promise<string> {
  return t.execute!(input, {} as never) as Promise<string>
}

interface MockCall {
  url: string
  init: RequestInit
}

/** fetch mock：response 可为单一值或按调用序取用的数组（不足时复用末项）；元素可为 { status, body } */
function mockFetch(responses: unknown[] | unknown, status = 200): { calls: MockCall[] } {
  const list = Array.isArray(responses) ? responses : [responses]
  const calls: MockCall[] = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const idx = Math.min(calls.length - 1, list.length - 1)
    const r = list[idx]
    const item =
      typeof r === 'object' && r !== null && 'body' in r && typeof (r as { status?: unknown }).status === 'number'
        ? (r as { status: number; body: unknown })
        : { status, body: r }
    return new Response(typeof item.body === 'string' ? item.body : JSON.stringify(item.body), { status: item.status })
  }) as typeof fetch
  return { calls }
}

/** OpenAI Responses 形状（合成数据；字段集与 @ai-sdk/openai responses 适配器 zod 校验对齐） */
function responsesBody(text: string, annotations: unknown[] = []): Record<string, unknown> {
  return {
    id: 'resp_synth_1',
    object: 'response',
    created_at: 1787436269,
    status: 'completed',
    background: false,
    completed_at: 1787436280,
    content_filters: null,
    error: null,
    frequency_penalty: 0,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 800,
    max_tool_calls: null,
    model: 'deepseek-v4-flash',
    moderation: null,
    output: [
      { type: 'reasoning', id: 'r1', status: 'completed', content: [{ type: 'reasoning_text', text: '…' }], summary: [] },
      { type: 'web_search_call', id: 'call_1', status: 'completed', action: { type: 'search', queries: ['q1'] } },
      { type: 'message', id: 'm1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations }] },
    ],
    parallel_tool_calls: true,
    presence_penalty: 0,
    previous_response_id: null,
    prompt_cache_key: null,
    prompt_cache_retention: null,
    reasoning: { effort: null, summary: null },
    safety_identifier: 'user_abc',
    service_tier: 'default',
    store: true,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [{ type: 'web_search' }],
    top_logprobs: 0,
    top_p: 1,
    truncation: 'disabled',
    usage: { total_tokens: 42, input_tokens: 10, output_tokens: 32 },
    user: null,
    metadata: {},
  }
}

/** Google GenerateContentResponse 形状（合成数据；字段集与 @ai-sdk/google 适配器 zod 校验对齐） */
function googleBody(text: string): Record<string, unknown> {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        finishReason: 'STOP',
        groundingMetadata: {
          groundingChunks: [{ web: { uri: 'https://g.example.com/1', title: 'Gemini 引用页' } }],
          webSearchQueries: ['合成查询'],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 20, totalTokenCount: 25 },
    modelVersion: 'gemini-synth-1',
  }
}

// ─── Source Normalizer ──────────────────────────────────────────────────────

test('extractSourceUrls：提取 URL、去标点/噪声后缀、去重保序', () => {
  const text =
    '## 数据来源\n- 平台A：https://example.com/a#ws_call_id=call_01、https://example.com/a\n- 平台B：https://example.com/b?x=1，'
  const sources = extractSourceUrls(text)
  assert.deepEqual(
    sources.map((s) => s.url),
    ['https://example.com/a', 'https://example.com/b?x=1'],
  )
})

// ─── 守卫降级路径（薄封装）─────────────────────────────────────────────────

test('hostedSearch：请求打到 /responses（anthropic 后缀剥离）+ web_search 工具 + 返回 output_text + 来源提取', async () => {
  const { calls } = mockFetch({
    output: [
      { type: 'message', content: [{ type: 'output_text', text: '结论：1.9-2.4万' }] },
      { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://ref.com/p#ws_call_id=x' } },
    ],
  })
  const out = await hostedSearch(provider, '苏州 医疗器械 薪资')
  assert.equal(out.text, '结论：1.9-2.4万')
  assert.deepEqual(out.sources, [{ url: 'https://ref.com/p' }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, 'https://api.deepseek.com/responses')
  const body = JSON.parse(String(calls[0]!.init.body))
  assert.deepEqual(body.tools, [{ type: 'web_search', search_context_size: 'medium' }])
  assert.equal(body.input, '苏州 医疗器械 薪资')
})

test('hostedSearch：非 200 → 抛错含状态码', async () => {
  mockFetch('rate limited', 429)
  await assert.rejects(() => hostedSearch(provider, 'query'), /429/)
})

test('hostedSearch：超时 → 错误归一（timeout 消息，经 externalFetch）', async () => {
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
    await assert.rejects(() => hostedSearch(provider, 'query', { timeoutMs: 50 }), /超时/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('hostedSearch：无 output_text → 抛错（诚实失败，不回空文本冒充搜索）', async () => {
  mockFetch({ output: [{ type: 'reasoning' }] })
  await assert.rejects(() => hostedSearch(provider, 'query'), /无文本产出/)
})

// ─── 主路径（官方 responses 适配器）────────────────────────────────────────

test('主路径：SDK 适配器检索 → 返回文本 + 文本内来源提取 + system 检索指令下发', async () => {
  const { calls } = mockFetch(
    responsesBody('数据：1.5-2.0万\n\n## 数据来源\n- 平台X：https://ref.example.com/salary'),
  )
  const session = makeSession()
  const out = await session.execute('苏州 医疗器械 薪资')
  assert.equal(out.cached, false)
  assert.match(out.text, /1\.5-2\.0万/)
  assert.deepEqual(out.sources, [{ url: 'https://ref.example.com/salary' }])
  assert.equal(calls.length, 1)
  const body = JSON.parse(String(calls[0]!.init.body))
  // 主路径经官方适配器：system 检索指令进 input 数组 + provider 侧 web_search 工具
  const systemPart = (body.input as Array<{ role: string; content: string }>).find((p) => p.role === 'system')
  assert.match(String(systemPart?.content), /数据来源/)
  assert.ok(JSON.stringify(body.tools).includes('web_search'))
})

test('主路径：SDK 适配器空文本（协议形态变化）→ 守卫降级薄封装成功 + 锁定本会话', async () => {
  // 第 1 次调用：SDK 响应 200 但无产出文本（协议变化）→ 降级；第 2 次：薄封装正常
  const { calls } = mockFetch([
    responsesBody(''), // 完整骨架但 message 文本为空 → 主路径判定失败
    { output: [{ type: 'message', content: [{ type: 'output_text', text: '降级路径结果' }] }] },
  ])
  const session = makeSession()
  const first = await session.execute('查询A')
  assert.equal(first.text, '降级路径结果')
  assert.equal(calls.length, 2, 'SDK 失败 + 薄封装成功 = 2 次请求')
  // 锁定后：新查询只走薄封装（1 次请求），即使 SDK 会失败也不重试主路径
  const second = await session.execute('查询B')
  assert.equal(second.text, '降级路径结果')
  assert.equal(calls.length, 3, '锁定后新查询 = 1 次请求')
})

// ─── P2 native sources（结构化标题）────────────────────────────────────────

test('responses 模式：url_citation → SDK sources（含 title）→ 文本缺来源段时渲染 [title](url)', async () => {
  const { calls } = mockFetch(
    responsesBody('结论：1.5-2.0万', [
      { type: 'url_citation', url: 'https://ref.example.com/a', title: '合成引用页', start_index: 0, end_index: 10 },
    ]),
  )
  const session = makeSession()
  const out = await session.execute('Synthetic 薪资查询')
  assert.deepEqual(out.sources, [{ url: 'https://ref.example.com/a', title: '合成引用页' }])
  assert.match(out.text, /- \[合成引用页\]\(https:\/\/ref\.example\.com\/a\)/)
  assert.equal(calls.length, 1)
  assert.equal(out.cached, false)
})

test('google 模式：grounding 检索 → SDK sources（含 title）+ providerOptions.google.googleSearch 下发', async () => {
  const { calls } = mockFetch(googleBody('Gemini 结论：1.8-2.4万'))
  const session = makeSession({ provider: { ...provider, mode: 'google', model: 'gemini-synth-1' } })
  const out = await session.execute('Synthetic 薪资查询')
  assert.match(out.text, /Gemini 结论：1.8-2.4万/)
  assert.deepEqual(out.sources, [{ url: 'https://g.example.com/1', title: 'Gemini 引用页' }])
  const body = JSON.parse(String(calls[0]!.init.body))
  assert.ok(JSON.stringify(body).includes('googleSearch'), '请求体应含 googleSearch grounding 开关')
})

test('google 模式：失败即抛错（无 responses 兼容降级——诚实失败）', async () => {
  mockFetch([{ status: 200, body: googleBody('') }, { status: 500, body: 'boom' }])
  const session = makeSession({ provider: { ...provider, mode: 'google' } })
  await assert.rejects(() => session.execute('查询C'), /boom|无文本产出/)
})

test('主路径：双路径全失败 → 抛错（错误文本由工具层转达，不抛穿循环）', async () => {
  mockFetch([
    { status: 200, body: responsesBody('') }, // SDK 解析空文本 → 守卫触发
    { status: 500, body: 'boom' }, // 薄封装也失败
  ])
  const session = makeSession()
  await assert.rejects(() => session.execute('查询C'), /500/)
})

// ─── 预算（P1a）─────────────────────────────────────────────────────────────

test('预算：budget=2 → 前两次成功，第三次抛预算用尽（不产生第 3 次请求）', async () => {
  const { calls } = mockFetch(responsesBody('结果'))
  const session = makeSession({ budget: 2 })
  await session.execute('Q1')
  await session.execute('Q2')
  assert.equal(calls.length, 2)
  await assert.rejects(() => session.execute('Q3'), /预算.*用尽/)
  assert.equal(calls.length, 2, '预算用尽不得外发请求')
})

test('预算：缓存命中不消耗预算（budget=1：miss→缓存命中→新查询预算用尽）', async () => {
  const { calls } = mockFetch(responsesBody('结果'))
  const session = makeSession({ budget: 1 })
  const a1 = await session.execute('同一查询')
  assert.equal(a1.cached, false)
  const a2 = await session.execute('同一查询')
  assert.equal(a2.cached, true, '第二次命中缓存')
  assert.match(a2.text, /检索缓存/)
  assert.equal(calls.length, 1)
  await assert.rejects(() => session.execute('新查询'), /预算.*用尽/)
})

test('预算：隐私拒绝不消耗预算（拦截后仍可正常搜索）', async () => {
  const { calls } = mockFetch(responsesBody('结果'))
  const session = makeSession({ budget: 1 })
  const phone = '13' + '812345678'
  await assert.rejects(() => session.execute(`查一下 ${phone} 的薪资`), /隐私红线/)
  assert.equal(calls.length, 0, '隐私拒绝不得外发请求')
  const ok = await session.execute('正常查询')
  assert.equal(ok.text, '结果', '隐私拒绝不消耗预算')
  assert.equal(calls.length, 1)
})

// ─── 缓存（P1a）─────────────────────────────────────────────────────────────

test('缓存：同 query（大小写/空白差异）命中同一缓存；ttl=0 不缓存', async () => {
  const { calls } = mockFetch(responsesBody('结果'))
  const session = makeSession()
  await session.execute('苏州 医疗器械  薪资')
  const hit = await session.execute('苏州 医疗器械 薪资'.toUpperCase())
  assert.equal(hit.cached, true)
  assert.equal(calls.length, 1, '规范化后同 key，不发第二次请求')

  const { calls: calls2 } = mockFetch(responsesBody('结果2'))
  const session2 = makeSession({ cacheTtlMs: 0 })
  await session2.execute('Q')
  const again = await session2.execute('Q')
  assert.equal(again.cached, false)
  assert.equal(calls2.length, 2, 'ttl=0：每次均重新检索')
})

test('缓存：引擎级共享缓存跨会话复用（第二个任务同查询不重复检索）', async () => {
  const { calls } = mockFetch(responsesBody('结果'))
  const shared = new Map()
  const s1 = makeSession({ cache: shared })
  const s2 = makeSession({ cache: shared })
  await s1.execute('跨任务查询')
  const hit = await s2.execute('跨任务查询')
  assert.equal(hit.cached, true, '第二个任务命中共享缓存')
  assert.equal(calls.length, 1)
})

// ─── 工具层（Agent 语义）───────────────────────────────────────────────────

test('buildWebSearchTool：预算用尽 → 引导模型停止搜索的文本（对齐 T2 反复重试治理）', async () => {
  mockFetch(responsesBody('结果'))
  const session = makeSession({ budget: 1 })
  const t = buildWebSearchTool(session)
  await runTool(t, { query: 'Q1' })
  const out = await runTool(t, { query: 'Q2' })
  assert.match(out, /预算/)
  assert.match(out, /不要再调用搜索/)
})

test('buildWebSearchTool：隐私红线 → 拒绝文本', async () => {
  const { calls } = mockFetch({})
  const t = buildWebSearchTool(makeSession())
  const phone = '13' + '812345678'
  const out = await runTool(t, { query: `查一下 ${phone} 的薪资` })
  assert.match(out, /隐私红线/)
  assert.equal(calls.length, 0)
})

test('buildWebSearchTool：检索成功 → 返回检索文本（含缓存时间戳提示时不丢正文）', async () => {
  mockFetch(responsesBody('数据 + 来源'))
  const t = buildWebSearchTool(makeSession())
  const out = await runTool(t, { query: '苏州医疗器械结构工程师薪资' })
  assert.equal(out, '数据 + 来源')
})

test('buildWebSearchTool：双路径全失败 → 错误文本回给模型（对齐文件工具语义，不抛穿循环）', async () => {
  mockFetch([{ status: 200, body: responsesBody('') }, { status: 500, body: 'boom' }])
  const t = buildWebSearchTool(makeSession())
  const out = await runTool(t, { query: '测试查询' })
  assert.match(out, /^web_search 失败：/)
})

// ─── Tool Evidence Contract（Phase 3C）─────────────────────────────────────

test('Tool Evidence Contract：成功检索 → takeEvidence 带来源引用；缓存命中 → 复现；取即清', async () => {
  mockFetch(responsesBody('数据：1.5-2.0万\n\n## 数据来源\n- 平台X：https://ref.example.com/salary'))
  const session = makeSession()
  await session.execute('苏州 医疗器械 薪资')
  const evs = session.takeEvidence()
  assert.equal(evs.length, 1)
  assert.equal(evs[0].source, 'hosted')
  assert.equal(evs[0].provider, 'hosted')
  assert.ok(evs[0].citation.includes('https://ref.example.com/salary'), 'citation = 来源 URL')
  assert.ok(!Number.isNaN(Date.parse(evs[0].fetchedAt)), 'fetchedAt 为 ISO 时刻')
  assert.equal(session.takeEvidence().length, 0, '取即清')
  // 缓存命中：证据复现（fetchedAt = 首次获取时刻）
  const hit = await session.execute('苏州 医疗器械 薪资')
  assert.equal(hit.cached, true)
  const hitEvs = session.takeEvidence()
  assert.equal(hitEvs.length, 1)
  assert.ok(hitEvs[0].citation.includes('https://ref.example.com/salary'))
})
