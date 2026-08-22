/**
 * Provider Health Check（ADR-030 Phase 0.5）：一次最小真实调用探测 LLM 链路。
 * - 目的：把「Operation aborted 75s 才浮错」变成「打开设置页/启动时即可见的红绿灯」
 * - 判定：真实 generateText（maxTokens=1，10s 超时）——能出字 = ready；报文都带 latency
 * - 不配置服务商 → not_configured（状态可见，不是错误）
 */
import { generateText } from 'ai'
import { resolveAgentConnection, type EngineConfig } from '../config.ts'
import { resolveLanguageModel } from '../agent/providers/model.ts'
import type { Logger } from '../logger.ts'

export interface AgentHealth {
  provider: string
  model: string
  baseUrl?: string
  status: 'ready' | 'error' | 'not_configured'
  /** 凭据来源（Step 0.6 契约：env/config；UI 展示凭据来自哪层） */
  credentialSource?: 'env' | 'config'
  latencyMs?: number
  error?: string
}

export async function checkAgentHealth(config: EngineConfig, logger: Logger): Promise<AgentHealth> {
  const conn = resolveAgentConnection(config)
  if (!conn) {
    return {
      provider: '-',
      model: '-',
      status: 'not_configured',
      error: '未配置已启用的服务商（设置页添加并启用 provider 后可用）',
    }
  }
  const { model } = resolveLanguageModel(conn)
  const base: AgentHealth = {
    provider: conn.validModels.length === 0 ? '-' : conn.model ?? '-',
    model: conn.model ?? '-',
    ...(conn.baseUrl !== undefined ? { baseUrl: conn.baseUrl } : {}),
    credentialSource: conn.credentialSource,
    status: 'error',
  }
  const started = Date.now()
  try {
    await generateText({
      model,
      prompt: 'ok',
      maxOutputTokens: 1,
      abortSignal: AbortSignal.timeout(10_000),
    })
    return {
      ...base,
      status: 'ready',
      latencyMs: Date.now() - started,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`agent/health 探测失败：${message}`)
    return {
      ...base,
      status: 'error',
      latencyMs: Date.now() - started,
      error: /abort|timeout/i.test(message) ? `连接超时（10s）——服务商或网络不可用：${conn.model}` : message,
    }
  }
}
