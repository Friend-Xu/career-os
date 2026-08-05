/**
 * Cover Letter Traceability Adapter（M4-5.4，Concrete First）。
 * - NarrativeSourceRef → ArtifactLocator：adapter 内转换，不扩 Cover Letter IR（M4-3 稳定）
 * - objectType 由 artifact 决定（switch，禁止从字符串猜测）：resume → claim；portfolio/interview → fact
 * - 顺序：sourceRefs 原始声明顺序（resolver 返回顺序不参与排序——依赖声明顺序即展示语义）
 * - 断链显式：resolveLocator error 透传（ReferenceInvalid，无 fallback）
 */
import type { Workspace } from '../storage/workspace.ts'
import { scanCoverLetters } from '../storage/cover-letter-watcher.ts'
import { resolveLocator } from '../reference/locator-resolver.ts'
import type { NarrativeSourceRef } from '../ir/cover-letter.ts'
import type { ArtifactLocator } from '../ir/reference.ts'
import type { TraceabilityContext } from '../ir/traceability.ts'

/** objectType 由 artifact 决定——命名不是协议，禁止从 factId/claimId 字符串猜测 */
function toLocator(ref: NarrativeSourceRef): ArtifactLocator {
  return {
    artifact: ref.artifact,
    ...(ref.scopeId ? { scopeId: ref.scopeId } : {}),
    objectType: ref.artifact === 'resume' ? 'claim' : 'fact',
    objectId: ref.factId,
  }
}

export function buildCoverLetterTraceability(
  ws: Workspace,
  clId: string,
  unitId: string,
): TraceabilityContext {
  const letter = scanCoverLetters(ws).find((c) => c.record.id === clId)?.record
  if (!letter) throw new Error(`Cover Letter 不存在：${clId}`)
  const unit = letter.units.find((u) => u.id === unitId)
  if (!unit) throw new Error(`NarrativeUnit 不存在：${clId} · ${unitId}`)
  return {
    owner: { artifact: 'cover-letter', id: clId },
    node: { type: 'narrative_unit', id: unitId, text: unit.text },
    sources: unit.sourceRefs.map((ref) => {
      const locator = toLocator(ref)
      const resolution = resolveLocator(ws, locator)
      return {
        locator,
        factStatement: resolution.statement ?? '',
        resolved: resolution.exists,
        ...(resolution.error ? { error: resolution.error } : {}),
      }
    }),
  }
}
