/**
 * Agent 适配层：claude-agent-sdk 封装（落地顺序第 4 步提前）。
 *
 * 职责：SDK 事件流 → IR 归一化事件流（text_delta / tool_start / tool_done /
 * permission_request / done / error）。编排层只消费这些事件，不感知 SDK 形状。
 *
 * - 权限：SDK canUseTool 回调与事件流握手——权限请求经 permission_request
 *   事件抛出，决策来自 QueryOptions.onPermissionRequest（前端弹窗批准/拒绝），
 *   本模块只负责抛事件并 await 决策。
 * - 会话：session_id 在首条消息捕获，经 onSessionId 回调暴露（resume 续接用）。
 * - 认证：复用本地 claude CLI 登录态（不传 apiKey）。
 * - 轨迹：每次 query 一条 logger.trace（logs/traces/{sessionId}-{ts}.jsonl）。
 *
 * 仅 erasable syntax（Node 24 type-stripping），相对 import 带 .ts 扩展名。
 */
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import type {
  CanUseTool,
  Options,
  SDKAssistantMessageError,
  SDKMessage,
  SDKResultError,
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentError } from '../../ir/schema.ts'
import type { Logger } from '../../logger.ts'

// ─── 归一化事件（编排层/前端只消费这些）──────────────────────────────────────

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_done'; name: string }
  | { type: 'permission_request'; tool: string; canUseTool: () => Promise<boolean> }
  | { type: 'done'; result: string }
  | { type: 'error'; error: AgentError }

export interface QueryOptions {
  task: string // 任务指令（task-planner 产出）
  context?: string // 上下文组装文本（context-builder 产出）
  cwd: string // 工作目录（workspace 根，技能加载靠它）
  resumeSessionId?: string // 续接会话（SDK options.resume）
  permissionMode?: 'acceptEdits' | 'ask' | 'bypassPermissions'
  allowedTools?: string[]
  maxTurns?: number
  abortController?: AbortController // 取消 → AgentError 'cancelled'
  /** 权限决策源：permission_request 事件抛出后，模块 await 此回调的决策（true=放行/false=拒绝）。缺省时权限请求交由 SDK 默认处理（不抛事件）。 */
  onPermissionRequest?: (tool: string) => Promise<boolean>
  logger?: Logger // Agent 轨迹（缺省不记录）
}

// 引擎 permissionMode → SDK permissionMode（引擎 'ask' = SDK 'default'：
// 未在 allowedTools 放行的工具经 canUseTool 回调升权限询问）
const SDK_PERMISSION_MODE: Record<NonNullable<QueryOptions['permissionMode']>, Options['permissionMode']> = {
  acceptEdits: 'acceptEdits',
  ask: 'default',
  bypassPermissions: 'bypassPermissions',
}

// ─── AgentError 映射（SDK 错误 → IR 契约）──────────────────────────────────

const AUTH_API_ERRORS = new Set<SDKAssistantMessageError>(['authentication_failed', 'oauth_org_not_allowed', 'billing_error'])
const RETRYABLE_API_ERRORS = new Set<SDKAssistantMessageError>(['rate_limit', 'overloaded', 'server_error'])

function mapAssistantError(err: SDKAssistantMessageError): AgentError {
  if (AUTH_API_ERRORS.has(err)) return { code: 'api_error', message: `API 认证或计费失败：${err}`, retryable: false }
  if (RETRYABLE_API_ERRORS.has(err)) return { code: 'api_error', message: `API 暂时不可用：${err}`, retryable: true }
  if (err === 'invalid_request' || err === 'model_not_found') {
    return { code: 'api_error', message: `API 请求非法：${err}`, retryable: false }
  }
  if (err === 'max_output_tokens') return { code: 'api_error', message: '输出超出 token 上限', retryable: false }
  return { code: 'unknown', message: 'API 未知错误', retryable: true }
}

function mapResultError(msg: SDKResultError, assistantError?: SDKAssistantMessageError): AgentError {
  if (msg.permission_denials.length > 0) {
    return { code: 'permission_denied', message: '用户拒绝了工具权限请求，任务未完成', retryable: false }
  }
  if (assistantError !== undefined) return mapAssistantError(assistantError)
  const firstError = msg.errors[0] ?? msg.subtype
  switch (msg.subtype) {
    case 'error_max_turns':
    case 'error_max_budget_usd':
      return { code: 'timeout', message: `运行超限：${firstError}`, retryable: true }
    case 'error_during_execution':
    case 'error_max_structured_output_retries':
    default:
      return { code: 'tool_failed', message: firstError, retryable: true }
  }
}

function mapThrownError(err: unknown): AgentError {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return { code: 'cancelled', message: '任务已取消', retryable: false }
    const m = err.message
    if (/auth|permission|login/i.test(m)) return { code: 'api_error', message: m, retryable: false }
    if (/timeout|timed out/i.test(m)) return { code: 'timeout', message: m, retryable: true }
    return { code: 'unknown', message: m, retryable: true }
  }
  return { code: 'unknown', message: String(err), retryable: true }
}

// ─── query：SDK 事件 → AgentEvent ──────────────────────────────────────────

interface PendingPermission {
  tool: string
  promise: Promise<boolean> // 决策结果（SDK 回调与事件消费方共同 await）
  resolve: (ok: boolean) => void
}

/**
 * 流式执行一次 Agent 任务。第二参数 onSessionId 在捕获到 session_id 时回调
 * （首条 SDK 消息即含；resume 续接时即被续接会话的 id）。
 *
 * 权限握手实现说明：SDK 对 can_use_tool control_request 是 fire-and-forget 派发
 * （不阻塞消息流），但 CLI 在收到 control_response 前会停止产出新帧，正在拉取
 * 的 next() 因此挂起。这里将 SDK 拉取与"权限入队"信号赛跑：canUseTool 回调入队
 * 时唤醒等待中的拉取，生成器转去抛 permission_request 事件并 await 决策；被挂起
 * 的 next() 不丢弃——决策完成、CLI 恢复后，用同一个 in-flight pull 重新赛跑取回
 * 后续消息（AsyncIterator 协议会串行化挂起的 next()，消息不会丢失）。
 */
export async function* query(opts: QueryOptions, onSessionId?: (id: string) => void): AsyncIterable<AgentEvent> {
  const startedAt = Date.now()
  const logger = opts.logger
  const pending: PendingPermission[] = []
  let signalResolve: (() => void) | null = null

  const canUseTool: CanUseTool = (toolName) => {
    if (opts.onPermissionRequest === undefined) return Promise.resolve(null) // 无决策源 → SDK 默认处理
    let resolve: (ok: boolean) => void = () => {}
    const promise = new Promise<boolean>((r) => {
      resolve = r
    })
    pending.push({ tool: toolName, promise, resolve })
    signalResolve?.()
    signalResolve = null
    return promise.then((ok) => (ok ? { behavior: 'allow' } : { behavior: 'deny', message: '用户拒绝了工具调用' }))
  }

  const sdkOptions: Options = {
    cwd: opts.cwd,
    allowedTools: opts.allowedTools,
    maxTurns: opts.maxTurns,
    resume: opts.resumeSessionId,
    permissionMode: opts.permissionMode === undefined ? undefined : SDK_PERMISSION_MODE[opts.permissionMode],
    allowDangerouslySkipPermissions: opts.permissionMode === 'bypassPermissions',
    abortController: opts.abortController,
    canUseTool,
  }
  const sdk = sdkQuery({
    prompt: opts.context === undefined ? opts.task : `${opts.task}\n\n${opts.context}`,
    options: sdkOptions,
  })
  const iter = sdk[Symbol.asyncIterator]()

  let sessionId: string | undefined
  let assistantError: SDKAssistantMessageError | undefined
  const toolNames = new Map<string, string>() // tool_use_id → 工具名（tool_done 反查 / 去重）
  let sawTextDeltas = false // 本轮是否已走 stream_event 增量（assistant 整段文本不再重复发）
  let pull: Promise<IteratorResult<SDKMessage, void>> | null = null
  let finalResult: string | undefined
  let finalError: AgentError | undefined

  try {
    for (;;) {
      // 1. 清空待决权限（可多枚 in-flight）：逐个抛事件 → await 决策 → 回填 SDK 回调
      while (pending.length > 0) {
        const req = pending.shift()!
        yield { type: 'permission_request', tool: req.tool, canUseTool: () => req.promise }
        const ok = await opts.onPermissionRequest!(req.tool)
        req.resolve(ok)
      }

      // 2. 拉取 SDK 消息，与"权限入队"信号赛跑
      if (pull === null) pull = iter.next()
      const signal = new Promise<null>((resolve) => {
        signalResolve = () => resolve(null)
      })
      const outcome = await Promise.race([pull, signal])
      if (outcome === null) continue // 权限信号优先 → 回到顶部抛事件
      pull = null
      signalResolve = null
      if (outcome.done) break

      // 3. 归一化（双路径：部分 CLI 发 stream_event 增量，本机 CLI 发完整 assistant 消息；按轮去重）
      const msg = outcome.value
      if (sessionId === undefined && msg.session_id !== undefined) {
        sessionId = msg.session_id
        onSessionId?.(sessionId)
      }
      switch (msg.type) {
        case 'stream_event': {
          const ev = msg.event
          if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
            if (!toolNames.has(ev.content_block.id)) {
              toolNames.set(ev.content_block.id, ev.content_block.name)
              yield { type: 'tool_start', name: ev.content_block.name }
            }
          } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            sawTextDeltas = true
            yield { type: 'text_delta', text: ev.delta.text }
          }
          break
        }
        case 'assistant': {
          if (msg.error !== undefined) assistantError = msg.error
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              if (!toolNames.has(block.id)) {
                toolNames.set(block.id, block.name)
                yield { type: 'tool_start', name: block.name }
              }
            } else if (block.type === 'text' && !sawTextDeltas) {
              yield { type: 'text_delta', text: block.text }
            }
          }
          sawTextDeltas = false // 本轮结束，下轮重新判定
          break
        }
        case 'user': {
          const content = msg.message.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const name = toolNames.get(block.tool_use_id)
                if (name !== undefined) yield { type: 'tool_done', name }
              }
            }
          }
          break
        }
        case 'result': {
          if (msg.subtype === 'success') {
            finalResult = msg.result
            yield { type: 'done', result: msg.result }
          } else {
            finalError = mapResultError(msg, assistantError)
            yield { type: 'error', error: finalError }
          }
          return
        }
        default:
          break // system/status/hook 等内部消息不归一化
      }
    }
  } catch (err) {
    finalError = mapThrownError(err)
    yield { type: 'error', error: finalError }
  } finally {
    // 清理：回填未决权限（解挂 SDK 回调），终止 CLI 进程
    for (const req of pending) req.resolve(false)
    sdk.close()
    // Agent 轨迹：每次 query 一条（请求摘要 + 最终结果）
    if (logger !== undefined) {
      logger.trace(sessionId ?? 'unknown', {
        event: 'query_complete',
        sessionId: sessionId ?? null,
        task: opts.task,
        contextLength: opts.context?.length ?? 0,
        cwd: opts.cwd,
        permissionMode: opts.permissionMode ?? 'default',
        resume: opts.resumeSessionId ?? null,
        maxTurns: opts.maxTurns ?? null,
        durationMs: Date.now() - startedAt,
        ok: finalError === undefined,
        result: finalResult ?? null,
        error: finalError ?? null,
      })
    }
  }
}
