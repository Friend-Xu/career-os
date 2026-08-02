/**
 * 统一 IR 契约（引擎 ↔ UI 共享契约源）
 *
 * 引擎端 import 同一份类型定义；UI 用 `import type` 引用（编译期擦除，
 * validator 运行时代码不进前端 bundle）。协议升级只影响 validator 分派，
 * UI 无感知。仅 erasable syntax（Node 24 type-stripping 限制）。
 */

export const ProtocolVersion = '2.1' as const

export type RiskLevel = 'low' | 'medium' | 'high'
export type Confidence = 'high' | 'medium' | 'low'
export type ApplicationStatus =
  | '已评估'
  | '已投递'
  | '已联系'
  | '已回复'
  | '面试中'
  | '已录取'
  | '已拒绝'
export type FollowupUrgency = 'urgent' | 'overdue' | 'waiting' | 'cooled'
export type PoolNodeType = 'person' | 'decision' | 'direction' | 'city' | 'company'
export type EdgeStrength = 'high' | 'medium' | 'low'
export type ChatRole = 'user' | 'assistant' | 'system'
export type ToolCallStatus = 'running' | 'done' | 'error'
export interface ToolCallInfo {
  name: string
  status: ToolCallStatus
}

/** 人（角色 = 人，不是岗位）：profiles/{name}.md */
export interface Person {
  id: number
  name: string // 对应 profiles/{name}.md
  color: string
  emoji: string
  matchScore: number
  riskLevel: RiskLevel
  archived: boolean
  profilePath: string
  targetRoles?: string[] // 目标岗位列表（有名目；评估/投递另有挂载点）
}

/** 决策链状态机（V1）：6 阶段线性链投影视图（decision-runtime 派生，不落盘） */
export type StageId = '方向探索' | '转行评估' | '城市评估' | '公司筛选' | 'JD分析' | '简历定制'
export type StageStatus = 'completed' | 'current' | 'pending' | 'skipped'
export interface PersonStage {
  stage: StageId
  status: StageStatus
  direction?: string
  city?: string
}
export interface DecisionChain {
  person: string // 决策记录归属人（profile）
  stages: PersonStage[] // 6 阶段线性链
  currentStage: StageId
  progressedAt: string // 最近一次推进时间
}

// ─── V1.5：决策问题绑定与聚合（4.3 定稿；context 文件真相源，聚合运行时组装不落盘）──

export type ContextStatus = 'exploring' | 'evaluating' | 'decided' | 'reviewing'

/** 问题绑定（轻量文件 `decision-contexts/{问题}.md`，skill/用户维护，引擎只读解析） */
export interface DecisionContext {
  id: string // 文件名（无 .md）
  person: string
  question: string
  relatedDecisions: string[] // decisions/ 下文件名（不含扩展名）
  status: ContextStatus
  createdAt: string
}

/** 聚合视图（引擎运行时组装：Record + Context 派生，不落盘、引擎不自己打分） */
export interface DecisionAggregate {
  context: DecisionContext
  records: DecisionRecord[] // 一个问题的多个方向决策（Options 展开形态）
  options: { name: string; status: 'candidate' | 'selected' | 'rejected'; reasons?: string[] }[]
  factors: { name: string; description: string }[] // 只记概念，不评分
  evidence: { type: string; content: string; source?: string }[]
  conclusion?: { selected: string; confidence: number }
  risks: { description: string; mitigation?: string }[]
  /** 复盘记录（`## 复盘` 段落，作者写入；存在时聚合视图展示"已复盘"派生状态） */
  review?: { conclusion: string; date: string }
}

/** 决策记录（14 字段摘要表；profile = 人名，v2.1） */
export interface DecisionRecord {
  id: string
  title: string
  skill: string
  direction: string
  directionMatch: number // 0-100
  directionConfidence: Confidence
  city: string
  cityScore: number // 0-100
  salaryFeasible: boolean
  riskLevel: RiskLevel
  keyRisk: string
  status: string
  profile: string
  summary: string
  createdAt: string
  protocolVersion: string
}

/** 公司档案：companies/{name}.md */
export interface CompanyRecord {
  id: string
  name: string
  city: string
  industry: string
  matchScore: number
  riskLevel: RiskLevel
  source: string
  tags: string[]
  contacted: boolean
  parkId?: number
}

/** 画像摘要（Agent 上下文与聚合视图用，来自 profiles/{name}.md） */
export interface ProfileSummary {
  name: string
  profilePath: string
  matchScore?: number
  riskLevel?: RiskLevel
  targetRoles: string[]
  constraints: string[] // 地域/薪资/工作方式约束
}

/** 信息池节点（图谱） */
export interface PoolNode {
  id: string
  label: string
  type: PoolNodeType
  riskLevel?: RiskLevel
  matchScore?: number
  x?: number // 静态坐标（力导向种子）
  y?: number
}

/** 信息池边（图谱） */
export interface PoolEdge {
  id: string
  source: string
  target: string
  relation: string
  strength: EdgeStrength
}

/** 投递记录（按人过滤；position = 岗位名） */
export interface Application {
  id: number
  personId: number
  company: string
  position: string
  sourceDecision?: string
  status: ApplicationStatus
  appliedAt?: string
  followupDue?: string
  urgency: FollowupUrgency
  notes?: string
}

/** 会话（SDK resume 用；messages 只存于运行时，不持久化） */
export interface Session {
  id: string
  title: string
  personId: number
  createdAt: string
  updatedAt: string
  archived: boolean
  messages: ChatMessage[]
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  timestamp: string
  thinking?: string
  reportCard?: DecisionRecord
  toolCalls?: ToolCallInfo[]
}

/**
 * IR 降级标记：validator 输出 { value, validation }——
 * degraded 不崩、invalid 标记待人工；完全合法时不带 validation。
 */
export type ValidationStatus = 'ok' | 'degraded' | 'invalid'
export interface ValidationIssue {
  path: string
  reason: string
  severity: 'warn' | 'error'
}
export interface Validation {
  status: ValidationStatus
  issues: ValidationIssue[]
}

/** Agent 运行错误（契约先行，第 2 步实现） */
export type AgentErrorCode =
  | 'permission_denied'
  | 'tool_failed'
  | 'api_error'
  | 'cancelled'
  | 'timeout'
  | 'unknown'
export interface AgentError {
  code: AgentErrorCode
  message: string
  retryable: boolean
}
