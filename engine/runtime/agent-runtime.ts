/**
 * Agent 运行时（第 4 步收尾）：任务注册表 + 事件循环 + 权限/提问/取消往返。
 * - 职责：Agent 是能力提供者——start() 创建任务（config 默认值合并），消费 createAgent
 *   事件流并转成可过 WS 的 AgentRuntimeEvent（permission_request 换为 requestId，canUseTool
 *   promise 留在挂起表）；answer/cancel/permission 三个 RPC 入口驱动任务。
 * - 生命周期：done/error → 清理任务；cancel → AbortController.abort()。
 * - 权限：onPermissionRequest 返回挂起 promise，permission() 决策后 resolve（前端弹窗往返）。
 * - AskUserQuestion：adapter 侧直接 allow（卡片不是危险操作），question_request 事件带结构化问题。
 * - 事件推送：构造时注入 emit(taskId, ev) 回调（websocket 广播 agent.event）。
 */
import { createAgent, type AgentHandle, type AgentEvent, type AgentQuestion } from '../agent/adapter/claude.ts'
import type { AgentError } from '../ir/schema.ts'
import type { Logger } from '../logger.ts'

/** 引擎 → 前端的事件（过 WS：canUseTool 已替换为 requestId；session_id 供 resume 存前端会话） */
export type AgentRuntimeEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_done'; name: string }
  | { type: 'permission_request'; tool: string; requestId: string }
  | { type: 'question_request'; question: AgentQuestion }
  | { type: 'session_id'; sessionId: string }
  | { type: 'done'; result: string }
  | { type: 'error'; error: AgentError }

export interface AgentStartParams {
  task: string
  context?: string
  resumeSessionId?: string
  permissionMode?: 'acceptEdits' | 'ask' | 'bypassPermissions'
  allowedTools?: string[]
  maxTurns?: number
}

/** config.agent 默认值（start 时合并；前端不传则用引擎配置） */
export interface AgentDefaults {
  permissionMode: 'acceptEdits' | 'ask' | 'bypassPermissions'
  allowedTools: string[]
  maxTurns?: number
  model?: string
}

interface TaskState {
  handle: AgentHandle
  abort: AbortController
  sessionId?: string
  pendingPermissions: Map<string, (ok: boolean) => void>
}

export class AgentRuntime {
  private tasks = new Map<string, TaskState>()
  private permissionSeq = 0
  private logger: Logger
  private emit: (taskId: string, ev: AgentRuntimeEvent) => void

  constructor(logger: Logger, emit: (taskId: string, ev: AgentRuntimeEvent) => void) {
    this.logger = logger
    this.emit = emit
  }

  start(params: AgentStartParams, defaults: AgentDefaults, cwd: string): string {
    const taskId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const abort = new AbortController()
    const task: TaskState = { handle: undefined as unknown as AgentHandle, abort, pendingPermissions: new Map() }

    const handle = createAgent(
      {
        task: params.task,
        context: params.context,
        cwd,
        resumeSessionId: params.resumeSessionId,
        permissionMode: params.permissionMode ?? defaults.permissionMode,
        allowedTools: params.allowedTools ?? defaults.allowedTools,
        maxTurns: params.maxTurns ?? defaults.maxTurns,
        model: defaults.model,
        abortController: abort,
        logger: this.logger,
        onPermissionRequest: (tool) =>
          new Promise<boolean>((resolve) => {
            const requestId = `p-${++this.permissionSeq}`
            task.pendingPermissions.set(requestId, resolve)
            this.emit(taskId, { type: 'permission_request', tool, requestId })
          }),
      },
      (sessionId) => {
        task.sessionId = sessionId
        this.emit(taskId, { type: 'session_id', sessionId })
      },
    )
    task.handle = handle
    this.tasks.set(taskId, task)
    void this.runLoop(taskId)
    return taskId
  }

  private async runLoop(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return
    try {
      for await (const ev of task.handle.events) {
        this.forward(taskId, ev)
      }
    } catch (err) {
      this.logger.error(`agent/${taskId} 事件循环异常：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.tasks.delete(taskId)
    }
  }

  /** adapter 事件 → WS 可传事件（permission_request 已由 onPermissionRequest 转发带 requestId 版本） */
  private forward(taskId: string, ev: AgentEvent): void {
    switch (ev.type) {
      // 不转发：start 的 onPermissionRequest 已 emit { tool, requestId } 给前端（adapter
      // yield 此事件后立即 await 该回调，一一对应；canUseTool promise 由挂起表持有）
      case 'permission_request':
        break
      case 'question_request':
        this.emit(taskId, { type: 'question_request', question: ev.question })
        break
      case 'done':
        this.emit(taskId, { type: 'done', result: ev.result })
        break
      case 'error':
        this.emit(taskId, { type: 'error', error: ev.error })
        break
      case 'text_delta':
      case 'tool_start':
      case 'tool_done':
        this.emit(taskId, ev)
        break
    }
  }

  answer(taskId: string, text: string): void {
    this.tasks.get(taskId)?.handle.answer(text)
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.abort.abort()
    // 挂起中的权限决策视为拒绝（解挂 SDK 回调）
    for (const resolve of task.pendingPermissions.values()) resolve(false)
    task.pendingPermissions.clear()
  }

  permission(taskId: string, requestId: string, allow: boolean): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    const resolve = task.pendingPermissions.get(requestId)
    if (resolve === undefined) return // 未知 requestId（已决策/任务结束）→ 忽略
    task.pendingPermissions.delete(requestId)
    resolve(allow)
  }
}
