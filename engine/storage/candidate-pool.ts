/**
 * candidate-pool：公司适配榜候选池（company-pool/{name}.md → CandidatePoolEntry；
 * 契约 Company-Leaderboard-Contract-v0.1 §2.1）。
 * - parseCandidatePoolMarkdown：摘要表 + 信号表解析（文件名 = canonical 锚定名）
 * - scanCandidatePool：目录扫描（无目录 → 空数组）
 * - upsertCandidatePool：Agent 输出 JSON → Engine 校验写文件（id 生成 + 锚定名由 Engine 登记，
 *   Agent 无文件写权限——Producer 边界）
 * - watchCandidatePool：目录监听 → onChanged（不含数据，客户端重拉 candidates/list）
 *
 * 校验惯例：id/city 缺失 → invalid（error）；fit_stars 值域非法 → degraded（warn）保留原值。
 */
import { watch } from 'chokidar'
import type { CandidatePoolEntry, Validation } from '../ir/schema.ts'
import { finalize, type Validated } from '../ir/validator.ts'
import type { Workspace } from './workspace.ts'
import { parseSummaryTable } from '../ir/summary-table.ts'

/** 今日日期 YYYY-MM-DD（本地时区） */
function today(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 单个 company-pool/{name}.md → CandidatePoolEntry */
export function parseCandidatePoolMarkdown(md: string, sourceFile: string): Validated<CandidatePoolEntry> {
  const name = sourceFile.replace(/\.md$/, '')
  const checks: Validation['issues'] = []
  const fields = parseSummaryTable(md)
  const record: Record<string, unknown> = { name }

  const id = fields?.id?.trim() ?? ''
  if (!id) checks.push({ path: 'id', reason: '缺失（摘要表 id 未填——Engine 登记字段）', severity: 'error' })
  else record.id = id

  const city = fields?.city?.trim() ?? ''
  if (!city) checks.push({ path: 'city', reason: '缺失（摘要表 city 未填）', severity: 'error' })
  else record.city = city

  const industry = (fields?.industry ?? '')
    .split(/[\/,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
  record.industry = industry

  const fitRaw = fields?.fit_stars
  if (fitRaw !== undefined && fitRaw !== '' && fitRaw !== '-') {
    const n = Number(fitRaw)
    if (Number.isInteger(n) && n >= 1 && n <= 5) record.fitStars = n
    else {
      record.fitStars = fitRaw // 保留原值展示
      checks.push({ path: 'fitStars', reason: `非法值 ${JSON.stringify(fitRaw)}（合法值：1-5 整数）`, severity: 'warn' })
    }
  }

  const capturedAt = fields?.captured_at?.trim() ?? ''
  if (!capturedAt) checks.push({ path: 'capturedAt', reason: '缺失（摘要表 captured_at 未填）', severity: 'error' })
  else record.capturedAt = capturedAt

  const source = fields?.source?.trim() ?? ''
  record.source = source

  // ## 信号 段表格：| 信号 | 来源 | 日期 |
  const signals: { tag: string; source: string; date?: string }[] = []
  const sec = md.split(/##\s*信号/, 2)[1]
  if (sec) {
    const body = sec.split(/\n##\s+/)[0]
    for (const line of body.split('\n')) {
      const m = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|$/)
      if (!m) continue
      const tag = m[1]!.trim()
      const sigSource = m[2]!.trim()
      const date = m[3]!.trim()
      if (!tag || tag.startsWith('-') || tag === '信号') continue
      signals.push({ tag, source: sigSource, ...(date && date !== '-' ? { date } : {}) })
    }
  }
  record.signals = signals

  return finalize(record as unknown as CandidatePoolEntry, checks)
}

export interface ParsedCandidate {
  sourceFile: string
  record: CandidatePoolEntry
  validation?: Validation
}

/** company-pool/ 目录扫描 → ParsedCandidate[]（无目录 → 空数组；按文件名稳定排序） */
export function scanCandidatePool(ws: Workspace): ParsedCandidate[] {
  if (!ws.exists('company-pool')) return []
  return ws
    .listMarkdown('company-pool')
    .sort()
    .map((f) => {
      const parsed = parseCandidatePoolMarkdown(ws.read(`company-pool/${f}`), f)
      return { sourceFile: `company-pool/${f}`, record: parsed.value, validation: parsed.validation }
    })
}

export interface CandidatePoolInput {
  name: string
  city: string
  industry: string[]
  signals: { tag: string; source: string; date?: string }[]
  fitStars: number
  source: string
  capturedAt?: string
}

/** Agent 输出候选池 JSON → Engine 校验写文件（fail fast 边界校验；同公司重写保留原 id）。
 *  返回落盘后的完整条目（含 Engine 生成的 id/capturedAt）。 */
export function upsertCandidatePool(ws: Workspace, entries: CandidatePoolInput[]): CandidatePoolEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('候选池登记：entries 非空数组')
  const existing = scanCandidatePool(ws)
  const maxSeq = existing.reduce((max, p) => {
    const m = p.record.id.match(/^candidate_(\d{8})_(\d+)$/)
    if (m && m[1] === today().replace(/-/g, '')) return Math.max(max, Number(m[2]))
    return max
  }, 0)
  let seq = maxSeq

  const out: CandidatePoolEntry[] = []
  for (const e of entries) {
    if (!e.name?.trim()) throw new Error('候选池登记：name 非空（canonical 锚定名）')
    if (!e.city?.trim()) throw new Error(`候选池登记：${e.name} city 非空`)
    if (!Array.isArray(e.industry)) throw new Error(`候选池登记：${e.name} industry 为数组`)
    if (!Number.isInteger(e.fitStars) || e.fitStars < 1 || e.fitStars > 5) {
      throw new Error(`候选池登记：${e.name} fitStars 1-5 整数（值：${JSON.stringify(e.fitStars)}）`)
    }
    if (!Array.isArray(e.signals) || e.signals.some((s) => !s?.tag?.trim() || !s?.source?.trim())) {
      throw new Error(`候选池登记：${e.name} signals 数组且每条 tag/source 非空`)
    }
    const name = e.name.trim()
    const capturedAt = e.capturedAt?.trim() || today()
    const path = `company-pool/${name}.md`
    const prior = existing.find((p) => p.record.name === name)
    const id = prior?.record.id ?? `candidate_${capturedAt.replace(/-/g, '')}_${String(++seq).padStart(3, '0')}`

    const md = `# ${name}

## 分析摘要

| 字段 | 值 |
|------|-----|
| id | ${id} |
| city | ${e.city.trim()} |
| industry | ${e.industry.map((s) => s.trim()).filter(Boolean).join(' / ')} |
| fit_stars | ${e.fitStars} |
| source | ${e.source?.trim() ?? '-'} |
| captured_at | ${capturedAt} |

## 信号

| 信号 | 来源 | 日期 |
|------|------|------|
${e.signals.map((s) => `| ${s.tag.trim()} | ${s.source.trim()} | ${s.date?.trim() || '-'} |`).join('\n')}
`
    ws.write(path, md)
    out.push(parseCandidatePoolMarkdown(md, `${name}.md`).value)
  }
  return out
}

/** company-pool/ 目录监听：add/change/unlink → 全量重扫 → onChanged（同 targets 全量重扫决策） */
export function watchCandidatePool(
  ws: Workspace,
  onChanged: (parsed: ParsedCandidate[]) => void,
): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.companyPool, { ignoreInitial: true })
  const rescan = (): void => onChanged(scanCandidatePool(ws))
  watcher.on('add', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  watcher.on('change', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  watcher.on('unlink', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  return { close: () => watcher.close() }
}
