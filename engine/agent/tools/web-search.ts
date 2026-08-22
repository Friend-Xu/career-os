/**
 * WebSearch 工具（直连 AgentRunner 客户端工具）：薄封装 DeepSeek Responses API 托管搜索
 * （hosted web_search——搜索由 DeepSeek 服务端执行，返回带来源引用的整理文本）。
 *
 * 治理（CLAUDE.md §8 / Agent Safety Rules）：
 * - 搜索结果 = 外部事实输入，Agent 只消费写入决策正文，来源随文本返回（模型自动附「数据来源」段）；
 *   系统事实（person_id/company_id/状态字段）仍由 Engine Registration 产生。
 * - 隐私红线：query 含手机号/邮箱/身份证 → 拒绝执行（搜索词外发前校验）。
 * - 次数护栏：每次调用 = streamText 工具循环 1 步，受 MAX_STEPS(25) 上限约束，无单独计数器
 *   （与文件工具同一护栏面，不加第二套防御——CLAUDE.md §4 禁止兜底）。
 */
import { z } from 'zod'
import { tool } from 'ai'
import type { Tool } from 'ai'

export interface WebSearchProvider {
  /** Responses API 根（如 https://api.deepseek.com；anthropic 通道 baseUrl 会剥 /anthropic 后缀） */
  baseUrl: string
  apiKey: string
  model: string
}

const PRIVACY_PATTERN =
  /(1[3-9]\d{9})|(\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]?)|([\w.+-]+@[\w-]+\.[\w.]+)/

function responsesUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/anthropic\/?$/, '').replace(/\/+$/, '')
  return `${root}/responses`
}

/** 一次托管搜索（非流式）：query → DeepSeek 内部 web_search 循环 → 整理文本（含来源） */
export async function hostedSearch(provider: WebSearchProvider, query: string): Promise<string> {
  const res = await fetch(responsesUrl(provider.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      instructions:
        '你是职业数据检索助手：只检索事实数据，输出简明结构化结论，并在末尾以「## 数据来源」列出引用平台与 URL；不确定的数据明确标注。',
      input: query,
      tools: [{ type: 'web_search', search_context_size: 'medium' }],
      max_output_tokens: 4000,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`搜索服务响应 ${res.status}${body.slice(0, 200) ? `：${body.slice(0, 200)}` : ''}`)
  }
  const j = (await res.json()) as { output?: unknown[]; error?: unknown }
  // DeepSeek Responses 正常响应 error 字段恒存在（值为 null）——只有非空才是真错误
  if (j.error != null) throw new Error(`搜索服务错误：${JSON.stringify(j.error).slice(0, 200)}`)
  const texts: string[] = []
  for (const item of j.output ?? []) {
    const rec = (item ?? {}) as { type?: string; content?: Array<{ type?: string; text?: string }> }
    if (rec.type !== 'message') continue
    for (const part of rec.content ?? []) {
      if (part.type === 'output_text' && part.text) texts.push(part.text)
    }
  }
  if (texts.length === 0) throw new Error('搜索完成但无文本产出')
  return texts.join('\n\n')
}

/** streamText 客户端工具：Agent 按需调用（权限闸/步数护栏/事件归一全部复用现有循环） */
export function buildWebSearchTool(provider: WebSearchProvider): Tool<any, any> {
  return tool({
    description:
      '联网搜索事实数据（薪资水平/公司信息/行业数据等）。输入自然语言查询，返回带来源引用的检索结论。隐私红线：不得包含手机号、邮箱、身份证号等个人信息。',
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe('自然语言检索查询（如：苏州 医疗器械结构设计工程师 平均薪资）'),
    }),
    execute: async ({ query }) => {
      if (PRIVACY_PATTERN.test(query)) {
        return 'web_search 拒绝执行：查询含疑似个人信息（手机号/邮箱/身份证），隐私红线禁止外发。请改用不含个人标识的查询。'
      }
      try {
        return await hostedSearch(provider, query)
      } catch (err) {
        return `web_search 失败：${err instanceof Error ? err.message : String(err)}`
      }
    },
  })
}
