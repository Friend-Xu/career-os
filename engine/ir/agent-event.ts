/**
 * Agent 事件契约（ADR-030 运行面真源）：归一化事件流（编排层/前端只消费这些）。
 * 生产运行时（AgentRunner / AgentRuntime / UI 通道）从此文件取类型；
 * claude adapter（legacy 保留位/benchmark）只 re-export，不再是类型真源。
 */
import type { AgentError, AgentQuestion } from './schema.ts'
import type { ToolEvidence, ToolSource } from './schema.ts'

export type { AgentQuestion }

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string; source?: ToolSource }
  | { type: 'tool_done'; name: string; source?: ToolSource; evidence?: ToolEvidence[] }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_stop' }
  | { type: 'permission_request'; tool: string; canUseTool: () => Promise<boolean> }
  | { type: 'question_request'; question: AgentQuestion }
  | { type: 'done'; result: string }
  | { type: 'error'; error: AgentError }

export interface AgentHandle {
  events: AsyncIterable<AgentEvent>
  /** 回答 AskUserQuestion（直连 runner 与 SDK adapter 同语义） */
  answer(text: string): void
}
