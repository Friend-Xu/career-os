import type { ChatMessage } from '../types'

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
