/**
 * artifact-type-registry：Stage Artifact 类型注册表（契约 v0.2 §1.2「类型注册表」+ v0.3 §一「证据域参数化」）。
 *
 * artifactType 键 → StageArtifactSpec（dir/idPrefix/marker/evidenceRefPattern 等实例参数）。evaluator
 * （artifact-exists）按 evaluatorParams.artifactType 反查 spec 执行 count；各 Stage 的 done 钩子登记
 * 与 UI 投影共用同一 spec——单一物理/格式定义源。
 *
 * v0.2 仅 'direction_candidate'；v0.3 增 'evaluation_candidate'（Stage 3 评估闭环）。
 * 挂参即需登记——缺 spec = 配置错误 → fail fast，不静默放行。
 */
import type { StageArtifactSpec } from './stage-artifact-registry.ts'

export const DIRECTION_SPEC: StageArtifactSpec = {
  artifactType: 'direction_candidate',
  dir: (personId) => `persons/${personId}/directions`,
  idPrefix: 'direction_',
  marker: /##\s*方向主张/,
  /** 证据域（v0.3 §一）：方向候选依据 = 个人事实（facts/ + snapshot/current/） */
  evidenceRefPattern: /^(facts|snapshot\/current)\/[^/\\]+\.md$/,
}

export const EVALUATION_SPEC: StageArtifactSpec = {
  artifactType: 'evaluation_candidate',
  dir: (personId) => `persons/${personId}/evaluations`,
  idPrefix: 'evaluation_',
  marker: /##\s*方向评估/,
  /** 证据域（v0.3 §一）：评估依据 = 已确认方向（directions/）+ 个人事实（facts/ + snapshot/current/） */
  evidenceRefPattern: /^(facts|snapshot\/current|directions)\/[^/\\]+\.md$/,
}

const ARTIFACT_TYPE_SPECS: Record<string, StageArtifactSpec> = {
  [DIRECTION_SPEC.artifactType]: DIRECTION_SPEC,
  [EVALUATION_SPEC.artifactType]: EVALUATION_SPEC,
}

export function getArtifactSpec(artifactType: string): StageArtifactSpec {
  const spec = ARTIFACT_TYPE_SPECS[artifactType]
  if (!spec) throw new Error(`artifactType 未登记（类型注册表缺 spec）：${artifactType}`)
  return spec
}
