/**
 * Health Engine：workspace/decisions/graph/knowledge 四维度健康投影（契约 v1）。
 * 纯投影不修复（Detection ≠ Remediation）；空数据源按空维度 score=100 诚实处理。
 * 输入：workspace（fs）+ store（投影层 listDecisions/graph）。
 */
import type { Workspace } from '../storage/workspace.ts'
import type { ProjectionStore } from '../storage/projection.ts'
import { scanKnowledge } from '../storage/knowledge-watcher.ts'
import type { HealthDimension, HealthIssue, HealthReport } from './types.ts'

/** workspace 域：目录树 + protocol.json + INDEX.md 完整性 */
function workspaceDimension(ws: Workspace): HealthDimension {
  const checks: { ok: boolean; message: string; severity: 'error' | 'warn' }[] = [
    { ok: ws.exists('persons'), message: '缺 persons/ 目录（M6.5 Person Intelligence 真相源）', severity: 'error' },
    { ok: ws.exists('decisions'), message: '缺 decisions/ 目录', severity: 'error' },
    { ok: ws.exists('companies'), message: '缺 companies/ 目录', severity: 'warn' },
    { ok: ws.exists('knowledge'), message: '缺 knowledge/ 目录', severity: 'warn' },
    { ok: ws.exists('metadata/protocol.json'), message: '缺 metadata/protocol.json', severity: 'error' },
    { ok: ws.exists('INDEX.md'), message: '缺 INDEX.md', severity: 'warn' },
  ]
  const issues = groupIssues(checks.filter((c) => !c.ok).map((c) => ({ severity: c.severity, message: c.message })))
  return { name: 'workspace', score: roundScore(checks.filter((c) => c.ok).length / checks.length), issues }
}

/** decisions 域：invalid = 脏数据（error），degraded = 待改善（warn） */
function decisionsDimension(store: ProjectionStore): HealthDimension {
  const records = store.listDecisions()
  const issues: HealthIssue[] = []
  if (records.length === 0) return { name: 'decisions', score: 100, issues }

  const invalid = records.filter((r) => r.validation?.status === 'invalid')
  const degraded = records.filter((r) => r.validation?.status === 'degraded')
  if (invalid.length > 0) {
    issues.push({ severity: 'error', message: `${invalid.length} 条决策缺必填字段（待人工处理）`, count: invalid.length })
  }
  if (degraded.length > 0) {
    issues.push({ severity: 'warn', message: `${degraded.length} 条决策值域非法（已降级保留）`, count: degraded.length })
  }
  return { name: 'decisions', score: roundScore(1 - invalid.length / records.length), issues }
}

/** graph 域：孤立节点（无任何边）为唯一 M1 指标；字段缺失模型尚无（missing=0，诚实） */
function graphDimension(store: ProjectionStore): HealthDimension {
  const graph = store.graph()
  const issues: HealthIssue[] = []
  if (graph.nodes.length === 0) return { name: 'graph', score: 100, issues }

  const linked = new Set<string>()
  for (const e of graph.edges) {
    linked.add(e.source)
    linked.add(e.target)
  }
  const isolated = graph.nodes.filter((n) => !linked.has(n.id)).length
  if (isolated > 0) {
    issues.push({ severity: 'warn', message: `${isolated} 个孤立节点（无关联边）`, count: isolated })
  }
  return { name: 'graph', score: roundScore(1 - isolated / graph.nodes.length), issues }
}

/** knowledge 域：文件缺失（error）、词表空（warn） */
function knowledgeDimension(ws: Workspace): HealthDimension {
  const checks: { ok: boolean; message: string; severity: 'error' | 'warn' }[] = [
    { ok: ws.exists('knowledge/skills.md'), message: '缺 knowledge/skills.md', severity: 'error' },
    { ok: ws.exists('knowledge/roles.md'), message: '缺 knowledge/roles.md', severity: 'error' },
  ]
  const scan = scanKnowledge(ws)
  const fileIssues = checks.filter((c) => !c.ok).map((c) => ({ severity: c.severity, message: c.message }))
  if (scan.skills.length === 0) fileIssues.push({ severity: 'warn', message: '技能词表为空' })
  if (scan.roles.length === 0) fileIssues.push({ severity: 'warn', message: '岗位档案为空' })
  const issues = groupIssues(fileIssues)
  return { name: 'knowledge', score: roundScore(checks.filter((c) => c.ok).length / checks.length), issues }
}

/** 生成健康报告（唯一入口；CLI --doctor 与 system/health RPC 共用） */
export function generateHealthReport(ws: Workspace, store: ProjectionStore): HealthReport {
  const dimensions: HealthDimension[] = [
    workspaceDimension(ws),
    decisionsDimension(store),
    graphDimension(store),
    knowledgeDimension(ws),
  ]
  // 注意：维度 score 已是 0-100 分数，不能复用 roundScore（其参数是 0-1 ratio）
  const avgScore = dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length
  const overallScore = Math.max(0, Math.min(100, Math.round(avgScore)))
  return {
    overallScore,
    dimensions,
    generatedAt: new Date().toISOString(),
    version: 1,
  }
}

function groupIssues(items: { severity: 'error' | 'warn'; message: string }[]): HealthIssue[] {
  const byMessage = new Map<string, HealthIssue>()
  for (const it of items) {
    const existing = byMessage.get(it.message)
    if (existing) existing.count++
    else byMessage.set(it.message, { severity: it.severity, message: it.message, count: 1 })
  }
  return [...byMessage.values()]
}

function roundScore(ratio: number): number {
  return Math.max(0, Math.min(100, Math.round(ratio * 100)))
}
