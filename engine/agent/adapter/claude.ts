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
import type { AgentError, AgentQuestion } from '../../ir/schema.ts'
import type { Logger } from '../../logger.ts'

// ─── 归一化事件（编排层/前端只消费这些）──────────────────────────────────────

export type { AgentQuestion }

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_done'; name: string }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_stop' }
  | { type: 'permission_request'; tool: string; canUseTool: () => Promise<boolean> }
  | { type: 'question_request'; question: AgentQuestion }
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
  model?: string // 模型覆盖（config.agent.model，缺省用 CLI 默认）
  /** API 密钥：传则走 API 模式（SDK options.apiKey）；留空复用本机 claude CLI 登录态 */
  apiKey?: string
  /** API 端点根地址（SDK options.baseURL）；留空 = 官方 */
  baseUrl?: string
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

// ─── createAgent：SDK 事件 → AgentEvent（含 AskUserQuestion 回答通道）────────

interface PendingPermission {
  tool: string
  promise: Promise<boolean> // 决策结果（SDK 回调与事件消费方共同 await）
  resolve: (ok: boolean) => void
}

export interface AgentHandle {
  events: AsyncIterable<AgentEvent>
  /** 回答 AskUserQuestion（实测 2026-08-03：streamInput yield 文本 user 消息即被 CLI 当作回答） */
  answer(text: string): void
}

/** 提取 AskUserQuestion 形状（SDK 0.3.220：user 消息的 tool_use_result.questions[]） */
function parseQuestions(msg: unknown): AgentQuestion[] {
  const m = msg as { tool_use_result?: { questions?: unknown[] } }
  const qs = m.tool_use_result?.questions
  if (!Array.isArray(qs)) return []
  const out: AgentQuestion[] = []
  for (const q of qs) {
    const raw = q as { question?: string; header?: string; options?: { label?: string; description?: string }[]; multiSelect?: boolean }
    if (typeof raw.question !== 'string') continue
    out.push({
      question: raw.question,
      header: raw.header,
      options: (raw.options ?? []).map((o) => ({ label: o.label ?? '', description: o.description })),
      multiSelect: raw.multiSelect === true,
    })
  }
  return out
}

/**
 * 创建一次 Agent 任务：SDK 事件流 → 归一化 AgentEvent（生成器随 CLI 会话结束自然完成）。
 * 与旧 query() 生成器等价，另提供 answer() 回答 AskUserQuestion（内部 streamInput 通道）。
 *
 * 权限握手实现说明：SDK 对 can_use_tool control_request 是 fire-and-forget 派发
 * （不阻塞消息流），但 CLI 在收到 control_response 前会停止产出新帧，正在拉取
 * 的 next() 因此挂起。这里将 SDK 拉取与"权限入队"信号赛跑：canUseTool 回调入队
 * 时唤醒等待中的拉取，生成器转去抛 permission_request 事件并 await 决策；被挂起
 * 的 next() 不丢弃——决策完成、CLI 恢复后，用同一个 in-flight pull 重新赛跑取回
 * 后续消息（AsyncIterator 协议会串行化挂起的 next()，消息不会丢失）。
 */
export function createAgent(opts: QueryOptions, onSessionId?: (id: string) => void): AgentHandle {
  const startedAt = Date.now()
  const logger = opts.logger
  const pending: PendingPermission[] = []
  let signalResolve: (() => void) | null = null

  // AskUserQuestion 回答通道：持续打开的输入流，answer() 推入待发队列
  const answers: unknown[] = []
  const inputStream = (async function* () {
    for (;;) {
      if (answers.length > 0) yield answers.shift()
      await new Promise((r) => setTimeout(r, 50))
    }
  })()

  const canUseTool: CanUseTool = (toolName) => {
    // AskUserQuestion 是交互卡片不是危险操作：实测必须 allow（返回 null → CLI 静默挂起 60s 无消息）
    if (toolName === 'AskUserQuestion') return Promise.resolve({ behavior: 'allow' })
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
    model: opts.model,
    ...(opts.apiKey !== undefined && opts.apiKey !== '' ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseUrl !== undefined && opts.baseUrl !== '' ? { baseURL: opts.baseUrl } : {}),
    // 管道模式实测 AskUserQuestion 会立即跳过（tool_use_result 已含 "did not answer"）：
    // 显式给 10 分钟等待窗口，回答（前端点击）才来得及送达
    askUserQuestionTimeout: '10m',
    permissionMode: opts.permissionMode === undefined ? undefined : SDK_PERMISSION_MODE[opts.permissionMode],
    allowDangerouslySkipPermissions: opts.permissionMode === 'bypassPermissions',
    abortController: opts.abortController,
    canUseTool,
  }
  const sdk = sdkQuery({
    prompt: opts.context === undefined ? opts.task : `${opts.task}\n\n${opts.context}`,
    options: sdkOptions,
  })
  void sdk.streamInput(inputStream)

  const events = (async function* (): AsyncIterable<AgentEvent> {
    const iter = sdk[Symbol.asyncIterator]()

    let sessionId: string | undefined
    let assistantError: SDKAssistantMessageError | undefined
    const toolNames = new Map<string, string>() // tool_use_id → 工具名（tool_done 反查 / 去重）
    let sawTextDeltas = false // 本轮是否已走 stream_event 增量（assistant 整段文本不再重复发）
    let pull: Promise<IteratorResult<SDKMessage, void>> | null = null
    let finalResult: string | undefined
    let finalError: AgentError | undefined
    // 思考阶段（thinking_* 事件）：信号源双路径——system thinking_tokens（思考期间
    // 实时到达，最先触发）与 thinking 内容块（本机 CLI 在完整 assistant 消息里带全文）
    let thinkingActive = false
    function* endThinking(): Generator<AgentEvent, void, unknown> {
      if (thinkingActive) {
        thinkingActive = false
        yield { type: 'thinking_stop' }
      }
    }
    function* beginThinking(): Generator<AgentEvent, void, unknown> {
      if (!thinkingActive) {
        thinkingActive = true
        yield { type: 'thinking_start' }
      }
    }

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
          case 'system': {
            // thinking_tokens：思考阶段的实时进度信号（token 估算），最先到达 → 思考提示
            if (msg.subtype === 'thinking_tokens') yield* beginThinking()
            break
          }
          case 'stream_event': {
            const ev = msg.event
            if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
              if (!toolNames.has(ev.content_block.id)) {
                toolNames.set(ev.content_block.id, ev.content_block.name)
                yield* endThinking()
                yield { type: 'tool_start', name: ev.content_block.name }
              }
            } else if (ev.type === 'content_block_start' && ev.content_block.type === 'thinking') {
              yield* beginThinking()
            } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
              sawTextDeltas = true
              yield* endThinking()
              yield { type: 'text_delta', text: ev.delta.text }
            } else if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta') {
              yield* beginThinking()
              if (typeof ev.delta.thinking === 'string' && ev.delta.thinking.length > 0) {
                yield { type: 'thinking_delta', text: ev.delta.thinking }
              }
            }
            break
          }
          case 'assistant': {
            if (msg.error !== undefined) assistantError = msg.error
            for (const block of msg.message.content) {
              if (block.type === 'thinking') {
                // 本机 CLI：thinking 块带全文，整段到达（stream 路径由 thinking_delta 增量承接）
                yield* beginThinking()
                if (typeof block.thinking === 'string' && block.thinking.length > 0) {
                  yield { type: 'thinking_delta', text: block.thinking }
                }
                yield* endThinking()
              } else if (block.type === 'tool_use') {
                if (!toolNames.has(block.id)) {
                  toolNames.set(block.id, block.name)
                  yield* endThinking()
                  yield { type: 'tool_start', name: block.name }
                }
              } else if (block.type === 'text' && !sawTextDeltas) {
                yield* endThinking()
                yield { type: 'text_delta', text: block.text }
              }
            }
            sawTextDeltas = false // 本轮结束，下轮重新判定
            break
          }
          case 'user': {
            yield* endThinking()
            const content = msg.message.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_result') {
                  const name = toolNames.get(block.tool_use_id)
                  if (name !== undefined) yield { type: 'tool_done', name }
                }
              }
            }
            // AskUserQuestion 卡片（实测：tool_use_result.questions[]；每个问题一条事件）
            for (const q of parseQuestions(msg)) yield { type: 'question_request', question: q }
            break
          }
          case 'result': {
            yield* endThinking()
            // result 是中间态：AskUserQuestion 空闲跳过也会产 result，CLI 继续运行
            //（实测 2026-08-03：回答后还有新一轮 assistant → result）。success 更新 finalResult 继续迭代；
            // 失败才终止。
            if (msg.subtype === 'success') {
              finalResult = msg.result
            } else {
              finalError = mapResultError(msg, assistantError)
              yield { type: 'error', error: finalError }
              return
            }
            break
          }
          default:
            break // system/status/hook 等内部消息不归一化
        }
      }
      // 4. 流自然结束（CLI 会话关闭）：以最后状态收尾
      yield* endThinking()
      if (finalError !== undefined) yield { type: 'error', error: finalError }
      else yield { type: 'done', result: finalResult ?? '' }
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
  })()

  return {
    events,
    answer(text) {
      answers.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
      })
    },
  }
}

/** 兼容入口：query() 生成器 = createAgent 的事件流（smoke 测试用） */
export async function* query(opts: QueryOptions, onSessionId?: (id: string) => void): AsyncIterable<AgentEvent> {
  const handle = createAgent(opts, onSessionId)
  for await (const ev of handle.events) yield ev
}
