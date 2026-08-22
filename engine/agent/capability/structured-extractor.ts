/**
 * StructuredExtractor 能力面（ADR-030 两条路径之一）：input → schema → typed object。
 * - 底层 = Vercel AI SDK generateObject（schema 正式下发 + 校验失败自动重试 + Zod 类型同步）
 * - 只服务「一次性结构化提取」（JD/简历/政策），不走 AgentEvent 流——类型直达，不包装成文本再解析
 */
import { generateObject } from 'ai'
import type { LanguageModel } from 'ai'
import type { ZodType } from 'zod'

export interface StructuredExtractOptions {
  /** 待提取原文（外部输入，边界在调用方裁剪长度） */
  text: string
  /** 可选系统指令（缺省用任务自带 schema 语义） */
  system?: string
  /** 超时（毫秒，AbortSignal.timeout）；缺省不设 */
  timeoutMs?: number
  /** schema 校验失败重试次数（模型输出漂移时防误杀；缺省用 SDK 默认） */
  maxRetries?: number
  /** 输出预算（token；提取产物 = schema JSON + 少量文本，调用方按任务声明——Stage Policy 的提取档） */
  maxOutputTokens?: number
}

export interface StructuredExtractor {
  extract<T>(opts: StructuredExtractOptions, schema: ZodType<T>): Promise<T>
}

export function createStructuredExtractor(model: LanguageModel): StructuredExtractor {
  return {
    async extract<T>(opts: StructuredExtractOptions, schema: ZodType<T>): Promise<T> {
      const { object } = await generateObject({
        model,
        schema,
        prompt: opts.text,
        ...(opts.system !== undefined ? { system: opts.system } : {}),
        ...(opts.timeoutMs !== undefined ? { abortSignal: AbortSignal.timeout(opts.timeoutMs) } : {}),
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      })
      return object
    },
  }
}
