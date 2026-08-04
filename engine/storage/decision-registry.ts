/**
 * decision-registry：决策文件身份登记——决策文件名的最终命名权归引擎，不归 Agent/用户（M1.6）。
 * - 写入方仍按旧协议写 `decisions/{日期}-{主题}.md`（暂存名），引擎登记时分配系统 ID
 *   `decision_{YYYYMMDD}_{NNNNN}` → 重命名 + 注入 frontmatter（id/created_at/source_file；
 *   内容头部已有的 type/subject_id 声明透传保留）
 * - 同主题重复分析天然不覆盖：每次登记生成新 ID，旧暂存名已消失（T2 修复）
 * - 只登记含 `## 分析摘要` 的决策格式文件（写入方是外部方，边界校验；笔记等非决策 md 不赋予决策身份）
 * - 幂等：已登记文件（文件名 decision_ 前缀）跳过；registerDecisionIdentity 可反复调用
 */
import type { Workspace } from './workspace.ts'

const REGISTERED_RE = /^decision_\d{8}_\d{5}$/
const SUMMARY_RE = /##\s*分析摘要/

/** 内容头部 frontmatter（`---` 包裹的 key: value 块，写入方可选声明决策元数据）→ meta + body */
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

/** 系统 ID 生成：decision_{YYYYMMDD}_{NNNNN}（当日已有计数 +1，跨日归零；单进程个人工具无需锁） */
export function nextDecisionId(ws: Workspace, now: Date): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '')
  const n = ws.listMarkdown('decisions').filter((f) => f.startsWith(`decision_${day}_`)).length
  return `decision_${day}_${String(n + 1).padStart(5, '0')}`
}

/** 扫描 decisions/ 未登记文件 → 分配系统 ID → 重命名 + 注入 frontmatter（返回登记数） */
export function registerDecisionIdentity(ws: Workspace, now: Date = new Date()): { registered: number } {
  let registered = 0
  for (const f of ws.listMarkdown('decisions').sort()) {
    const id = f.replace(/\.md$/, '')
    if (REGISTERED_RE.test(id)) continue
    const md = ws.read(`decisions/${f}`)
    if (!SUMMARY_RE.test(md)) continue // 非决策格式文件不赋予决策身份
    const { meta, body } = splitFrontmatter(md)
    const systemId = nextDecisionId(ws, now)
    const createdAt = now.toISOString().slice(0, 10)
    const fm = [
      '---',
      `id: ${systemId}`,
      `created_at: ${createdAt}`,
      `source_file: ${id}`,
      ...(meta.type ? [`type: ${meta.type}`] : []),
      ...(meta.subject_id ? [`subject_id: ${meta.subject_id}`] : []),
      '---',
      '',
    ].join('\n')
    ws.write(`decisions/${systemId}.md`, fm + body)
    ws.delete(`decisions/${f}`)
    registered++
  }
  return { registered }
}
