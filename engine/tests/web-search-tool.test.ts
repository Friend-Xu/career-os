import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWebSearchTool, hostedSearch } from '../agent/tools/web-search.ts'

const provider = { baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-test', model: 'deepseek-v4-flash' }

/** fetch mock：记录调用，返回预设响应 */
function mockFetch(response: unknown, status = 200): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(typeof response === 'string' ? response : JSON.stringify(response), { status })
  }) as typeof fetch
  return { calls }
}

test('hostedSearch：请求打到 /responses（anthropic 后缀剥离）+ web_search 工具 + 返回 output_text', async () => {
  const { calls } = mockFetch({ output: [{ type: 'message', content: [{ type: 'output_text', text: '结论：1.9-2.4万' }] }] })
  const out = await hostedSearch(provider, '苏州 医疗器械 薪资')
  assert.equal(out, '结论：1.9-2.4万')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, 'https://api.deepseek.com/responses')
  const body = JSON.parse(String(calls[0]!.init.body))
  assert.deepEqual(body.tools, [{ type: 'web_search', search_context_size: 'medium' }])
  assert.equal(body.input, '苏州 医疗器械 薪资')
  assert.ok(calls[0]!.init.headers !== undefined)
})

test('hostedSearch：非 200 → 抛错含状态码', async () => {
  mockFetch('rate limited', 429)
  await assert.rejects(() => hostedSearch(provider, 'query'), /429/)
})

test('hostedSearch：无 output_text → 抛错（诚实失败，不回空文本冒充搜索）', async () => {
  mockFetch({ output: [{ type: 'reasoning' }] })
  await assert.rejects(() => hostedSearch(provider, 'query'), /无文本产出/)
})

test('buildWebSearchTool：隐私红线——查询含手机号 → 拒绝且不发请求', async () => {
  const { calls } = mockFetch({})
  const t = buildWebSearchTool(provider)
  // 运行时拼接（架构文件不落手机号字面量——sanitize 数据边界）
  const phone = '13' + '812345678'
  const out = await t.execute({ query: `查一下 ${phone} 的薪资` })
  assert.match(out, /隐私红线/)
  assert.equal(calls.length, 0, '隐私拒绝不得外发任何请求')
})

test('buildWebSearchTool：正常查询 → 返回检索文本', async () => {
  mockFetch({ output: [{ type: 'message', content: [{ type: 'output_text', text: '数据 + 来源' }] }] })
  const t = buildWebSearchTool(provider)
  const out = await t.execute({ query: '苏州医疗器械结构工程师薪资' })
  assert.equal(out, '数据 + 来源')
})

test('buildWebSearchTool：搜索服务失败 → 错误文本回给模型（对齐文件工具语义，不抛穿循环）', async () => {
  mockFetch({}, 500)
  const t = buildWebSearchTool(provider)
  const out = await t.execute({ query: '测试查询' })
  assert.match(out, /^web_search 失败：/)
})
