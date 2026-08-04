/**
 * decision-registry：决策资产登记（M1.6）——artifact-registry 的决策 spec + 兼容导出。
 * 通用登记机制见 artifact-registry.ts（Decision/Evidence 共用，不复制代码）。
 */
import type { Workspace } from './workspace.ts'
import { nextArtifactId, registerArtifacts, splitFrontmatter, type ArtifactSpec } from './artifact-registry.ts'

export const DECISION_SPEC: ArtifactSpec = {
  type: 'decision',
  dir: 'decisions',
  idPrefix: 'decision_',
  marker: /##\s*分析摘要/,
  passthroughFields: ['type', 'subject_id'],
}

export { splitFrontmatter, type ArtifactSpec }

/** 系统 ID 生成：decision_{YYYYMMDD}_{NNNNN}（当日已有计数 +1，跨日归零） */
export function nextDecisionId(ws: Workspace, now: Date): string {
  return nextArtifactId(ws, DECISION_SPEC, now)
}

/** 扫描 decisions/ 未登记文件 → 分配系统 ID → 重命名 + 注入 frontmatter（返回登记数） */
export function registerDecisionIdentity(ws: Workspace, now: Date = new Date()): { registered: number } {
  return registerArtifacts(ws, DECISION_SPEC, now)
}
