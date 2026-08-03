/**
 * decision-editor：决策记录摘要表字段更新（decisions/update RPC 的写入端）。
 * - updateSummaryFields：读 md → 定位 `## 分析摘要` 表格 → 更新/插入字段行 → 重组 md
 * - 只改摘要表：H1/正文/复盘段落原样保留（决策编辑 = 局部修改，不是重写）
 * - 字段白名单：评估结果字段（skill 归属/方向/匹配度/置信度/城市/风险/关键风险/状态）
 * - 不可编辑：profile（归属人）、protocol_version（协议）、id（文件名）——UI 侧也不提供
 */
import type { Workspace } from './workspace.ts'

const SUMMARY_HEADING = '## 分析摘要'
const FIELD_ROW_RE = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|$/
const SEPARATOR_RE = /^\|[\s\-|]+\|$/

/** 可编辑字段（snake_case，与摘要表协议一致） */
export const UPDATEABLE_FIELDS: readonly string[] = [
  'skill',
  'direction',
  'direction_match',
  'direction_confidence',
  'city',
  'city_score',
  'salary_feasible',
  'risk_level',
  'key_risk',
  'status',
]

/** 决策文件局部修改：读 md → 更新白名单字段 → 写回（watcher 自动重扫；profile/protocol_version 不可编辑） */
export function updateDecisionFile(ws: Workspace, id: string, fields: Record<string, string>): { id: string; updatedFields: string[] } {
  if (!/^[^\\/]+$/.test(id)) throw new Error(`非法决策 id：${JSON.stringify(id)}`)
  const rel = `decisions/${id}.md`
  if (!ws.exists(rel)) throw new Error(`决策不存在：${id}`)
  const updates: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (!UPDATEABLE_FIELDS.includes(k)) throw new Error(`字段不可编辑：${k}`)
    updates[k] = v
  }
  const out = updateSummaryFields(ws.read(rel), updates)
  ws.write(rel, out)
  return { id, updatedFields: Object.keys(updates) }
}

export function updateSummaryFields(md: string, updates: Record<string, string>): string {
  const headIdx = md.indexOf(SUMMARY_HEADING)
  if (headIdx === -1) throw new Error('未找到 `## 分析摘要` 段落，无法更新字段')

  const afterHead = md.slice(headIdx + SUMMARY_HEADING.length)
  const tableMatch = afterHead.match(/((?:\|[^\n]*\|\n)+)/)
  if (!tableMatch || tableMatch.index === undefined) throw new Error('`## 分析摘要` 后未找到表格')

  const tableStart = headIdx + SUMMARY_HEADING.length + tableMatch.index
  const tableText = tableMatch[1]
  const tableEnd = tableStart + tableText.length

  // 拆行：header/分隔行原样保留，字段行记录（更新时保留位置）
  const headerLines: string[] = []
  const fieldLines: { field: string; value: string }[] = []
  for (const line of tableText.split('\n')) {
    if (line.trim().length === 0) continue
    const m = line.match(FIELD_ROW_RE)
    if (!m || SEPARATOR_RE.test(line) || m[1].trim() === '字段') {
      headerLines.push(line)
      continue
    }
    fieldLines.push({ field: m[1].trim(), value: m[2].trim() })
  }

  const seen = new Set<string>()
  const rows: string[] = []
  for (const { field, value } of fieldLines) {
    seen.add(field)
    rows.push(`| ${field} | ${updates[field] !== undefined ? updates[field] : value} |`)
  }
  for (const [field, value] of Object.entries(updates)) {
    if (!seen.has(field)) rows.push(`| ${field} | ${value} |`)
  }

  const newTable = [...headerLines, ...rows].join('\n') + '\n'
  return md.slice(0, tableStart) + newTable + md.slice(tableEnd)
}
