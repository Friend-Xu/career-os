/**
 * 统一 IR 契约（引擎 ↔ UI 共享契约源）
 *
 * 引擎端 import 同一份类型定义；UI 用 `import type` 引用（编译期擦除，
 * validator 运行时代码不进前端 bundle）。协议升级只影响 validator 分派，
 * UI 无感知。仅 erasable syntax（Node 24 type-stripping 限制）。
 */

export const ProtocolVersion = '2.3' as const

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
export type PoolNodeType = 'person' | 'decision' | 'direction' | 'city' | 'company' | 'role' | 'skill'
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
  skills?: PersonSkill[] // V2 知识层：画像技能声明（`## 技能` 段落，可缺省）
}

/** 决策链状态机（V1）：6 阶段线性链投影视图（decision-runtime 派生，不落盘） */
export type StageId = '方向探索' | '转行评估' | '城市评估' | '公司筛选' | 'JD分析' | '简历定制'
export type StageStatus = 'completed' | 'current' | 'pending' | 'skipped'
export interface PersonStage {
  stage: StageId
  status: StageStatus
  direction?: string
  city?: string
  /** 该阶段全部合法决策 id（computeChain 收集；UI 阶段点击 → 该阶段决策列表） */
  decisionIds?: string[]
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

// ─── V2.1：Evidence Pattern Registry v0（工程族岗位证据词表；引擎单方定义，扩展走 Registry 条目）──

/** 证据维度：岗位需要什么证明方式（Job Intelligence 的 evidenceExpectations 引用） */
export type EvidenceDimension = 'impact' | 'validation' | 'scope' | 'method' | 'adoption'

/** 证据模式（Registry 条目）：维度 + 通用追问模板。岗位特定追问由 Agent 依 responsibility 生成，存 requirement 级 questions。 */
export interface EvidencePattern {
  id: string // 'engineering_validation'（角色族前缀）
  dimension: EvidenceDimension
  question: string // 通用追问模板（展示 fallback / 面试准备）
  applicableRoles: string[] // v0 仅工程族；管理/研究族未来扩展
}

/** v0 注册表（工程族 5 模式，M1 冻结）。运行时数据：引擎解析校验 patternId 用；
 *  UI 如需模板展示可 import（数据极小，bundle 无害）。 */
export const EVIDENCE_PATTERNS_V0: readonly EvidencePattern[] = [
  { id: 'engineering_scope', dimension: 'scope', question: '你负责设计哪些模块？', applicableRoles: ['engineering'] },
  { id: 'engineering_method', dimension: 'method', question: '采用什么设计流程/工具？', applicableRoles: ['engineering'] },
  { id: 'engineering_validation', dimension: 'validation', question: '如何验证设计有效？', applicableRoles: ['engineering'] },
  { id: 'engineering_impact', dimension: 'impact', question: '改善了什么指标？', applicableRoles: ['engineering'] },
  { id: 'engineering_adoption', dimension: 'adoption', question: '方案/成果是否被采纳应用？', applicableRoles: ['engineering'] },
]

// ─── V2.2：Job Intelligence（M1：JD 从文本容器升级为岗位责任单元 + 证据需求）──

/**
 * 岗位责任单元——JD 分析的分析单元是「岗位责任」而非「技能要求」。
 * M1 迁移：旧 requirements[].name 解析映射为 statement（source: user）；AI 分析写回完整责任单元（source: ai）。
 */
export interface JobResponsibility {
  id: string // 'user-1' / 'ai-1'（溯源前缀 + 序号）
  statement: string // 岗位责任："自动化设备结构设计"（旧数据迁移：技能词暂居此位）
  priority: 'must' | 'nice' // 沿用 skill 阶段2 Must/Nice 分级（旧数据默认 must）
  capabilities: string[] // 岗位语言；Signal Layer 对齐源（自由文本 + 可选词表 ID；AI 分析填充）
  /** 岗位需要什么证明（不是用户证据——方向相反，避免提前触发 ADR-003）；patternId 引用 EVIDENCE_PATTERNS_V0 */
  evidenceExpectations: {
    patternId: string
    questions: string[] // 岗位特定追问，Agent 生成（pattern 提供模板）
  }[]
  source: 'user' | 'ai' // 溯源：建档输入 vs AI 分析
  confidence?: Confidence // 解析置信度（AI 条目）
}

/** 岗位（Job）：JD 是一等数据对象——岗位事实，非投递附属文本；jobs/{id}.md 真相源 */
export interface JobRecord {
  id: string
  company: string
  title: string
  location?: string
  salary?: string
  jdSource?: string // JD 来源（URL/粘贴）
  responsibilities: JobResponsibility[] // 岗位责任单元（M1 建档 source=user；AI 分析写回 source=ai）
  /** JD 原文（`## JD 原文` 正文段；卡片展开展示，Agent 后续分析源） */
  jd?: string
  createdAt: string
}

// ─── V2.3：Evidence Inventory（M2：个人证据资产——"我有什么证明"，与 Job/Decision 平行的第三实体）──

/** 证据生命周期（原地演进不追加版本；trusted = 可表达授权，仅 trusted 可被消费者读取） */
export type EvidenceStatus = 'raw' | 'candidate' | 'trusted' | 'archived'

/** 可信度确立方式（trusted 时写入；与 source 两轴：内容从哪来 vs 可信怎么确立） */
export type EvidenceVerificationType = 'user_confirmed' | 'document_supported' | 'imported'

export interface EvidenceVerification {
  type: EvidenceVerificationType
  confirmedAt: string // ISO 时间戳
}

/** 一条证明（一维度可多条："样机测试 + EMC 测试"；未来扩展字段直接加，不破 schema） */
export interface EvidenceValue {
  content: string
}

/** 内容来源（溯源不是证据本身——引用允许腐烂，内容自足） */
export type EvidenceSourceType = 'user_input' | 'resume' | 'document' | 'conversation' | 'decision'

export interface EvidenceSource {
  type: EvidenceSourceType
  locator?: { artifactId?: string; section?: string; offset?: string } // 粗粒度溯源，不精确到行
  capturedAt: string
}

/**
 * 证据维度定义（Registry 条目）：id 是 immutable key（引用键——改名使历史证据全失效）；
 * name/description 可改（version 递增记录演进）；岗位族扩展（软件/产品）走注册 + Benchmark 验证，
 * 内容/软技能（leadership 等）永远不是维度（M1 Freeze 2 纪律）。
 */
export interface EvidenceDimensionDefinition {
  id: string
  name: string
  description: string
  applicableDomains: string[] // v0 仅 engineering
  version: number
}

/** v0 注册表（工程族 5 维，M2 冻结）：与 EvidencePattern.dimension 同源（岗位/个人共用一词表） */
export const EVIDENCE_DIMENSIONS_V0: readonly EvidenceDimensionDefinition[] = [
  { id: 'scope', name: '设计范围', description: '负责/设计的范围与模块', applicableDomains: ['engineering'], version: 1 },
  { id: 'method', name: '方法工具', description: '采用的设计流程/工具/方法', applicableDomains: ['engineering'], version: 1 },
  { id: 'validation', name: '验证方式', description: '如何验证设计/成果有效', applicableDomains: ['engineering'], version: 1 },
  { id: 'impact', name: '结果指标', description: '改善了什么指标/结果', applicableDomains: ['engineering'], version: 1 },
  { id: 'adoption', name: '采纳应用', description: '方案/成果是否被采纳应用', applicableDomains: ['engineering'], version: 1 },
]

/** 个人证据条目（Event 为根；role/contribution 分离——岗位责任与个人贡献语义不同） */
export interface EvidenceItem {
  id: string // evidence_{YYYYMMDD}_{NNNNN}，引擎登记生成（artifact-registry）
  event: {
    title: string // 事件名："减速机壳体结构设计项目"
    context?: string // 背景（可选）
    period?: string // 时间（可选，自由文本）
  }
  role: string // 职责身份："机械结构负责人"
  contribution: string // 实际贡献："负责机架和传动模块设计"（coverage 关联键）
  evidence: Record<string, EvidenceValue[]> // dimensionId → 证明列表（维度 id 引用 EVIDENCE_DIMENSIONS_V0）
  source: EvidenceSource
  verification?: EvidenceVerification // trusted 时写入
  confidence?: Confidence // AI 结构化置信度（raw 未结构化时无）
  status: EvidenceStatus
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
  /** 人数规模（如 "1.5万人" / "1000-5000"；可选，Agent 建档时填写） */
  headcount?: string
}

// ─── V2 知识层：Skill/Role 领域对象（knowledge/*.md 真相源，V3 Capability 复用同一技能词表）──

/** 技能（受控词表叶技能，别名归一化；不建技能树——个人规模扁平词表足够） */
export interface Skill {
  name: string
  aliases: string[] // 别名归一化（LinkedIn Skills Graph 37 万别名归一化的小规模版）
  anchor?: string[] // 熟练度 1-5 级行为锚点（SFIA 式：每级一句行为描述，可缺省）
}

/** 岗位（挂载在公司下；技能需求带必需/可选 + 来源引用） */
export interface Role {
  id: string
  name: string
  company: string
  skills: { name: string; essential: boolean; source: string }[]
}

/** 画像技能声明（profiles/{名字}.md `## 技能` 段落，Open Badges Assertion 简化：{技能, 熟练度}） */
export interface PersonSkill {
  name: string
  level: number // 1-5（SFIA 式行为锚点）
}

/** 差距分析（纯派生视图：目标 Role 技能矩阵 vs 画像技能声明；引擎不自己打分，只做清单） */
export interface SkillGap {
  name: string
  essential: boolean
  source: string // 为什么：Role 需求来源引用（JD/档案片段）
  action: string // 怎么办：模板化补强动作（AI 可细化）
}
export interface GapResult {
  role: Role
  person: string
  satisfied: { name: string; level: number }[] // 声明水平 ≥3（可独立产出）
  transferable: { name: string; level: number }[] // 声明水平 1-2（有基础需补强）
  missing: SkillGap[] // 未声明（需学习）
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
  /** 关联岗位（jobs/{id}.md，M1 起新投递走 Job 实体；旧记录无 jobId 兼容显示 company/position） */
  jobId?: string
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

/** AskUserQuestion 提问卡片（实测 SDK 0.3.220：user 消息的 tool_use_result.questions[] 形状） */
export interface AgentQuestion {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect: boolean
}

/**
 * 引擎 → 前端 Agent 事件（WS agent.event 帧 data；权限事件已换为 requestId——canUseTool
 * promise 留在引擎挂起表；session_id 供前端会话存 resume 凭据；thinking_* 归一化自
 * SDK thinking_tokens 系统消息与 thinking 内容块——思考提示 + 折叠思考块展示）
 */
export type AgentRuntimeEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_done'; name: string }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_stop' }
  | { type: 'permission_request'; tool: string; requestId: string }
  | { type: 'question_request'; question: AgentQuestion }
  | { type: 'session_id'; sessionId: string }
  | { type: 'done'; result: string }
  | { type: 'error'; error: AgentError }

/** 健康投影（HealthReport 契约 v1，docs/contracts/HealthReport-contract-v1.md；CLI --doctor 与 UI 共用单一计算源） */
export interface HealthIssue {
  severity: 'error' | 'warn'
  message: string
  count: number
}
export type DimensionName = 'workspace' | 'decisions' | 'graph' | 'knowledge'
export interface HealthDimension {
  name: DimensionName
  score: number // 0-100
  issues: HealthIssue[]
}
export interface HealthReport {
  overallScore: number // 0-100 = avg(dimensions[].score)
  dimensions: HealthDimension[]
  generatedAt: string
  version: number
}
