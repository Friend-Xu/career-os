/**
 * WebSearch 能力（Search Capability Layer，P1）：任务级治理 + 双路径执行。
 *
 * 架构（用户裁决：WebSearch 做 Runtime 不做裸 Tool）：
 * - SearchSession = 每次 Agent 任务一个会话（AgentRuntime 创建，引擎单方决定预算/缓存——CLAUDE.md §8：
 *   Engine 负责资源/预算/状态，Agent 只消费）。治理面：
 *   ① 预算：任务级外部搜索调用次数上限（默认 8；缓存命中不消耗——预算治的是外部成本）；
 *   ② 缓存：规范化 query → 内存 Map + TTL（默认 30 分钟；跨任务共享，引擎重启即失效——可接受）；
 *   ③ 隐私红线：query 含手机号/邮箱/身份证 → 拒绝执行（搜索词外发前校验，不消耗预算）。
 * - 执行双路径（DeepSeek Responses 是 Codex 兼容的事实兼容，非承诺——协议演进需守卫）：
 *   主路径 = 官方 @ai-sdk/openai responses 适配器（协议解析/重试/错误类型由 SDK 维护）；
 *   守卫降级 = 薄封装裸 fetch（协议异常/适配器解析失败 → 降级，成功后锁定本会话，防反复双请求）。
 * - 来源引用：DeepSeek 托管搜索无结构化 url_citation，引用清单内嵌于模型输出文本（「## 数据来源」
 *   段，由检索指令要求）。Source Normalizer = 输出文本 URL 提取（去重、去 ws_call_id 噪声），
 *   文本缺失来源段且提取到 URL 时追加「## 数据来源」段（引用保障）。
 */
import { z } from 'zod'
import { tool } from 'ai'
import { generateText, type Tool } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { PRIVACY_PATTERN } from './privacy-filter.ts'
import { externalFetch } from './external-call.ts'
import type { WebSearchMode } from '../providers/capabilities.ts'
import type { Logger } from '../../logger.ts'
import type { ToolEvidence } from '../../ir/schema.ts'
import type { ToolRuntimeMeta } from './tool-assembly.ts'

/** WebSearch 模型调用超时（实测 20-37s——20s 峰值常态，60s 留余量；超时走 fallback 链） */
export const WEBSEARCH_MODEL_TIMEOUT_MS = 60_000
/** WebSearch 降级路径超时（语义同上） */
export const WEBSEARCH_HOSTED_TIMEOUT_MS = 60_000

export interface WebSearchProvider {
  /** Responses API 根（如 https://api.deepseek.com；anthropic 通道 baseUrl 会剥 /anthropic 后缀） */
  baseUrl: string
  apiKey: string
  model: string
  /** 执行模式（Provider Capability Registry 判定：responses/google/off——off 不会到达这里） */
  mode: WebSearchMode
}

export interface SearchSource {
  url: string
  /** 结构化来源标题（native 路径透出；文本提取无标题） */
  title?: string
}

export interface SearchResult {
  text: string
  sources: SearchSource[]
  /** 是否缓存命中（工具层据此附加时间戳提示） */
  cached: boolean
}

export interface SearchSessionOptions {
  provider: WebSearchProvider
  /** 任务级搜索预算（正整数；引擎单方决定，客户端不可设） */
  budget: number
  /** 缓存 TTL（毫秒；0 = 不缓存） */
  cacheTtlMs: number
  /** 单次调用超时毫秒（Phase 4C 配置化；缺省 = WEBSEARCH_MODEL_TIMEOUT_MS） */
  timeoutMs?: number
  /** 守卫降级重试次数（Phase 4C；缺省 0——降级即恢复语义，重试=计费搜索×2） */
  hostedRetries?: number
  /** 共享缓存（引擎级单例——跨任务复用检索结果；缺省 = 会话私有，测试友好） */
  cache?: Map<string, CacheEntry>
  logger?: Logger
}

/** 检索指令（主路径 system / 降级路径 instructions 同源）：只检索事实 + 要求来源段 + 标注不确定 */
const SEARCH_INSTRUCTIONS =
  '你是职业数据检索助手：只检索事实数据，输出简明结构化结论，并在末尾以「## 数据来源」列出引用平台与 URL；不确定的数据明确标注。'

function responsesRoot(baseUrl: string): string {
  return baseUrl.replace(/\/anthropic\/?$/, '').replace(/\/+$/, '')
}

/** 预算/隐私策略错误（工具层转为文本回给模型，不抛穿循环） */
export class SearchPolicyError extends Error {
  readonly code: 'privacy' | 'budget_exhausted'
  constructor(code: 'privacy' | 'budget_exhausted', message: string) {
    super(message)
    this.name = 'SearchPolicyError'
    this.code = code
  }
}

// ─── Source Normalizer：结构化来源 + 输出文本 URL 提取 ───────────────────────

/** 提取文本内引用 URL：去尾部标点、去 #ws_call_id 噪声后缀、去重、保序、限 20 条 */
export function extractSourceUrls(text: string): SearchSource[] {
  const seen = new Set<string>()
  const out: SearchSource[] = []
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]）】,，。;；]+/g)) {
    let url = m[0]
    url = url.replace(/[.,;:!?）】]+$/, '')
    url = url.replace(/#ws_call_id=[^&]*$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ url })
    if (out.length >= 20) break
  }
  return out
}

/** 结构化来源（SDK sources / google groundingChunks，含可选标题）与文本提取合并：结构化优先、URL 去重 */
function mergeSources(structured: SearchSource[], text: string): SearchSource[] {
  const byUrl = new Map<string, SearchSource>()
  for (const s of structured) {
    if (s.url !== '' && !byUrl.has(s.url)) byUrl.set(s.url, { url: s.url, ...(s.title ? { title: s.title } : {}) })
  }
  for (const s of extractSourceUrls(text)) {
    if (!byUrl.has(s.url)) byUrl.set(s.url, s)
  }
  return [...byUrl.values()]
}

/** 来源段渲染（共享：外部检索工具统一「## 数据来源」格式） */
export function renderSources(sources: SearchSource[]): string {
  return `## 数据来源\n${sources.map((s) => (s.title ? `- [${s.title}](${s.url})` : `- ${s.url}`)).join('\n')}`
}

// ─── 执行路径：注册表分派（responses → 守卫降级；google → 无降级诚实失败）──

/** 'responses' 模式：OpenAI Responses 协议 + provider 侧 webSearch（DeepSeek 兼容/OpenAI 原生共用） */
async function responsesSearch(provider: WebSearchProvider, query: string, timeoutMs?: number): Promise<SearchResult> {
  const openai = createOpenAI({ apiKey: provider.apiKey, baseURL: responsesRoot(provider.baseUrl) })
  const result = await generateText({
    model: openai.responses(provider.model),
    system: SEARCH_INSTRUCTIONS,
    tools: { webSearch: openai.tools.webSearch({ searchContextSize: 'medium' }) },
    prompt: query,
    maxOutputTokens: 4000,
    // Provider Stability v0.1：主路径显式超时（SDK fetch 无默认超时）+ 重试上限 1
    // （重试 = 服务端搜索重算计费；超时/失败有 fallback 链兜底，压缩双成本）
    abortSignal: AbortSignal.timeout(timeoutMs ?? WEBSEARCH_MODEL_TIMEOUT_MS),
    maxRetries: 1,
  })
  if (result.text.trim().length === 0) {
    throw new Error('搜索完成但无文本产出（官方适配器解析为空）')
  }
  // native 结构化来源（OpenAI 原生 url_citation → SDK sources 含 title）；DeepSeek 不填 → 文本提取兜底
  const structured = (result.sources ?? [])
    .filter((s) => s.sourceType === 'url')
    .map((s) => ({ url: s.url, ...(s.title !== undefined ? { title: s.title } : {}) }))
  return { text: result.text, sources: mergeSources(structured, result.text), cached: false }
}

/** 'google' 模式：Gemini grounding（google.tools.googleSearch 服务端执行）；SDK 将 groundingChunks 映射为 sources（含 title） */
async function googleSearch(provider: WebSearchProvider, query: string, timeoutMs?: number): Promise<SearchResult> {
  const google = createGoogleGenerativeAI({ apiKey: provider.apiKey })
  const result = await generateText({
    model: google(provider.model),
    system: SEARCH_INSTRUCTIONS,
    prompt: query,
    maxOutputTokens: 4000,
    tools: { webSearch: google.tools.googleSearch({ searchTypes: { webSearch: {} } }) },
    abortSignal: AbortSignal.timeout(timeoutMs ?? WEBSEARCH_MODEL_TIMEOUT_MS),
    maxRetries: 1,
  })
  if (result.text.trim().length === 0) {
    throw new Error('搜索完成但无文本产出（Google 适配器解析为空）')
  }
  const structured = (result.sources ?? [])
    .filter((s) => s.sourceType === 'url')
    .map((s) => ({ url: s.url, ...(s.title !== undefined ? { title: s.title } : {}) }))
  return { text: result.text, sources: mergeSources(structured, result.text), cached: false }
}

/** 守卫降级路径（仅 'responses' 模式）：对外部 HTTP 经统一封装（Provider Stability v0.1）
 *  ——retries=0：降级路径即恢复语义（主路径已重试 1 次），重试 = 计费搜索 ×2 且延迟放大 */
export async function hostedSearch(
  provider: WebSearchProvider,
  query: string,
  call?: { timeoutMs?: number; logger?: Logger; retries?: number },
): Promise<SearchResult> {
  const res = await externalFetch(
    `${responsesRoot(provider.baseUrl)}/responses`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        instructions: SEARCH_INSTRUCTIONS,
        input: query,
        tools: [{ type: 'web_search', search_context_size: 'medium' }],
        max_output_tokens: 4000,
      }),
    },
    {
      timeoutMs: call?.timeoutMs ?? WEBSEARCH_HOSTED_TIMEOUT_MS,
      retries: call?.retries ?? 0,
      ...(call?.logger !== undefined ? { logger: call.logger } : {}),
      traceScope: 'web_search',
      endpoint: 'websearch:responses',
    },
  )
  // externalFetch 已保证 res.ok（错误归一抛 ExternalCallError）
  const j = (await res.json()) as { output?: unknown[]; error?: unknown }
  if (j.error != null) throw new Error(`搜索服务错误：${JSON.stringify(j.error).slice(0, 200)}`)
  const texts: string[] = []
  const urls = new Set<string>()
  for (const item of j.output ?? []) {
    const rec = (item ?? {}) as { type?: string; content?: Array<{ type?: string; text?: string }> }
    if (rec.type === 'message') {
      for (const part of rec.content ?? []) {
        if (part.type === 'output_text' && part.text) texts.push(part.text)
      }
    } else if (rec.type === 'web_search_call') {
      // open_page/find_in_page 中间动作的 URL 也是引用线索（去 #ws_call_id 噪声；search 动作无 URL）
      const action = (rec as { action?: { url?: string } }).action
      if (action?.url) urls.add(action.url.replace(/#ws_call_id=[^&]*$/, ''))
    }
  }
  if (texts.length === 0) throw new Error('搜索完成但无文本产出')
  const text = texts.join('\n\n')
  const sources = [...extractSourceUrls(text), ...[...urls].map((url) => ({ url }))].filter(
    (s, i, arr) => arr.findIndex((x) => x.url === s.url) === i,
  )
  return { text, sources, cached: false }
}

// ─── SearchSession：预算 + 缓存 + 隐私（引擎治理面，任务级）──────────────────

export interface CacheEntry {
  result: SearchResult
  at: number
}

export interface SearchSession {
  /** 工具执行入口：隐私拒绝/预算用尽抛 SearchPolicyError；外部失败抛 Error（工具层转文本） */
  execute(query: string): Promise<SearchResult>
  /** 证据引用（Tool Evidence Contract 生产方：检索成功的来源引用；取即清——runner 在 tool_done 取） */
  takeEvidence(): ToolEvidence[]
}

export function createSearchSession(opts: SearchSessionOptions): SearchSession {
  if (!Number.isInteger(opts.budget) || opts.budget <= 0) {
    throw new Error(`search budget 应为正整数（当前 ${opts.budget}）`)
  }
  const cache = opts.cache ?? new Map<string, CacheEntry>()
  let used = 0
  let fallbackLocked = false
  const evidenceBuf: ToolEvidence[] = []
  const trace = (event: string, extra?: Record<string, unknown>): void => {
    opts.logger?.trace('web_search', { event, budgetUsed: used, budgetTotal: opts.budget, ...extra })
  }
  const recordEvidence = (sources: SearchSource[], at: number): void => {
    const citation = sources.map((s) => s.url).filter((u) => u !== '').join(' | ')
    if (citation !== '') {
      evidenceBuf.push({
        source: 'hosted',
        provider: 'hosted',
        citation,
        fetchedAt: new Date(at).toISOString(),
      })
    }
  }

  return {
    async execute(query) {
      const startedAt = Date.now()
      if (PRIVACY_PATTERN.test(query)) {
        throw new SearchPolicyError(
          'privacy',
          'web_search 拒绝执行：查询含疑似个人信息（手机号/邮箱/身份证），隐私红线禁止外发。请改用不含个人标识的查询。',
        )
      }
      const key = query.trim().replace(/\s+/g, ' ').toLowerCase()
      if (opts.cacheTtlMs > 0) {
        const hit = cache.get(key)
        if (hit !== undefined && Date.now() - hit.at < opts.cacheTtlMs) {
          trace('cache_hit')
          recordEvidence(hit.result.sources, hit.at)
          // 缓存结果附首次搜索时间（模型知情可判断新鲜度，避免无意义重搜）
          const at = new Date(hit.at).toISOString().slice(0, 16)
          return {
            ...hit.result,
            cached: true,
            text: `${hit.result.text}\n\n（本结果为检索缓存，首次搜索时间 ${at}——如需要最新数据请换查询角度）`,
          }
        }
        if (hit !== undefined) cache.delete(key) // 过期即失效
      }
      if (used >= opts.budget) {
        trace('budget_exhausted')
        throw new SearchPolicyError(
          'budget_exhausted',
          `web_search 已停用：本任务搜索预算（${opts.budget} 次）用尽。请基于已获得的信息继续完成当前任务，不要再调用搜索。`,
        )
      }
      used += 1 // 预算语义 = 外部调用次数上限：调用即消耗（失败亦然），一次 execute 一次
      trace('search_start')
      let result: SearchResult
      try {
        if (opts.provider.mode === 'google') {
          // Google grounding：无 Responses 兼容降级路径——失败即诚实报错（不当兼容）
          result = await googleSearch(opts.provider, query, opts.timeoutMs)
        } else if (fallbackLocked) {
          result = await hostedSearch(opts.provider, query, { timeoutMs: opts.timeoutMs, logger: opts.logger, retries: opts.hostedRetries })
        } else {
          try {
            result = await responsesSearch(opts.provider, query, opts.timeoutMs)
          } catch (err) {
            // 协议守卫：主路径失败 → 降级薄封装；降级成功即锁定本会话（防每次双请求）
            trace('fallback')
            result = await hostedSearch(opts.provider, query, { timeoutMs: opts.timeoutMs, logger: opts.logger, retries: opts.hostedRetries })
            fallbackLocked = true
          }
        }
      } catch (err) {
        trace('search_error', { durationMs: Date.now() - startedAt })
        throw err
      }
      // 引用保障：文本缺来源段但提取到 URL → 追加结构化来源段（不重复模型自带引用）
      if (result.sources.length > 0 && !result.text.includes('数据来源')) {
        result = {
          ...result,
          text: `${result.text}\n\n${renderSources(result.sources)}`,
        }
      }
      trace('search_ok', { durationMs: Date.now() - startedAt })
      recordEvidence(result.sources, Date.now())
      if (opts.cacheTtlMs > 0) cache.set(key, { result, at: Date.now() })
      return result
    },
    takeEvidence() {
      const out = [...evidenceBuf]
      evidenceBuf.length = 0
      return out
    },
  }
}

/** 客户端工具（streamText 工具循环）─────────────────────────────────────── */

/** WebSearch 治理元数据（Tool Assembly Layer）：hosted 源 = provider 托管检索（数据出境 external）；
 *  budget 由 AgentRuntime 组装时注入（config.agent.search.budgetPerTask）；trace 命名空间与
 *  Session 内部 trace('web_search', …) 前缀一致（P3 指标板聚合源）。 */
export const WEB_SEARCH_TOOL_META: ToolRuntimeMeta = {
  source: 'hosted',
  egress: 'external',
  traceScope: 'web_search',
  provider: 'hosted',
}

/** streamText 客户端工具：Agent 按需调用（权限闸/步数护栏/事件归一全部复用现有循环） */
export function buildWebSearchTool(session: SearchSession): Tool<any, any> {
  return tool({
    description:
      '快速联网搜索（快搜）：即时事实查询（薪资水平/公司信息/行业数据等），输入自然语言查询，返回带来源引用的检索结论。需要深度研究/公司尽调时请改用 WebResearch（深入研究）。注意：本工具每任务有调用次数预算，请聚焦关键事实一次查清，避免低效重复搜索。',
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe('自然语言检索查询（如：苏州 医疗器械结构设计工程师 平均薪资）'),
    }),
    execute: async ({ query }) => {
      try {
        const result = await session.execute(query)
        return result.text
      } catch (err) {
        if (err instanceof SearchPolicyError) return err.message
        return `web_search 失败：${err instanceof Error ? err.message : String(err)}`
      }
    },
  })
}
