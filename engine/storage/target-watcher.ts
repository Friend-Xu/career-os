/**
 * target-watcher：M6 Target 机会资产（targets/{target_id}/target.md → TargetRecord）。
 * - parseTargetMarkdown：单文件解析（frontmatter: id/company_id/candidate_person/
 *   original_jd_id/current_jd_path/created_at/context_status/research_scope_id/
 *   research_scope_status + 正文 role/focus/exclude）
 * - scanTargets：targets/ 子目录枚举 → 只收含 target.md 的目录 → ParsedTarget[]（排序稳定）
 * - watchTargets：监听 targets/ 目录（add/change/unlink → 全量重扫 → onChanged(parsed)）
 *
 * 真相源由 Agent/用户维护，引擎只读解析不写（同 person-watcher 降级惯例：缺字段不阻塞，
 * 仅 id/company_id 缺失 → invalid；research_scope_status 值域非法 → degraded warn）。
 * 已知缺口：目录名与 frontmatter id 不一致时不校验目录名（与 person-watcher 现状一致，
 * 目录名仅作定位，身份以 frontmatter id 为准）。
 */
import { watch } from 'chokidar'
import type { TargetRecord, Validation } from '../ir/schema.ts'
import { finalize, type Validated } from '../ir/validator.ts'
import type { Workspace } from './workspace.ts'
import { splitFrontmatter } from './artifact-registry.ts'

/** 同目录伴生资产文件名（确定性列举顺序；存在才列出，不复制文件内容） */
const COMPANION_FILES = [
  'jd.md',
  'requirement_matrix.md',
  'compatibility.md',
  'company_context.md',
  'industry_context.md',
  'product_context.md',
] as const

/** 可选 frontmatter 值归一：非空且非 `-` 才算存在（`-` = 未填写惯例，等价缺省） */
function present(v: string | undefined): string | undefined {
  const t = v?.trim()
  return t && t !== '-' ? t : undefined
}

/** 正文 `role: 值` 行 → role（缺失/占位 `-` → undefined） */
function parseRole(body: string): string | undefined {
  const m = body.match(/^role\s*:\s*(.+)$/m)
  return m ? present(m[1]) : undefined
}

/** 正文 `{key}（…）:` 段 → 紧随其后的 `- ` 列表（空行/非列表行终止；`-` 占位值过滤） */
function parseListSection(body: string, key: string): string[] {
  const m = body.match(new RegExp(`^${key}\\s*(?:（[^）]*）)?\\s*:\\s*$`, 'm'))
  if (!m) return []
  const rest = body.slice((m.index ?? 0) + m[0].length).replace(/^\n+/, '')
  const out: string[] = []
  for (const line of rest.split('\n')) {
    if (line.trim() === '') break
    const bullet = line.match(/^\s*[-*]\s*(.+?)\s*$/)
    if (!bullet) break
    const t = bullet[1]!.trim()
    if (t && t !== '-') out.push(t)
  }
  return out
}

/** 单个 target.md → IR（frontmatter id/company_id 必填；research_scope_status 值域校验） */
export function parseTargetMarkdown(md: string, companionFiles: string[]): Validated<TargetRecord> {
  const { meta, body } = splitFrontmatter(md)
  const checks: Validation['issues'] = []

  const id = meta.id?.trim() ?? ''
  const companyId = meta.company_id?.trim() ?? ''
  if (!id) checks.push({ path: 'id', reason: '缺失（frontmatter id 未填）', severity: 'error' })
  if (!companyId) checks.push({ path: 'companyId', reason: '缺失（frontmatter company_id 未填）', severity: 'error' })

  const rawStatus = present(meta.research_scope_status)
  let researchScopeStatus: 'draft' | 'confirmed' | undefined
  if (rawStatus) {
    if (rawStatus === 'draft' || rawStatus === 'confirmed') researchScopeStatus = rawStatus
    else checks.push({ path: 'researchScopeStatus', reason: `非法值 ${JSON.stringify(rawStatus)}（合法值：draft/confirmed）`, severity: 'warn' })
  }

  const record: TargetRecord = {
    id,
    companyId,
    candidatePerson: present(meta.candidate_person) ?? '',
    currentJdPath: present(meta.current_jd_path) ?? '',
    createdAt: present(meta.created_at) ?? '',
    contextStatus: present(meta.context_status) ?? '',
    ...(present(meta.original_jd_id) ? { originalJdId: present(meta.original_jd_id) } : {}),
    ...(present(meta.research_scope_id) ? { researchScopeId: present(meta.research_scope_id) } : {}),
    ...(researchScopeStatus ? { researchScopeStatus } : {}),
    ...(parseRole(body) ? { role: parseRole(body) } : {}),
    focus: parseListSection(body, 'focus'),
    exclude: parseListSection(body, 'exclude'),
    companionFiles,
  }
  return finalize(record, checks)
}

export interface ParsedTarget {
  sourceFile: string
  record: TargetRecord
  validation?: Validation
}

/** targets/ 子目录扫描 → ParsedTarget[]（只收含 target.md 的目录；无 targets/ 目录 → 空数组） */
export function scanTargets(ws: Workspace): ParsedTarget[] {
  if (!ws.exists('targets')) return []
  const dirs = ws.listDirs('targets').sort()
  const out: ParsedTarget[] = []
  for (const dir of dirs) {
    const sourceFile = `targets/${dir}/target.md`
    if (!ws.exists(sourceFile)) continue
    const companionFiles = COMPANION_FILES.filter((f) => ws.exists(`targets/${dir}/${f}`))
    const parsed = parseTargetMarkdown(ws.read(sourceFile), companionFiles)
    out.push({ sourceFile, record: parsed.value, validation: parsed.validation })
  }
  return out
}

/** targets/ 目录监听：add/change/unlink → 全量重扫 → onChanged（同 jobs 全量重扫决策） */
export function watchTargets(ws: Workspace, onChanged: (parsed: ParsedTarget[]) => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.targets, { ignoreInitial: true })
  const rescan = (): void => onChanged(scanTargets(ws))
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
