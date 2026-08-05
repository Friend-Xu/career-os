/**
 * locator-resolver（M4-4.2，契约 ARTIFACT-REFERENCE-PROTOCOL-M4-v0.1 §5）。
 * 只回答"这个地址现在是否存在"——不判语义、不缓存、无 fallback。
 * 每次解析扫源 Artifact 当前状态（地址非快照——永远返回最新事实）。
 */
import type { Workspace } from '../storage/workspace.ts'
import type { ArtifactLocator, LocatorResolution } from '../ir/reference.ts'
import { scanClaims } from '../storage/claim-watcher.ts'
import { scanPortfolioProjects } from '../storage/portfolio-watcher.ts'
import { scanInterviewQas } from '../storage/interview-watcher.ts'

/** 解析 locator → 存在性 + 当前事实快照（断链显式 error，不允许 fallback/stale） */
export function resolveLocator(ws: Workspace, loc: ArtifactLocator): LocatorResolution {
  if (loc.artifact === 'resume') {
    if (loc.objectType !== 'claim') return { exists: false, error: 'resume 的 Fact 层是 claim（objectType=claim）' }
    const stmt = scanClaims(ws).find((c) => c.record.id === loc.objectId)?.record.statement
    return stmt !== undefined ? { exists: true, statement: stmt } : { exists: false, error: `claim 不存在：${loc.objectId}` }
  }
  if (loc.artifact === 'portfolio') {
    return resolveScopedFact(ws, loc, 'portfolio')
  }
  if (loc.artifact === 'interview') {
    return resolveScopedFact(ws, loc, 'interview')
  }
  // cover-letter：无 Fact Layer（unit 是 Expression）——v0.1 协议中不可作为引用目标（并轨待未来）
  return { exists: false, error: 'cover-letter 无 Fact Layer（不可作为引用目标）' }
}

/** portfolio/interview 共用：scopeId（容器）→ objectId（fact）两级定位 */
function resolveScopedFact(ws: Workspace, loc: ArtifactLocator, kind: 'portfolio' | 'interview'): LocatorResolution {
  if (loc.objectType !== 'fact') return { exists: false, error: `${kind} 的 Fact 层是 fact（objectType=fact）` }
  if (!loc.scopeId) return { exists: false, error: `${kind} 引用必须带 scopeId（Local Addressing）` }
  if (kind === 'portfolio') {
    const project = scanPortfolioProjects(ws).find((p) => p.record.id === loc.scopeId)
    if (!project) return { exists: false, error: `项目不存在：${loc.scopeId}` }
    const fact = project.record.factItems.find((f) => f.id === loc.objectId)
    return fact ? { exists: true, statement: fact.statement } : { exists: false, error: `FactItem 不存在：${loc.scopeId}/${loc.objectId}` }
  }
  const qa = scanInterviewQas(ws).find((q) => q.record.id === loc.scopeId)
  if (!qa) return { exists: false, error: `QA 不存在：${loc.scopeId}` }
  const fact = qa.record.factItems.find((f) => f.id === loc.objectId)
  return fact ? { exists: true, statement: fact.statement } : { exists: false, error: `FactItem 不存在：${loc.scopeId}/${loc.objectId}` }
}
