/**
 * Cover Letter Artifact IR（M4-3，契约 COVER-LETTER-ARTIFACT-M4-v0.1）。
 * - 第一个 Projection Artifact：NarrativeUnit 引用源 Artifact Fact Layer（单向读取）
 * - 四边界：≠ 生成器 / Narrative ≠ Fact / sourceRefs ≠ ownership / intent 属决策层
 * - adapt only mutates NarrativeUnit.text（Adaptation Space ⊆ Expression Space）
 */
export type CoverLetterStatus = 'draft' | 'reviewed' | 'ready'
export type CoverLetterProposalStatus = 'pending' | 'accepted' | 'rejected'
export type CoverLetterChangeType = 'adapt' // 同一组 sourceRefs 下表达适配
export type SourceArtifactType = 'resume' | 'portfolio' | 'interview'

/** 引用源 Artifact 的 Fact Layer（非表达层）——"为什么这句话存在"，不是修改入口 */
export interface NarrativeSourceRef {
  artifact: SourceArtifactType
  scopeId?: string // portfolio → projectId；interview → qaId（factId 是容器内局部 id，非全局唯一）；resume 忽略
  factId: string // resume → claim_xxx；portfolio → FactItem；interview → FactItem
}

/** Narrative Unit：Expression——不是 Fact，依据全部来自 sourceRefs */
export interface NarrativeUnit {
  id: string // nu_001
  text: string // Expression——AI 唯一可改字段（adapt only）
  sourceRefs: NarrativeSourceRef[] // MUST ≥ 1（无来源的叙述不可存在）
  intent?: string // 叙述意图（用户维护，AI read-only——Career Positioning Decision 属决策层）
}

/** 投递记录：append-only 事件（不改变 status；事件 metadata 非 Fact） */
export interface DeliveryRecord {
  targetCompany: string
  targetJobId?: string
  at: string
}

/** 演化记录（append-only 审计信息） */
export interface CoverLetterTransitionRecord {
  from: string // '' = 初始
  to: string
  at: string
  via?: string // proposal id（apply 产生 draft 时）
}

/** Cover Letter：集合型（每封求职信一个文件）；核心对象是 Narrative Unit 演化 */
export interface CoverLetter {
  id: string // cl_YYYYMMDD_NNNNN（引擎登记）
  status: CoverLetterStatus
  units: NarrativeUnit[]
  targetCompany?: string // metadata（不能成为 Fact）
  targetJobId?: string
  deliveries: DeliveryRecord[]
  transitions: CoverLetterTransitionRecord[]
  createdAt?: string
  sourceFile?: string
}

/** 单条适配建议：old 必须与 NarrativeUnit.text 逐字匹配（空格 normalize；防幻觉） */
export interface CoverLetterProposalChange {
  type: CoverLetterChangeType
  unitId: string
  old: string
  new: string
  reason: string
}

/** Cover Letter Proposal：AI 写 Proposal，不能直接写 Cover Letter 文件（Intent Layer） */
export interface CoverLetterProposal {
  id: string // clp_YYYYMMDD_NNNNN（引擎登记）
  clId: string
  changes: CoverLetterProposalChange[]
  status: CoverLetterProposalStatus // 引擎管理；AI 写文件只能产生 pending
  createdBy: 'ai' // 本层固定：Proposal 是 AI 建议的唯一通道
  createdAt?: string
  decidedAt?: string
  acceptReason?: string // Human Preference Signal，与 rejectReason 对称
  rejectReason?: string
  validation?: CoverLetterValidation
}

/** 三态复用（形态与前序 Artifact 同构；类型独立） */
export type CoverLetterValidationStatus = 'valid' | 'warning' | 'invalid'
export interface CoverLetterValidationIssue {
  code: string // CL-01 ~ CL-07 / CL-08 / NO_CHANGES
  message: string
  target: string
}
export interface CoverLetterValidation {
  status: CoverLetterValidationStatus
  issues: CoverLetterValidationIssue[]
}

/** Read Projection：Source Fact Projection（Fact Resolver 解析后的只读快照） */
export interface CoverLetterContext {
  coverLetters: {
    id: string
    status: string
    units: {
      id: string
      text: string
      intent?: string
      sourceRefs: {
        artifact: SourceArtifactType
        scopeId?: string
        factId: string
        factStatement?: string // Fact Resolver 快照；断链时缺省（显式可见）
      }[]
    }[]
    deliveries: DeliveryRecord[]
    transitions: CoverLetterTransitionRecord[]
  }[]
}
