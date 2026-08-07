/**
 * 统一 IR 契约（引擎 ↔ UI 共享契约源）
 *
 * 引擎端 import 同一份类型定义；UI 用 `import type` 引用（编译期擦除，
 * validator 运行时代码不进前端 bundle）。协议升级只影响 validator 分派，
 * UI 无感知。仅 erasable syntax（Node 24 type-stripping 限制）。
 */

export const ProtocolVersion = '2.8' as const

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

/** 人（角色 = 人，不是岗位）：profiles/{name}.md（旧）→ persons/{person_id}/（M6.5 新真相源） */
export interface Person {
  id: number
  name: string // 展示名（对应 persons/{person_id}/manifest.md name 或 profiles/{name}.md）
  personId?: string // M6.5：引擎 person 稳定标识（person_001）——owner 协议引用键
  color: string
  emoji: string
  matchScore: number
  riskLevel: RiskLevel
  archived: boolean
  profilePath: string
  targetRoles?: string[] // 目标岗位列表（有名目；评估/投递另有挂载点）
  sourceMode?: 'resume' | 'interview' // 初始化通道（M6.5 双通道：简历驱动/访谈驱动——用户意图，非文件状态）
  initialInterest?: string[] // 创建时自报的关注方向（user_reported 意向，非方向决策；语义见 M6.5 initial_interest）
  initStatus?: 'pending' | 'active' // 初始化生命周期状态（Banner 显隐；缺省 = active；session 内部多阶段在引擎资产层）
  skills?: PersonSkill[] // V2 知识层：画像技能声明（`## 技能` 段落，可缺省）
}

// ─── M6.5：Person Intelligence Layer（persons/{person_id}/ 主体资产，ADR-009）──

/**
 * Person 快照（persons/{person_id}/ 投影）：manifest + snapshot/*.md + events/ 计数。
 * 当前状态投影（非可编辑真相源）——来源可包括 Change Events、用户确认输入、
 * 迁移后的历史资产。Snapshot 是事实层；UI 展示 Person 由引擎从快照映射。
 */
export interface PersonSnapshot {
  personId: string // person_001（manifest id）
  name: string // 展示名（manifest name）
  status: string // active / archived（manifest status）
  /** 初始化状态：in_progress=首次采集未完成；completed=已进入正常使用；缺失=旧档案 */
  initState?: 'in_progress' | 'completed'
  /** 初始化通道（manifest source_mode；刷新后恢复通道语义） */
  sourceMode?: 'resume' | 'interview'
  manifestPath: string // persons/{person_id}/manifest.md
  identity?: {
    education?: string
    graduationYear?: string
    location?: string
    currentStatus?: string
    yearsExperience?: string
  }
  careerProfile?: {
    currentRole?: string
    targetRoles?: string[]
    excludedRoles?: string[]
  }
  preference?: {
    salaryRange?: string
    city?: string
  }
  /** M6.6.5：confirmed 技能（snapshot/skill_inventory.md 派生；inferred/learned 不进） */
  skills?: PersonSkill[]
  /** skill_inventory 版本（frontmatter status: vX；Decision inputs.skillRefs.version） */
  skillInventoryVersion?: string
  eventCount: number // events/*.md 计数（Change Events 轻协议）
}

/** 初始化采集 Candidate（切片 2.2：extraction/candidates.md 投影）——Candidate ≠ Fact。
 * 不携带 confidence/score/importance——候选阶段只回答"系统认为这里有一条可能的信息"；
 * epistemic 语义（confirmed/inferred）与确认动作在 Resolution 阶段（切片 2.3）。 */
export interface InitCandidate {
  id: string
  category: 'education' | 'experience' | 'skill' | 'constraint' | 'interest'
  content: string
  source: 'user_reported' | 'resume'
  status: 'pending' | 'confirmed' | 'rejected'
  sessionRef: string
}

/** 决策类型标签（ADR-008 语义降级：不是链上阶段，是 Decision Intelligence 分析类型） */
export type DecisionType = 'direction' | 'city' | 'company' | 'jd' | 'resume'
/** 决策历史分组（决策记录按类型聚合；computeHistory 纯投影，不落盘） */
export interface DecisionHistoryGroup {
  type: DecisionType
  /** 中文展示名（方向探索/城市评估/公司筛选/JD分析/简历定制） */
  label: string
  /** 该类型全部合法决策 id（computeHistory 收集；UI 类型点击 → 该类型决策列表） */
  decisionIds: string[]
  /** 最新合法决策的 direction（非空值合并，部分更新不覆盖） */
  direction?: string
  /** 最新合法决策的 city（非空值合并） */
  city?: string
  /** 最近一条合法决策的 createdAt（无合法决策不输出该组） */
  updatedAt: string
}
export interface DecisionHistory {
  person: string // 决策记录归属人（profile）
  groups: DecisionHistoryGroup[] // 仅含已有决策的类型，按类型固定顺序
}

// ─── V1.5：决策问题绑定与聚合（4.3 定稿；context 文件真相源，聚合运行时组装不落盘）──
// ─── M6.6.3：Decision Status 对齐 Contract v1（Record 生命周期 4 值）——
//      legacy 值（evaluating/decided/reviewing）经 normalizeDecisionStatus 归一化，原始记录不修改 ──

export type DecisionStatus = 'exploring' | 'accepted' | 'rejected' | 'revisiting'

/** 问题绑定（轻量文件 `decision-contexts/{问题}.md`，skill/用户维护，引擎只读解析） */
export interface DecisionContext {
  id: string // 文件名（无 .md）
  person: string
  question: string
  relatedDecisions: string[] // decisions/ 下文件名（不含扩展名）
  status: DecisionStatus
  createdAt: string
}

/** 候选（Contract v1 options[].status 保留——Record 状态不替代候选状态） */
export interface DecisionOption {
  name: string
  status: 'candidate' | 'selected' | 'rejected'
  support: string[]
  gap: string[]
  risk: string[]
  reasons?: string[]
}

/** 分析过程记录（Contract v1 analysis）——confidence 数值/解释分离，不强制模块量化 */
export interface DecisionAnalysis {
  method: string
  confidence?: { level: Confidence; score?: number }
}

/** 人的裁决（Contract v1 user_decision：分析 ≠ 选择；commitment 为 M7 Ledger 预留） */
export interface UserDecision {
  selected: string | null
  rejected: string[]
  deferred: string[]
  commitment?: 'tentative' | 'confirmed' | 'abandoned'
}

/** 聚合视图（引擎运行时组装：Record + Context 派生，不落盘、引擎不自己打分） */
export interface DecisionAggregate {
  context: DecisionContext
  records: DecisionRecord[] // 一个问题的多个方向决策（Options 展开形态）
  options: DecisionOption[]
  factors: { name: string; description: string }[] // 只记概念，不评分
  evidence: { type: string; content: string; source?: string }[]
  analysis?: DecisionAnalysis // Contract: analysis
  unknowns: string[] // Contract: unknowns——系统主动声明不知道什么（不确定性容器）
  conclusion?: { selected: string; confidence: number } // legacy 形态（与 userDecision.selected 同源，UI 兼容保留）
  risks: { description: string; mitigation?: string }[]
  userDecision?: UserDecision // Contract: user_decision（从 options/conclusion 派生）
  /** 复盘记录（`## 复盘` 段落，作者写入；存在时聚合视图展示"已复盘"派生状态） */
  review?: { conclusion: string; date: string }
}

/** 决策输入引用（Contract v1 inputs——对象引用带版本语义，不裸 ID；历史解释不依赖当前最新状态） */
export interface DecisionInputRef {
  id: string
  /** evidence 引用时的生命周期（active/legacy/archived） */
  snapshot?: string
  /** skill_inventory 引用版本（v1/v2…） */
  version?: string
}
export interface DecisionInputs {
  evidenceRefs: DecisionInputRef[]
  skillRefs: DecisionInputRef[]
  constraintRefs: DecisionInputRef[]
  knowledgeRefs: DecisionInputRef[]
}

// ─── M6.6.5：JD Intelligence 结果（Contract v1 对齐形态——options/unknowns/inputs；不产生 user_decision）──

export interface JDIntelligenceOption {
  candidate: string
  status: 'candidate'
  support: string[]
  gap: string[]
  risk: string[]
}
export interface JDIntelligenceResult {
  type: 'jd'
  question: string
  options: JDIntelligenceOption[]
  analysis: { method: string }
  unknowns: string[]
  inputs: DecisionInputs
}

/** 决策记录（14 字段摘要表；profile = 人名，v2.1；M6.6.4 增加 personId/inputs——Person Aggregate 引用非快照） */
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
  /** ADR-013 单身份源（存量无 person_id 时按 profile 人名映射） */
  personId?: string
  /** Contract v1 inputs：本次分析引用的 Person Aggregate 资产（`## 输入引用` 段落） */
  inputs?: DecisionInputs
  /** v2.8：城市评估置信度（摘要表 city_confidence；缺失合法） */
  cityConfidence?: Confidence
  /** v2.8：领域化评估明细（`## 城市评估明细` / `## 方向评估明细` 段落解析）。
   *  通用字段保持扁平（metadata），多值领域数据进 payload——解决多城市/多方向自由字符串协议局限。 */
  payload?: DecisionPayload
}

// ─── V2.8：Decision Payload（业务协议结构化——多值领域数据从摘要表字符串升级为机器可读段落）──

/** 城市评估明细行（`## 城市评估明细` 表格行；得分 X/10 → IR 0-100 归一） */
export interface CityEvaluationRow {
  name: string
  score: number // 0-100（明细表 7.6/10 → 76）
  confidence?: Confidence
  strengths: string[]
  risks: string[]
}
/** 方向评估明细行（`## 方向评估明细` 表格行；匹配度 %） */
export interface DirectionEvaluationRow {
  name: string
  match: number // 0-100
  confidence?: Confidence
  strengths: string[]
  risks: string[]
}
/** 领域化 payload（v2.8 判别联合：type 定领域，行结构随领域） */
export type DecisionPayload =
  | { type: 'city'; direction?: string; cities: CityEvaluationRow[] }
  | { type: 'direction'; directions: DirectionEvaluationRow[] }

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
  owner?: string // M6.5：归属 person_id（persons/{person_id}/，ADR-009 Owner Protocol）
  lifecycle?: 'active' | 'legacy' | 'archived' // ADR-011：legacy=开发期提取/构造（不参与新表达）
  origin?: string // dev_era_extraction / resume_import / self_report / development_fixture
  type?: 'professional_experience' | 'independent_project' | 'learning_record' // M6.5 经历分类
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

// ─── V2.4：CareerClaim（M3：表达 IR 层——"我可以安全表达什么"，从 trusted Evidence 派生）──

/** Claim 认识类型：fact（可逐字映射证据原文）/ interpretation（归纳/评价/抽象提升，不能逐字映射） */
export type ClaimType = 'fact' | 'interpretation'

/** Claim 生成来源（provenance，不代表可信——可信从证据继承，verification = policy） */
export type ClaimSource = 'user_written' | 'agent_generated'

/** provenance 引用粒度：最低 EvidenceItem，不引用自由文本片段；consumedParts 是消费范围声明 */
export interface ClaimProvenance {
  evidenceId: string
  consumedParts?: {
    contribution?: boolean
    dimensions?: string[] // EvidenceDimensionRegistry id
  }
}

/**
 * 表达 IR（M3-0 冻结）：Claim 没有可信度，只有可消费性——canUseClaim 从证据推导，
 * 无 status/verification 字段（不产生双重审核体系）。created_at 是表达资产生成时间，
 * 非事件时间（事件时间在 Evidence.event.period）。
 */
export interface CareerClaim {
  id: string // claim_{YYYYMMDD}_{NNNNN}，引擎登记生成（artifact-registry）
  owner?: string // M6.5：归属 person_id（persons/{person_id}/，ADR-009 Owner Protocol）
  lifecycle?: 'active' | 'legacy' | 'archived' // ADR-011：legacy=开发期表达（基于 legacy evidence）
  created_at: string // ISO 时间戳（表达资产生成时间）
  source: ClaimSource
  statement: string // 可声明的表达
  claimType: ClaimType
  provenance: ClaimProvenance[] // ≥1：Claim 不脱离证据（canUseClaim 空数组恒 false）
}

/** 岗位上下文 Claim Coverage 视图（M3-1 Step 3 UI 第三段数据；引擎派生，不落盘） */
export interface ClaimCoverageRow {
  responsibility: string // JobResponsibility.statement
  evidenceStatus: 'covered' | 'partial' | 'missing' // evidence 层三态（复用 Coverage 引擎）
  matchedItems: string[] // 关联 evidence item id
  claims: { id: string; statement: string; claimType: ClaimType }[] // 引用 matchedItems 的可消费 Claims
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
  /** 别名（业务名/简称——同一主体的其他称呼；Agent 提议、引擎校验登记；消费端 canonical/alias 精确解析，禁止模糊匹配） */
  aliases?: string[]
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

/** 画像技能声明（profiles/{名字}.md `## 技能` 段落 legacy；M6.6.5 起 Person.skills 由 skill_inventory.md 派生） */
export interface PersonSkill {
  name: string
  level: number // 1-5（SFIA 式行为锚点）
  /** skill_inventory 的 skill_id（M6.6.5：Decision inputs.skillRefs 的 provenance 键） */
  skillId?: string
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
