/**
 * 推理等级 → providerOptions 映射（2026-08-28 探针实测驱动，单一事实源）。
 * - DeepSeek 原生 OpenAI 兼容线（createDeepSeek）：reasoning_effort 语义——
 *   off/低/高/最大 四档真实生效（实测 thinking tokens：0 / 419 / 685 / 1358，单调）。
 *   关闭 = thinking:{type:'disabled'}（SDK deepseek 通道；effort 枚举无 none）。
 * - Anthropic 线（createAnthropic，Anthropic 官方模型）：thinking budget 语义——
 *   off=disabled；low=2048 / high=8192 / max=max_tokens−1024（协议要求 max_tokens > budget + 文本预留；
 *   budget 下限 1024）。
 * 注意：DeepSeek 的 Anthropic 兼容网关（/anthropic 后缀）仅接受参数、不实现语义
 * （effort/budget 行为乱序实测）——DeepSeek 用户应使用原生端点（无 /anthropic 后缀）。
 */
import type { JSONObject } from '@ai-sdk/provider'
import type { ReasoningLevel } from '../../ir/schema.ts'

export type WireFormat = 'anthropic' | 'openai-compatible'

/** 固定档思考预算（token；仅 anthropic 线用） */
const ANTHROPIC_BUDGET: Record<'low' | 'high', number> = { low: 2048, high: 8192 }

export function reasoningProviderOptions(
  wire: WireFormat,
  level: ReasoningLevel,
  maxTokens: number,
): Record<string, JSONObject> {
  if (wire === 'openai-compatible') {
    if (level === 'off') return { deepseek: { thinking: { type: 'disabled' } } }
    return { deepseek: { reasoningEffort: level } }
  }
  // anthropic 线（Anthropic 官方语义：thinking budget）
  if (level === 'off') return { anthropic: { thinking: { type: 'disabled' } } }
  const budget =
    level === 'max'
      ? Math.max(1024, maxTokens - 1024)
      : Math.min(ANTHROPIC_BUDGET[level], Math.max(1024, maxTokens - 1024))
  return { anthropic: { thinking: { type: 'enabled', budgetTokens: budget } } }
}
