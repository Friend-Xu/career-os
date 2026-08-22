/**
 * Provider 层（ADR-030）：AgentConnection → Vercel AI SDK LanguageModel。
 * - 线格式选择：baseUrl 以 /anthropic 结尾 → Anthropic Messages 线格式（createAnthropic）；
 *   否则 OpenAI 兼容线格式（createDeepSeek）——DeepSeek 两种端点都提供，按服务商登记照实选择。
 * - 模型名只使用服务商登记 models 列表内的名字（resolveAgentConnection 已校验回落）。
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import type { LanguageModel } from 'ai'
import type { AgentConnection } from '../../config.ts'

export interface ResolvedLanguageModel {
  model: LanguageModel
  modelId: string
}

/** baseUrl 线格式判别（服务商登记的唯一事实源；/anthropic 后缀 = Anthropic 线格式） */
export function wireFormatOf(conn: AgentConnection): 'anthropic' | 'openai-compatible' {
  return conn.baseUrl?.endsWith('/anthropic') ? 'anthropic' : 'openai-compatible'
}

export function resolveLanguageModel(conn: AgentConnection): ResolvedLanguageModel {
  const modelId = conn.model
  if (!modelId) throw new Error('provider 未登记模型（providers[].models 为空）——请在设置页勾选模型')
  if (wireFormatOf(conn) === 'anthropic') {
    return {
      model: createAnthropic({ apiKey: conn.apiKey, baseURL: conn.baseUrl })(modelId),
      modelId,
    }
  }
  return {
    model: createDeepSeek({ apiKey: conn.apiKey, baseURL: conn.baseUrl })(modelId),
    modelId,
  }
}
