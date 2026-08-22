/**
 * AgentRunner 能力面（ADR-030 两条路径之二）：task → AsyncIterable<AgentEvent>（多轮工具工作流）。
 * - 底层 = Vercel AI SDK streamText（工具循环在进程内；无 CLI/无登录态/无代理）
 * - 事件归一化与 claude adapter 同形状（AgentHandle { events, answer }）——AgentRuntime/UI 零改动
 * - 工具集 = allowedTools ∩ 文件工具（Read/Write/Edit/Grep/Glob）+ ask_user_question（恒可用，
 *   对齐旧 CLI 对 AskUserQuestion 的特殊放行）
 * - resume 语义：直连模式不消费 resumeSessionId（ADR-030：上下文由引擎按 Artifact 全量重建）
 */
import { APICallError, stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import type { LanguageModel, Tool } from 'ai'
import type { AgentError, AgentQuestion } from '../../ir/schema.ts'
import type { Logger } from '../../logger.ts'
import type { Workspace } from '../../storage/workspace.ts'
import type { AgentEvent, AgentHandle } from '../adapter/claude.ts'
import { buildFsTools } from '../tools/fs-tools.ts'
import { buildWebSearchTool, type WebSearchProvider } from '../tools/web-search.ts'

export interface AgentRunnerOptions {
  task: string
  context?: string
  model: LanguageModel
  workspace: Workspace
  allowedTools: string[]
  permissionMode: 'acceptEdits' | 'ask' | 'bypassPermissions'
  maxTurns?: number
  /** 单步输出预算（token；Control Plane 按 Stage Policy 下发——见 workflow-registry StageSpec.task.outputBudget）。
   *  缺省 8_000 = 通用默认；不随模型成本策略变化。 */
  outputBudget?: number
  abortController?: AbortController
  logger?: Logger
  /** 权限决策源（permissionMode='ask' 时文件工具执行前询问）；缺省 = 直接放行 */
  onPermissionRequest?: (toolName: string) => Promise<boolean>
  /** WebSearch 工具所需 provider（缺省 = 不注册该工具——allowedTools 白名单交集自然排除） */
  webSearch?: WebSearchProvider
}

interface PendingQuestion {
  question: AgentQuestion
  resolve: (text: string) => void
}

/** 解析 ask_user_question 工具入参（外部输入边界校验：形状非法 → 错误文本回给模型） */
function parseQuestionInput(input: unknown): AgentQuestion | string {
  if (typeof input !== 'object' || input === null) return '参数应为对象'
  const p = input as Record<string, unknown>
  if (typeof p.question !== 'string' || p.question.trim().length === 0) return 'question 必须是非空字符串'
  const options = Array.isArray(p.options) ? p.options : []
  const opts: { label: string; description?: string }[] = []
  for (const o of options) {
    const rec = (typeof o === 'object' && o !== null ? o : {}) as Record<string, unknown>
    if (typeof rec.label !== 'string') return 'options[] 每项需 { label } 对象'
    opts.push({ label: rec.label, ...(typeof rec.description === 'string' ? { description: rec.description } : {}) })
  }
  return {
    question: p.question.trim(),
    ...(typeof p.header === 'string' && p.header.trim() !== '' ? { header: p.header.trim() } : {}),
    options: opts,
    multiSelect: p.multiSelect === true,
  }
}

function mapRunnerError(err: unknown, aborted: boolean): AgentError {
  if (aborted) return { code: 'cancelled', message: '任务已取消', retryable: false }
  if (err instanceof APICallError) {
    return {
      code: 'api_error',
      message: `API 调用失败：${err.message}`,
      retryable: err.isRetryable,
    }
  }
  const m = err instanceof Error ? err.message : String(err)
  if (/timeout|timed out/i.test(m)) return { code: 'timeout', message: m, retryable: true }
  return { code: 'unknown', message: m, retryable: true }
}

export function createAgentRunner(opts: AgentRunnerOptions): AgentHandle {
  const startedAt = Date.now()
  const logger = opts.logger
  const aborted = () => opts.abortController?.signal.aborted === true

  // ─── 事件队列（streamText 回调在 await 期间产生事件，生成器从队列消费）──────
  const queue: AgentEvent[] = []
  let wake: (() => void) | null = null
  let closed = false
  const push = (ev: AgentEvent): void => {
    if (closed) return
    queue.push(ev)
    wake?.()
    wake = null
  }
  const close = (): void => {
    closed = true
    wake?.()
    wake = null
  }
  const next = (): Promise<AgentEvent | undefined> => {
    const take = (): AgentEvent | undefined => (queue.length > 0 ? queue.shift() : undefined)
    const got = take()
    if (got !== undefined || closed) return Promise.resolve(got)
    return new Promise((resolve) => {
      wake = () => resolve(take())
    })
  }

  // ─── 提问通道（对齐 claude adapter 的 answer() 语义）───────────────────────
  let pending: PendingQuestion | null = null
  const answer = (text: string): void => {
    if (pending !== null) {
      pending.resolve(text)
      pending = null
    }
    // 无待答提问的 answer 忽略（提问卡片流程决定调用时序）
  }

  // ─── 工具集：allowedTools ∩ {文件工具 + WebSearch} + ask_user_question（恒可用）──────
  const fsTools = buildFsTools(opts.workspace)
  const tools: Record<string, Tool<any, any>> = {}
  for (const name of opts.allowedTools) {
    if (fsTools[name] !== undefined) tools[name] = fsTools[name]
    else if (name === 'WebSearch' && opts.webSearch !== undefined) tools[name] = buildWebSearchTool(opts.webSearch)
  }
  const askUserQuestion = tool({
    description: '向用户提问（多选项卡片；await 用户选择后返回答案文本）',
    inputSchema: z.object({
      question: z.string().describe('问题正文'),
      header: z.string().optional().describe('卡片标题'),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional().describe('选项列表'),
      multiSelect: z.boolean().optional().describe('是否多选'),
    }),
    execute: async (input) => {
      const parsed = parseQuestionInput(input)
      if (typeof parsed === 'string') return parsed
      push({ type: 'question_request', question: parsed })
      return new Promise<string>((resolve) => {
        pending = { question: parsed, resolve }
      })
    },
  })
  tools.ask_user_question = askUserQuestion

  const executeGuarded = async (name: string, exec: () => PromiseLike<string>): Promise<string> => {
    if (opts.permissionMode === 'ask' && opts.onPermissionRequest !== undefined) {
      const ok = await opts.onPermissionRequest(name)
      if (!ok) return '用户拒绝了工具调用'
    }
    return exec()
  }
  const wrappedTools: Record<string, Tool<any, any>> = {}
  for (const [name, t] of Object.entries(tools)) {
    const exec = t.execute
    wrappedTools[name] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
      execute: (input, options) =>
        executeGuarded(name, () => {
          if (exec === undefined) throw new Error(`${name} 工具未注册 execute（注册不变量被破坏）`)
          return exec(input, options)
        }),
    })
  }
  // 提问卡片不是危险操作：恒放行，不过权限闸（对齐旧 CLI 对 AskUserQuestion 的特殊放行）
  wrappedTools.ask_user_question = askUserQuestion

  // 无 maxTurns（工作流默认，CLI 时代 = 无限）时的步数护栏：工具调用是唯一循环燃料，
  // 模型异常自我循环会无限消耗——上限 25 步（单阶段工作流实测工具轮次 <10，余量充足）
  const MAX_STEPS = 25

  // ─── 事件生成器 ────────────────────────────────────────────────────────────
  const events = (async function* (): AsyncIterable<AgentEvent> {
    const toolStarted = new Set<string>()
    let finalError: AgentError | undefined
    try {
      const prompt = opts.context === undefined ? opts.task : `${opts.task}\n\n${opts.context}`
      const stream = streamText({
        model: opts.model,
        prompt,
        tools: wrappedTools,
        // 显式输出上限：@ai-sdk/anthropic 对未知模型走兼容模式时默认 4096（实测会截断长任务——
        // 工具调用 JSON 被切断 → 任务看似 done 实则未写产物）。DeepSeek 支持 8K 输出。
        // 预算来源：Stage Policy（Control Plane 按阶段下发；成本优化与防截断的同一旋钮）
        maxOutputTokens: opts.outputBudget ?? 8_000,
        // maxTurns → 步数上限；未设（工作流默认）→ 25 步护栏（防模型自我循环）。
        // v7 默认 stopWhen = stepCountIs(1)，工具循环会一步即停，必须显式覆盖）
        stopWhen: stepCountIs(opts.maxTurns ?? MAX_STEPS),
        ...(opts.abortController !== undefined ? { abortSignal: opts.abortController.signal } : {}),
        onChunk: ({ chunk }) => {
          if (chunk.type === 'text-delta') {
            push({ type: 'text_delta', text: chunk.text })
          } else if (chunk.type === 'tool-call') {
            // 只报告已注册工具（未注册调用由 SDK 自动回错误结果，不上报 tool_start——避免误导 UI）
            if (!toolStarted.has(chunk.toolCallId) && chunk.toolName in wrappedTools) {
              toolStarted.add(chunk.toolCallId)
              push({ type: 'tool_start', name: chunk.toolName })
            }
          }
        },
        onStepFinish: ({ toolCalls }) => {
          for (const call of toolCalls) {
            if (call.toolName in wrappedTools) push({ type: 'tool_done', name: call.toolName })
          }
        },
      })

      void (async () => {
        try {
          const text = await stream.text
          push({ type: 'done', result: text })
        } catch (err) {
          finalError = mapRunnerError(err, aborted())
          push({ type: 'error', error: finalError })
        } finally {
          close()
        }
      })()

      for (;;) {
        const ev = await next()
        if (ev === undefined) break
        yield ev
      }
    } catch (err) {
      // stream.text 的 reject 已由上方 .catch 推送 error 事件；此处只兜住生成器自身的同步异常
      if (finalError === undefined) {
        finalError = mapRunnerError(err, aborted())
        yield { type: 'error', error: finalError }
      }
    } finally {
      close()
      if (logger !== undefined) {
        logger.trace('direct', {
          event: 'query_complete',
          sessionId: null,
          task: opts.task,
          contextLength: opts.context?.length ?? 0,
          cwd: opts.workspace.paths.root,
          permissionMode: opts.permissionMode,
          resume: null,
          maxTurns: opts.maxTurns ?? null,
          durationMs: Date.now() - startedAt,
          ok: finalError === undefined,
          error: finalError ?? null,
        })
      }
    }
  })()

  return { events, answer }
}
