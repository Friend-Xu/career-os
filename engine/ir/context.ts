/**
 * CareerContext IR（M3.5.4：AI Read Model——契约 CAREER-CONTEXT-M3-v0.1）。
 * 只读投影：AI 不直接读数据库结构，只看引擎组合的可解释视图。
 * 不包含：AI Memory / 推荐 / 评分 / 决策字段（AI 是知情协作者不拥有决策权）。
 */
import type { EvidenceItem } from './schema.ts'
import type { ResumeStatus } from './resume.ts'

export interface CareerContext {
  generatedAt: string
  workspace: { id: string }

  currentJob?: {
    id: string
    title: string
    responsibilities: string[]
    expectations: {
      id: string // patternId
      dimension: string
      coverage: 'covered' | 'partial' | 'missing'
    }[]
  }

  claims: {
    id: string
    type: 'fact' | 'interpretation'
    statement: string
    usable: boolean // canUseClaim（引擎派生）
    usedByResume: string[] // 被哪些简历版本引用（反查）
    provenance: { evidenceIds: string[] }
    owner?: string // 归属 person_id（Engine Registration——approve 从证据 owner 派生；缺失 = 归属不明，UI 不展示给任何人）
    evidenceType?: EvidenceItem['type'] // 证据经历分类（professional_experience/independent_project——编辑器模块建议标注）
  }[]

  expressions: {
    id: string // resumeId:sectionIndex:bulletIndex
    claimId: string
    statement: string
    languageFamily?: string
  }[]

  resumes: {
    id: string
    status: ResumeStatus // lifecycle 全可见（archived 不隐藏——AI 需要历史）
    targetJobId?: string
    lineage?: { parent?: string; derivationType: string }
    validation: { status: 'valid' | 'warning' | 'invalid' }
  }[]

  exports: {
    resumeId: string
    format: 'pdf' | 'markdown' | 'html'
    exportedAt: string
  }[]

  // ─── M6.5：Person Intelligence（ADR-009/013——Agent 身份与经历上下文）──

  /** Person 快照（persons/ 扫描）+ active Evidence 经历分类（M6.5：Professional/Independent/Learning） */
  persons: {
    personId: string
    name: string
    identity?: {
      education?: string
      graduationYear?: string
      location?: string
      currentStatus?: string
      yearsExperience?: string
    }
    /** active evidence（owner=person，有 type 分类）——经历全集消费视图 */
    experiences: {
      evidenceId: string
      type: 'professional_experience' | 'independent_project' | 'learning_record'
      title: string
      period?: string
      role?: string
      contribution?: string
    }[]
  }[]

  // ─── M3.5.7：Proposal Feedback Projection（决策反馈——Evolution Evidence）──

  /** 决策历史（已决策提案，decidedAt 降序；pending 不入历史） */
  proposalHistory: {
    proposalId: string
    action: 'accepted' | 'rejected'
    reason?: string // accept_reason / reject_reason 原样（Human Preference Signal，不升级为规则）
    actor: 'user' // 决策仅由用户经 RPC 触发（AI 不能自批）
    at: string
  }[]

  /** 决策统计（引擎确定性派生；不做语义归纳——模式归 AI 消费时推理） */
  proposalInsights: {
    stats: { total: number; accepted: number; rejected: number; acceptRate: number }
    byType: Record<string, { accepted: number; rejected: number }>
    byExpectation: Record<string, { accepted: number; rejected: number }>
    rejectedReasons: string[]
    acceptedReasons: string[]
  }
}
