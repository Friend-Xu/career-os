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
import type { Logger } from '../../logger.ts'
import { extractSourceUrls, renderSources } from './web-search.ts'
import { PRIVACY_PATTERN } from './privacy-filter.ts'
import type { ToolRuntimeMeta } from './tool-assembly.ts'

export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
export const EXA_SESSION_BUDGET = 5
export const EXA_CACHE_TTL_MINUTES = 30

/** MCP 工具名 → 认知层工具名（T1：协议/供应商标识在转译点消失，Agent 只见能力动词） */
export const EXA_TOOL_MAP = {
  web_search_exa: 'WebResearch',
  web_fetch_exa: 'WebFetch',
} as const

export type ExaMcpToolName = keyof typeof EXA_TOOL_MAP

/** 认知层描述：只写能力语义，不含 Exa/MCP 供应商标识（T1） */
const EXA_TOOL_DESCRIPTIONS: Record<ExaMcpToolName, string> = {
  web_search_exa:
    '深度联网检索（语义搜索）：返回干净、带来源引用的检索文本——适合公司研究/行业研究/岗位趋势等需要高质量结果的查询，与 WebSearch（快搜）互补。每任务有调用预算，请聚焦关键查询。',
  web_fetch_exa:
    '读取网页全文（转 markdown）：输入一个或多个 URL，返回页面正文——适合在检索命中后深入阅读来源页面。每任务有调用预算。',
}

/** Exa 工具治理元数据（Tool Assembly Layer）：mcp 源 = 外部协议适配（数据出境 external） */
export const EXA_TOOL_META: Record<string, ToolRuntimeMeta> = {
  WebResearch: { source: 'mcp', egress: 'external', budget: EXA_SESSION_BUDGET, traceScope: 'exa' },
  WebFetch: { source: 'mcp', egress: 'external', budget: EXA_SESSION_BUDGET, traceScope: 'exa' },
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

  /** 调用 MCP 工具并提取文本（CallToolResult.content 的 text 块拼接） */
  async callToolText(name: ExaMcpToolName, args: Record<string, unknown>): Promise<string> {
    const client = this.client
    if (client === null) throw new Error('外部检索连接未就绪')
    const res = await client.callTool({ name, arguments: args })
    const content = (res.content ?? []) as Array<{ type?: string; text?: string }>
    const text = content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
    if (res.isError === true) {
      throw new Error(`外部检索服务错误：${text.slice(0, 200)}`)
    }
    if (text.trim().length === 0) throw new Error('检索完成但无文本产出')
    return text
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
  logger?: Logger
}

export interface ExaSession {
  /** 执行入口：隐私拒绝/预算用尽抛 ExaPolicyError；外部失败抛 Error（工具层转文本） */
  execute(toolName: ExaMcpToolName, args: Record<string, unknown>): Promise<string>
}

export function createExaSession(opts: ExaSessionOptions): ExaSession {
  if (!Number.isInteger(opts.budget) || opts.budget <= 0) {
    throw new Error(`exa budget 应为正整数（当前 ${opts.budget}）`)
  }
  const cache = opts.cache ?? new Map<string, ExaCacheEntry>()
  let used = 0
  const trace = (event: string): void => {
    opts.logger?.trace('exa', { event, budgetUsed: used, budgetTotal: opts.budget })
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
      if (opts.cacheTtlMs > 0) cache.set(key, { text, at: Date.now() })
      return text
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
