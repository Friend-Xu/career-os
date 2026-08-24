import type { ChatMessage } from '../types'
import type { Execution } from '../../engine/ir/execution.ts'

/**
 * Agent 任务执行阶段——UI 展示的辅助文案，与「任务运行中」（activeTask）分层：
 * running 是任务级状态（停止按钮同源），phase 只是当前正在做什么。
 * 推导自流式占位消息的实时字段，不引入新事件协议。
 */
export type AgentPhase = 'thinking' | 'tool' | 'waiting_approval' | 'generating' | 'running'

export function deriveAgentPhase(msg: ChatMessage): AgentPhase {
  if (msg.toolCalls?.some((t) => t.status === 'waiting_approval')) return 'waiting_approval'
  if (msg.toolCalls?.some((t) => t.status === 'running')) return 'tool'
  if (msg.isThinking) return 'thinking'
  if (msg.content) return 'generating'
  return 'running'
}

export const PHASE_META: Record<AgentPhase, string> = {
  thinking: '正在分析',
  tool: '正在读取资料',
  waiting_approval: '等待授权',
  generating: '正在生成回答',
  running: '正在处理',
}

/** 任务运行状态条可展示的阶段（waiting_input = 提问挂起，任务未结束但由用户输入驱动） */
export type StreamPhase = AgentPhase | 'waiting_input'

/** 任务已运行时长（秒）→ 「12s」/「1分05秒」 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}分${String(total % 60).padStart(2, '0')}秒`
}

/**
 * ADR-034 UI Contract（P0-2）：状态条由 Execution 驱动，不从 messages.at(-1) 反推 Runtime fact。
 *
 * - 是否显示状态条 = 存在非终态执行（running/waiting）——Runtime 事实（Registry SoT）。
 * - phase 派生：waiting→waiting_input（pendingInteraction 是 Registry 事实）；
 *   running→细分为 thinking/tool/generating——这些是 UI 消息字段（projection 信息），
 *   不是 Runtime 状态（不扩五态）；无内容段 → 'running'（「正在处理」兜底展示，
 *   如 interaction boundary 后 answer 已送达、新段未到的瞬间）。
 */
export function executionPhaseOf(exec: Execution | undefined, lastContentSegment: ChatMessage | undefined): StreamPhase | undefined {
  if (exec === undefined) return undefined
  if (exec.status === 'waiting') return 'waiting_input'
  if (exec.status !== 'running') return undefined // completed/failed/cancelled：无运行状态条
  if (lastContentSegment !== undefined) return deriveAgentPhase(lastContentSegment)
  return 'running'
}

/**
 * 最后 active segment 消息（UI projection）：会话中最后一条 assistant 内容消息
 * （提问卡片带 question 字段，不是内容段；interaction 后的 user answer 是用户消息，非内容段）。
 * 与 pullExecutions 的恢复不变量同源——状态条/恢复共用同一 segment 判定，不分叉。
 */
export function lastContentSegmentOf(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.question === undefined) return m
  }
  return undefined
}
