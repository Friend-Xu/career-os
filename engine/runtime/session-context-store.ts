/**
 * Session Context Store（ADR-036 Phase 2——Frame 的引擎侧持久化 + 确定性更新）。
 * - 存储：workspace 用户数据域 sessions/{sessionId}.frame.json（唯一 fs 出口 = Workspace）；
 *   Engine Registration：首次观察到该 sessionId 的执行终止时创建（无执行 = 无 Frame）。
 * - 单写方：Context Compiler（本类）；UI 只读投影（契约 §B.2）。
 * - 更新规则（契约 §D，确定性无 LLM 判定）：
 *   - refs 非空 → focus 替换（截断 SESSION_FRAME_MAX_FOCUS）；空/缺省 → focus 保留
 *   - userText/assistantText → recentTurns 追加（FIFO SESSION_FRAME_MAX_TURNS；单条截断）
 * - 职责边界：不感知 taskType / workflow 语义——「是否 conversation 任务」由调用方
 *   （AgentRuntime）判定后调用；本类不读不写 workflow 状态。
 * - 红线（契约 §H）：不引入 Summary / Health / 预算分区 / Lock；文本只截断不改写。
 */
import type { SessionContextFrame, SessionFocusRef, SessionTurn } from '../ir/session-context.ts'
import { SESSION_FRAME_MAX_FOCUS, SESSION_FRAME_MAX_TURNS, SESSION_FRAME_MAX_TURN_TEXT } from '../ir/session-context.ts'
import type { Workspace } from '../storage/workspace.ts'

export interface FrameUpdateInput {
  executionId: string
  sessionId: string
  personId?: string
  /** 本轮显式引用（已解析 label；空/缺省 = 无显式引用 → focus 保留——契约 §D） */
  refs?: SessionFocusRef[]
  userText?: string
  assistantText?: string
}

/** 单条文本截断（契约 §C.3：保留首尾，中间删；总长 = SESSION_FRAME_MAX_TURN_TEXT） */
export function truncateTurnText(text: string, max = SESSION_FRAME_MAX_TURN_TEXT): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.48)
  const tail = max - head - 2
  return `${text.slice(0, head)}……${text.slice(-tail)}`
}

export class SessionContextStore {
  private ws: Workspace

  constructor(ws: Workspace) {
    this.ws = ws
  }

  /** 读取 Frame；不存在 → undefined（零风险路径：无 Frame = 行为与现状一致） */
  get(sessionId: string): SessionContextFrame | undefined {
    const rel = this.relOf(sessionId)
    if (!this.ws.exists(rel)) return undefined
    return JSON.parse(this.ws.read(rel)) as SessionContextFrame
  }

  /** 执行终点更新（单写方入口；契约 §D 全部分支） */
  updateOnExecutionTerminal(input: FrameUpdateInput): SessionContextFrame {
    const now = new Date().toISOString()
    const prev = this.get(input.sessionId)
    const frame: SessionContextFrame = {
      sessionId: input.sessionId,
      personId: input.personId ?? prev?.personId,
      // focus：显式引用非空 → 替换（有界）；否则保留（新建 → 空）
      focus:
        input.refs !== undefined && input.refs.length > 0
          ? input.refs.slice(0, SESSION_FRAME_MAX_FOCUS)
          : prev?.focus ?? [],
      recentTurns: appendTurns(prev?.recentTurns ?? [], now, input.userText, input.assistantText),
      lastExecutionId: input.executionId,
      updatedAt: now,
    }
    this.ws.write(this.relOf(input.sessionId), JSON.stringify(frame, null, 2) + '\n')
    return frame
  }

  private relOf(sessionId: string): string {
    return `sessions/${sessionId}.frame.json`
  }
}

/** 有界追加（契约 §C.3：FIFO 丢最旧；空文本不写） */
function appendTurns(
  existing: SessionTurn[],
  at: string,
  userText?: string,
  assistantText?: string,
): SessionTurn[] {
  const out = [...existing]
  if (userText !== undefined && userText.length > 0) {
    out.push({ role: 'user', text: truncateTurnText(userText), at })
  }
  if (assistantText !== undefined && assistantText.length > 0) {
    out.push({ role: 'assistant', text: truncateTurnText(assistantText), at })
  }
  return out.slice(-SESSION_FRAME_MAX_TURNS)
}
