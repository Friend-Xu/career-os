/**
 * 外部调用统一封装（Provider Stability v0.1）：Agent 工具链路全部外部 HTTP 调用的
 * 稳定性原语——timeout / 有限重试 / 错误归一 / 调用耗时 trace。
 *
 * 设计边界（v0.1 纪律）：
 * - 只做传输层（请求发起 + 响应等待 + 状态判定）；响应体解析（JSON.parse）与协议细节
 *   （NBS WAF 挑战页识别等）留在调用方——归一化不替调用方做业务判定。
 * - 重试只针对传输层瞬时错误（timeout/network）与 5xx/429；4xx 不重试（auth/参数错误
 *   是永久错误，重试无意义且放大依赖方压力）。
 * - 预算口径：一次逻辑调用（含重试）在 session 层计一次预算——重试是传输层故障处理，
 *   与 Agent 决策调用区分，不重复消耗（对齐「预算治外部成本」语义）。
 * - trace 隐私纪律（延续 web_search）：只记 endpoint 类别标签 + 指标 + 耗时，
 *   不记录 URL 全文与查询内容（trace 文件含任务上下文语义，查询串不外泄）。
 */
import type { Logger } from '../../logger.ts'

export type ExternalCallErrorKind = 'timeout' | 'network' | 'http' | 'unknown'

export class ExternalCallError extends Error {
  readonly kind: ExternalCallErrorKind
  readonly status?: number
  /** 最终 attempt 序号（1 = 初次即失败；>1 = 重试后仍失败） */
  readonly attempts: number
  /** 整个调用（含重试）耗时（ms） */
  readonly durationMs: number
  readonly retryable: boolean

  constructor(kind: ExternalCallErrorKind, message: string, extra: { status?: number; attempts: number; durationMs: number }) {
    super(message)
    this.name = 'ExternalCallError'
    this.kind = kind
    this.status = extra.status
    this.attempts = extra.attempts
    this.durationMs = extra.durationMs
    this.retryable = kind === 'timeout' || kind === 'network' || (extra.status !== undefined && (extra.status === 429 || extra.status >= 500))
  }
}

/** 默认超时（毫秒；NBS/视觉/探测按语义覆盖——见各接入点常量） */
export const DEFAULT_EXTERNAL_CALL_TIMEOUT_MS = 15_000
/** 默认重试次数（初次 + N 次重试；0 = 不重试） */
export const DEFAULT_EXTERNAL_CALL_RETRIES = 1
/** 重试间隔（毫秒；NBS 场景传 600 对齐节流真机安全值） */
export const DEFAULT_EXTERNAL_CALL_RETRY_BACKOFF_MS = 500

export interface ExternalCallOptions {
  /** 单次 attempt 超时（毫秒；缺省 DEFAULT_EXTERNAL_CALL_TIMEOUT_MS） */
  timeoutMs?: number
  /** 重试次数（缺省 DEFAULT_EXTERNAL_CALL_RETRIES） */
  retries?: number
  /** 重试间隔（缺省 DEFAULT_EXTERNAL_CALL_RETRY_BACKOFF_MS） */
  retryBackoffMs?: number
  logger?: Logger
  /** trace 命名空间（与调用方既有 scope 一致，如 'nbs'/'web_search'；缺省 'external'） */
  traceScope?: string
  /** trace 中的端点类别标签（如 'nbs:esData'；不记录完整 URL） */
  endpoint?: string
}

const isTimeout = (err: unknown): boolean => {
  if (err instanceof DOMException && err.name === 'TimeoutError') return true
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return true
  return /timed? ?out|timeout/i.test(err instanceof Error ? err.message : String(err))
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 传输层错误归一（fetch 抛错 / 非 2xx → ExternalCallError；2xx 原样返回 Response 由调用方解析） */
export async function externalFetch(url: string, init: RequestInit, opts: ExternalCallOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXTERNAL_CALL_TIMEOUT_MS
  const retries = opts.retries ?? DEFAULT_EXTERNAL_CALL_RETRIES
  const backoffMs = opts.retryBackoffMs ?? DEFAULT_EXTERNAL_CALL_RETRY_BACKOFF_MS
  const scope = opts.traceScope ?? 'external'
  const startedAt = Date.now()
  let last: ExternalCallError | undefined

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    if (attempt > 1) await sleep(backoffMs)
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) {
        // 错误体摘要随错误消息传播（服务端错误详情有诊断价值：如智谱 1305 限流码、NBS 错误提示）——
        // 摘要限长 200 字符且只取文本前段（错误体无查询内容，隐私面安全）
        const body = await res.text().catch(() => '')
        const summary = body.trim().slice(0, 200)
        last = new ExternalCallError('http', `外部服务响应 ${res.status}${summary !== '' ? `：${summary}` : ''}`, {
          status: res.status,
          attempts: attempt,
          durationMs: Date.now() - startedAt,
        })
      } else {
        opts.logger?.trace(scope, {
          event: 'http_call',
          endpoint: opts.endpoint ?? null,
          ok: true,
          attempts: attempt,
          durationMs: Date.now() - startedAt,
          status: res.status,
        })
        return res
      }
    } catch (err) {
      if (isTimeout(err)) {
        const secs = Math.round(timeoutMs / 1000)
        const label = secs >= 1 ? `${secs}s` : `${timeoutMs}ms`
        last = new ExternalCallError('timeout', `外部服务响应超时（${label} 无响应）`, {
          attempts: attempt,
          durationMs: Date.now() - startedAt,
        })
      } else if (err instanceof ExternalCallError) {
        last = err
      } else {
        last = new ExternalCallError('network', '外部服务网络连接失败', {
          attempts: attempt,
          durationMs: Date.now() - startedAt,
        })
      }
    }
    // 重试判定：可重试类且未耗尽重试次数
    if (attempt <= retries && last.retryable) continue
    break
  }

  const final = last as ExternalCallError
  opts.logger?.trace(scope, {
    event: 'http_call',
    endpoint: opts.endpoint ?? null,
    ok: false,
    attempts: final.attempts,
    durationMs: final.durationMs,
    kind: final.kind,
    ...(final.status !== undefined ? { status: final.status } : {}),
  })
  throw final
}
