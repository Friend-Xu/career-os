/**
 * Evidence 投影 v1（UI 纯格式化层——**不做语义解释**）。
 *
 * 边界（用户裁定，2026-08-24）：
 * - ToolEvidence.citation 按契约原样保真；只做展示格式化（hostname 提取/截断/可点击），
 *   不做 hostname → 机构名的映射（那属于 Evidence Interpretation Layer——UI 无权解释来源语义）
 * - source 只作视觉分组（Web/Data/MCP），不承担语义
 * - 不显示 fetchedAt/period/confidence（那是「证据卡片系统」前兆，P0 不做）
 * - 不引入新的 Evidence Entity/Store/Registry——数据源就是消息的 toolCalls[].evidence[]
 *
 * 格式化 ≠ 人话化：
 *   ✓ URL → hostname；超长 → 截断展示（点击还原全文）；同 citation → 去重；按 source 分组
 *   ✗ suzhou.gov.cn → 「苏州市政府」；✗ domains.json 映射表；✗ 猜测机构名
 */
import type { ToolCallInfoUi } from '../types'

/** 证据条目（扁平化视图模型：按 toolCalls[].evidence[] 元素计，不拆 provider 打包的 citation 串） */
export interface EvidenceItemView {
  /** 视觉分组（source 原值；UI 只做分组标签映射，不做语义解释） */
  source: ToolCallInfoUi['source']
  /** 去重键（source + citation + provider） */
  key: string
  citation: string
  /** hostname（URL 类才提取；指标 id / 其他原样空） */
  host?: string
}

/** NBS 指标 id 形态（如 urban_economy_v1::苏州|江苏|全国）——非 URL，原样展示 */
const URL_PREFIX = /^(https?:\/\/)/i

function tryHost(citation: string): string | undefined {
  if (!URL_PREFIX.test(citation)) return undefined
  try {
    return new URL(citation).hostname
  } catch {
    return undefined
  }
}

/** 聚合：toolCalls[].evidence[] → 扁平 + 去重（同 source+citation+provider 只留一条） */
export function collectEvidence(toolCalls: ToolCallInfoUi[] | undefined): EvidenceItemView[] {
  if (!toolCalls || toolCalls.length === 0) return []
  const seen = new Set<string>()
  const out: EvidenceItemView[] = []
  for (const tc of toolCalls) {
    if (tc.evidence === undefined) continue
    for (const ev of tc.evidence) {
      const key = `${ev.source}::${ev.provider ?? ''}::${ev.citation}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ source: ev.source, key, citation: ev.citation, host: tryHost(ev.citation) })
    }
  }
  return out
}

/** 分组标签（source → 视觉标签；不做语义解释，仅分类） */
export function evidenceGroupLabel(source: ToolCallInfoUi['source']): string {
  switch (source) {
    case 'hosted':
      return 'Web'
    case 'mcp':
      return 'MCP'
    case 'data':
      return 'Data'
    case 'builtin':
      return '工具'
    default:
      return source ?? '来源'
  }
}

/** 展示串：hostname 优先（URL），非 URL 指标 id 原样 */
export function evidenceDisplay(citation: string, host: string | undefined, maxLen: number): string {
  const base = host ?? citation
  if (base.length <= maxLen) return base
  return `${base.slice(0, maxLen - 1)}…`
}
