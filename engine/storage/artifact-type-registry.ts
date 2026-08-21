/**
 * artifact-type-registry：Stage Artifact 类型注册表（契约 v0.2 §1.2「类型注册表」）。
 *
 * artifactType 键 → StageArtifactSpec（dir/idPrefix/marker 等实例参数）。evaluator
 * （artifact-exists）按 evaluatorParams.artifactType 反查 spec 执行 count；DirectionCandidate
 * 注册（done 钩子）与 UI 投影共用同一 spec——单一物理/格式定义源。
 *
 * v0.2 仅 'direction_candidate'；Stage 3 evaluation_artifact 下一切片登记（挂参即需登记，
 * 缺 spec = 配置错误 → fail fast，不静默放行）。
 */
import type { StageArtifactSpec } from './stage-artifact-registry.ts'

export const DIRECTION_SPEC: StageArtifactSpec = {
  artifactType: 'direction_candidate',
  dir: (personId) => `persons/${personId}/directions`,
  idPrefix: 'direction_',
  marker: /##\s*方向主张/,
}

const ARTIFACT_TYPE_SPECS: Record<string, StageArtifactSpec> = {
  [DIRECTION_SPEC.artifactType]: DIRECTION_SPEC,
}

export function getArtifactSpec(artifactType: string): StageArtifactSpec {
  const spec = ARTIFACT_TYPE_SPECS[artifactType]
  if (!spec) throw new Error(`artifactType 未登记（类型注册表缺 spec）：${artifactType}`)
  return spec
}
