/**
 * summary-table：摘要表解析协议（`## 分析摘要` 两列表格 → 字段映射）。
 * 决策/公司档案/快照/证据等共用（storage 各 watcher + ir 投影消费）——解析协议归 ir 层。
 */
const SUMMARY_RE = /##\s*分析摘要\s*\n((?:\|[^\n]*\|\n)+)/
const ROW_RE = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|$/

/** 摘要表解析：`## 分析摘要` 两列表格 → { 字段: 值 }（决策/公司档案共用协议） */
export function parseSummaryTable(md: string): Record<string, string> | null {
  const m = md.match(SUMMARY_RE)
  if (!m) return null
  const fields: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    if (!line.trim().startsWith('|')) continue
    if (/^\|[\s\-|]+\|$/.test(line)) continue // 分隔行
    const r = line.match(ROW_RE)
    if (r) {
      const key = r[1].trim()
      if (key && key !== '字段') fields[key] = r[2].trim()
    }
  }
  return fields
}
