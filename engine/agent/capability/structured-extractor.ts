/**
 * StructuredExtractor 能力面（ADR-030 两条路径之一）：input → schema → typed object。
 * - 执行路径变化（v0.2，2026-08-26 真机定位）：原 generateObject（SDK 结构化输出——provider
 *   无 structured-outputs 支持时走强制工具模式）在 DeepSeek /anthropic 兼容端点对复杂输入
 *   不可靠：同一输入 generateObject 全程失败（"response did not match schema"/"did not return
 *   a response"），而 generateText 输出完全合规 JSON（实测 1276 tokens / finishReason=stop）。
 *   → v0.2 统一为 generateText + 严格 JSON 提取 + zod 校验 + 重试（JSON 提取剥离 markdown 围栏
 *   与前后杂质——模型输出方言容错；parseJdJson 即此设计的历史遗留，现回归路径）。
 * - 只服务「一次性结构化提取」（JD/简历/政策），不走 AgentEvent 流——类型直达。
 */
import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import type { ZodType } from 'zod'

export interface StructuredExtractOptions {
  /** 待提取原文（外部输入，边界在调用方裁剪长度） */
  text: string
  /** 可选系统指令（缺省用任务自带 schema 语义） */
  system?: string
  /** 超时（毫秒，AbortSignal.timeout——每轮调用共用预算）；缺省不设 */
  timeoutMs?: number
  /** JSON 产出失败重试次数（模型输出漂移时防误杀；缺省 = 0） */
  maxRetries?: number
  /** 输出预算（token；提取产物 = schema JSON + 少量文本，调用方按任务声明——Stage Policy 的提取档） */
  maxOutputTokens?: number
}

export interface StructuredExtractor {
  extract<T>(opts: StructuredExtractOptions, schema: ZodType<T>): Promise<T>
}

/** 从模型输出文本提取 JSON 对象：剥离 markdown 围栏、只取首个 { 到末个 }（前后杂质过滤）；
 *  非法 JSON 抛错（重试循环消费）。 */
export function extractJsonObject(text: string): unknown {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('未提取到 JSON 对象')
  return JSON.parse(cleaned.slice(start, end + 1))
}

export function createStructuredExtractor(model: LanguageModel): StructuredExtractor {
  return {
    async extract<T>(opts: StructuredExtractOptions, schema: ZodType<T>): Promise<T> {
      let lastErr: Error | undefined
      const maxRetries = opts.maxRetries ?? 0
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt =
          attempt === 0
            ? opts.text
            : `${opts.text}\n\n（上次输出不是合法 JSON：${lastErr?.message ?? '未知错误'}。请只输出 JSON 对象，不要 markdown 围栏或说明文字。）`
        const { text } = await generateText({
          model,
          ...(opts.system !== undefined ? { system: opts.system } : {}),
          prompt,
          ...(opts.timeoutMs !== undefined ? { abortSignal: AbortSignal.timeout(opts.timeoutMs) } : {}),
          ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
        })
        try {
          const parsed = extractJsonObject(text)
          const checked = schema.safeParse(parsed)
          if (!checked.success) {
            throw new Error(
              `JSON 结构不符合契约：${checked.error.issues
                .slice(0, 3)
                .map((i) => `${i.path.join('.') || '(root)'}:${i.message}`)
                .join('；')}`,
            )
          }
          return checked.data
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err))
        }
      }
      throw new Error(`No object generated: ${lastErr?.message ?? '模型未返回可解析的 JSON'}`)
    },
  }
}
