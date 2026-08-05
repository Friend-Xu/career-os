/**
 * Artifact Reference Protocol IR（M4-4，契约 ARTIFACT-REFERENCE-PROTOCOL-M4-v0.1）。
 * - Reference = Owner Artifact + Target Fact Locator + Relation（宪法层——只读定位，非同步）
 * - objectType 白名单：fact / claim（仅 Fact Layer——Expression 引用结构上不存在）
 * - 不加 metadata/weight/confidence/syncMode/snapshot——定位协议不污染成语义关系模型
 */
export type ReferenceArtifactType = 'resume' | 'portfolio' | 'interview' | 'cover-letter'
export type ReferenceObjectType = 'fact' | 'claim' // 仅 Fact Layer（claim 为 Resume 特例）
export type ReferenceRelation = 'supports' // v0.1 唯一实现；mentions/derived_from 语义空间预留（定义不实现）

/** 地址：Local Addressing（portfolio/projectA/fact_001）——非全局身份，非快照 */
export interface ArtifactLocator {
  artifact: ReferenceArtifactType
  scopeId?: string // 容器局部（projectId / qaId / clId）；resume 忽略（claim 是系统 ID 全局唯一）
  objectType: ReferenceObjectType
  objectId: string // resume → claim_xxx；portfolio/interview → fact_xxx
}

/** 引用关系：owner 声明"我依赖谁"——owner 是 reference owner, not factual source（图模型防歧义） */
export interface ArtifactReference {
  id: string
  owner: ArtifactLocator
  target: ArtifactLocator // 被引用事实（事实真相在 target 侧，不复制）
  relation: ReferenceRelation
  createdAt: string
}

/** Resolver 结果：只回答"这个地址现在是否存在"——不判语义（ReferenceInvalid 显式，无 fallback） */
export interface LocatorResolution {
  exists: boolean
  statement?: string // exists 时——源 Artifact 当前事实（地址非快照，永远最新）
  error?: string // 不存在时——原因（断链显式可见）
}
