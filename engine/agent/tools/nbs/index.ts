/**
 * NBS 数据能力（Tool Runtime 第二阶段 Phase 3 —— data source 首个实例，Evidence Layer
 * 第一个 Data Provider）。
 *
 * 定位（用户裁决：吸收数据能力，不是移植 MCP）：NBS = Structured Data Query（确定指标/
 * 时间/区域的值），与 WebSearch（快事实）/ WebResearch（深资料）构成三种证据来源。
 * 数据访问层协议 = 国家数据新版 API（老 easyquery 已被站点 WAF 封禁——真机勘察结论，
 * 见 api.ts 协议事实注释）；地区表 = 国标行政区划代码（regions.ts）。
 *
 * 分层（与 Exa 同构）：
 * - NbsConnector（引擎级）：指标索引预热（顶级分类遍历，TTL 天级）+ 数据序列查询；
 *   索引预热不计任务预算（连接器初始化语义，对齐 Exa connect/listTools）
 * - NbsSession（任务级治理）：预算 3 次数据查询/任务（API 请求口径）、缓存 TTL 1440 分钟
 *   （宏观数据低频）、隐私红线共享 privacy-filter.ts、trace 前缀 nbs
 *
 * 认知面隔离（T1）：工具名 QueryMacroStats（能力语义），描述含权威性定位（GDP/产值类
 * 权威数字必须用本工具），无「easyquery/esData/API 协议」细节；协议与供应商标识只在审计面。
 */
import { tool } from 'ai'
import type { Tool } from 'ai'
import { z } from 'zod'
import type { Logger } from '../../../logger.ts'
import { PRIVACY_PATTERN } from '../privacy-filter.ts'
import { findRegionCode } from './regions.ts'
import {
  buildIndicatorIndex,
  fetchSeries,
  NBS_INDEX_TTL_MS,
  NBS_TREE_ROOT_CATALOG_ID,
  searchIndicator,
  type NbsIndicatorIndex,
} from './api.ts'
import type { ToolRuntimeMeta } from '../tool-assembly.ts'

export const NBS_SESSION_BUDGET = 3
export const NBS_CACHE_TTL_MINUTES = 1440

/** QueryMacroStats 治理元数据（Tool Assembly Layer）：data 源 = 结构化数据查询（出境 external） */
export const NBS_TOOL_META: Record<string, ToolRuntimeMeta> = {
  QueryMacroStats: { source: 'data', egress: 'external', budget: NBS_SESSION_BUDGET, traceScope: 'nbs', provider: 'nbs' },
}

/** 预算/隐私策略错误（工具层转文本回给模型，不抛穿循环） */
export class NbsPolicyError extends Error {
  readonly code: 'privacy' | 'budget_exhausted'
  constructor(code: 'privacy' | 'budget_exhausted', message: string) {
    super(message)
    this.name = 'NbsPolicyError'
    this.code = code
  }
}

// ─── NbsConnector：引擎级（指标索引 + 数据查询；索引预热幂等、fail-safe）────────

export interface NbsConnectorOptions {
  logger?: Logger
  /** 测试注入：索引构建器（缺省 = 真连国家数据 API） */
  indexBuilder?: () => Promise<NbsIndicatorIndex>
}

export class NbsConnector {
  private index: NbsIndicatorIndex | null = null
  private indexPromise: Promise<NbsIndicatorIndex | null> | null = null
  private readonly opts: NbsConnectorOptions

  constructor(opts: NbsConnectorOptions = {}) {
    this.opts = opts
  }

  /** 幂等索引预热：并发共享同一 promise；失败 → null（fail-safe，查询时报错文本） */
  ensureIndex(): Promise<NbsIndicatorIndex | null> {
    if (this.index !== null && Date.now() - this.index.builtAt < NBS_INDEX_TTL_MS) return Promise.resolve(this.index)
    if (this.indexPromise === null) {
      this.indexPromise = (this.opts.indexBuilder ?? buildIndicatorIndex)()
        .then((idx) => {
          this.index = idx
          this.opts.logger?.trace('nbs', { event: 'index_built', entryCount: idx.entries.length })
          return idx
        })
        .catch((err: unknown) => {
          this.indexPromise = null // 失败可重试
          this.opts.logger?.trace('nbs', {
            event: 'index_error',
            error: err instanceof Error ? err.message : String(err),
          })
          return null
        })
    }
    return this.indexPromise
  }

  /** 关键词 → 指标（未预热/未命中 → undefined） */
  async resolveIndicator(keyword: string): Promise<{ name: string; id: string; cid: string } | undefined> {
    const idx = await this.ensureIndex()
    if (idx === null) throw new Error('统计指标库不可用（索引预热失败），请稍后重试或改用搜索')
    return searchIndicator(idx, keyword)
  }

  /** 数据序列查询（das 12 位区划码；dts 年份区间） */
  async querySeries(opts: {
    cid: string
    indicatorId: string
    regionCode: string
    regionName: string
    years: string[]
  }): Promise<{ year: string; value: string; unit: string; indicatorName: string }[]> {
    const series = await fetchSeries({
      cid: opts.cid,
      indicatorIds: [opts.indicatorId],
      das: [{ text: opts.regionName, value: opts.regionCode }],
      dts: opts.years,
      rootId: NBS_TREE_ROOT_CATALOG_ID,
    })
    const out: { year: string; value: string; unit: string; indicatorName: string }[] = []
    for (const y of series) {
      for (const v of y.values ?? []) {
        const value = v.value
        if (value === undefined || value === '') continue
        out.push({
          year: y.name ?? y.code ?? '',
          value,
          unit: v.du_name ?? '',
          indicatorName: v.i_showname ?? v._name ?? '',
        })
      }
    }
    return out
  }
}

// ─── NbsSession：任务级治理（预算 + 缓存 + 隐私）────────────────────────────

export interface NbsCacheEntry {
  text: string
  at: number
}

export interface NbsSessionOptions {
  connector: NbsConnector
  /** 任务级数据查询预算（正整数；API 请求口径——Engine 决定，Agent 只消费） */
  budget: number
  /** 缓存 TTL（毫秒；宏观数据低频，默认天级） */
  cacheTtlMs: number
  /** 共享缓存（引擎级单例——跨任务复用；缺省 = 会话私有，测试友好） */
  cache?: Map<string, NbsCacheEntry>
  logger?: Logger
}

export interface NbsQueryInput {
  indicator: string
  region: string
  year?: string
}

export interface NbsSession {
  /** 执行入口：隐私拒绝/预算用尽抛 NbsPolicyError；外部失败抛 Error（工具层转文本） */
  execute(input: NbsQueryInput): Promise<string>
}

export function createNbsSession(opts: NbsSessionOptions): NbsSession {
  if (!Number.isInteger(opts.budget) || opts.budget <= 0) {
    throw new Error(`nbs budget 应为正整数（当前 ${opts.budget}）`)
  }
  const cache = opts.cache ?? new Map<string, NbsCacheEntry>()
  let used = 0
  const trace = (event: string): void => {
    opts.logger?.trace('nbs', { event, budgetUsed: used, budgetTotal: opts.budget })
  }

  return {
    async execute(input) {
      const region = input.region.trim() === '' ? '全国' : input.region.trim()
      const flat = `${input.indicator} ${region} ${input.year ?? ''}`
      if (PRIVACY_PATTERN.test(flat)) {
        throw new NbsPolicyError(
          'privacy',
          'QueryMacroStats 拒绝执行：查询含疑似个人信息（手机号/邮箱/身份证），隐私红线禁止外发。请改用不含个人标识的查询。',
        )
      }
      const key = `nbs::${input.indicator.trim()}::${region}::${input.year ?? ''}`
      if (opts.cacheTtlMs > 0) {
        const hit = cache.get(key)
        if (hit !== undefined && Date.now() - hit.at < opts.cacheTtlMs) {
          trace('cache_hit')
          const at = new Date(hit.at).toISOString().slice(0, 16)
          return `${hit.text}\n\n（本结果为统计缓存，首次查询时间 ${at}——官方年度数据低频更新）`
        }
        if (hit !== undefined) cache.delete(key)
      }
      // 本地校验先行（不消耗外部预算）：地区解析 + 指标解析（索引为引擎级内存，本地操作）
      const regionCode = findRegionCode(region)
      if (regionCode === undefined) {
        return `QueryMacroStats 失败：未识别地区「${region}」（支持省区市全称/简称与主要城市，如 苏州/江苏/全国）`
      }
      let hit: { name: string; id: string; cid: string } | undefined
      try {
        hit = await opts.connector.resolveIndicator(input.indicator)
      } catch (err) {
        return `QueryMacroStats 失败：${err instanceof Error ? err.message : String(err)}`
      }
      if (hit === undefined) {
        return `QueryMacroStats 失败：未找到指标「${input.indicator}」（年度口径；请用更精确的关键词，如 工业增加值/居民人均可支配收入）`
      }
      if (used >= opts.budget) {
        trace('budget_exhausted')
        throw new NbsPolicyError(
          'budget_exhausted',
          `QueryMacroStats 已停用：本任务统计查询预算（${opts.budget} 次）用尽。请基于已获得的数据继续完成当前任务，不要再调用统计查询。`,
        )
      }
      used += 1 // 预算语义 = 数据查询（API 请求）次数：外部查询即消耗（失败亦然）
      trace('search_start')
      try {
        const years = input.year !== undefined && input.year.trim() !== '' ? [`${input.year.trim()}YY`] : ['2021YY-2026YY']
        const rows = await opts.connector.querySeries({
          cid: hit.cid,
          indicatorId: hit.id,
          regionCode,
          regionName: region,
          years,
        })
        if (rows.length === 0) {
          return `QueryMacroStats 完成但无数据：指标「${hit.name}」在「${region}」${years[0]} 无统计值（该地区/年份可能无此口径数据）`
        }
        const lines = rows.map((r) => `- ${r.year}：${r.value}${r.unit !== '' ? ` ${r.unit}` : ''}`)
        const text = [
          '【权威统计数据】',
          `指标：${rows[0].indicatorName || hit.name}`,
          `地区：${region}`,
          ...lines,
          '',
          '数据来源：国家统计局 · 国家数据（data.stats.gov.cn 年度数据）',
        ].join('\n')
        trace('query_ok')
        if (opts.cacheTtlMs > 0) cache.set(key, { text, at: Date.now() })
        return text
      } catch (err) {
        trace('search_error')
        throw err
      }
    },
  }
}

// ─── 客户端工具（streamText 工具循环）───────────────────────────────────────

/** data capability → AI SDK 工具（认知层包装：能力语义名 + 权威定位描述 + 治理会话执行） */
export function buildNbsTools(session: NbsSession): Record<string, Tool<any, any>> {
  const queryMacroStats = tool({
    description:
      '权威统计数据查询（国家统计体系·年度口径）：输入指标关键词与地区，返回官方数值、单位与年份序列。GDP/产值/工业增加值/居民收入等权威数字必须用本工具，不得用搜索新闻替代。注意：首次查询需预热指标库（数秒）；每任务有查询预算，请聚焦关键指标一次查清。',
    inputSchema: z.object({
      indicator: z.string().min(1).max(50).describe('指标关键词（如：工业增加值 / 居民人均可支配收入 / 社会消费品零售总额）'),
      region: z.string().optional().describe('地区名（省区市全称/简称或主要城市，如 苏州/江苏；缺省 = 全国）'),
      year: z.string().optional().describe('年份（如 2024；缺省 = 近五年序列）'),
    }),
    execute: async (input) => {
      try {
        return await session.execute({
          indicator: typeof input.indicator === 'string' ? input.indicator : String(input.indicator ?? ''),
          region: typeof input.region === 'string' ? input.region : '',
          year: typeof input.year === 'string' ? input.year : undefined,
        })
      } catch (err) {
        if (err instanceof NbsPolicyError) return err.message
        return `QueryMacroStats 失败：${err instanceof Error ? err.message : String(err)}`
      }
    },
  })
  return { QueryMacroStats: queryMacroStats }
}
