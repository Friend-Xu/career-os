/**
 * Session Context Frame（ADR-036——会话连续性的受控承载物；契约 §B）。
 * - 生产方 = Context Compiler（引擎单写方，SessionContextStore）；UI 只读投影；
 *   Execution 只读编译结果，不写 Frame。
 * - focus = 显式引用投影（resolveContextRefs 输出；禁止口语解析/推断对象——契约 §F）
 * - recentTurns = Bounded Raw Conversation Context（原始文本；截断可、改写不可；
 *   禁止 LLM 摘要——Producer Ownership 红线，契约 §B.3）
 * - 有界规则（契约 §C.3）：物理上限即预算——无动态 Context Governance（ADR-036 §五.3）
 */
export interface SessionFocusRef {
  type: 'job' | 'company' | 'resume' | 'decision'
  id: string
  label: string
}

export interface SessionTurn {
  role: 'user' | 'assistant'
  text: string
  at: string
}

export interface SessionContextFrame {
  sessionId: string
  personId?: string
  focus: SessionFocusRef[]
  recentTurns: SessionTurn[]
  lastExecutionId?: string
  updatedAt: string
}

/** focus 有界（契约 §C.3：保留最近执行的前 N 项） */
export const SESSION_FRAME_MAX_FOCUS = 3
/** recentTurns 有界（契约 §C.3：FIFO 追加，丢最旧） */
export const SESSION_FRAME_MAX_TURNS = 6
/** 单条文本有界（契约 §C.3：保留首尾，中间删） */
export const SESSION_FRAME_MAX_TURN_TEXT = 500
