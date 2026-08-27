/**
 * Provider Stability v0.1：统一外部调用封装测试——
 * 超时 / 有限重试 / 错误归一（timeout|network|http）/ duration trace / 接入点行为。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '../logger.ts'
import { externalFetch, ExternalCallError } from '../agent/tools/external-call.ts'
import { fetchCatalogChildren } from '../agent/tools/nbs/api.ts'
import { ZhipuVisionProvider, createVisionProvider } from '../runtime/document/vision-provider.ts'

interface TraceRec {
  scope: string
  entry: Record<string, unknown>
}

function traceLogger(): { logger: Logger; traces: TraceRec[] } {
  const traces: TraceRec[] = []
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    trace(scope, entry) {
      traces.push({ scope, entry })
    },
  }
  return { logger, traces }
}

const realFetch = globalThis.fetch

function restoreFetch(): void {
  globalThis.fetch = realFetch
}

// ─── 基础：成功路径 ──────────────────────────────────────────────────────────

test('externalFetch：2xx → 返回 Response；trace 一条 http_call（ok/attempts/durationMs）', async () => {
  const { logger, traces } = traceLogger()
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch
  try {
    const res = await externalFetch('https://example.test/api', { method: 'GET' }, { logger, traceScope: 'nbs', endpoint: 'nbs:tree' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    assert.equal(traces.length, 1)
    assert.equal(traces[0].scope, 'nbs')
    assert.equal(traces[0].entry.event, 'http_call')
    assert.equal(traces[0].entry.ok, true)
    assert.equal(traces[0].entry.attempts, 1)
    assert.equal(traces[0].entry.endpoint, 'nbs:tree')
    assert.ok(typeof traces[0].entry.durationMs === 'number' && (traces[0].entry.durationMs as number) >= 0)
  } finally {
    restoreFetch()
  }
})

// ─── 错误归一 ────────────────────────────────────────────────────────────────

test('externalFetch：超时 → ExternalCallError(kind=timeout, retryable)，消息含秒数', async () => {
  const { logger } = traceLogger()
  // mock 尊重 signal：真实 fetch 会因 AbortSignal.timeout 中止；mock 模拟该行为（拒绝并带 signal.reason）
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (signal != null) {
        if (signal.aborted) reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason))
      }
    })) as typeof fetch
  try {
    await assert.rejects(
      () => externalFetch('https://example.test/slow', {}, { timeoutMs: 50, retries: 0, logger, traceScope: 't', endpoint: 'ep' }),
      (err: unknown) => {
        assert.ok(err instanceof ExternalCallError)
        assert.equal(err.kind, 'timeout')
        assert.equal(err.retryable, true)
        assert.match(err.message, /超时/)
        return true
      },
    )
  } finally {
    restoreFetch()
  }
})

test('externalFetch：网络错误（fetch TypeError）→ kind=network', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  try {
    await assert.rejects(
      () => externalFetch('https://example.test/api', {}, { retries: 0 }),
      (err: unknown) => {
        assert.ok(err instanceof ExternalCallError)
        assert.equal(err.kind, 'network')
        assert.equal(err.retryable, true)
        return true
      },
    )
  } finally {
    restoreFetch()
  }
})

test('externalFetch：4xx → kind=http + status；不重试（调用 1 次）', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('{"error":{"code":1305}}', { status: 401 })
  }) as typeof fetch
  try {
    await assert.rejects(
      () => externalFetch('https://example.test/api', {}, { retries: 2 }),
      (err: unknown) => {
        assert.ok(err instanceof ExternalCallError)
        assert.equal(err.kind, 'http')
        assert.equal(err.status, 401)
        assert.equal(err.retryable, false)
        assert.match(err.message, /401/)
        return true
      },
    )
    assert.equal(calls, 1, '4xx 永久错误不重试')
  } finally {
    restoreFetch()
  }
})

test('externalFetch：5xx 重试（backoff=0）→ 第二次成功；calls=2；trace ok/attempts=2', async () => {
  let calls = 0
  const { logger, traces } = traceLogger()
  globalThis.fetch = (async () => {
    calls += 1
    return calls === 1 ? new Response('upstream error', { status: 503 }) : new Response('{"ok":true}', { status: 200 })
  }) as typeof fetch
  try {
    const res = await externalFetch('https://example.test/api', {}, { retries: 1, retryBackoffMs: 0, logger, traceScope: 'nbs', endpoint: 'nbs:esData' })
    assert.equal(res.status, 200)
    assert.equal(calls, 2)
    const okTrace = traces.find((t) => t.entry.ok === true)
    assert.ok(okTrace !== undefined, '成功应有 http_call trace')
    assert.equal(okTrace.entry.attempts, 2, '重试后成功 attempts=2')
    assert.equal(okTrace.entry.endpoint, 'nbs:esData')
  } finally {
    restoreFetch()
  }
})

test('externalFetch：429 可重试；恒失败 → 最终 throw（attempts = retries+1）+ 失败 trace', async () => {
  let calls = 0
  const { logger, traces } = traceLogger()
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('rate limited', { status: 429 })
  }) as typeof fetch
  try {
    await assert.rejects(
      () => externalFetch('https://example.test/api', {}, { retries: 2, retryBackoffMs: 0, logger, traceScope: 't', endpoint: 'ep' }),
      (err: unknown) => {
        assert.ok(err instanceof ExternalCallError)
        assert.equal(err.kind, 'http')
        assert.equal(err.status, 429)
        assert.equal(err.attempts, 3, '重试耗尽 attempts = retries+1')
        return true
      },
    )
    assert.equal(calls, 3)
    const failTrace = traces.find((t) => t.entry.ok === false)
    assert.ok(failTrace !== undefined, '失败应有 http_call trace')
    assert.equal(failTrace.entry.kind, 'http')
    assert.equal(failTrace.entry.status, 429)
    assert.equal(failTrace.entry.attempts, 3)
  } finally {
    restoreFetch()
  }
})

// ─── 接入点：NBS（WAF 挑战页不重试；200+HTML 语义保持）───────────────────────

test('NBS：WAF 挑战页（200 + HTML）→ 诚实报错且不重试（calls=1）', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('<html><body>challenge</body></html>', { status: 200 })
  }) as typeof fetch
  try {
    await assert.rejects(() => fetchCatalogChildren(''), /反爬挑战页/)
    assert.equal(calls, 1, '200+HTML 非错误状态，不触发重试')
  } finally {
    restoreFetch()
  }
})

// ─── 接入点：Zhipu 视觉（错误归一 + 外层退避重试语义）────────────────────────

test('ZhipuVisionProvider：成功 → 返回文本', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '识别结果' } }] }), { status: 200 })) as typeof fetch
  const dir = mkdtempSync(join(tmpdir(), 'cos-vision-'))
  const img = join(dir, 'page.png')
  writeFileSync(img, 'fake-png-bytes')
  try {
    const p = new ZhipuVisionProvider({ apiKey: 'k', model: 'glm-4.6v-flash' })
    assert.equal(await p.analyzeImage(img, '提取文本'), '识别结果')
  } finally {
    restoreFetch()
  }
})

test('ZhipuVisionProvider：429 限流 → 外层重试 3 次后抛错（错误体摘要透传限流码）', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({ error: { code: 1305, message: 'rate limit' } }), { status: 429 })
  }) as typeof fetch
  const dir = mkdtempSync(join(tmpdir(), 'cos-vision-'))
  const img = join(dir, 'page.png')
  writeFileSync(img, 'fake-png-bytes')
  try {
    await assert.rejects(
      () => new ZhipuVisionProvider({ apiKey: 'k', model: 'glm-4.6v-flash' }).analyzeImage(img, '提取'),
      (err: unknown) => {
        assert.ok(err instanceof ExternalCallError)
        assert.match(err.message, /429/)
        assert.match(err.message, /1305/, '错误体摘要含限流码')
        return true
      },
    )
    assert.equal(calls, 3, '瞬时错误外层退避重试（MAX_ATTEMPTS=3）')
  } finally {
    restoreFetch()
  }
})

test('ZhipuVisionProvider：401（4xx 永久错误）→ 不重试立即抛', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('invalid key', { status: 401 })
  }) as typeof fetch
  const dir = mkdtempSync(join(tmpdir(), 'cos-vision-'))
  const img = join(dir, 'page.png')
  writeFileSync(img, 'fake-png-bytes')
  try {
    await assert.rejects(() => new ZhipuVisionProvider({ apiKey: 'bad', model: 'm' }).analyzeImage(img, '提取'))
    assert.equal(calls, 1, '4xx 不重试')
  } finally {
    restoreFetch()
  }
})

// ─── 接入点：createVisionProvider（provider 分流端点/默认模型；DeepSeek 多模态 Exp）──

test('createVisionProvider：deepseek → DeepSeek 端点 + 默认模型 deepseek-v4-flash-vision-exp', async () => {
  let captured: { url: string; body: { model: string } } | null = null
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(input), body: JSON.parse(String(init?.body)) as { model: string } }
    return new Response(JSON.stringify({ choices: [{ message: { content: '识别结果' } }] }), { status: 200 })
  }) as typeof fetch
  const dir = mkdtempSync(join(tmpdir(), 'cos-vision-'))
  const img = join(dir, 'page.png')
  writeFileSync(img, 'fake-png-bytes')
  try {
    const p = createVisionProvider({ provider: 'deepseek', apiKey: 'k' })
    assert.equal(await p.analyzeImage(img, '提取文本'), '识别结果')
    assert.ok(captured, '捕获到请求')
    assert.equal(captured!.url, 'https://api.deepseek.com/chat/completions', 'DeepSeek 端点')
    assert.equal(captured!.body.model, 'deepseek-v4-flash-vision-exp', '默认模型 = Exp')
  } finally {
    restoreFetch()
  }
})

test('createVisionProvider：deepseek + 显式 model → 用显式模型', async () => {
  let captured: { body: { model: string } } | null = null
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = { body: JSON.parse(String(init?.body)) as { model: string } }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
  }) as typeof fetch
  const dir = mkdtempSync(join(tmpdir(), 'cos-vision-'))
  const img = join(dir, 'page.png')
  writeFileSync(img, 'fake-png-bytes')
  try {
    const p = createVisionProvider({ provider: 'deepseek', apiKey: 'k', model: 'deepseek-v4-flash-vision-exp-20260821' })
    await p.analyzeImage(img, '提取')
    assert.equal(captured!.body.model, 'deepseek-v4-flash-vision-exp-20260821')
  } finally {
    restoreFetch()
  }
})

test('createVisionProvider：zhipu（缺省）→ 智谱端点 + glm-4.6v-flash', async () => {
  let captured: { url: string; body: { model: string } } | null = null
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(input), body: JSON.parse(String(init?.body)) as { model: string } }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
  }) as typeof fetch
  const dir = mkdtempSync(join(tmpdir(), 'cos-vision-'))
  const img = join(dir, 'page.png')
  writeFileSync(img, 'fake-png-bytes')
  try {
    const p = createVisionProvider({ provider: 'zhipu', apiKey: 'k' })
    await p.analyzeImage(img, '提取')
    assert.equal(captured!.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions', '智谱端点')
    assert.equal(captured!.body.model, 'glm-4.6v-flash', '默认模型 = glm 免费')
  } finally {
    restoreFetch()
  }
})
