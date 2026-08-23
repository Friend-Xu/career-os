/**
 * Exa 外部检索能力（Tool Runtime 第二阶段 Phase 2 —— MCP Tool Source 首个实例）。
 *
 * 连接：Exa hosted MCP（https://mcp.exa.ai/mcp，streamable-http）→ @ai-sdk/mcp http transport。
 * 匿名可用（限速），apiKey 可选（Authorization: Bearer 提升额度）。无 stdio 子进程——
 * 连接生命周期随引擎（连接失败 = 不注册，fail-safe，主链路不受影响）。
 *
 * 认知面隔离（T1）：工具名 = WebResearch / WebFetch（能力动词），描述不含 Exa/MCP 标识——
 * 协议身份在转译点消失；供应商标识只存在于审计面（ToolRuntimeMeta.source='mcp' + trace）。
 *
 * 治理面（对齐 WebSearch 三条 + 共享隐私红线 privacy-filter.ts）：
 * ① 预算：任务级外部调用池（默认 5；两工具共享——预算治的是外部成本）；
 * ② 缓存：规范化 key（工具名+参数）→ 内存 Map + TTL（默认 30 分钟；引擎级共享）；
 * ③ 隐私红线：PRIVACY_PATTERN 拒绝外发（用户事实不出境是统一治理规则）。
 */
import { createMCPClient } from '@ai-sdk/mcp'
import type { MCPClient } from '@ai-sdk/mcp'
import { tool } from 'ai'
import type { Tool } from 'ai'
import { z } from 'zod'
import type { Logger } from '../../logger.ts'
import type { ToolEvidence } from '../../ir/schema.ts'
import { extractSourceUrls, renderSources } from './web-search.ts'
import { PRIVACY_PATTERN } from './privacy-filter.ts'
import type { ToolRuntimeMeta } from './tool-assembly.ts'

export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
export const EXA_SESSION_BUDGET = 5
export const EXA_CACHE_TTL_MINUTES = 30

// Provider Stability v0.1：@ai-sdk/mcp 默认无超时（挂起 = 永不 ready）——显式接入 SDK 配置
export const EXA_INIT_TIMEOUT_MS = 15_000
export const EXA_INIT_MAX_TOTAL_TIMEOUT_MS = 30_000
export const EXA_CALL_TIMEOUT_MS = 60_000
export const EXA_CALL_MAX_TOTAL_TIMEOUT_MS = 180_000

/** MCP 工具名 → 认知层工具名（T1：协议/供应商标识在转译点消失，Agent 只见能力动词） */
export const EXA_TOOL_MAP = {
  web_search_exa: 'WebResearch',
  web_fetch_exa: 'WebFetch',
} as const

export type ExaMcpToolName = keyof typeof EXA_TOOL_MAP

/** 认知层描述：只写能力语义与定位分工，不含 Exa/MCP 供应商标识（T1） */
const EXA_TOOL_DESCRIPTIONS: Record<ExaMcpToolName, string> = {
  web_search_exa:
    '深入研究检索（深度调研专用）：语义搜索 + 干净内容抽取，返回带来源引用的高质量检索文本——适合公司研究/行业研究/岗位趋势等需要深度的查询，结果质量高于快速搜索。即时事实快查请用 WebSearch（快搜）。每任务有调用预算，请聚焦关键查询。',
  web_fetch_exa:
    '读取网页全文（转 markdown）：输入一个或多个 URL，返回页面正文——适合在检索命中后深入阅读来源页面。每任务有调用预算。',
}

/** Exa 工具治理元数据（Tool Assembly Layer）：mcp 源 = 外部协议适配（数据出境 external） */
export const EXA_TOOL_META: Record<string, ToolRuntimeMeta> = {
  WebResearch: { source: 'mcp', egress: 'external', budget: EXA_SESSION_BUDGET, traceScope: 'exa', provider: 'exa' },
  WebFetch: { source: 'mcp', egress: 'external', budget: EXA_SESSION_BUDGET, traceScope: 'exa', provider: 'exa' },
}

/** 预算/隐私策略错误（工具层转为文本回给模型，不抛穿循环） */
export class ExaPolicyError extends Error {
  readonly code: 'privacy' | 'budget_exhausted'
  constructor(code: 'privacy' | 'budget_exhausted', message: string) {
    super(message)
    this.name = 'ExaPolicyError'
    this.code = code
  }
}

// ─── ExaConnector：引擎级连接（幂等、fail-safe）─────────────────────────────

export interface ExaConnectorOptions {
  /** Exa API key（可选：匿名限速可用；key 提升额度） */
  apiKey?: string
  logger?: Logger
  /** 测试注入：MCP client 工厂（缺省 = 真连 Exa hosted endpoint） */
  clientFactory?: () => Promise<MCPClient>
  /** 调用超时（毫秒；缺省 = EXA_CALL_TIMEOUT_MS；测试注短值验证透传） */
  callTimeoutMs?: number
  /** 调用总超时上限（毫秒；缺省 = EXA_CALL_MAX_TOTAL_TIMEOUT_MS） */
  callMaxTotalTimeoutMs?: number
}

export class ExaConnector {
  private client: MCPClient | null = null
  private mcpTools: Record<string, Tool<any, any>> | null = null
  private connectPromise: Promise<boolean> | null = null
  private readonly opts: ExaConnectorOptions

  constructor(opts: ExaConnectorOptions) {
    this.opts = opts
  }

  /** 幂等连接：并发调用共享同一 promise；失败 → trace + false（fail-safe，不抛——外部工具不可用不拖垮主链路） */
  connect(): Promise<boolean> {
    if (this.connectPromise === null) {
      this.connectPromise = this.doConnect()
    }
    return this.connectPromise
  }

  private async doConnect(): Promise<boolean> {
    try {
      const client = await (this.opts.clientFactory ??
        (() =>
          createMCPClient({
            transport: {
              type: 'http',
              url: EXA_MCP_URL,
              ...(this.opts.apiKey !== undefined && this.opts.apiKey !== ''
                ? { headers: { Authorization: `Bearer ${this.opts.apiKey}` } }
                : {}),
            },
            // Provider Stability v0.1：SDK 默认无超时（挂起 = 连接永不 ready）+ 瞬态失败重试默认 0
            initializationOptions: { timeout: EXA_INIT_TIMEOUT_MS, maxTotalTimeout: EXA_INIT_MAX_TOTAL_TIMEOUT_MS },
            maxRetries: 1,
          })))()
      const defs = await client.listTools()
      this.mcpTools = client.toolsFromDefinitions(defs) as Record<string, Tool<any, any>>
      this.client = client
      this.opts.logger?.trace('exa', { event: 'connect_ok', toolCount: defs.tools.length })
      return true
    } catch (err) {
      this.opts.logger?.trace('exa', {
        event: 'connect_error',
        error: err instanceof Error ? err.message : String(err),
      })
      this.client = null
      this.mcpTools = null
      return false
    }
  }

  /** 是否连接成功（false/未连接 = 装配层交集排除，不注册工具） */
  get ready(): boolean {
    return this.client !== null
  }

  /** 已连接的 MCP 工具（未连接 = undefined） */
  mcpTool(name: ExaMcpToolName): Tool<any, any> | undefined {
    return this.mcpTools?.[name]
  }

  /** 调用 MCP 工具并提取文本（CallToolResult.content 的 text 块拼接）；
   *  超时/重试由 SDK 配置承担（callTool RequestOptions + maxRetries=1），本层记耗时 trace */
  async callToolText(name: ExaMcpToolName, args: Record<string, unknown>): Promise<string> {
    const client = this.client
    if (client === null) throw new Error('外部检索连接未就绪')
    const startedAt = Date.now()
    try {
      const res = await client.callTool({
        name,
        arguments: args,
        options: {
          timeout: this.opts.callTimeoutMs ?? EXA_CALL_TIMEOUT_MS,
          maxTotalTimeout: this.opts.callMaxTotalTimeoutMs ?? EXA_CALL_MAX_TOTAL_TIMEOUT_MS,
        },
      })
      const content = (res.content ?? []) as Array<{ type?: string; text?: string }>
      const text = content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n')
      if (res.isError === true) throw new Error(`外部检索服务错误：${text.slice(0, 200)}`)
      if (text.trim().length === 0) throw new Error('检索完成但无文本产出')
      this.opts.logger?.trace('exa', { event: 'call_ok', toolName: name, durationMs: Date.now() - startedAt })
      return text
    } catch (err) {
      this.opts.logger?.trace('exa', { event: 'call_error', toolName: name, durationMs: Date.now() - startedAt })
      throw err
    }
  }

  async close(): Promise<void> {
    const client = this.client
    this.client = null
    this.mcpTools = null
    if (client !== null) await client.close().catch(() => {})
  }
}

// ─── ExaSession：任务级治理（预算 + 缓存 + 隐私）──────────────────────────

export interface ExaCacheEntry {
  text: string
  at: number
}

export interface ExaSessionOptions {
  connector: ExaConnector
  /** 任务级预算（正整数；引擎单方决定） */
  budget: number
  /** 缓存 TTL（毫秒；0 = 不缓存） */
  cacheTtlMs: number
  /** 共享缓存（引擎级单例——跨任务复用检索结果；缺省 = 会话私有，测试友好） */
  cache?: Map<string, ExaCacheEntry>
  /** 证据分桶标签覆盖（缺省 = EXA_TOOL_MAP；行业模板工具用独立标签，避免与 WebResearch 串桶） */
  evidenceLabels?: Partial<Record<ExaMcpToolName, string>>
  logger?: Logger
}

export interface ExaSession {
  /** 执行入口：隐私拒绝/预算用尽抛 ExaPolicyError；外部失败抛 Error（工具层转文本） */
  execute(toolName: ExaMcpToolName, args: Record<string, unknown>): Promise<string>
  /** 证据引用（Tool Evidence Contract 生产方：检索成功的来源 URL；按认知层工具名分桶，取即清） */
  takeEvidence(displayName: string): ToolEvidence[]
}

export function createExaSession(opts: ExaSessionOptions): ExaSession {
  if (!Number.isInteger(opts.budget) || opts.budget <= 0) {
    throw new Error(`exa budget 应为正整数（当前 ${opts.budget}）`)
  }
  const cache = opts.cache ?? new Map<string, ExaCacheEntry>()
  let used = 0
  const evidenceBuf = new Map<string, ToolEvidence[]>()
  const labelOf = (toolName: ExaMcpToolName): string => opts.evidenceLabels?.[toolName] ?? EXA_TOOL_MAP[toolName]
  const trace = (event: string): void => {
    opts.logger?.trace('exa', { event, budgetUsed: used, budgetTotal: opts.budget })
  }
  const recordEvidence = (displayName: string, text: string, at: number): void => {
    const urls = extractSourceUrls(text).map((s) => s.url).filter((u) => u !== '')
    if (urls.length === 0) return
    const list = evidenceBuf.get(displayName) ?? []
    list.push({
      source: 'mcp',
      provider: 'exa',
      citation: urls.join(' | '),
      fetchedAt: new Date(at).toISOString(),
    })
    evidenceBuf.set(displayName, list)
  }

  return {
    async execute(toolName, args) {
      const flat = Object.values(args)
        .filter((v): v is string => typeof v === 'string')
        .join(' ')
      if (PRIVACY_PATTERN.test(flat)) {
        throw new ExaPolicyError(
          'privacy',
          `${EXA_TOOL_MAP[toolName]} 拒绝执行：查询含疑似个人信息（手机号/邮箱/身份证），隐私红线禁止外发。请改用不含个人标识的查询。`,
        )
      }
      const key = `${toolName}::${JSON.stringify(args)}`
      if (opts.cacheTtlMs > 0) {
        const hit = cache.get(key)
        if (hit !== undefined && Date.now() - hit.at < opts.cacheTtlMs) {
          trace('cache_hit')
          recordEvidence(labelOf(toolName), hit.text, hit.at)
          const at = new Date(hit.at).toISOString().slice(0, 16)
          return `${hit.text}\n\n（本结果为检索缓存，首次检索时间 ${at}——如需要最新数据请换查询角度）`
        }
        if (hit !== undefined) cache.delete(key) // 过期即失效
      }
      if (used >= opts.budget) {
        trace('budget_exhausted')
        throw new ExaPolicyError(
          'budget_exhausted',
          `${EXA_TOOL_MAP[toolName]} 已停用：本任务外部检索预算（${opts.budget} 次）用尽。请基于已获得的信息继续完成当前任务，不要再调用检索。`,
        )
      }
      used += 1 // 预算语义 = 外部调用次数上限：调用即消耗（失败亦然）
      trace('search_start')
      let text: string
      try {
        text = await opts.connector.callToolText(toolName, args)
      } catch (err) {
        trace('search_error')
        throw err
      }
      // 引用保障：文本缺来源段但提取到 URL → 追加结构化来源段（不重复已有引用）
      const urls = extractSourceUrls(text)
      if (urls.length > 0 && !text.includes('数据来源')) {
        text = `${text}\n\n${renderSources(urls)}`
      }
      recordEvidence(labelOf(toolName), text, Date.now())
      if (opts.cacheTtlMs > 0) cache.set(key, { text, at: Date.now() })
      return text
    },
    takeEvidence(displayName) {
      const out = evidenceBuf.get(displayName) ?? []
      evidenceBuf.delete(displayName)
      return out
    },
  }
}

// ─── 客户端工具（streamText 工具循环）───────────────────────────────────────

/** MCP 工具 → AI SDK 工具（认知层包装：语义名 + 语义描述 + 治理会话执行） */
export function buildExaTools(connector: ExaConnector, session: ExaSession): Record<string, Tool<any, any>> {
  const tools: Record<string, Tool<any, any>> = {}
  for (const [mcpName, displayName] of Object.entries(EXA_TOOL_MAP) as Array<[ExaMcpToolName, string]>) {
    const base = connector.mcpTool(mcpName)
    if (base === undefined) continue // 未连接/工具缺失 → 不注册（fail-safe）
    tools[displayName] = tool({
      description: EXA_TOOL_DESCRIPTIONS[mcpName],
      inputSchema: base.inputSchema,
      execute: async (input) => {
        // 外部输入边界校验：MCP 工具入参应为对象（协议保证，边界校验）
        const args = typeof input === 'object' && input !== null && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : null
        if (args === null) return `${displayName} 失败：入参应为对象`
        try {
          return await session.execute(mcpName, args)
        } catch (err) {
          if (err instanceof ExaPolicyError) return err.message
          return `${displayName} 失败：${err instanceof Error ? err.message : String(err)}`
        }
      },
    })
  }
  return tools
}

// ─── 行业证据模板工具（Phase 3D：Engine 提供确定性检索配方，Agent 只消费事实）────

/**
 * 行业证据检索模板（Engine 侧确定性配方——查询词不由 Agent 自由发挥；
 * 仅区域 + 行业两个受控输入。空输入 → 空串（工具层转错误文本））。
 */
export function buildIndustrySearchQuery(region: string, industry: string): string {
  const r = region.trim()
  const i = industry.trim()
  if (r === '' || i === '') return ''
  return `${r} ${i} 产业集群 龙头企业 政策文件 园区规划 就业环境 产业规模`
}

/** QueryIndustryEvidence 治理元数据：mcp 源（Exa），独立会话预算/缓存（不挤占 WebResearch） */
export const INDUSTRY_EVIDENCE_TOOL_META: Record<string, ToolRuntimeMeta> = {
  QueryIndustryEvidence: {
    source: 'mcp',
    egress: 'external',
    budget: EXA_SESSION_BUDGET,
    traceScope: 'exa_industry',
    provider: 'exa',
  },
}

/** 行业证据检索工具（T1 认知面隔离：无供应商标识 + 诚实边界——统计口径值不在本工具）；
 *  返回 Record（与 buildNbsTools/buildExaTools 同形态，装配层 spread） */
export function buildIndustryEvidenceTool(session: ExaSession): Record<string, Tool<any, any>> {
  return {
    QueryIndustryEvidence: tool({
      description:
        '行业证据检索（深度研究专用）：输入区域与行业，检索产业集群/龙头企业/政策文件/园区规划/就业环境等资料，返回带来源引用的检索文本。统计口径值（企业数量/营收/利润等）不在本工具——权威数字请用权威统计工具（CompareRegionProfiles/QueryMacroStats）。注意：本工具每任务有调用预算，请聚焦关键检索。',
      inputSchema: z.object({
        region: z.string().min(1).max(20).describe('区域（省区市全称/简称或主要城市，如 苏州/江苏）'),
        industry: z.string().min(1).max(30).describe('行业（如 医疗器械/新能源/机器人）'),
      }),
      execute: async (input) => {
        const region = typeof input.region === 'string' ? input.region : ''
        const industry = typeof input.industry === 'string' ? input.industry : ''
        const query = buildIndustrySearchQuery(region, industry)
        if (query === '') return 'QueryIndustryEvidence 失败：区域与行业不能为空'
        try {
          return await session.execute('web_search_exa', { query })
        } catch (err) {
          if (err instanceof ExaPolicyError) return err.message
          return `QueryIndustryEvidence 失败：${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),
  }
}
