/**
 * job-watcher：jobs/*.md → JobRecord（JD 一等数据对象；M1 只存事实，不做分析）。
 * - parseJobMarkdown：单文件解析（摘要表协议：company/title/location/salary/jd_source/
 *   requirements/created_at；`## JD 原文` 正文段保留原文）
 * - requirements：分号分隔技能列表 → [{ name, essential: true }]（M1 人工录入默认全必需；
 *   非必需标记与结构化解析是后续能力升级，不是数据迁移）
 * - createJobFile：新建岗位（jobs/create RPC 的写入端；id = {日期}-{公司}-{岗位}）
 * - watchJobs：监听 jobs/ 目录（add/change/unlink → 全量重扫 → 广播 data.jobs.changed）
 */
import type { JobRecord, JobRequirement, Validation } from '../ir/schema.ts'
import { finalize, validateByProtocol, type Validated } from '../ir/validator.ts'
import type { Workspace } from './workspace.ts'
import { watch } from 'chokidar'

const REQUIREMENTS_SEP = /[;；]/

/** 分号分隔技能列表 → 结构化要求（M1 默认全 essential=true） */
function parseRequirements(raw: string): JobRequirement[] {
  return raw
    .split(REQUIREMENTS_SEP)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name, essential: true }))
}

function deriveH1(md: string, fallback: string): string {
  const h1 = md.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : fallback
}

/** 摘要表解析（决策/公司共用协议；job 字段映射独立） */
function parseSummary(md: string): Record<string, string> | null {
  const m = md.match(/##\s*分析摘要\s*\n((?:\|[^\n]*\|\n)+)/)
  if (!m) return null
  const fields: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    if (!line.trim().startsWith('|') || /^\|[\s\-|]+\|$/.test(line)) continue
    const r = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|$/)
    if (r) {
      const key = r[1].trim()
      if (key && key !== '字段') fields[key] = r[2].trim()
    }
  }
  return fields
}

/** `## JD 原文` 段落全文（JD 是岗位核心资产，正文原样保留） */
function deriveJdText(md: string): string {
  const parts = md.split(/##\s*JD\s*原文/, 2)
  if (parts.length < 2) return ''
  return parts[1]
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim()
    .slice(0, 5000)
}

const JOB_REQUIRED: readonly (keyof JobRecord)[] = ['company', 'title']

export function parseJobMarkdown(md: string, sourceFile: string): Validated<JobRecord> {
  const fields = parseSummary(md)
  if (!fields) {
    return finalize({} as JobRecord, [
      { path: sourceFile, reason: '未找到 `## 分析摘要` 表格', severity: 'error' },
    ])
  }

  const record: Record<string, unknown> = {
    id: sourceFile.replace(/\.md$/, ''),
    title: fields.title || deriveH1(md, sourceFile.replace(/\.md$/, '')),
    company: fields.company ?? '',
    createdAt: fields.created_at ?? sourceFile.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? '',
    requirements: [],
  }
  if (fields.location) record.location = fields.location
  if (fields.salary) record.salary = fields.salary
  if (fields.jd_source) record.jdSource = fields.jd_source
  if (fields.requirements) record.requirements = parseRequirements(fields.requirements)
  else record.requirements = []
  const jdText = deriveJdText(md)
  if (jdText) record.jd = jdText

  const checks: Validation['issues'] = []
  for (const field of JOB_REQUIRED) {
    if (!record[field]) checks.push({ path: field, reason: '缺失（摘要表未填）', severity: 'error' })
  }
  return finalize(record as JobRecord, checks)
}

export interface ParsedJob {
  sourceFile: string
  record: JobRecord
  validation?: Validation
}

export function scanJobs(ws: Workspace): ParsedJob[] {
  if (!ws.exists('jobs')) return []
  return ws.listMarkdown('jobs').sort().map((f) => {
    const parsed = parseJobMarkdown(ws.read(`jobs/${f}`), f)
    return { sourceFile: f, record: parsed.value, validation: parsed.validation }
  })
}

/** jobs/ 目录监听：add/change/unlink → 全量重扫 → onChanged（同 decisions 全量重扫决策） */
export function watchJobs(ws: Workspace, onChanged: (parsed: ParsedJob[]) => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.jobs, { ignoreInitial: true })
  const rescan = (): void => onChanged(scanJobs(ws))
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

/** 删除岗位文件：id = {日期}-{公司}-{岗位}（文件名无 .md；watcher unlink 自动重扫广播） */
export function deleteJobFile(ws: Workspace, id: string): void {
  if (!/^[^\\/]+$/.test(id)) throw new Error(`非法岗位 id：${JSON.stringify(id)}`)
  const rel = `jobs/${id}.md`
  if (!ws.exists(rel)) throw new Error(`岗位不存在：${id}`)
  ws.delete(rel)
}

export interface CreateJobParams {
  company: string
  title: string
  location?: string
  salary?: string
  jdSource?: string
  requirements?: string // 分号分隔技能列表（可选）
  jdText?: string // JD 原文（可选）
}

/** 新建岗位：写 jobs/{日期}-{公司}-{岗位}.md（M1 只有 create；修正走版本化写入后续） */
export function createJobFile(ws: Workspace, params: CreateJobParams, now: Date = new Date()): JobRecord {
  if (!/^[^\\/]+$/.test(params.company) || !/^[^\\/]+$/.test(params.title)) {
    throw new Error(`非法公司/岗位名：${JSON.stringify(params.company)}/${JSON.stringify(params.title)}`)
  }
  const date = now.toISOString().slice(0, 10)
  const topic = `${params.company}-${params.title}`
  const id = `${date}-${topic}`
  const rel = `jobs/${id}.md`
  if (ws.exists(rel)) throw new Error(`岗位已存在：${id}`)

  const rows = [
    '| company | ' + params.company + ' |',
    '| title | ' + params.title + ' |',
  ]
  if (params.location) rows.push('| location | ' + params.location + ' |')
  if (params.salary) rows.push('| salary | ' + params.salary + ' |')
  if (params.jdSource) rows.push('| jd_source | ' + params.jdSource + ' |')
  if (params.requirements) rows.push('| requirements | ' + params.requirements + ' |')
  rows.push('| created_at | ' + date + ' |')

  const md = `# ${params.title} — ${params.company}

## 分析摘要

| 字段 | 值 |
|------|-----|
${rows.join('\n')}
${params.jdText ? `\n---\n\n## JD 原文\n\n${params.jdText}\n` : ''}
`
  ws.write(rel, md)
  return { ...parseJobMarkdown(md, `${id}.md`).value, id }
}
