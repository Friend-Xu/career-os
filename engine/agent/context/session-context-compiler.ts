/**
 * Session Context Compiler（ADR-036 Phase 3——契约 §C：Frame → system section 的确定性编译）。
 * - 纯函数：入参 Frame + 本轮是否显式引用，输出注入文本（system 通道）；空 → ''（零风险路径）。
 * - 编译顺序 = 优先级（契约 §C.1，非质量判定）：
 *   1. 本轮显式引用（权威，ADR-020）——有则 focus 不继承
 *   2. 无显式引用 → 继承 focus（标注「继承自会话」，提示性语境非权威）
 *   3. recentTurns 恒注入（Bounded Raw Conversation Context——原文，非摘要）
 * - 红线：不含 Summary / Health / 质量判定；文本只呈现不改写（截断已在 Store 层完成）。
 */
import type { SessionContextFrame } from '../../ir/session-context.ts'

export interface SessionContextCompileInput {
  frame?: SessionContextFrame
  /** 本轮存在显式引用（ADR-020 权威）→ false：不继承 focus（契约 §C.1 优先级 1 覆盖 2） */
  inheritFocus: boolean
}

export function buildSessionContextSection(input: SessionContextCompileInput): string {
  const frame = input.frame
  if (frame === undefined) return ''
  const focusLines =
    input.inheritFocus && frame.focus.length > 0
      ? frame.focus.map((f) => `- ${f.label}（${f.type} ${f.id}）`)
      : []
  const turnLines = frame.recentTurns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
  if (focusLines.length === 0 && turnLines.length === 0) return ''
  const parts = [
    '## 会话上下文（引擎装配）',
    '',
  ]
  if (focusLines.length > 0) {
    parts.push('【会话焦点（继承自会话——非本轮确认依据，提示性语境）】', ...focusLines, '')
  }
  if (turnLines.length > 0) {
    parts.push('【最近对话（原始摘录）】', ...turnLines, '')
  }
  return parts.join('\n').trimEnd()
}
