/**
 * VisionProvider：Document Runtime 的视觉通道（与 Agent Provider 平行，不复用语义）。
 * 第一版最小接口：image → text（Zhipu GLM OpenAI 兼容 /chat/completions）。
 * 免费模型高峰限流（HTTP 429 / 5xx）是已实测的真实边界条件——对瞬时错误带退避重试；
 * 4xx（key 无效/载荷非法）立即失败，不重试。
 */
import { readFileSync } from 'node:fs'

export interface VisionProvider {
  analyzeImage(imagePath: string, prompt: string): Promise<string>
}

export const ZHIPU_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'

/** 瞬时错误（429 限流 / 5xx 服务端）可重试；4xx 永久错误立即失败 */
class VisionApiError extends Error {
  readonly retryable: boolean

  constructor(status: number, message: string) {
    super(message)
    this.retryable = status === 429 || status >= 500
  }
}

const MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [0, 2000, 5000]

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
        if (!(err instanceof VisionApiError) || !err.retryable) throw err
      }
    }
    throw last
  }

  private async callOnce(b64: string, prompt: string): Promise<string> {
    const res = await fetch(this.baseUrl ?? ZHIPU_ENDPOINT, {
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
    })
    if (!res.ok) {
      // 错误体尽量透传（智谱：{ error: { code, message } }），用户能自诊断（如 1305 限流）
      const raw = await res.text()
      let detail = `HTTP ${res.status}`
      try {
        const body = JSON.parse(raw) as { error?: { code?: string | number; message?: string } }
        const e = body.error
        if (e) detail = `${detail} ${String(e.code ?? '')} ${e.message ?? ''}`.trim()
      } catch {
        detail = raw.trim() ? `${detail} ${raw.trim().slice(0, 120)}` : detail
      }
      throw new VisionApiError(res.status, `视觉模型调用失败 ${detail}`)
    }
    const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] }
    const text = data.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) throw new Error('视觉模型返回空文本')
    return text.trim()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
