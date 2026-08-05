/**
 * artifact-registry：系统资产登记——决策/证据等资产文件的最终命名权归引擎，不归写入方（M1.6 起）。
 * - 写入方按旧协议写暂存名（decisions/{日期}-{主题}.md 等），引擎登记时分配系统 ID
 *   {prefix}{YYYYMMDD}_{NNNNN} → 重命名 + 注入 frontmatter（id/created_at/source_file；
 *   写入方在内容头部声明的透传字段保留）
 * - 同主题重复写入天然不覆盖：每次登记生成新 ID，旧暂存名已消失
 * - 只登记含 marker 段的资产格式文件（写入方是外部方，边界校验；笔记等非资产格式不赋予系统身份）
 * - 幂等：已登记文件（系统 ID 前缀）跳过；registerArtifacts 可反复调用
 * - Decision/Evidence 共用此机制（不复制代码）；各资产类型只是 spec 参数 + schema
 */
import type { Workspace } from './workspace.ts'

export interface ArtifactSpec {
  type: string // 'decision' | 'evidence'
  dir: string // 'decisions' | 'evidence'
  idPrefix: string // 'decision_' | 'evidence_'
  marker: RegExp // 必含段落（资产格式判定）
  passthroughFields: string[] // frontmatter 透传白名单（写入方声明的元数据，如 decision 的 type/subject_id）
}

/** 内容头部 frontmatter（`---` 包裹的 key: value 块，写入方可选声明元数据）→ meta + body */
export function splitFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { meta: {}, body: md }
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { meta, body: md.slice(m[0].length) }
}

/** 系统 ID 生成：{prefix}{YYYYMMDD}_{NNNNN}（当日最大序号 +1——按序号非数量，防删除空洞导致 ID 复用覆盖旧文件；跨日归零；单进程个人工具无需锁） */
export function nextArtifactId(ws: Workspace, spec: ArtifactSpec, now: Date): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `${spec.idPrefix}${day}_`
  let max = 0
  for (const f of ws.listMarkdown(spec.dir)) {
    if (!f.startsWith(prefix)) continue
    const n = parseInt(f.slice(prefix.length, -3), 10)
    if (!Number.isNaN(n) && n > max) max = n
  }
  return `${spec.idPrefix}${day}_${String(max + 1).padStart(5, '0')}`
}

/** 扫描 spec.dir 未登记文件 → 分配系统 ID → 重命名 + 注入 frontmatter（返回登记数） */
export function registerArtifacts(ws: Workspace, spec: ArtifactSpec, now: Date = new Date()): { registered: number } {
  const registeredRe = new RegExp(`^${spec.idPrefix}\\d{8}_\\d{5}$`)
  let registered = 0
  for (const f of ws.listMarkdown(spec.dir).sort()) {
    const id = f.replace(/\.md$/, '')
    if (registeredRe.test(id)) continue
    const md = ws.read(`${spec.dir}/${f}`)
    if (!spec.marker.test(md)) continue // 非资产格式文件不赋予系统身份
    const { meta, body } = splitFrontmatter(md)
    const systemId = nextArtifactId(ws, spec, now)
    const createdAt = now.toISOString().slice(0, 10)
    const fm = [
      '---',
      `id: ${systemId}`,
      `created_at: ${createdAt}`,
      `source_file: ${id}`,
      ...spec.passthroughFields.flatMap((k) => (meta[k] ? [`${k}: ${meta[k]}`] : [])),
      '---',
      '',
    ].join('\n')
    ws.write(`${spec.dir}/${systemId}.md`, fm + body)
    ws.delete(`${spec.dir}/${f}`)
    registered++
  }
  return { registered }
}
