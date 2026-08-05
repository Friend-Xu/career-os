/**
 * Interview Artifact IR（M4-2，契约 INTERVIEW-ARTIFACT-M4-v0.1）。
 * - 三层分离：FactLayer（FactItem）/ ExpressionLayer（AnswerStatement）/ StrategyLayer（Intent）
 * - 四边界：AI 只 rewrite Answer.text；STAR 是投影非存储；无 ownership 检测；draft→reviewed→ready
 * - factRefs >= 1（每条回答必须有 Fact Anchor，I-08）；v0.1 无 version（无发布语义）
 */
export type InterviewStatus = 'draft' | 'reviewed' | 'ready'
export type InterviewProposalStatus = 'pending' | 'accepted' | 'rejected'
export type InterviewChangeType = 'rewrite' // v0.1 固定；只改写 AnswerStatement.text
export type InterviewFactType = 'project_context' | 'responsibility' | 'action' | 'result' | 'technical_decision'
export type InterviewEvidenceType = 'code' | 'design' | 'demo' | 'result'

/** FactLayer：发生过什么（用户写，AI 不可动——Expression cannot mutate Fact） */
export interface InterviewFactItem {
  id: string // fact_001
  statement: string
  type: InterviewFactType
  evidenceRefs: string[] // 引用 InterviewEvidence.id
  // type 是语义分类标签，不定义 STAR 投影结构（action ≠ STAR Action）
}

/** 内嵌证据资产（用户写；Link 只是 location 的一种形态） */
export interface InterviewEvidence {
  id: string
  type: InterviewEvidenceType
  location: string
  metadata?: Record<string, string>
}

/** ExpressionLayer：如何讲述（用户写 raw；AI rewrite-only） */
export interface InterviewStatement {
  id: string // ans_001
  text: string
  factRefs: string[] // MUST contain at least one FactItem reference（I-08）
}

/** StrategyLayer：为什么这样回答（用户写；v0.1 无 AI 通道） */
export interface InterviewIntent {
  id: string // int_001
  statement: string
}

/** 演化记录（append-only 审计信息；命名同 Portfolio TransitionRecord 精神） */
export interface InterviewTransitionRecord {
  from: string // '' = 初始
  to: string
  at: string // ISO
  via?: string // proposal id（apply 产生 draft 时）
}

/** QA Artifact：核心对象是 Question → Answer Evolution，不是"面试场次" */
export interface InterviewQa {
  id: string // qa_YYYYMMDD_NNNNN（引擎登记）
  status: InterviewStatus
  question: string // 面试问题（外部输入；AI 不可修改）
  factItems: InterviewFactItem[]
  evidence: InterviewEvidence[]
  answerStatements: InterviewStatement[]
  intents: InterviewIntent[]
  transitions: InterviewTransitionRecord[]
  createdAt?: string
  sourceFile?: string // 登记前文件名（显示名/溯源）
  metadata?: Record<string, string> // targetRole/company 等（不能成为 Fact）
}

/** 单条改写建议：old 必须与 AnswerStatement.text 逐字匹配（空格 normalize；防幻觉） */
export interface InterviewProposalChange {
  type: InterviewChangeType
  statementId: string // 目标 AnswerStatement
  old: string
  new: string
  reason: string
}

/** Interview Proposal：AI 写 Proposal，不能直接写 QA 文件（Intent Layer） */
export interface InterviewProposal {
  id: string // ip_YYYYMMDD_NNNNN（引擎登记）
  qaId: string
  changes: InterviewProposalChange[]
  status: InterviewProposalStatus // 引擎管理；AI 写文件只能产生 pending
  createdBy: 'ai' // 本层固定：Proposal 是 AI 建议的唯一通道
  createdAt?: string
  decidedAt?: string
  acceptReason?: string // Human Preference Signal，与 rejectReason 对称
  rejectReason?: string
  validation?: InterviewValidation
}

/** 三态复用（形态与 Resume/Portfolio 同构；类型独立——各 Artifact 独立闭环） */
export type InterviewValidationStatus = 'valid' | 'warning' | 'invalid'
export interface InterviewValidationIssue {
  code: string // I-01 ~ I-08 / NO_CHANGES
  message: string
  target: string
}
export interface InterviewValidation {
  status: InterviewValidationStatus
  issues: InterviewValidationIssue[]
}

/** Read Projection（引擎确定性聚合；不成为事实存储；不依赖 CareerContext） */
export interface InterviewContext {
  qas: InterviewQa[]
}
