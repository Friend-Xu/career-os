/**
 * Portfolio Artifact IR（M4-1，契约 PORTFOLIO-ARTIFACT-M4-v0.1）。
 * - 集合型 Artifact：N 个项目，每项目一文件（workspace/portfolio/projects/）
 * - 三边界：ProjectFact ≠ ProjectDescription / Evidence ≠ Link / Published ≠ Editable
 * - FactItem 无删除操作（v0.1）；change 类型固定 rewrite
 * - transitions 是审计信息，不作为 Proposal 生成语义输入
 */
export type PortfolioStatus = 'draft' | 'reviewed' | 'published'
export type PortfolioProposalStatus = 'pending' | 'accepted' | 'rejected'
export type PortfolioChangeType = 'rewrite' // v0.1 固定；预留 merge/split/archive/link
export type PortfolioEvidenceType = 'code' | 'design' | 'demo' | 'result'

/** 项目事实（不可由 AI 生成；AI 只能经 Proposal 改写 statement，不能新增/删除 FactItem） */
export interface PortfolioFactItem {
  id: string // pf_001
  statement: string // "完成自动化夹具设计"
  type: string // engineering_work / achievement / role / tech_stack
  evidenceRefs: string[] // 引用 Evidence.id，非空
}

/** 登记的证据对象：Link 只是 location 的一种形态（Evidence ≠ Link） */
export interface PortfolioEvidence {
  id: string // design_001
  type: PortfolioEvidenceType
  location: string // figma/project-x/design.pdf
  metadata?: Record<string, string> // 时间 / 版本 / 标签
}

/**
 * 演化记录（append-only 审计信息——不作为 Proposal 生成语义输入）。
 * 命名保留 TransitionRecord（不改 StateTransition）：承载 state transition
 * 与 artifact evolution event 两个语义（apply 产生的 draft→draft 是演化事件）。
 */
export interface PortfolioTransitionRecord {
  version: number
  from: string // '' = 初始
  to: string
  at: string // ISO
  via?: string // proposal id（apply 产生 draft 时）
}

/** 项目 Artifact：status ≠ version（分离）；published 不可回退/原地修改 */
export interface PortfolioProject {
  id: string // project_YYYYMMDD_NNNNN（引擎登记）
  status: PortfolioStatus
  version: number
  factItems: PortfolioFactItem[]
  evidence: PortfolioEvidence[]
  transitions: PortfolioTransitionRecord[]
  createdAt?: string
  sourceFile?: string // 登记前文件名（显示名/溯源）
}

/** 单条改写建议：old 必须与项目事实 statement 逐字匹配（空格 normalize；防幻觉） */
export interface PortfolioProposalChange {
  type: PortfolioChangeType
  factId: string // 目标 FactItem
  old: string
  new: string
  reason: string
}

/** Portfolio Proposal：AI 写 Proposal，不能直接写项目文件（Intent Layer） */
export interface PortfolioProposal {
  id: string // pp_YYYYMMDD_NNNNN（引擎登记）
  projectId: string
  changes: PortfolioProposalChange[]
  status: PortfolioProposalStatus // 引擎管理；AI 写文件只能产生 pending
  createdBy: 'ai' // 本层固定：Proposal 是 AI 建议的唯一通道
  createdAt?: string
  decidedAt?: string
  acceptReason?: string // accepted 可选理由（Human Preference Signal，与 rejectReason 对称）
  rejectReason?: string
  resultVersion?: number // accepted 且已 apply 后回填（apply 后版本）
  validation?: PortfolioValidation
}

/** 三态复用（形态与 ResumeValidation 同构；类型独立——Portfolio 独立闭环，ADR-007） */
export type PortfolioValidationStatus = 'valid' | 'warning' | 'invalid'
export interface PortfolioValidationIssue {
  code: string // P-01 ~ P-07 / NO_CHANGES
  message: string
  target: string
}
export interface PortfolioValidation {
  status: PortfolioValidationStatus
  issues: PortfolioValidationIssue[]
}

/** Read Projection（引擎确定性聚合；不成为事实存储；不依赖 CareerContext） */
export interface PortfolioContext {
  projects: PortfolioProject[]
}
