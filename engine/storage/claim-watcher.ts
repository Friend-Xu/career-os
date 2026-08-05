/**
 * claim-watcher：claims/*.md → CareerClaim（M3：表达 IR 层——"我可以安全表达什么"）。
 * - markdown 契约（与 skill 输出共享）：H1 声明标题 + `## 分析摘要`（statement/claim_type/source/
 *   captured_at）+ `## 证据来源` 段（`- {evidenceId}` 行 → provenance，粒度最低 EvidenceItem）
 * - CLAIM_SPEC：artifact 登记参数（ID 系统生成，复用 artifact-registry 通用机制）
 * - 验证：statement/claim_type/source 必填（invalid）；provenance 空 → degraded（半成品合法，
 *   canUseClaim 消费层恒 false 保护）；claim_type/source 非法值 → degraded（warn）
 * - watchClaims：add 事件先登记再重扫（与 decisions/evidence 同模式）
 */
import type { CareerClaim, ClaimProvenance, ClaimSource, ClaimType, Validation } from '../ir/schema.ts'
import { finalize, type Validated } from '../ir/validator.ts'
import type { Workspace } from './workspace.ts'
import { watch } from 'chokidar'
import { registerArtifacts, splitFrontmatter, type ArtifactSpec } from './artifact-registry.ts'
import { parseSummaryTable } from './report-watcher.ts'

export const CLAIM_SPEC: ArtifactSpec = {
  type: 'claim',
  dir: 'claims',
  idPrefix: 'claim_',
  marker: /##\s*分析摘要/,
  passthroughFields: [],
}

const CLAIM_TYPES: ClaimType[] = ['fact', 'interpretation']
const CLAIM_SOURCES: ClaimSource[] = ['user_written', 'agent_generated']

function deriveTitle(md: string, sourceFile: string): string {
  const h1 = md.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : sourceFile.replace(/\.md$/, '')
}

function deriveCreatedAt(file: string): string {
  const sys = file.match(/^claim_(\d{4})(\d{2})(\d{2})_/)
  return sys ? `${sys[1]}-${sys[2]}-${sys[3]}` : ''
}

/** `## 证据来源` 段：`- {evidenceId}` 行 → provenance（粒度最低 EvidenceItem；非 evidence 前缀行过滤） */
function parseProvenanceSection(md: string): ClaimProvenance[] {
  const parts = md.split(/##\s*证据来源/, 2)
  if (parts.length < 2) return []
  const section = parts[1].split(/\n##\s+/)[0]
  const provenance: ClaimProvenance[] = []
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*[-*]\s*(evidence_\d{8}_\d{5})\s*$/)
    if (m) provenance.push({ evidenceId: m[1] })
  }
  return provenance
}

const CLAIM_REQUIRED = ['statement', 'claim_type', 'source'] as const

/** 单个 claim md → IR（摘要表缺失 → invalid；必填/枚举校验——claim 自校验，不走版本分派） */
export function parseClaimMarkdown(md: string, sourceFile: string): Validated<CareerClaim> {
  const { meta, body } = splitFrontmatter(md)
  const fields = parseSummaryTable(body)
  if (!fields) {
    return finalize({} as CareerClaim, [
      { path: sourceFile, reason: '未找到 `## 分析摘要` 表格', severity: 'error' },
    ])
  }

  const checks: Validation['issues'] = []
  for (const field of CLAIM_REQUIRED) {
    const v = fields[field]
    if (!v || v === '-') checks.push({ path: field, reason: '缺失（摘要表未填）', severity: 'error' })
  }
  const claimType = fields.claim_type as ClaimType
  if (fields.claim_type && !CLAIM_TYPES.includes(claimType)) {
    checks.push({ path: 'claim_type', reason: `非法值 ${JSON.stringify(fields.claim_type)}（合法值：${CLAIM_TYPES.join('/')}）`, severity: 'warn' })
  }
  const source = fields.source as ClaimSource
  if (fields.source && !CLAIM_SOURCES.includes(source)) {
    checks.push({ path: 'source', reason: `非法值 ${JSON.stringify(fields.source)}（合法值：${CLAIM_SOURCES.join('/')}）`, severity: 'warn' })
  }

  const provenance = parseProvenanceSection(body)
  if (provenance.length === 0) {
    checks.push({ path: 'provenance', reason: '无证据来源（Claim 不脱离证据；canUseClaim 恒 false 保护）', severity: 'warn' })
  }

  const record: CareerClaim = {
    id: meta.id ?? sourceFile.replace(/\.md$/, ''),
    created_at: fields.captured_at ?? meta.created_at ?? deriveCreatedAt(sourceFile) ?? '',
    source: CLAIM_SOURCES.includes(source) ? source : 'user_written',
    statement: fields.statement ?? deriveTitle(body, sourceFile),
    claimType: CLAIM_TYPES.includes(claimType) ? claimType : 'fact',
    provenance,
  }
  return finalize(record, checks)
}

export interface ParsedClaim {
  sourceFile: string
  record: CareerClaim
  validation?: Validation
}

/** claims/ 全量扫描 */
export function scanClaims(ws: Workspace): ParsedClaim[] {
  return ws.listMarkdown('claims').sort().map((f) => {
    const parsed = parseClaimMarkdown(ws.read(`claims/${f}`), f)
    return { sourceFile: f, record: parsed.value, validation: parsed.validation }
  })
}

/** claims/ 目录监听：add 先登记（系统 ID）再全量重扫；change/unlink → 重扫 */
export function watchClaims(ws: Workspace, onChanged: (parsed: ParsedClaim[]) => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.claims, { ignoreInitial: true })
  const rescan = (): void => onChanged(scanClaims(ws))
  watcher.on('add', (p: string) => {
    if (!p.endsWith('.md')) return
    registerArtifacts(ws, CLAIM_SPEC)
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
