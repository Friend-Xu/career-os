/**
 * VisionProvider：Document Runtime 的视觉通道（与 Agent Provider 平行，不复用语义）。
 * 第一版最小接口：image → text（Zhipu GLM OpenAI 兼容 /chat/completions）。
 * 免费模型高峰限流（HTTP 429 / 5xx）是已实测的真实边界条件——对瞬时错误带退避重试；
 * 4xx（key 无效/载荷非法）立即失败，不重试。
 */
import { readFileSync } from 'node:fs'
import { externalFetch, ExternalCallError } from '../../agent/tools/external-call.ts'

export interface VisionProvider {
  analyzeImage(imagePath: string, prompt: string): Promise<string>
}

export const ZHIPU_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'

/** 视觉调用超时（视觉模型响应慢；无超时 = 上传流程挂死） */
export const VISION_CALL_TIMEOUT_MS = 60_000

const MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [0, 2000, 5000]

/** 瞬时错误（429 限流 / 5xx / 超时 / 网络）可重试；4xx 永久错误立即失败——
 *  判定统一走 ExternalCallError.retryable（Provider Stability v0.1 错误归一） */
function isRetryable(err: unknown): boolean {
  if (err instanceof ExternalCallError) return err.retryable
  return false
}

export class ZhipuVisionProvider implements VisionProvider {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl?: string

  constructor(opts: { apiKey: string; model: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.baseUrl = opts.baseUrl
  }

  async analyzeImage(imagePath: string, prompt: string): Promise<string> {
    const b64 = readFileSync(imagePath).toString('base64')
    let last: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt])
      try {
        return await this.callOnce(b64, prompt)
      } catch (err) {
        last = err
        if (!isRetryable(err)) throw err
      }
    }
    throw last
  }

  private async callOnce(b64: string, prompt: string): Promise<string> {
    const res = await externalFetch(
      this.baseUrl ?? ZHIPU_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
              ],
            },
          ],
        }),
      },
      { timeoutMs: VISION_CALL_TIMEOUT_MS, retries: 0 },
    )
    // externalFetch 已保证 res.ok（错误归一抛 ExternalCallError——含状态码与错误体摘要，如智谱 1305 限流码）
    const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] }
    const text = data.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) throw new Error('视觉模型返回空文本')
    return text.trim()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
