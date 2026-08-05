/**
 * snapshot-archive：M7.1 Snapshot Version Archive（Career Ledger Contract v0.1 冻结结构）。
 * persons/{pid}/snapshot/ 下 current/（覆盖写真相源）+ versions/（append-only 版本存档）。
 * - migrateSnapshotLayout：旧平铺 snapshot/*.md → current/ + bootstrap 版本（幂等，引擎启动调用）
 * - archiveCurrentSnapshot：外部写入 current 前调用——旧状态入 versions/{YYYYMMDD}_{reason}_vN/（增量）+ manifest
 * - listSnapshotVersions：manifest 列表（版本链正序）
 * - readSnapshotVersion：沿 parent 链合并完整状态（M7.1 Snapshot Diff Engine 输入）
 *
 * 单向依赖：Ledger 引用 Snapshot Version，本模块不读写 ledger/ 也不反向修改 current/。
 */
import { readdirSync } from 'node:fs'
import type { Workspace } from './workspace.ts'
import { WorkspaceError } from './workspace.ts'
import { splitFrontmatter } from './artifact-registry.ts'

export interface SnapshotVersionManifest {
  id: string              // snapshot_YYYYMMDD_vN
  personId: string
  createdAt: string       // ISO
  parentVersion: string | null
  reason: string          // 归档原因（目录名段，如 bootstrap / skill_update）
  changedPaths: string[]  // 相对 current/ 的变化文件
  trigger?: string
  sourceRefs: string[]
}

export interface SnapshotArchiveOptions {
  /** 目录名段（如 bootstrap / skill_update / preference_update）——RPC 边界校验 */
  reason: string
  /** 触发来源（自由文本，如 skill_intelligence_v3_completed） */
  trigger?: string
  /** evidence refs（provenance） */
  sourceRefs?: string[]
}

const dirOf = (pid: string): string => `persons/${pid}/snapshot`
const curDir = (pid: string): string => `persons/${pid}/snapshot/current`
const verDir = (pid: string): string => `persons/${pid}/snapshot/versions`

function listFiles(ws: Workspace, rel: string): string[] {
  try {
    return ws.listMarkdown(rel)
  } catch {
    return [] // 目录未创建 → 空（current/ 由迁移/首次写入建立）
  }
}

function readCurrent(ws: Workspace, pid: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of listFiles(ws, curDir(pid))) out[f] = ws.read(`${curDir(pid)}/${f}`)
  return out
}

/** 版本目录内文件（manifest.md 除外）——增量存档只存 changed files */
function readVersionDir(ws: Workspace, pid: string, versionId: string): Record<string, string> {
  const out: Record<string, string> = {}
  const base = `${verDir(pid)}/${versionId}`
  for (const f of listFiles(ws, base)) {
    if (f === 'manifest.md') continue
    out[f] = ws.read(`${base}/${f}`)
  }
  return out
}

function versionNumber(id: string): number {
  const m = id.match(/_v(\d+)$/)
  return m ? parseInt(m[1]!, 10) : 0
}

function localDateOf(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}${m}${day}`
}

/** 版本号：latest 存档 +1；无存档 → 从状态文件 frontmatter status 取 max（与契约"版本链对齐"） */
function nextVersionNumber(ws: Workspace, pid: string, source: Record<string, string>): number {
  const latest = listSnapshotVersions(ws, pid).at(-1)
  if (latest) return versionNumber(latest.id) + 1
  let max = 0
  for (const content of Object.values(source)) {
    const m = content.match(/^status:\s*v(\d+)/m)
    if (m) max = Math.max(max, parseInt(m[1]!, 10))
  }
  return max || 1
}

function renderManifest(m: SnapshotVersionManifest): string {
  const lines = [
    '---',
    `id: ${m.id}`,
    `person_id: ${m.personId}`,
    `created_at: ${m.createdAt}`,
    `parent_version: ${m.parentVersion ?? 'null'}`,
    `reason: ${m.reason}`,
    `changed_paths: ${m.changedPaths.join(',')}`,
    ...(m.trigger ? [`trigger: ${m.trigger}`] : []),
    `source_refs: ${m.sourceRefs.join(',')}`,
    '---',
    '',
    `# Snapshot Version ${m.id}`,
    '',
  ]
  return lines.join('\n')
}

export function parseSnapshotManifest(md: string): SnapshotVersionManifest | undefined {
  const { meta } = splitFrontmatter(md)
  const id = meta.id?.trim()
  const personId = meta.person_id?.trim()
  if (!id || !personId) return undefined
  return {
    id,
    personId,
    createdAt: meta.created_at?.trim() ?? '',
    parentVersion: meta.parent_version && meta.parent_version.trim() !== 'null' ? meta.parent_version.trim() : null,
    reason: meta.reason?.trim() ?? '',
    changedPaths: (meta.changed_paths ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    trigger: meta.trigger?.trim() || undefined,
    sourceRefs: (meta.source_refs ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  }
}

function readManifest(ws: Workspace, pid: string, dirName: string): SnapshotVersionManifest | undefined {
  const rel = `${verDir(pid)}/${dirName}/manifest.md`
  return ws.exists(rel) ? parseSnapshotManifest(ws.read(rel)) : undefined
}

/** 版本目录扫描（id → dirName 绑定；目录名 = {YYYYMMDD}_{reason}_vN，与 manifest.id 解耦） */
function scanVersionDirs(ws: Workspace, pid: string): { manifest: SnapshotVersionManifest; dirName: string }[] {
  const out: { manifest: SnapshotVersionManifest; dirName: string }[] = []
  for (const dirName of listDirsOf(ws, verDir(pid))) {
    const m = readManifest(ws, pid, dirName)
    if (m) out.push({ manifest: m, dirName })
  }
  return out.sort((a, b) => versionNumber(a.manifest.id) - versionNumber(b.manifest.id))
}

/** 版本 manifest 列表（正序 v1 → vN；versions/ 缺失 → 空） */
export function listSnapshotVersions(ws: Workspace, pid: string): SnapshotVersionManifest[] {
  return scanVersionDirs(ws, pid).map((v) => v.manifest)
}

/** 读取某版本完整状态（沿 parent 链合并：子版本文件覆盖父版本；空内容 = 该文件已删除） */
export function readSnapshotVersion(ws: Workspace, pid: string, versionId: string): Record<string, string> {
  const dirs = scanVersionDirs(ws, pid)
  const byId = new Map(dirs.map((d) => [d.manifest.id, d]))
  const chain: string[] = []
  let cur: string | null = versionId
  while (cur) {
    const d = byId.get(cur)
    if (!d) throw new WorkspaceError(`${verDir(pid)}/${cur}`, '版本不存在或 manifest 缺失')
    chain.unshift(d.dirName)
    cur = d.manifest.parentVersion
  }
  const out: Record<string, string> = {}
  for (const dirName of chain) Object.assign(out, readVersionDir(ws, pid, dirName))
  return out
}

function listDirsOf(ws: Workspace, rel: string): string[] {
  try {
    return ws.listDirs(rel)
  } catch {
    return []
  }
}

function listPersonIds(ws: Workspace): string[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(ws.paths.persons, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && ws.exists(`persons/${e.name}/manifest.md`))
    .map((e) => e.name)
}

/**
 * 旧平铺 snapshot/*.md → snapshot/current/ + bootstrap 版本（幂等：无平铺残留 → no-op）。
 * 引擎启动调用（main.ts）；返回 bootstrap 版本 id 或 null。
 */
export function migrateSnapshotLayout(ws: Workspace): string | null {
  let bootstrapped: string | null = null
  for (const pid of listPersonIds(ws)) {
    const flat = listFiles(ws, dirOf(pid))
    if (flat.length === 0) continue
    for (const f of flat) {
      const content = ws.read(`${dirOf(pid)}/${f}`)
      ws.write(`${curDir(pid)}/${f}`, content)
      ws.delete(`${dirOf(pid)}/${f}`)
    }
    bootstrapped = archiveCurrentSnapshot(ws, pid, { reason: 'bootstrap', trigger: 'layout_migration' })?.id ?? null
  }
  return bootstrapped
}

/**
 * 归档当前状态 → versions/{YYYYMMDD}_{reason}_vN/（增量：只存与 latest 差异文件）+ manifest。
 * 与 latest 版本无差异 → null（幂等：同状态不重复产生版本）。reason 是 RPC 边界（校验）。
 */
export function archiveCurrentSnapshot(
  ws: Workspace,
  pid: string,
  opts: SnapshotArchiveOptions,
): SnapshotVersionManifest | null {
  if (!/^[a-z0-9_-]{1,40}$/i.test(opts.reason)) {
    throw new WorkspaceError(`snapshot（person ${pid}）`, `reason 非法：${opts.reason}（仅字母数字/下划线/短横线）`)
  }
  const current = readCurrent(ws, pid)
  const versions = scanVersionDirs(ws, pid)
  const latest = versions.at(-1)
  let changed: string[]
  if (latest) {
    const prev = readSnapshotVersion(ws, pid, latest.manifest.id)
    const names = new Set([...Object.keys(prev), ...Object.keys(current)])
    changed = [...names].filter((f) => current[f] !== prev[f])
  } else {
    changed = Object.keys(current)
  }
  if (changed.length === 0) return null

  const now = new Date()
  const date = localDateOf(now)
  const n = latest ? versionNumber(latest.manifest.id) + 1 : nextVersionNumber(ws, pid, current)
  const id = `snapshot_${date}_v${n}`
  const manifest: SnapshotVersionManifest = {
    id,
    personId: pid,
    createdAt: now.toISOString(),
    parentVersion: latest?.manifest.id ?? null,
    reason: opts.reason,
    changedPaths: changed,
    trigger: opts.trigger,
    sourceRefs: opts.sourceRefs ?? [],
  }
  const base = `${verDir(pid)}/${date}_${opts.reason}_v${n}`
  for (const f of changed) ws.write(`${base}/${f}`, current[f] ?? '')
  ws.write(`${base}/manifest.md`, renderManifest(manifest))
  return manifest
}
