/**
 * NBS 区域经济画像（Tool Runtime 第二阶段 Phase 3C —— data capability 第二个工具）。
 *
 * 定位（用户裁决：Engine 产事实，Agent 产判断——ADR-030）：
 * - CompareRegionProfiles = 多区域 × 多指标的**事实矩阵**投影：数值 + 覆盖 + 原因。
 *   不输出排序/推荐/总体置信度——那是 Agent 的判断职责，不进数据层。
 * - 画像（profile）是数据层定义，不携带业务语义（如 CareerOS 的职业迁移）；
 *   业务侧对画像的引用（career_migration.required_profiles）属于上层配置，后置。
 * - 解析复用 Indicator Resolver（curator 优先 + 树兜底 + Ambiguity Gate）：
 *   歧义单元格显式化为候选，绝不静默选（与 QueryMacroStats 同一纪律）。
 * - 批量口径：esData 为单 cid + indicatorIds[] 协议——按（区域 × 分类）分组批量，
 *   API 请求是成本单位（预算口径与 QueryMacroStats 一致：外部调用即消耗）。
 * - 诚实覆盖：no_data/error/not_supported 均带原因文本；覆盖统计由工具计算
 *   （事实），不交给 Agent 数。
 */
import type { NbsRegion } from './regions.ts'
import { findRegion, regionLevelLabel } from './regions.ts'
import type { ResolveResult, ResolvedIndicator } from './resolver.ts'

// ─── 画像定义（数据层事实；扩展 = 新增 profile id，additive）──────────────

export interface ProfileIndicatorDef {
  /** 解析关键词（curator 优先 + 树兜底——与 QueryMacroStats 同管线） */
  keyword: string
  /** 展示名（缺省 = keyword） */
  label?: string
}

export interface ProfileDefinition {
  id: string
  /** 画像语义说明（输出矩阵头行；不携带业务用途） */
  description: string
  indicators: ProfileIndicatorDef[]
}

/**
 * urban_economy_v1：城市/区域经济基础画像。
 * 指标准入纪律：真机定向验证后写入（curator / 树解析验证）；未验证指标不进默认包。
 */
export const URBAN_ECONOMY_V1: ProfileDefinition = {
  id: 'urban_economy_v1',
  description: '城市/区域经济基础画像（GDP、人均GDP、工业增加值、居民人均可支配收入）',
  indicators: [
    { keyword: 'GDP', label: 'GDP' },
    { keyword: '人均GDP', label: '人均GDP' },
    { keyword: '工业增加值' },
    { keyword: '居民人均可支配收入' },
  ],
}

// ─── 矩阵结构（事实投影单元）──────────────────────────────────────────────

export type ProfileCellStatus = 'available' | 'ambiguous' | 'not_supported' | 'no_data' | 'error'

export interface ProfileCell {
  keyword: string
  label: string
  status: ProfileCellStatus
  /** available/ambiguous 时的解析结果（ambiguous = 候选列表，未静默选） */
  resolved?: ResolvedIndicator
  candidates?: ResolvedIndicator[]
  /** available 数据行（年份序列，响应序） */
  rows?: Array<{ year: string; value: string; unit: string }>
  /** no_data/error 原因文本（诚实呈现；不做跨区域/口径推断断言） */
  reason?: string
}

export interface RegionProfile {
  /** 请求输入原样回显（与 canonical 对照——错位可见） */
  requestedName: string
  /** canonical 行政区条目（未识别 = undefined + error） */
  region?: NbsRegion
  /** 未识别地区时的说明（该区域无矩阵单元格） */
  error?: string
  cells: ProfileCell[]
  /** 覆盖（工具计算的事实：available 数 / 画像指标总数） */
  coverage: { available: number; total: number }
}

/** 批量数据行（querySeriesBatch 输出行；indicatorName 为响应 i_showname） */
export interface ProfileRows {
  indicatorName: string
  year: string
  value: string
  unit: string
}

/** 窄接口（NbsConnector 实现；测试注入 fake——不 mock fetch） */
export interface ProfileConnector {
  resolveIndicator(keyword: string): Promise<ResolveResult>
  querySeriesBatch(opts: {
    cid: string
    indicatorIds: string[]
    regionCode: string
    regionName: string
    years: string[]
  }): Promise<ProfileRows[]>
}

/** 外部查询节流（复用指标预热节流值：真机勘察 600ms 实测安全） */
export const PROFILE_QUERY_THROTTLE_MS = 600

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 默认年份区间（年度口径近五年——对齐 QueryMacroStats） */
const PROFILE_YEARS = ['2021YY-2026YY']

/** 会话策略错误（budget_exhausted/privacy）不得被单元格级容错吞掉——按 code 识别（避免与
 *  index.ts 的 NbsPolicyError 循环依赖；策略错误向上传播，由工具层转文本） */
function isPolicyError(err: unknown): boolean {
  return err instanceof Error && ((err as { code?: string }).code === 'budget_exhausted' || (err as { code?: string }).code === 'privacy')
}

/**
 * 矩阵组装：区域 → 指标解析 → 按（区域 × 分类）分组批量查询 → 单元格 + 覆盖。
 * 失败语义：单元格级（单组失败不毁整矩阵）；预算消耗由会话层记账。
 */
export async function queryRegionProfiles(
  connector: ProfileConnector,
  profile: ProfileDefinition,
  regionInputs: string[],
  throttleMs: number = PROFILE_QUERY_THROTTLE_MS,
): Promise<RegionProfile[]> {
  const out: RegionProfile[] = []
  for (const name of regionInputs) {
    const region = findRegion(name)
    if (region === undefined) {
      out.push({
        requestedName: name,
        region: undefined,
        error: `未识别地区「${name}」（支持省区市全称/简称与主要城市，如 苏州/上海/江苏/全国）`,
        cells: [],
        coverage: { available: 0, total: profile.indicators.length },
      })
      continue
    }
    await sleep(throttleMs)
    const cells: ProfileCell[] = []
    // 分组：已解析指标按 catalogId 聚（同分类一次 esData）
    const byCatalog = new Map<string, ResolvedIndicator[]>()
    for (const def of profile.indicators) {
      const keyword = def.keyword.trim()
      const label = def.label ?? keyword
      let result: ResolveResult
      try {
        result = await connector.resolveIndicator(keyword)
      } catch (err) {
        if (isPolicyError(err)) throw err
        cells.push({
          keyword,
          label,
          status: 'error',
          reason: `指标解析失败：${err instanceof Error ? err.message : String(err)}`,
        })
        continue
      }
      if (result.kind === 'miss') {
        cells.push({ keyword, label, status: 'not_supported', reason: '年度口径未匹配到统计指标' })
        continue
      }
      if (result.kind === 'candidates') {
        cells.push({ keyword, label, status: 'ambiguous', resolved: result.options[0], candidates: result.options })
        continue
      }
      cells.push({ keyword, label, status: 'available', resolved: result.indicator })
      const cid = result.indicator.catalogId
      const list = byCatalog.get(cid) ?? []
      list.push(result.indicator)
      byCatalog.set(cid, list)
    }
    // 分组批量查询（每（区域 × 分类）一次 esData；单元格级失败容忍）
    for (const [cid, group] of byCatalog) {
      await sleep(throttleMs)
      let rows: ProfileRows[] = []
      try {
        rows = await connector.querySeriesBatch({
          cid,
          indicatorIds: group.map((r) => r.indicatorId),
          regionCode: region.code,
          regionName: region.name,
          years: PROFILE_YEARS,
        })
      } catch (err) {
        if (isPolicyError(err)) throw err
        const reason = err instanceof Error ? err.message : String(err)
        for (const r of group) {
          const cell = cells.find((c) => c.resolved?.indicatorId === r.indicatorId)
          if (cell !== undefined) {
            cell.status = 'error'
            cell.reason = reason
          }
        }
        continue
      }
      // 行归属（组级一次性指派）：i_showname 去单位后缀后，解析名**全等 > 包含（取最长名）**——
      // 防串行：人均国内生产总值(元) 含「国内生产总值」，简单 includes 会把人均行归给 GDP
      const byCell = new Map<string, ProfileRows[]>()
      for (const row of rows) {
        const clean = row.indicatorName.replace(/\s*\(.*\)\s*$/, '').trim()
        let best: ResolvedIndicator | undefined
        let bestLen = 0
        for (const r of group) {
          if (clean === r.name) {
            best = r
            break
          }
          if (clean.includes(r.name) && r.name.length > bestLen) {
            best = r
            bestLen = r.name.length
          }
        }
        if (best === undefined) continue
        const list = byCell.get(best.indicatorId) ?? []
        list.push(row)
        byCell.set(best.indicatorId, list)
      }
      // 组内单指标且无任何行归属 → 全归（协议兜底——该响应即该指标；不猜测多指标组）
      const unassigned = group.filter((r) => !byCell.has(r.indicatorId))
      if (unassigned.length === 1 && byCell.size === 0) {
        byCell.set(unassigned[0].indicatorId, rows)
      }
      for (const r of group) {
        const cell = cells.find((c) => c.resolved?.indicatorId === r.indicatorId)
        if (cell === undefined) continue
        const mine = byCell.get(r.indicatorId) ?? []
        if (mine.length > 0) {
          cell.rows = mine.map((m) => ({ year: m.year, value: m.value, unit: m.unit }))
        } else {
          cell.status = 'no_data'
          cell.reason = '该区域/年份无此口径统计数据（部分指标无城市级口径，可考虑省级）'
        }
      }
    }
    const available = cells.filter((c) => c.status === 'available').length
    out.push({ requestedName: name, region, cells, coverage: { available, total: profile.indicators.length } })
  }
  return out
}

// ─── 矩阵渲染（文本返回给模型；覆盖为工具计算的事实）────────────────────────

/** 单元格单行（30 字内诚实口径，无推断结论） */
function renderCell(cell: ProfileCell): string {
  const label = cell.label
  if (cell.status === 'available' && cell.rows !== undefined) {
    const seq = cell.rows.map((r) => `${r.year} ${r.value}${r.unit !== '' ? ` ${r.unit}` : ''}`).join('；')
    return `- ${label}（${cell.resolved?.path ?? ''}）：${seq}`
  }
  if (cell.status === 'ambiguous' && cell.candidates !== undefined) {
    const opts = cell.candidates.map((o, i) => `${i + 1}. ${o.name}（indicatorId: ${o.indicatorId}）`).join('；')
    return `- ${label}：歧义未选——候选 ${opts}（如需要，请与用户确认后经 QueryMacroStats 带 indicatorId 查询）`
  }
  if (cell.status === 'not_supported') return `- ${label}：未匹配到统计指标（年度口径）`
  if (cell.status === 'no_data') return `- ${label}：无此口径数据（${cell.reason ?? ''}）`
  return `- ${label}：查询失败（${cell.reason ?? ''}）`
}

export function renderProfileMatrix(regions: RegionProfile[], profile: ProfileDefinition): string {
  const lines: string[] = [
    '【区域经济画像·权威统计数据】',
    `画像：${profile.id}（${profile.description}）`,
    '',
  ]
  let anyRecognized = false
  for (const rp of regions) {
    if (rp.region === undefined) {
      lines.push(`- ${rp.requestedName}：${rp.error ?? '未识别'}`)
      continue
    }
    anyRecognized = true
    lines.push(`${rp.region.name}（${regionLevelLabel(rp.region.level)}）`)
    for (const cell of rp.cells) lines.push(renderCell(cell))
    lines.push(`覆盖：${rp.coverage.available}/${rp.coverage.total} 指标可用`)
    lines.push('')
  }
  lines.push('数据来源：国家统计局 · 国家数据（data.stats.gov.cn 年度数据）')
  if (!anyRecognized) return lines.join('\n')
  // 全矩阵覆盖汇总（工具计算的事实；放在来源行之前）
  const total = regions.reduce((n, r) => n + r.coverage.total, 0)
  const avail = regions.reduce((n, r) => n + r.coverage.available, 0)
  lines.splice(lines.length - 1, 0, `矩阵总覆盖：${avail}/${total} 指标可用`)
  return lines.join('\n')
}
