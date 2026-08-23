/**
 * NBS 数据访问层（data capability）：国家数据新版 API 协议封装（Node fetch 直连，无外部依赖）。
 *
 * 协议事实（2026-08 真机勘察，老 easyquery 接口已被站点 WAF 封禁，新版为当前可达协议）：
 * - 指标树：GET /dg/website/publicrelease/web/external/new/queryIndexTreeAsync?pid={_id}&code=3
 *   （code 3=年度/2=季度/1=月度；pid 空 = 根；节点 _id 为下一级 pid）
 * - 分类指标：GET …/new/queryIndicatorsByCid?cid={分类 _id}&dt=&name=（name 仅过滤当前分类）
 * - 数据序列：POST …/stream/esData
 *   body = { cid, indicatorIds: [_id], daCatalogId: '', das: [{text, value: 12位区划码}],
 *            showType: '1', dts: ['YYYYYY-YYYYYY'], rootId }
 *   响应 data[] = { code:'2025YY', name:'2025年', values: [{ i_showname, value, du_name, da_name }] }
 *
 * 指标搜索：顶级分类（约 28 个）指标列表内存索引——首查预热（每分类一次 HTTP），TTL 天级。
 */
import { externalFetch, type ExternalCallOptions } from '../external-call.ts'
import type { Logger } from '../../../logger.ts'

export const NBS_API_BASE = 'https://data.stats.gov.cn/dg/website/publicrelease/web/external'
export const NBS_YEAR_DB = '3' // 年度数据（职业决策主口径）
export const NBS_TREE_ROOT_CATALOG_ID = '884c062607104a91967b22742537f44f' // 年度数据根 _id（真机勘察值）

/** NBS HTTP 调优（Provider Stability v0.1 接入：timeout/重试可注入——单测注短值/0，生产用常量） */
export interface NbsHttpTuning {
  timeoutMs?: number
  retries?: number
  retryBackoffMs?: number
  /** trace 通道（http_call 事件生产者；由 NbsConnector 构造时合并——接入点透传） */
  logger?: Logger
}

/** NBS 重试间隔（对齐 600ms 节流真机安全值——重试不放大 WAF 触发） */
export const NBS_RETRY_BACKOFF_MS = 600

const NBS_HTTP_DEFAULTS: ExternalCallOptions = {
  retryBackoffMs: NBS_RETRY_BACKOFF_MS,
}

/** 合并调优（boundary：值校验由调用方 fail fast——ExternalCallOptions 语义，非法值直接暴露） */
function httpOpts(tuning: NbsHttpTuning | undefined, endpoint: string): ExternalCallOptions {
  return {
    ...NBS_HTTP_DEFAULTS,
    ...(tuning?.timeoutMs !== undefined ? { timeoutMs: tuning.timeoutMs } : {}),
    ...(tuning?.retries !== undefined ? { retries: tuning.retries } : {}),
    ...(tuning?.retryBackoffMs !== undefined ? { retryBackoffMs: tuning.retryBackoffMs } : {}),
    ...(tuning?.logger !== undefined ? { logger: tuning.logger } : {}),
    traceScope: 'nbs',
    endpoint,
  }
}

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://data.stats.gov.cn/dg/website/page.html',
}

export interface NbsCatalogNode {
  _id?: string
  _name?: string
  name?: string
  isLeaf?: boolean
}

export interface NbsIndicator {
  _id?: string
  id?: string
  _name?: string
  name?: string
  /** 展示名（通常带单位后缀，如「社会消费品零售总额 (亿元) 」——resolver 首选匹配源） */
  i_showname?: string
  catalogid?: string
}

export interface NbsSeriesValue {
  i_showname?: string
  _name?: string
  value?: string
  du_name?: string
  da_name?: string
}

export interface NbsSeriesYear {
  code?: string
  name?: string
  values?: NbsSeriesValue[]
}

async function getJson(url: string, endpoint: string, tuning?: NbsHttpTuning): Promise<unknown> {
  const res = await externalFetch(`${NBS_API_BASE}${url}`, { headers: HEADERS }, httpOpts(tuning, endpoint))
  const text = await res.text()
  // WAF JS Challenge 页（连续快速请求触发）：返回 HTML 而非 JSON——识别并诚实报错（冷却后可恢复）
  if (text.trimStart().startsWith('<')) {
    throw new Error('国家数据服务返回反爬挑战页（请求过快触发 WAF），请稍后重试')
  }
  return JSON.parse(text) as unknown
}

/** 指标树子节点（pid 空 = 根） */
export async function fetchCatalogChildren(pid: string, code: string = NBS_YEAR_DB, tuning?: NbsHttpTuning): Promise<NbsCatalogNode[]> {
  const j = (await getJson(`/new/queryIndexTreeAsync?pid=${encodeURIComponent(pid)}&code=${code}`, 'nbs:tree', tuning)) as {
    data?: NbsCatalogNode[]
  }
  return j.data ?? []
}

/** 分类指标列表（name 仅过滤当前分类；返回 0 = 该分类无直接指标） */
export async function fetchIndicators(cid: string, name: string = '', tuning?: NbsHttpTuning): Promise<NbsIndicator[]> {
  const j = (await getJson(
    `/new/queryIndicatorsByCid?cid=${encodeURIComponent(cid)}&dt=&name=${encodeURIComponent(name)}`,
    'nbs:indicators',
    tuning,
  )) as { data?: { list?: NbsIndicator[]; total?: number } }
  return j.data?.list ?? []
}

/** 数据序列查询（das = [{text, value}]；dts = ['2021YY-2025YY'] 区间语义） */
export async function fetchSeries(
  opts: {
    cid: string
    indicatorIds: string[]
    das: Array<{ text: string; value: string }>
    dts: string[]
    rootId: string
  },
  tuning?: NbsHttpTuning,
): Promise<NbsSeriesYear[]> {
  const res = await externalFetch(
    `${NBS_API_BASE}/stream/esData`,
    {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cid: opts.cid,
        indicatorIds: opts.indicatorIds,
        daCatalogId: '',
        das: opts.das,
        showType: '1',
        dts: opts.dts,
        rootId: opts.rootId,
      }),
    },
    httpOpts(tuning, 'nbs:esData'),
  )
  const j = (await res.json()) as { success?: boolean; data?: NbsSeriesYear[] }
  if (j.success !== true) throw new Error('国家数据查询失败（success != true）')
  return j.data ?? []
}

// ─── 指标索引（首查预热 + TTL 天级；搜索语义 = 全名包含匹配，多命中取第一个）──

export interface NbsIndicatorIndex {
  entries: Array<{ name: string; id: string; cid: string }>
  builtAt: number
}

export const NBS_INDEX_TTL_MS = 24 * 60 * 60 * 1000 // 指标树低频变动，天级足够
/** 预热请求节流（真机勘察：连续快速请求触发 WAF JS Challenge；600ms 间隔实测安全） */
export const NBS_PREWARM_THROTTLE_MS = 600

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 预热：根 → 顶级分类（约 28 个）→ 各分类指标列表（节流逐请求；单分类失败跳过——
 *  索引部分可用优于整体失败；首查延迟约 20-30 秒，天级缓存摊销） */
export async function buildIndicatorIndex(tuning?: NbsHttpTuning): Promise<NbsIndicatorIndex> {
  const roots = await fetchCatalogChildren('', NBS_YEAR_DB, tuning)
  const rootId = roots[0]?._id ?? ''
  const tops = rootId !== '' ? await fetchCatalogChildren(rootId, NBS_YEAR_DB, tuning) : []
  const entries: Array<{ name: string; id: string; cid: string }> = []
  for (const t of tops) {
    const cid = t._id ?? ''
    if (cid === '') continue
    await sleep(NBS_PREWARM_THROTTLE_MS)
    let list: NbsIndicator[] = []
    try {
      list = await fetchIndicators(cid, '', tuning)
    } catch {
      // 单分类失败跳过：WAF 限流/网络抖动不毁掉整个索引（fail-tolerant 预热）
      continue
    }
    for (const i of list) {
      const name = i._name ?? i.name ?? ''
      const id = i._id ?? i.id ?? ''
      if (name !== '' && id !== '') entries.push({ name, id, cid })
    }
  }
  return { entries, builtAt: Date.now() }
}

/** 关键词 → 指标（包含匹配；空关键词/未命中 = undefined） */
export function searchIndicator(index: NbsIndicatorIndex, keyword: string): { name: string; id: string; cid: string } | undefined {
  const q = keyword.trim()
  if (q.length === 0) return undefined
  return index.entries.find((e) => e.name.includes(q))
}
