/**
 * evidence-watcher：evidence/*.md → EvidenceItem（M2：个人证据资产——"我有什么证明"）。
 * - markdown 契约（与 skill evidence 输出共享）：H1 事件名 + `## 分析摘要`（role/contribution/
 *   status/source_type/captured_at 等）+ `## 证据` 段（`### {dimension}` 小节 → `- {content}` 行）+ `## 事件` 段（context）
 * - dimension 词表校验：只解析 EVIDENCE_DIMENSIONS_V0 注册维度（Agent 是外部输出方，词表外过滤）
 * - EVIDENCE_SPEC：artifact 登记参数（ID 系统生成，复用 artifact-registry 通用机制）
 * - watchEvidence：add 事件先登记再重扫（与 decisions 同模式）
 */
import type { EvidenceItem, EvidenceStatus, EvidenceSourceType, EvidenceValue, Validation } from '../ir/schema.ts'
import { EVIDENCE_DIMENSIONS_V0 } from '../ir/schema.ts'
import { finalize, type Validated } from '../ir/validator.ts'
import type { Workspace } from './workspace.ts'
import { watch } from 'chokidar'
import { registerArtifacts, splitFrontmatter, type ArtifactSpec } from './artifact-registry.ts'
import { parseSummaryTable } from './report-watcher.ts'

export const EVIDENCE_SPEC: ArtifactSpec = {
  type: 'evidence',
  dir: 'evidence',
  idPrefix: 'evidence_',
  marker: /##\s*分析摘要/,
  passthroughFields: [],
}

const STATUSES: EvidenceStatus[] = ['raw', 'candidate', 'trusted', 'archived']
const SOURCE_TYPES: EvidenceSourceType[] = ['user_input', 'resume', 'document', 'conversation', 'decision']
const CONFIDENCES = ['high', 'medium', 'low']
const VERIFY_TYPES = ['user_confirmed', 'document_supported', 'imported']

function deriveTitle(md: string, sourceFile: string): string {
  const h1 = md.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : sourceFile.replace(/\.md$/, '')
}

function deriveCreatedAt(file: string): string {
  const legacy = file.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
  if (legacy) return legacy
  const sys = file.match(/^evidence_(\d{4})(\d{2})(\d{2})_/)
  return sys ? `${sys[1]}-${sys[2]}-${sys[3]}` : ''
}

/** `## 事件` 段首段文本（context 背景；可缺省） */
function deriveContext(md: string): string | undefined {
  const parts = md.split(/##\s*事件/, 2)
  if (parts.length < 2) return undefined
  const text = parts[1]
    .split(/\n##\s+/)[0]
    .split('\n')
    .map((l) => l.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean)
    .join(' ')
    .trim()
  return text || undefined
}

/** `## 证据` 段：`### {dimension}` 小节 → `- {content}` 行 → dimensionId → EvidenceValue[]（词表外维度过滤；`-` 占位值过滤） */
function parseEvidenceSection(md: string): Record<string, EvidenceValue[]> {
  const known = new Set(EVIDENCE_DIMENSIONS_V0.map((d) => d.id))
  const parts = md.split(/##\s*证据/, 2)
  if (parts.length < 2) return {}
  const section = parts[1].split(/\n##\s+/)[0]
  const evidence: Record<string, EvidenceValue[]> = {}
  let current: string | null = null
  for (const line of section.split('\n')) {
    const dim = line.match(/^###\s*(\S+)\s*$/)
    if (dim) {
      current = known.has(dim[1]) ? dim[1] : null // 词表外维度过滤（不进入 IR）
      continue
    }
    const content = line.match(/^\s*[-*]\s*(.+)$/)
    if (current && content) {
      const c = content[1].trim()
      if (c && c !== '-') (evidence[current] ??= []).push({ content: c }) // `-` 是摘要表缺失惯例，证据段无意义（契约规则 3）
    }
  }
  return evidence
}

const EVIDENCE_REQUIRED = ['role', 'contribution', 'status'] as const

/** 单个证据 md → IR（摘要表缺失 → invalid；必填/枚举校验——evidence 自校验，不走 decision 的版本分派） */
export function parseEvidenceMarkdown(md: string, sourceFile: string): Validated<EvidenceItem> {
  const { meta, body } = splitFrontmatter(md)
  const fields = parseSummaryTable(body)
  if (!fields) {
    return finalize({} as EvidenceItem, [
      { path: sourceFile, reason: '未找到 `## 分析摘要` 表格', severity: 'error' },
    ])
  }

  const checks: Validation['issues'] = []
  for (const field of EVIDENCE_REQUIRED) {
    const v = fields[field]
    if (!v || v === '-') checks.push({ path: field, reason: '缺失（摘要表未填）', severity: 'error' })
  }
  const status = fields.status as EvidenceStatus
  if (fields.status && !STATUSES.includes(status)) {
    checks.push({ path: 'status', reason: `非法值 ${JSON.stringify(fields.status)}（合法值：${STATUSES.join('/')}）`, severity: 'warn' })
  }
  if (fields.source_type && !SOURCE_TYPES.includes(fields.source_type as EvidenceSourceType)) {
    checks.push({ path: 'source_type', reason: `非法值 ${JSON.stringify(fields.source_type)}（合法值：${SOURCE_TYPES.join('/')}）`, severity: 'warn' })
  }
  if (fields.confidence && !CONFIDENCES.includes(fields.confidence)) {
    checks.push({ path: 'confidence', reason: `非法值 ${JSON.stringify(fields.confidence)}（合法值：${CONFIDENCES.join('/')}）`, severity: 'warn' })
  }

  const record: EvidenceItem = {
    id: meta.id ?? sourceFile.replace(/\.md$/, ''),
    event: {
      title: fields.event ?? deriveTitle(body, sourceFile),
      ...(fields.period ? { period: fields.period } : {}),
      ...(deriveContext(body) ? { context: deriveContext(body) } : {}),
    },
    role: fields.role ?? '',
    contribution: fields.contribution ?? '',
    evidence: parseEvidenceSection(body),
    source: {
      type: (fields.source_type as EvidenceSourceType) ?? 'user_input',
      capturedAt: fields.captured_at ?? meta.created_at ?? '',
    },
    ...(fields.verification_type && fields.confirmed_at && VERIFY_TYPES.includes(fields.verification_type)
      ? { verification: { type: fields.verification_type as 'user_confirmed' | 'document_supported' | 'imported', confirmedAt: fields.confirmed_at } }
      : {}),
    ...(fields.confidence && CONFIDENCES.includes(fields.confidence) ? { confidence: fields.confidence as 'high' | 'medium' | 'low' } : {}),
    status: STATUSES.includes(status) ? status : 'raw',
  }
  return finalize(record, checks)
}

export interface ParsedEvidence {
  sourceFile: string
  record: EvidenceItem
  validation?: Validation
}

/** evidence/ 全量扫描 */
export function scanEvidence(ws: Workspace): ParsedEvidence[] {
  return ws.listMarkdown('evidence').sort().map((f) => {
    const parsed = parseEvidenceMarkdown(ws.read(`evidence/${f}`), f)
    return { sourceFile: f, record: parsed.value, validation: parsed.validation }
  })
}

/** evidence/ 目录监听：add 先登记（系统 ID）再全量重扫；change/unlink → 重扫 */
export function watchEvidence(ws: Workspace, onChanged: (parsed: ParsedEvidence[]) => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.evidence, { ignoreInitial: true })
  const rescan = (): void => onChanged(scanEvidence(ws))
  watcher.on('add', (p: string) => {
    if (!p.endsWith('.md')) return
    registerArtifacts(ws, EVIDENCE_SPEC)
    rescan()
  })
  watcher.on('change', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  watcher.on('unlink', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  return { close: () => watcher.close() }
}
