/**
 * context-watcher：decision-contexts/{问题}.md → DecisionContext（V1.5 问题绑定，4.3 定稿）。
 * - parseContextMarkdown：单个 md → ParsedContext（摘要表 + 正文段落；复用 report-watcher 的
 *   摘要表协议与解析工具，不复制逻辑）
 * - scanContexts：decision-contexts/ 全量扫描（引擎只读解析不写，skill/用户维护）
 * - watchContexts：目录监听（add/change/unlink → onChanged；chokidar 全量重扫模式同 watchDecisions）
 *
 * 文件协议（对齐决策文件摘要表协议）：`## 分析摘要` 两列表格，字段 snake_case：
 *   person / question（缺省回退 H1 / 文件名）/ status（中文四档 → 英文）/ related_decisions
 *   （逗号分隔 decisions/ 下文件名，不含扩展名）/ created_at
 *   可选排除项：rejected_decisions + rejected_reasons（不入 IR 契约，ParsedContext 承载，供聚合组装）
 * 必填缺失 → invalid（error）；status 值域非法 → degraded（warn）保留原值（validator 降级惯例）。
 *
 * 正文段落约定（聚合组装读；段落缺失 → 空数组，不参与校验）：
 *   ## 考虑因素 → 列表项 `- 名称：描述`（无冒号 → 仅名称，description = ''）
 *   ## 证据     → 列表项 `- 类型：内容`，可选后缀 `（来源：xxx）`（无冒号 → 类型 = note）
 *   ## 结论     → 首项 `- 选项（置信度：高/中/低）`（无置信度 → 中性 0.5；作者声明值，引擎不自己打分）
 *   ## 风险     → 列表项 `- 描述`，可选后缀 `（缓解：xxx）`
 */
import type { DecisionContext, DecisionStatus, Validation } from '../ir/schema.ts'
import { normalizeDecisionStatus } from '../ir/decision-status.ts'
import { finalize, type FieldCheck } from '../ir/validator.ts'
import type { Workspace } from './workspace.ts'
import { parseSummaryTable } from './report-watcher.ts'
import { watch } from 'chokidar'

/** 中文状态 → DecisionStatus（Contract v1 4 值；legacy 评估中=exploring 归一化） */
const STATUS_MAP: Record<string, DecisionStatus> = {
  探索中: 'exploring',
  评估中: 'exploring', // legacy evaluating → exploring（分析中 = 尚未裁决）
  已决定: 'accepted',
  复盘中: 'revisiting',
}
const STATUS_VALUES: readonly string[] = ['exploring', 'accepted', 'rejected', 'revisiting']
const LEGACY_STATUS_VALUES: readonly string[] = ['evaluating', 'decided', 'reviewing']

/** 必填字段（question 始终可派生不检查）：缺失 → invalid（error） */
const CONTEXT_REQUIRED: readonly (keyof DecisionContext)[] = ['person', 'status', 'relatedDecisions', 'createdAt']

/** 结论置信度声明映射（文件作者声明值，非引擎打分） */
const CONFIDENCE_NUM: Record<string, number> = { 高: 0.9, 中: 0.7, 低: 0.5 }

/** 正文段落（聚合组装视图用；缺失段落 = 空数组/缺省，不崩） */
export interface ContextSections {
  factors: { name: string; description: string }[]
  evidence: { type: string; content: string; source?: string }[]
  conclusion?: { selected: string; confidence: number }
  risks: { description: string; mitigation?: string }[]
  review?: { conclusion: string; date: string }
  /** `## 分析方法` 首项（Contract analysis.method；缺失 → undefined） */
  analysisMethod?: string
  /** `## 未知` 列表（Contract unknowns——系统主动声明不知道什么；缺失 → 空数组） */
  unknowns: string[]
}

/** 解析产物：record + 校验标记 + 排除项（可选）+ 正文段落 */
export interface ParsedContext {
  sourceFile: string
  record: DecisionContext
  rejectedDecisions?: string[]
  rejectedReasons?: string[]
  validation?: Validation
  sections: ContextSections
}

/** 逗号/全角逗号拆分（knowledge 词表别名、related_decisions 等共用） */
export function splitList(v: string): string[] {
  return v.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
}

function parseStatus(v: string): DecisionStatus | undefined {
  const mapped = STATUS_MAP[v]
  if (mapped) return mapped
  if (STATUS_VALUES.includes(v)) return v as DecisionStatus
  if (LEGACY_STATUS_VALUES.includes(v)) return normalizeDecisionStatus(v)
  return undefined
}

function deriveQuestion(md: string, fallback: string): string {
  const h1 = md.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : fallback
}

/** `## 标题` 起至下一个 `## ` 标题（或文尾）之间的非空行（knowledge 词表/岗位清单共用） */
export function sectionLines(md: string, heading: string): string[] {
  const re = new RegExp(`^##\\s*${heading}\\s*$`, 'm')
  const m = md.match(re)
  if (!m) return []
  const lines: string[] = []
  for (const line of md.slice(m.index! + m[0].length).split('\n')) {
    const t = line.trim()
    if (!t || t === '---') continue
    if (t.startsWith('## ')) break
    lines.push(t)
  }
  return lines
}

/** 列表项：`- xxx` → xxx（段内非列表行跳过；knowledge 词表/画像技能段落共用） */
export function listItems(lines: string[]): string[] {
  const items: string[] = []
  for (const line of lines) {
    const m = line.match(/^-\s+(.+)$/)
    if (m) items.push(m[1].trim())
  }
  return items
}

/** 首个中/英文冒号拆分（无冒号 → 左空右原值；knowledge 词表/画像技能段落共用） */
export function splitFirstColon(s: string): [string, string] {
  const i = s.search(/[：:]/)
  return i === -1 ? ['', s] : [s.slice(0, i).trim(), s.slice(i + 1).trim()]
}

function parseFactors(md: string): ContextSections['factors'] {
  return listItems(sectionLines(md, '考虑因素')).map((item) => {
    const i = item.search(/[：:]/)
    if (i === -1) return { name: item, description: '' }
    return { name: item.slice(0, i).trim(), description: item.slice(i + 1).trim() }
  })
}

function parseEvidence(md: string): ContextSections['evidence'] {
  return listItems(sectionLines(md, '证据')).map((item) => {
    const src = item.match(/（来源：(.+?)）$/)
    const rest = (src ? item.slice(0, src.index) : item).trim()
    const [type, content] = splitFirstColon(rest)
    const e: ContextSections['evidence'][number] = { type: type || 'note', content }
    if (src) e.source = src[1].trim()
    return e
  })
}

function parseConclusion(md: string): ContextSections['conclusion'] {
  const item = listItems(sectionLines(md, '结论'))[0]
  if (!item) return undefined
  const m = item.match(/^(.+?)（置信度：([高中低])）$/)
  if (m) return { selected: m[1].trim(), confidence: CONFIDENCE_NUM[m[2]!]! }
  return { selected: item.trim(), confidence: 0.5 } // 未声明置信度 → 中性默认
}

function parseRisks(md: string): ContextSections['risks'] {
  return listItems(sectionLines(md, '风险')).map((item) => {
    const m = item.match(/^(.+?)（缓解：(.+?)）$/)
    if (m) return { description: m[1].trim(), mitigation: m[2].trim() }
    return { description: item.trim() }
  })
}

/** 复盘段落：`## 复盘` 列表项 `- 结论：xxx` + `- 复盘日期：yyyy-mm-dd`（缺任一项 → 不产出） */
function parseReview(md: string): ContextSections['review'] {
  const fields: Record<string, string> = {}
  for (const item of listItems(sectionLines(md, '复盘'))) {
    const [key, value] = splitFirstColon(item)
    if (key && value) fields[key] = value
  }
  const conclusion = fields['结论'] ?? fields['conclusion']
  const date = fields['复盘日期'] ?? fields['date']
  if (!conclusion || !date) return undefined
  return { conclusion, date }
}

function parseSections(md: string): ContextSections {
  const sections: ContextSections = {
    factors: parseFactors(md),
    evidence: parseEvidence(md),
    risks: parseRisks(md),
    unknowns: listItems(sectionLines(md, '未知')),
  }
  const review = parseReview(md)
  if (review) sections.review = review
  const method = listItems(sectionLines(md, '分析方法'))[0]
  if (method) sections.analysisMethod = method
  return sections
}

/** 单个 context md → ParsedContext（摘要表缺失 → invalid；必填缺失 → invalid；status 值域非法 → degraded） */
export function parseContextMarkdown(md: string, sourceFile: string): ParsedContext {
  const id = sourceFile.replace(/\.md$/, '')
  const sections = parseSections(md)
  sections.conclusion = parseConclusion(md)

  const fields = parseSummaryTable(md)
  if (!fields) {
    // id/question 无条件派生：invalid context 仍需在列表中按 id 可识别
    return {
      sourceFile,
      record: { id, question: deriveQuestion(md, id) } as DecisionContext,
      sections,
      validation: { status: 'invalid', issues: [{ path: sourceFile, reason: '未找到 `## 分析摘要` 表格', severity: 'error' }] },
    }
  }

  const record: Record<string, unknown> = {
    id,
    question: fields.question && fields.question !== '-' ? fields.question : deriveQuestion(md, id),
  }
  const checks: FieldCheck[] = []
  const rejected: { decisions?: string[]; reasons?: string[] } = {}

  const person = fields.person
  if (person !== undefined && person !== '' && person !== '-') record.person = person
  const createdAt = fields.created_at
  if (createdAt !== undefined && createdAt !== '' && createdAt !== '-') record.createdAt = createdAt

  const status = fields.status
  if (status !== undefined && status !== '' && status !== '-') {
    const parsed = parseStatus(status)
    if (parsed !== undefined) {
      record.status = parsed
    } else {
      record.status = status // 保留原值展示，标记可疑
      checks.push({
        path: 'status',
        reason: `非法值 ${JSON.stringify(status)}（合法值：探索中/评估中/已决定/复盘中 或 exploring/evaluating/decided/reviewing）`,
        severity: 'warn',
      })
    }
  }

  const related = fields.related_decisions
  if (related !== undefined && related !== '' && related !== '-') record.relatedDecisions = splitList(related)
  const rejectedRaw = fields.rejected_decisions
  if (rejectedRaw !== undefined && rejectedRaw !== '' && rejectedRaw !== '-') rejected.decisions = splitList(rejectedRaw)
  const reasonsRaw = fields.rejected_reasons
  if (reasonsRaw !== undefined && reasonsRaw !== '' && reasonsRaw !== '-') rejected.reasons = splitList(reasonsRaw)

  for (const field of CONTEXT_REQUIRED) {
    const v = record[field]
    if (v === undefined || (Array.isArray(v) && v.length === 0)) {
      checks.push({ path: field, reason: '缺失（摘要表未填或为 -）', severity: 'error' })
    }
  }

  const validated = finalize(record as unknown as DecisionContext, checks)
  const parsed: ParsedContext = { sourceFile, record: validated.value, sections }
  if (validated.validation) parsed.validation = validated.validation
  if (rejected.decisions) parsed.rejectedDecisions = rejected.decisions
  if (rejected.reasons) parsed.rejectedReasons = rejected.reasons
  return parsed
}

/** decision-contexts/ 全量扫描 */
export function scanContexts(ws: Workspace): ParsedContext[] {
  return ws.listMarkdown('decision-contexts').sort().map((f) => parseContextMarkdown(ws.read(`decision-contexts/${f}`), f))
}

/**
 * decision-contexts/ 目录监听：add/change/unlink 任一触发 → onChanged()（contexts/list 按需组装，
 * 变更信号由调用方广播）；返回 { close } 供测试/退出。
 */
export function watchContexts(ws: Workspace, onChanged: () => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.decisionContexts, { ignoreInitial: true })
  const rescan = (): void => onChanged()
  watcher.on('add', (path: string) => {
    if (path.endsWith('.md')) rescan()
  })
  watcher.on('change', (path: string) => {
    if (path.endsWith('.md')) rescan()
  })
  watcher.on('unlink', (path: string) => {
    if (path.endsWith('.md')) rescan()
  })
  return { close: () => watcher.close() }
}
