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
import type { ToolEvidence } from '../../../ir/schema.ts'
import { PRIVACY_PATTERN } from '../privacy-filter.ts'
import { findRegionCode } from './regions.ts'
import {
  buildIndicatorIndex,
  fetchCatalogChildren,
  fetchIndicators,
  fetchSeries,
  NBS_INDEX_TTL_MS,
  NBS_TREE_ROOT_CATALOG_ID,
  NBS_YEAR_DB,
  type NbsCatalogNode,
  type NbsHttpTuning,
  type NbsIndicator,
  type NbsIndicatorIndex,
} from './api.ts'
import { NBS_CURATOR } from './aliases.ts'
import { resolveIndicator as resolveByResolver, type ResolveResult, type ResolverTreeDeps, type ResolvedIndicator } from './resolver.ts'
import {
  PROFILE_QUERY_THROTTLE_MS,
  URBAN_ECONOMY_V1,
  queryRegionProfiles,
  renderProfileMatrix,
  type ProfileConnector,
  type ProfileRows,
} from './profile.ts'
import type { ToolRuntimeMeta } from '../tool-assembly.ts'

export const NBS_SESSION_BUDGET = 3
export const NBS_CACHE_TTL_MINUTES = 1440
/** 画像会话预算（API 请求口径 = 外部 esData 调用次数；3 区域 × 4 指标全异分类最坏 12） */
export const NBS_PROFILE_SESSION_MAX_REQUESTS = 12

/** QueryMacroStats 治理元数据（Tool Assembly Layer）：data 源 = 结构化数据查询（出境 external） */
export const NBS_TOOL_META: Record<string, ToolRuntimeMeta> = {
  QueryMacroStats: { source: 'data', egress: 'external', budget: NBS_SESSION_BUDGET, traceScope: 'nbs', provider: 'nbs' },
}

/** CompareRegionProfiles 治理元数据：同 data 源；独立会话预算（互不挤占 QueryMacroStats） */
export const NBS_PROFILE_TOOL_META: Record<string, ToolRuntimeMeta> = {
  CompareRegionProfiles: {
    source: 'data',
    egress: 'external',
    budget: NBS_PROFILE_SESSION_MAX_REQUESTS,
    traceScope: 'nbs_profile',
    provider: 'nbs',
  },
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
  /** 测试注入：resolver 树依赖（缺省 = 真连树 + 节点缓存） */
  treeDeps?: ResolverTreeDeps
  /** HTTP 调优（Provider Stability v0.1：timeout/重试——单测注短值，生产缺省 = 常量） */
  http?: NbsHttpTuning
}

export class NbsConnector {
  private index: NbsIndicatorIndex | null = null
  private indexPromise: Promise<NbsIndicatorIndex | null> | null = null
  /** 树节点缓存（cid → children；TTL 天级——resolver 定向下钻的请求去重） */
  private nodeCache = new Map<string, { kids: NbsCatalogNode[]; at: number }>()
  /** 指标 id → 分类 id 缓存（curator + 树搜索命中记录；indicatorId 消歧闭环用） */
  private idCatalog = new Map<string, string>()
  private readonly opts: NbsConnectorOptions
  /** HTTP 调优（合并 connector logger——http_call 事件透传通道，Provider Stability v0.1） */
  private readonly http: NbsHttpTuning

  constructor(opts: NbsConnectorOptions = {}) {
    this.opts = opts
    this.http = { ...(opts.http ?? {}), ...(opts.logger !== undefined ? { logger: opts.logger } : {}) }
  }

  /** 幂等索引预热：并发共享同一 promise；失败 → null（fail-safe，查询时报错文本） */
  ensureIndex(): Promise<NbsIndicatorIndex | null> {
    if (this.index !== null && Date.now() - this.index.builtAt < NBS_INDEX_TTL_MS) return Promise.resolve(this.index)
    if (this.indexPromise === null) {
      const build = this.opts.indexBuilder ?? (async (): Promise<NbsIndicatorIndex> => buildIndicatorIndex(this.http))
      this.indexPromise = build()
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

  // ─── 树访问（resolver deps）：节点缓存 + 节流由 resolver 控制 ──────────────

  private async childrenOfCached(cid: string): Promise<NbsCatalogNode[]> {
    const hit = this.nodeCache.get(cid)
    if (hit !== undefined && Date.now() - hit.at < NBS_INDEX_TTL_MS) return hit.kids
    const kids = await fetchCatalogChildren(cid, NBS_YEAR_DB, this.http)
    this.nodeCache.set(cid, { kids, at: Date.now() })
    return kids
  }

  private async indicatorsOfCached(cid: string): Promise<NbsIndicator[]> {
    return fetchIndicators(cid, '', this.http)
  }

  /** resolver 树依赖（注入优先；否则缓存视图——resolver 内部节流纪律不破坏缓存命中） */
  resolverDeps(): ResolverTreeDeps {
    if (this.opts.treeDeps !== undefined) return this.opts.treeDeps
    return {
      topCategories: async () => {
        const roots = await this.childrenOfCached('')
        const rootId = roots[0]?._id ?? ''
        return rootId !== '' ? this.childrenOfCached(rootId) : []
      },
      childrenOf: (cid) => this.childrenOfCached(cid),
      indicatorsOf: (cid) => this.indicatorsOfCached(cid),
    }
  }

  /** 关键词 → 解析结果（curator 优先 + 树搜索兜底 + Ambiguity Gate）；树命中记录 id→catalog */
  async resolveIndicator(keyword: string): Promise<ResolveResult> {
    const result = await resolveByResolver(keyword, {
      curator: NBS_CURATOR,
      tree: this.resolverDeps(),
      logger: this.opts.logger,
    })
    if (result.kind === 'resolved') this.idCatalog.set(result.indicator.indicatorId, result.indicator.catalogId)
    if (result.kind === 'candidates') {
      for (const o of result.options) this.idCatalog.set(o.indicatorId, o.catalogId)
    }
    return result
  }

  /** indicatorId → 分类 id（消歧闭环第二轮；curator 静态映射兜底） */
  catalogOf(indicatorId: string): string | undefined {
    const byCache = this.idCatalog.get(indicatorId)
    if (byCache !== undefined) return byCache
    return NBS_CURATOR.find((e) => e.indicatorId === indicatorId)?.catalogId
  }

  /** 数据序列查询（das 12 位区划码；dts 年份区间） */
  async querySeries(opts: {
    cid: string
    indicatorId: string
    regionCode: string
    regionName: string
    years: string[]
  }): Promise<{ year: string; value: string; unit: string; indicatorName: string }[]> {
    const series = await fetchSeries(
      {
        cid: opts.cid,
        indicatorIds: [opts.indicatorId],
        das: [{ text: opts.regionName, value: opts.regionCode }],
        dts: opts.years,
        rootId: NBS_TREE_ROOT_CATALOG_ID,
      },
      this.http,
    )
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

  /** 批量数据序列查询（同分类多指标一次 esData；ProfileConnector 窄接口实现——画像矩阵用） */
  async querySeriesBatch(opts: {
    cid: string
    indicatorIds: string[]
    regionCode: string
    regionName: string
    years: string[]
  }): Promise<ProfileRows[]> {
    const series = await fetchSeries(
      {
        cid: opts.cid,
        indicatorIds: opts.indicatorIds,
        das: [{ text: opts.regionName, value: opts.regionCode }],
        dts: opts.years,
        rootId: NBS_TREE_ROOT_CATALOG_ID,
      },
      this.http,
    )
    const out: ProfileRows[] = []
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
  /** 证据快照（缓存命中时作为生产方证据引用复现——fetchedAt 为首次获取时刻） */
  evidence?: ToolEvidence[]
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
  /** 消歧闭环：候选列表返回的指标 id（第二轮指认后精确查询，跳过解析） */
  indicatorId?: string
}

export interface NbsSession {
  /** 执行入口：隐私拒绝/预算用尽抛 NbsPolicyError；外部失败抛 Error（工具层转文本） */
  execute(input: NbsQueryInput): Promise<string>
  /** 证据引用（Tool Evidence Contract 生产方：成功查询的指标证据；取即清——runner 在 tool_done 取） */
  takeEvidence(): ToolEvidence[]
  /** 预算被拒是否已发生（budget_exhausted 事实——ADR-035 完成语义校验输入） */
  isBudgetExhausted(): boolean
}

/** 证据 period = 最新数据年份（rows 年份文本如「2024年」→ 取最大；无 → undefined） */
function latestYear(rows: Array<{ year: string }>): string | undefined {
  let max = -1
  for (const r of rows) {
    const m = /^(\d{4})/.exec(r.year)
    if (m !== null && Number(m[1]) > max) max = Number(m[1])
  }
  return max >= 0 ? `${max}年` : undefined
}

/** 构建 NBS 查询证据（生产方记录：citation=指标 id，period=最新年份，confidence=解析置信） */
function buildNbsEvidence(resolved: ResolvedIndicator, rows: Array<{ year: string }>, at: number): ToolEvidence {
  const period = latestYear(rows)
  return {
    source: 'data',
    provider: 'nbs',
    citation: resolved.indicatorId,
    fetchedAt: new Date(at).toISOString(),
    ...(period !== undefined ? { period } : {}),
    ...(resolved.confidence !== undefined ? { producerConfidence: resolved.confidence } : {}),
  }
}

export function createNbsSession(opts: NbsSessionOptions): NbsSession {
  if (!Number.isInteger(opts.budget) || opts.budget <= 0) {
    throw new Error(`nbs budget 应为正整数（当前 ${opts.budget}）`)
  }
  const cache = opts.cache ?? new Map<string, NbsCacheEntry>()
  let used = 0
  let exhausted = false
  const evidenceBuf: ToolEvidence[] = []
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
          evidenceBuf.push(...(hit.evidence ?? []))
          const at = new Date(hit.at).toISOString().slice(0, 16)
          return `${hit.text}\n\n（本结果为统计缓存，首次查询时间 ${at}——官方年度数据低频更新）`
        }
        if (hit !== undefined) cache.delete(key)
      }
      // 本地校验先行（不消耗外部预算）：地区解析 + 指标解析（curator/树缓存为本地操作）
      const regionCode = findRegionCode(region)
      if (regionCode === undefined) {
        return `QueryMacroStats 失败：未识别地区「${region}」（支持省区市全称/简称与主要城市，如 苏州/江苏/全国）`
      }
      // 指标解析：indicatorId 指认优先（消歧闭环）→ 语义解析（resolved/candidates/miss）
      let resolved: ResolvedIndicator | undefined
      if (input.indicatorId !== undefined && input.indicatorId !== '') {
        const cid = opts.connector.catalogOf(input.indicatorId)
        if (cid !== undefined) {
          resolved = { indicatorId: input.indicatorId, catalogId: cid, name: input.indicator, path: '（指标 id 指认）', confidence: 1 }
        } else {
          return `QueryMacroStats 失败：未识别指标 id「${input.indicatorId}」（候选列表的 id 才有效）`
        }
      } else {
        let result: ResolveResult
        try {
          result = await opts.connector.resolveIndicator(input.indicator)
        } catch (err) {
          return `QueryMacroStats 失败：${err instanceof Error ? err.message : String(err)}`
        }
        if (result.kind === 'miss') {
          return `QueryMacroStats 失败：未找到指标「${input.indicator}」（年度口径；请用更精确的关键词，如 工业增加值/居民人均可支配收入/GDP）`
        }
        if (result.kind === 'candidates') {
          // Ambiguity Gate：歧义显式化——返回候选编号列表，不静默选（第二轮用 indicatorId 指认）
          const lines = result.options.map(
            (o, i) => `${i + 1}. ${o.name}（路径：${o.path}；indicatorId: ${o.indicatorId}）`,
          )
          return [
            `QueryMacroStats 找到多个候选指标（歧义显式化，未自动选择）：`,
            ...lines,
            '请与用户确认选用哪个，然后用其 indicatorId 再次查询。',
          ].join('\n')
        }
        resolved = result.indicator
      }
      if (used >= opts.budget) {
        exhausted = true
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
          cid: resolved.catalogId,
          indicatorId: resolved.indicatorId,
          regionCode,
          regionName: region,
          years,
        })
        if (rows.length === 0) {
          return `QueryMacroStats 完成但无数据：指标「${resolved.name}」在「${region}」${years[0]} 无统计值（该地区/年份可能无此口径数据——部分指标如 GDP 无城市级口径，建议改用省级）`
        }
        const lines = rows.map((r) => `- ${r.year}：${r.value}${r.unit !== '' ? ` ${r.unit}` : ''}`)
        const text = [
          '【权威统计数据】',
          `指标：${rows[0].indicatorName || resolved.name}`,
          `指标路径：${resolved.path}`,
          `地区：${region}`,
          ...lines,
          '',
          '数据来源：国家统计局 · 国家数据（data.stats.gov.cn 年度数据）',
        ].join('\n')
        opts.logger?.trace('nbs', {
          event: 'query_ok',
          budgetUsed: used,
          budgetTotal: opts.budget,
          indicatorId: resolved.indicatorId,
          confidence: resolved.confidence,
        })
        const ev = buildNbsEvidence(resolved, rows, Date.now())
        evidenceBuf.push(ev)
        if (opts.cacheTtlMs > 0) cache.set(key, { text, at: Date.now(), evidence: [ev] })
        return text
      } catch (err) {
        trace('search_error')
        throw err
      }
    },
    takeEvidence() {
      const out = [...evidenceBuf]
      evidenceBuf.length = 0
      return out
    },
    isBudgetExhausted() {
      return exhausted
    },
  }
}

// ─── NbsProfileSession：任务级治理（预算 + 缓存 + 隐私；画像矩阵）──────────

export interface NbsProfileSessionOptions {
  connector: ProfileConnector
  /** 任务级画像预算（正整数；API 请求口径 = 外部 esData 调用次数——Engine 决定，Agent 只消费） */
  budget: number
  /** 缓存 TTL（毫秒；宏观数据低频，默认天级） */
  cacheTtlMs: number
  /** 外部请求节流（毫秒；缺省 = PROFILE_QUERY_THROTTLE_MS 真机安全值；测试注入 0） */
  throttleMs?: number
  /** 共享缓存（引擎级单例——跨任务复用；key 含 profileId+regions，与 QueryMacroStats 命名空间隔离） */
  cache?: Map<string, NbsCacheEntry>
  logger?: Logger
}

export interface NbsProfileSession {
  /** 执行入口：隐私拒绝/预算用尽抛 NbsPolicyError；外部失败抛 Error（工具层转文本） */
  execute(regions: string[]): Promise<string>
  /** 证据引用（Tool Evidence Contract 生产方：画像矩阵证据；取即清） */
  takeEvidence(): ToolEvidence[]
  /** 预算被拒是否已发生（budget_exhausted 事实——ADR-035 完成语义校验输入） */
  isBudgetExhausted(): boolean
}

export function createNbsProfileSession(opts: NbsProfileSessionOptions): NbsProfileSession {
  if (!Number.isInteger(opts.budget) || opts.budget <= 0) {
    throw new Error(`nbs profile budget 应为正整数（当前 ${opts.budget}）`)
  }
  const cache = opts.cache ?? new Map<string, NbsCacheEntry>()
  let used = 0
  let exhausted = false
  const evidenceBuf: ToolEvidence[] = []
  const trace = (event: string, extra?: Record<string, unknown>): void => {
    opts.logger?.trace('nbs_profile', { event, budgetUsed: used, budgetTotal: opts.budget, ...extra })
  }
  // 预算门卫（计数代理）：只在外部 esData 调用时消耗——本地解析/歧义/未匹配不消耗（对齐 QueryMacroStats）
  const guardedConnector: ProfileConnector = {
    resolveIndicator: (keyword) => opts.connector.resolveIndicator(keyword),
    querySeriesBatch: async (q) => {
      if (used >= opts.budget) {
        exhausted = true
        trace('budget_exhausted')
        throw new NbsPolicyError(
          'budget_exhausted',
          `CompareRegionProfiles 已停用：本任务画像查询预算（${opts.budget} 次）用尽。请基于已获得的数据继续完成当前任务，不要再调用区域画像查询。`,
        )
      }
      used += 1 // 预算语义 = 外部数据请求次数：调用即消耗（失败亦然）
      trace('query_batch', { regionName: q.regionName, indicatorCount: q.indicatorIds.length })
      return opts.connector.querySeriesBatch(q)
    },
  }

  return {
    async execute(regions) {
      const flat = regions.join(' ')
      if (PRIVACY_PATTERN.test(flat)) {
        throw new NbsPolicyError(
          'privacy',
          'CompareRegionProfiles 拒绝执行：查询含疑似个人信息（手机号/邮箱/身份证），隐私红线禁止外发。请改用不含个人标识的地区名。',
        )
      }
      const key = `nbs_profile::${URBAN_ECONOMY_V1.id}::${regions.join(',')}`
      if (opts.cacheTtlMs > 0) {
        const hit = cache.get(key)
        if (hit !== undefined && Date.now() - hit.at < opts.cacheTtlMs) {
          trace('cache_hit')
          evidenceBuf.push(...(hit.evidence ?? []))
          const at = new Date(hit.at).toISOString().slice(0, 16)
          return `${hit.text}\n\n（本结果为统计缓存，首次查询时间 ${at}——官方年度数据低频更新）`
        }
        if (hit !== undefined) cache.delete(key)
      }
      trace('profile_start', { regions: regions.length })
      const matrix = await queryRegionProfiles(
        guardedConnector,
        URBAN_ECONOMY_V1,
        regions,
        opts.throttleMs ?? PROFILE_QUERY_THROTTLE_MS,
      )
      const text = renderProfileMatrix(matrix, URBAN_ECONOMY_V1)
      trace('profile_ok', {
        regions: matrix.length,
        available: matrix.reduce((n, r) => n + r.coverage.available, 0),
        total: matrix.reduce((n, r) => n + r.coverage.total, 0),
      })
      const ev: ToolEvidence = {
        source: 'data',
        provider: 'nbs',
        citation: `${URBAN_ECONOMY_V1.id}::${regions.join('|')}`,
        fetchedAt: new Date().toISOString(),
      }
      evidenceBuf.push(ev)
      if (opts.cacheTtlMs > 0) cache.set(key, { text, at: Date.now(), evidence: [ev] })
      return text
    },
    takeEvidence() {
      const out = [...evidenceBuf]
      evidenceBuf.length = 0
      return out
    },
    isBudgetExhausted() {
      return exhausted
    },
  }
}

// ─── 客户端工具（streamText 工具循环）───────────────────────────────────────

/** data capability → AI SDK 工具（认知层包装：能力语义名 + 权威定位描述 + 治理会话执行） */
export function buildNbsTools(session: NbsSession): Record<string, Tool<any, any>> {
  const queryMacroStats = tool({
    description:
      '权威统计数据查询（国家统计体系·年度口径）：输入指标关键词与地区，返回官方数值、单位与年份序列。GDP/产值/工业增加值/居民收入等权威数字必须用本工具，不得用搜索新闻替代。若返回多个候选指标（歧义），请与用户确认后带 indicatorId 再次查询。注意：每任务有查询预算，请聚焦关键指标一次查清。',
    inputSchema: z.object({
      indicator: z.string().min(1).max(50).describe('指标关键词（如：工业增加值 / 居民人均可支配收入 / GDP / 社会消费品零售总额）'),
      region: z.string().optional().describe('地区名（省区市全称/简称或主要城市，如 苏州/江苏；缺省 = 全国）'),
      year: z.string().optional().describe('年份（如 2024；缺省 = 近五年序列）'),
      indicatorId: z.string().optional().describe('候选列表返回的指标 id（歧义指认时传，跳过关键词解析）'),
    }),
    execute: async (input) => {
      try {
        return await session.execute({
          indicator: typeof input.indicator === 'string' ? input.indicator : String(input.indicator ?? ''),
          region: typeof input.region === 'string' ? input.region : '',
          year: typeof input.year === 'string' ? input.year : undefined,
          indicatorId: typeof input.indicatorId === 'string' && input.indicatorId !== '' ? input.indicatorId : undefined,
        })
      } catch (err) {
        if (err instanceof NbsPolicyError) return err.message
        return `QueryMacroStats 失败：${err instanceof Error ? err.message : String(err)}`
      }
    },
  })
  return { QueryMacroStats: queryMacroStats }
}

/** 画像矩阵工具（data capability 第二个工具；无协议/供应商标识——T1 认知面隔离） */
export function buildNbsProfileTools(session: NbsProfileSession): Record<string, Tool<any, any>> {
  const compareRegionProfiles = tool({
    description:
      '区域经济画像对比（权威统计数据·年度口径）：一次查询多个区域 × 一组经济指标（GDP、人均GDP、工业增加值、居民人均可支配收入），返回证据矩阵——各指标数值/年份与缺失覆盖诚实标注（无数据的指标明确说明，不补数、不做结论）。适用场景：城市/区域经济对比分析。标准地名为宜（苏州/上海/江苏/全国）。注意：本工具每任务有查询预算，请聚焦 2-3 个关键区域一次查清。',
    inputSchema: z.object({
      regions: z
        .array(z.string().min(1).max(20))
        .min(1)
        .max(3)
        .describe('地区名列表（2-3 个区域对比；如 苏州/上海/杭州；省区市全称/简称或主要城市）'),
    }),
    execute: async (input) => {
      const regions = Array.isArray(input.regions) ? input.regions.map(String) : []
      if (regions.length === 0) return 'CompareRegionProfiles 失败：regions 至少需要 1 个地区'
      try {
        return await session.execute(regions)
      } catch (err) {
        if (err instanceof NbsPolicyError) return err.message
        return `CompareRegionProfiles 失败：${err instanceof Error ? err.message : String(err)}`
      }
    },
  })
  return { CompareRegionProfiles: compareRegionProfiles }
}
