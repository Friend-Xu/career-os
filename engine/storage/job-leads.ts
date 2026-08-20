/**
 * job-leads：公司适配榜岗位线索（job-leads/{company}.md → JobLead[]；
 * 契约 Company-Leaderboard-Contract-v0.1 §2.3）。
 * - parseJobLeadsMarkdown：`## 岗位线索` 表格逐行解析（文件名 = canonical 锚定名）
 * - scanJobLeads：目录扫描聚合（无目录 → 空数组）
 * - upsertJobLeads：Agent 输出 JSON → Engine 校验写文件（id/expiresAt 由 Engine 派生，
 *   Agent 无文件写权限——Producer 边界）；upsert = 全量覆盖该公司线索文件（刷新语义）
 * - watchJobLeads：目录监听 → onChanged（不含数据，客户端重拉 job-leads/list）
 *
 * 线索 ≠ 已递交 JD（jobs/ 才是递交真相源）；expiresAt = capturedAt + 14 天（不落盘派生）。
 * 行级校验：title/url/captured_at 缺失的行跳过 + warn（不静默丢——issue 记录）。
 */
import { watch } from 'chokidar'
import type { JobLead, Validation } from '../ir/schema.ts'
import type { Workspace } from './workspace.ts'

const LEAD_TTL_DAYS = 14 // 契约 §2.3：过期阈值（过期只标注不删除）

function today(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  const dt = new Date(y, m - 1, d + days)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

export interface ParsedJobLeads {
  sourceFile: string
  leads: JobLead[]
  validation?: Validation
}

/** 单个 job-leads/{company}.md → JobLead[]（行级解析；必填缺失行跳过并记 warn） */
export function parseJobLeadsMarkdown(md: string, sourceFile: string): ParsedJobLeads {
  const company = sourceFile.replace(/\.md$/, '')
  const issues: Validation['issues'] = []
  const leads: JobLead[] = []

  const sec = md.split(/##\s*岗位线索/, 2)[1]
  if (sec) {
    const body = sec.split(/\n##\s+/)[0]
    let row = 0
    for (const line of body.split('\n')) {
      const m = line.match(/^\|\s*(.+?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/)
      if (!m) continue
      const title = m[1]!.trim()
      if (!title || title.startsWith('-') || title === '岗位') continue // 表头/分隔行
      row++
      const salary = m[2]!.trim()
      const city = m[3]!.trim()
      const rawSource = m[4]!.trim()
      const url = m[5]!.trim()
      const capturedAt = m[6]!.trim()
      const fraud = m[7]!.trim()

      if (!title || title === '-' || !url || url === '-' || !capturedAt || capturedAt === '-') {
        issues.push({ path: `${company}#${row}`, reason: `线索行必填缺失（岗位/链接/抓取日期：${JSON.stringify({ title, url, capturedAt })}）→ 行跳过`, severity: 'warn' })
        continue
      }
      let source: JobLead['source']
      if (rawSource === '官网' || rawSource === '招聘平台' || rawSource === '其他') source = rawSource
      else {
        issues.push({ path: `${company}#${row}`, reason: `source 非法值 ${JSON.stringify(rawSource)}（合法值：官网/招聘平台/其他）→ 按「其他」`, severity: 'warn' })
        source = '其他'
      }
      const fraudFlags = fraud === '-' || fraud === '' ? [] : fraud.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      leads.push({
        id: `lead_${capturedAt.replace(/-/g, '')}_${String(row).padStart(3, '0')}`,
        company,
        title,
        ...(salary && salary !== '-' ? { salary } : {}),
        ...(city && city !== '-' ? { city } : {}),
        url,
        source,
        capturedAt,
        expiresAt: addDays(capturedAt, LEAD_TTL_DAYS),
        fraudFlags,
      })
    }
  } else {
    issues.push({ path: sourceFile, reason: '未找到 `## 岗位线索` 表格', severity: 'warn' })
  }

  const out: ParsedJobLeads = { sourceFile, leads }
  if (issues.length > 0) out.validation = { status: issues.some((i) => i.severity === 'error') ? 'invalid' : 'degraded', issues }
  return out
}

/** job-leads/ 目录扫描聚合 → JobLead[]（无目录 → 空数组；按文件名稳定排序） */
export function scanJobLeads(ws: Workspace): JobLead[] {
  if (!ws.exists('job-leads')) return []
  return ws
    .listMarkdown('job-leads')
    .sort()
    .flatMap((f) => parseJobLeadsMarkdown(ws.read(`job-leads/${f}`), f).leads)
}

export interface JobLeadInput {
  title: string
  salary?: string
  city?: string
  url: string
  source: '官网' | '招聘平台' | '其他'
  capturedAt?: string
  fraudFlags?: string[]
}

/** Agent 输出线索 JSON → Engine 校验写文件（fail fast 边界校验；全量覆盖该公司线索文件）。
 *  返回落盘后的完整线索（含 Engine 派生的 id/expiresAt）。 */
export function upsertJobLeads(ws: Workspace, company: string, leads: JobLeadInput[]): JobLead[] {
  if (!company?.trim()) throw new Error('线索登记：company 非空（canonical 锚定名）')
  if (!Array.isArray(leads) || leads.length === 0) throw new Error(`线索登记：${company} leads 非空数组`)
  const date = today()
  for (const l of leads) {
    if (!l?.title?.trim()) throw new Error(`线索登记：${company} title 非空`)
    if (!l?.url?.trim()) throw new Error(`线索登记：${company}「${l.title}」url 非空`)
    if (l.source !== '官网' && l.source !== '招聘平台' && l.source !== '其他') {
      throw new Error(`线索登记：${company}「${l.title}」source 合法值：官网/招聘平台/其他`)
    }
  }
  const path = `job-leads/${company.trim()}.md`
  const rows = leads
    .map((l) => `| ${l.title.trim()} | ${l.salary?.trim() || '-'} | ${l.city?.trim() || '-'} | ${l.source} | ${l.url.trim()} | ${l.capturedAt?.trim() || date} | ${(l.fraudFlags ?? []).map((f) => f.trim()).filter(Boolean).join(',') || '-'} |`)
    .join('\n')
  const md = `# ${company.trim()}

## 岗位线索

| 岗位 | 薪资 | 城市 | 来源 | 链接 | 抓取日期 | 诈骗信号 |
|------|------|------|------|------|---------|---------|
${rows}
`
  ws.write(path, md)
  return parseJobLeadsMarkdown(md, `${company.trim()}.md`).leads
}

/** job-leads/ 目录监听：add/change/unlink → 全量重扫 → onChanged */
export function watchJobLeads(ws: Workspace, onChanged: (leads: JobLead[]) => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.jobLeads, { ignoreInitial: true })
  const rescan = (): void => onChanged(scanJobLeads(ws))
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
