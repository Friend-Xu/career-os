/**
 * 统一 IR 契约（引擎 ↔ UI 共享契约源）
 *
 * 引擎端 import 同一份类型定义；UI 用 `import type` 引用（编译期擦除，
 * validator 运行时代码不进前端 bundle）。协议升级只影响 validator 分派，
 * UI 无感知。仅 erasable syntax（Node 24 type-stripping 限制）。
 */

export const ProtocolVersion = '2.9' as const

export type RiskLevel = 'low' | 'medium' | 'high'
export type Confidence = 'high' | 'medium' | 'low'
/** Application 生命周期 8 态（ADR-019 Decision 4：废弃旧 7 态中文枚举——PREPARING 起，全部状态由用户推进） */
export type ApplicationStatus =
  | 'PREPARING'     // 进入投递准备流程（原 DRAFT——不是「草稿」）
  | 'READY'         // 准备就绪，待提交
  | 'SUBMITTED'     // 用户确认投出（唯一真实投出事件）
  | 'COMMUNICATING' // 公司主动联系 / 用户建立沟通
  | 'INTERVIEWING'  // 进入面试流程
  | 'OFFERED'       // Offer
  | 'REJECTED'      // 结束
  | 'WITHDRAWN'     // 主动停止
/** 跟进投影（派生，不存事实；ADR-019 Decision 9——规则不冻结，v0.1 全 NONE） */
export type FollowUpState = 'NEEDS_ATTENTION' | 'WAITING' | 'NONE'
export type PoolNodeType = 'person' | 'decision' | 'direction' | 'city' | 'company' | 'role' | 'skill'
export type EdgeStrength = 'high' | 'medium' | 'low'
export type ChatRole = 'user' | 'assistant' | 'system'
export type ToolCallStatus = 'running' | 'done' | 'error'

/** 工具证据引用（Tool Evidence Contract v0.1，Phase 3C）：
 *  生产方 = Connector/Session（Engine 侧）——citation/fetchedAt 是系统事实（ADR-030：
 *  Agent 负责判断、Engine 负责事实），Agent 只读不写；UI 审计面渲染。
 *  citation 语义按 source/provider：nbs = 指标 id；exa/web-search = 来源 URL；
 *  period = 数据时间（如「2024年」；检索类无固定时间 → 缺省）。 */
export interface ToolEvidence {
  source: ToolSource
  /** 供应商标识（审计面；如 exa/nbs/hosted） */
  provider?: string
  /** 证据定位（指标 id / 来源 URL） */
  citation: string
  /** 证据获取时刻（ISO；生产方记录——缓存命中时为首次获取时刻） */
  fetchedAt: string
  /** 数据/内容时间（生产方给出；如 NBS 数据年份） */
  period?: string
  /** 生产方解析/来源置信（如 NBS 指标解析置信 0-1；**非事实可信度**——Agent 不产生该值，
   *  禁止任何"模型觉得可信"类评分写入；检索类无 → 缺省） */
  producerConfidence?: number
}

export interface ToolCallInfo {
  name: string
  status: ToolCallStatus
  /** 工具来源（additive 可选；UI 审计面角标用——mcp → 「MCP」标识；认知面不受影响） */
  source?: ToolSource
  /** 证据引用（additive 可选；Tool Evidence Contract——生产方写入，Agent 只读） */
  evidence?: ToolEvidence[]
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
  /** 身份基本信息（identity.md 投影；简历身份字段 seed 来源——User Confirmation 后写入） */
  identity?: PersonIdentity
  skills?: PersonSkill[] // V2 知识层：画像技能声明（`## 技能` 段落，可缺省）
  education?: PersonEducation[] // facts/education.md 登记事实（缺 = 未采集；缺件显式表达见 Person Education Registration Contract）
  /** 偏好事实（preference_constraints.md 投影——意向城市/期望薪资；无 = 未采集）。
   *  与 PersonSnapshot.preference 同形——JD 匹配度城市冲突 FLAG 与画像视图共用此源 */
  preference?: { salaryRange?: string; city?: string }
  /** 工作经历事实（facts/experience.md 派生——简历公司条目头来源；无 = 未采集） */
  experiences?: PersonWorkExperience[]
  /** 优势亮点（snapshot/summary_strengths.md 投影——引用型资产，锚 claims；Person Summary Strength Contract v0.1） */
  summaryStrengths?: SummaryStrength[]
}

/** JD 分析 Proposal（jd/analyze-result RPC 载荷——Agent → Validator，JSON 非 Markdown；
 *  Markdown 是 Artifact 投影。契约：references/jd-analysis-agent-output-contract.md v0.1 冻结） */
export interface JDAnalysisProposalField {
  value: string
  source: string // 原文锚点（JD 段落引用）
  confidence: 'high' | 'medium'
}

/** 约束模式（Freeze Review 补丁，2026-08-07）：exact 明确要求 / related 相关领域需映射
 *  （「机械相关专业」）/ preferred 偏好非门槛（「优先考虑」）/ inferred Agent 推断
 *  （非原文直述）。语义状态标记，不是匹配能力——匹配语义归 Matcher。缺省 = exact。 */
export type ConstraintMatchMode = 'exact' | 'related' | 'preferred' | 'inferred'

/** 匹配状态（四态派生：MATCHED 有证据覆盖 / NOT_MATCHED 明确不满足 / NOT_DECLARED 岗位未要求 /
 *  NEEDS_CONFIRMATION 不确定映射或档案缺件——Unknown ≠ False，Engine 不猜） */
export type MatchStatus = 'MATCHED' | 'NOT_MATCHED' | 'NOT_DECLARED' | 'NEEDS_CONFIRMATION'

/** 岗位门槛投影行（jobs/constraint-match RPC 产物；UI 只投影不解释——dim 文案映射归 UI 渲染层） */
export interface ConstraintMatchRow {
  id: string // 稳定 constraintRef（constraintRefOf 派生：维度 + 原文哈希；Decision Layer 引用不复制）
  dim: 'education' | 'major' | 'experience'
  requirement: string // 门槛值（原文枚举 join）
  person: string // 你的情况（confirmed 事实展示或「未登记」）
  personEvidence: EvidenceRef[] // 证据引用（画像事实回源；空 = 未登记——未声明 ≠ 不具备）
  status: MatchStatus
  note?: string // 状态说明（Engine 只说明缺什么，不做匹配推理外的解释）
}

/** 证据引用（Claim Strength ≤ Evidence Strength——只引用事实 ID 不复制文本；Decision Layer 透传） */
export interface EvidenceRef {
  source: 'skill_inventory' | 'education' | 'experience' | 'identity'
  id: string // skillId / 教育候选 ID / 经历候选 ID / 段落 ID
}

/** 差距行动分类（维度级确定性映射，非职业判断——「岗位偏差/是否值得」归 User 或 Career Ontology 冻结区） */
export type GapActionCategory = 'SKILL_GAP' | 'BACKGROUND_RISK' | 'POLICY_UNDEFINED'

/** 决策问题（status × dim 固定模板派生，禁止 Agent 生成——契约 career-decision-loop-contract-v0.1 §5） */
export interface DecisionQuestion {
  type: 'CONFIRM_CAPABILITY' | 'CONFIRM_BACKGROUND' | 'CONFIRM_EXPERIENCE'
  targetId: string // = constraintRef
  template: string // 确定性模板填充
}

/** 差距行（引用上游匹配行，不复制事实——契约 career-decision-loop-contract-v0.1 §4） */
export interface GapRow {
  constraintRef: string
  actionCategory: GapActionCategory
  question?: DecisionQuestion // NOT_MATCHED 事实明确 → 无确认问题
}

/** 决策候选（Engine 投影，RPC jobs/decision-draft 产物——Producer = Engine，Agent 不可改写回写） */
export interface DecisionCandidate {
  jobId: string
  gaps: GapRow[]
}

// ─── Career Decision Loop v0.1 Step 4：Resume Rewrite Context（适配层）──

/** 差距引用（简历改写上下文——传 dimension/requirement/status/evidence，禁止「缺少经验」类自由文本判断） */
export interface GapReference {
  dimension: 'capability' | 'education' | 'major' | 'experience'
  requirement: string
  status: MatchStatus
  evidence: EvidenceRef[] // 画像证据（空 = 未声明——不代表不具备）
}

/** AI 参考叙述（决策记录叙述段；不构成系统事实） */
export interface AIReference {
  section: 'understanding' | 'preparationPlan' | 'resumeAdvice'
  content: string
}

/** Resume Rewrite Context（Engine 投影——resume-writing 只消费此结构，不解析 decisions/ markdown） */
export interface ResumeRewriteContext {
  jobId: string
  confirmedGaps: GapReference[]
  evidenceHighlights: EvidenceRef[]
  preparationNotes: AIReference[]
}

export interface JDAnalysisConstraintProposal {
  values: string[] // 原文枚举
  source: string
  confidence: 'high' | 'medium'
  matchMode?: ConstraintMatchMode
}

export interface JDAnalysisCapabilityProposal {
  responsibility: string
  priority: 'must' | 'nice'
  category: 'hard' | 'soft' | 'preference'
  capabilities: string[]
  evidencePatterns: string[] // 固定词表（scope/method/validation/impact/adoption）
  questions: string[]
}

export interface JDAnalysisProposal {
  jobId: string
  artifactVersion: 2
  context: {
    workMode?: JDAnalysisProposalField[]
    careerPath?: JDAnalysisProposalField[]
    industry?: JDAnalysisProposalField[]
  }
  constraints: {
    education?: JDAnalysisConstraintProposal
    major?: JDAnalysisConstraintProposal
    experience?: JDAnalysisConstraintProposal
  }
  capabilities: JDAnalysisCapabilityProposal[]
  generatedAt: string
}

/** JD 分析 Proposal 校验结果（契约 v0.1：reject = 不写入 Artifact；warn = 写入但记录）。
 *  Producer = Validator（runtime/jd-analysis-validator.ts 实现），schema 持有契约定义。 */
export interface JDAnalysisValidationIssue {
  path: string
  reason: string
  severity: 'reject' | 'warn'
}

// ─── Company Research Proposal（company-file-contract：Agent 结构化结论 → Engine 校验落盘）──

/** 尽调摘要表字段（company-file-contract §字段与值格式——引擎严格校验） */
export interface CompanyResearchSummaryProposal {
  city?: string
  industry?: string
  matchScore?: string
  riskLevel?: string
  source?: string
  tags?: string
  contacted?: '是' | '否'
  aliases?: string
}

/** 公司事实行（Company Intelligence v0.1：类型 ∈ 7 枚举；value ∈ 评估契约 §4 规则表 value 枚举） */
export interface CompanyFactProposal {
  type: string
  value: string
  source: string
  url?: string
}

/** 公司尽调 Proposal（同 JDAnalysisProposal 模式：Agent 只提交候选，Engine 校验后写档）。
 *  detail = 尽调详情正文（## 尽调详情 段）；facts = 公司事实段（§4 枚举，枚举外不计分）。 */
export interface CompanyResearchProposal {
  companyId: string
  artifactVersion: 2
  summary: CompanyResearchSummaryProposal
  detail?: string
  facts?: CompanyFactProposal[]
  generatedAt: string
}

/** 公司尽调 Proposal 校验结果（同 JDAnalysisValidationIssue：reject = 不写入；warn = 写入但记录） */
export interface CompanyResearchValidationIssue {
  path: string
  reason: string
  severity: 'reject' | 'warn'
}

// ─── M6.5：Person Intelligence Layer（persons/{person_id}/ 主体资产，ADR-009）──

/** 身份基本信息（identity.md 基本信息表投影——用户确认事实；简历身份字段 seed 来源） */
export interface PersonIdentity {
  education?: string
  graduationYear?: string
  location?: string
  currentStatus?: string
  yearsExperience?: string
}

/** 工作经历事实（persons/{pid}/facts/experience.md 派生——Registration Owner = Engine；
 *  简历公司条目头 Candidate；无文件 = 未采集。契约：
 *  references/person-experience-registration-contract.md） */
export interface PersonWorkExperience {
  company: string
  role?: string
  start?: string
  end?: string
  candidateId?: string // 候选溯源（candidates.md 条目 id）
  status: 'pending' | 'confirmed' | 'rejected' // 复用 candidates 状态
}

/**
 * Person 初始化生命周期状态（PR-2/P0-1 状态机，manifest init_state）：
 * uploading=创建/资料上传 → extracting=提取文本就绪/事实提取 → candidate_review=候选确认中 →
 * confirmed=候选已全部裁决 → completed=快照齐备可进入正常使用；
 * in_progress 仅兼容旧档案（历史单态），新档案不再写入。
 */
export type PersonInitState =
  | 'uploading'
  | 'extracting'
  | 'candidate_review'
  | 'confirmed'
  | 'completed'
  | 'in_progress'

/**
 * Person 快照（persons/{person_id}/ 投影）：manifest + snapshot/*.md + events/ 计数。
 * 当前状态投影（非可编辑真相源）——来源可包括 Change Events、用户确认输入、
 * 迁移后的历史资产。Snapshot 是事实层；UI 展示 Person 由引擎从快照映射。
 */
export interface PersonSnapshot {
  personId: string // person_001（manifest id）
  name: string // 展示名（manifest name）
  status: string // active / archived（manifest status）
  /** 初始化状态机（见 PersonInitState；缺失=旧档案） */
  initState?: PersonInitState
  /** 初始化通道（manifest source_mode；刷新后恢复通道语义） */
  sourceMode?: 'resume' | 'interview'
  manifestPath: string // persons/{person_id}/manifest.md
  identity?: PersonIdentity
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
  /** education 事实（facts/education.md 派生；无 = 未采集——缺件语义，缺件显式表达见
   *  Person Education Registration Contract §6） */
  education?: PersonEducation[]
  /** skill_inventory 版本（frontmatter status: vX；Decision inputs.skillRefs.version） */
  skillInventoryVersion?: string
  /** 工作经历事实（facts/experience.md 派生——简历公司条目头来源） */
  experiences?: PersonWorkExperience[]
  /** 优势亮点（snapshot/summary_strengths.md 派生——引用型资产：锚 claims，不复制事实；
   *  Person Summary Strength Contract v0.1） */
  summaryStrengths?: SummaryStrength[]
  eventCount: number // events/*.md 计数（Change Events 轻协议）
}

/** 优势亮点条目（引用型 profile 资产：结论句 + 支撑引用数组——claimIds 经历型 + evidenceIds 技能/奖项型；
 *  双空 = 软性条目（降级标注）。Person Summary Strength Contract v0.2） */
export interface SummaryStrength {
  text: string
  claimIds: string[]
  evidenceIds: string[]
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
  /** 结构化载荷（提取端 proposal；candidates.md 通用 payload 列；education 类目 = 键值段
   *  `学校=…；专业=…；学历=…；起=…；止=…`；experience 类目 = `公司=…；岗位=…；起=…；止=…`；
   *  其余类目暂空） */
  payload?: string
  /** education 类目候选的结构化解析（listCandidates 派生；其余类目无） */
  education?: { school: string; major?: string; degree?: string; startYear?: number; endYear?: number }
  /** experience 类目候选的结构化解析（listCandidates 派生；其余类目无） */
  experience?: { company: string; role?: string; start?: string; end?: string }
}

/** Stage Artifact 生命周期投影（契约 Career-Workflow-Contract-v0.2 §1.2）——
 *  引擎↔UI 共享类型。身份/状态由引擎登记、用户裁决流转（终态不可逆）；Agent 只提案、不持有身份。
 *  stage_id/workflow_id 用 string（ir 不依赖 storage 层 StageId，保持依赖方向单向）。 */
export type StageArtifactState = 'registered' | 'confirmed' | 'rejected'

export interface StageArtifact {
  artifact_type: string
  artifact_id: string
  workflow_id: string
  stage_id: string
  person_id: string
  state: StageArtifactState
  evidence_refs: string[]
  version: number
  registered_by: 'engine'
  /** 裁决时间/裁决人（confirmed 与 rejected 共用「裁决」语义，引擎写盘） */
  confirmed_at?: string
  confirmed_by?: 'user'
  /** 提案暂存文件名（登记时快照，审计溯源） */
  source_file?: string
  created_at?: string
  /** 主张摘要（marker 段后首个非空段落，UI 投影用） */
  claim?: string
}

/** Person 教育事实（persons/{pid}/facts/education.md 派生；Registration Owner = Engine——
 *  candidate resolve 确认时登记；无文件 = 未采集（缺件语义，与「无教育」区分）。契约：
 *  references/person-education-registration-contract.md */
export interface PersonEducation {
  school: string
  major?: string
  degree: string // 归一化枚举：高中/大专/本科/硕士/博士
  startYear?: number
  graduationYear?: number
  status: 'pending' | 'confirmed' | 'rejected' // 复用 candidates 状态
  source: 'user_reported' | 'resume'
  candidateId?: string
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
  /** subject_id frontmatter（系统身份字段）：jd-analysis 决策关联的岗位 ID——Engine Registration 写入，
   *  身份关联不靠标题解析（存量旧记录无此字段，缺失合法） */
  subjectId?: string
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

// ─── Promotion Event（ADR-032 Decision Promotion Flow——Accepted 冻结，v0.4.2 补充）───

/**
 * Promotion = 「用户从 Decision Artifact 选定候选」的领域事件。
 * - 唯一触发者 user（actor 引擎硬编码；Agent Tool Call 禁止创建——Promotion RPC 不在 Agent 协议白名单）
 * - candidateId Authority：候选 id 由引擎从 Decision 派生（city:{城市名}），客户端不可输入（防伪造）
 * - revoke = 状态翻转（active→revoked），不删除历史（History immutable；投影只消费 active）
 * - 投影取值见 Authority Resolution Order：active Promotion（用户确认事实）> Candidate Payload（候选事实）
 *   > Decision/AI 建议（永不自动成为事实）
 */
export type PromotionType = 'city_choice'
export type PromotionStatus = 'active' | 'revoked'
export interface PromotionEvent {
  id: string // promo_001（引擎登记，系统身份）
  decisionId: string // 决策 id（DecisionRecord.id）
  candidateId: string // 决策内候选稳定 id（city:{城市名}——引擎派生）
  type: PromotionType
  actor: 'user'
  target: { personId: string; domain: 'preference.city' }
  status: PromotionStatus
  provenance: { confirmedAt: string }
  revokedAt?: string
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
  /** v2 能力分级（岗位智能段 Category 列，6 列格式）：hard 进匹配 / soft·preference 仅证据
   *  引导——消费语义见 Capability Matching Boundary（jd-constraint-match-contract v0.2） */
  category?: 'hard' | 'soft' | 'preference'
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

// ─── M6：Target 机会资产（targets/{target_id}/target.md 真相源，engine 只读解析不写）──

/** 目标机会记录（TargetRecord）：targets/{target_id}/target.md 的 frontmatter + 正文 focus/exclude。
 *  - id/companyId 必填（frontmatter id/company_id）；缺失 → invalid
 *  - candidatePerson/currentJdPath/createdAt/contextStatus 缺省空串（可选语义字段缺失填 - 属常态）
 *  - researchScopeStatus 值域 draft/confirmed，非法值 → degraded warn（保留原值展示）
 *  - companionFiles = 同目录存在的伴生资产文件名（确定性列举，不复制文件内容） */
export interface TargetRecord {
  id: string
  companyId: string
  candidatePerson: string
  /** 原始 JD 引用（frontmatter original_jd_id；断链填 - → 缺省，不在 IR 保留占位） */
  originalJdId?: string
  currentJdPath: string
  createdAt: string
  /** 上下文就绪度复合值（company=ready|product=ready|... 原样保留，引擎不解释） */
  contextStatus: string
  researchScopeId?: string
  researchScopeStatus?: 'draft' | 'confirmed'
  role?: string
  focus: string[]
  exclude: string[]
  companionFiles: string[]
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
  /** Resume Entry Contract v0.2 Option A：identity.md 工作经历行引用（自然键 = 公司名+入职时间）——
   *  公司/职位/时间单一真相源；引擎投影校验 event.period 与行 period 一致（错位可检测） */
  workRowRef?: { company: string; start: string }
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
  /** 尽调评级回链（Company-Leaderboard-Contract-v0.1 §2.2）：tier = 榜单排序因子；caveat = 保留条件（升档前置条件展示）。可选字段——未尽调公司无评级（缺席是常态，非异常） */
  ratingTier?: 'recommend' | 'consider' | 'cautious'
  ratingCaveat?: string
  /** 职业价值评估（Projection Artifact——transport 层附加，不写回 markdown；无 `## 公司事实` 段 → null，未评估 ≠ 0 分） */
  assessment?: CompanyAssessment | null
}

// ─── 公司适配榜数据层（Company-Leaderboard-Contract-v0.1）──

/** 候选池条目（company-pool/{name}.md）：screener 捕捉、未尽调的候选公司。
 *  信号/对口星 = Agent 检索+打分（AI 推理）；id/锚定名/captured_at = Engine 登记。 */
export interface CandidatePoolEntry {
  id: string // candidate_{date}_{seq}（Engine 生成；同公司重写保留原 id）
  name: string // canonical 锚定名（文件名——实体锚定铁律，禁止简称自补全）
  city: string
  industry: string[] // 行业桶，可多值
  signals: { tag: string; source: string; date?: string }[] // 资质/融资/招聘信号，每条带来源
  fitStars: number // 1-5（screener ★对口，仅候选段排序，不进入主排序）
  source: string // screener 报告链接
  capturedAt: string
}

/** 岗位线索（job-leads/{company}.md）：company-jobs 检索的外部事实（带来源+日期）。
 *  线索 ≠ 已递交 JD（jobs/ 才是递交真相源）；expiresAt = capturedAt + 14 天（Engine 派生，不落盘）。 */
export interface JobLead {
  id: string // lead_{capturedAt}_{seq}（Engine 按文件行序派生，UI key 用，无外部引用）
  company: string // canonical 锚定名（文件名）
  title: string
  salary?: string
  city?: string
  url: string
  source: '官网' | '招聘平台' | '其他'
  capturedAt: string
  expiresAt: string
  fraudFlags: string[] // 求职诈骗信号（收费内推/保offer/培训贷等；提示不否决）
}

// ─── 二期：薪资基准知识层（Company-Leaderboard-Contract-v0.1 §7.2）──

/** 经验档位枚举（Engine 定义；来源表述「3-5年」「不限」由 Engine parseExpTier 归一） */
export type SalaryExpTier = '0-2' | '3-5' | '6-10' | '10+' | 'any'

/** 薪资基准条目（knowledge/薪资基准-{城市}-{岗位}-{档位}.md，样本点模式 §7.2.1）。
 *  条目 = 单来源快照（Agent 检索登记）；分位不落盘，由 engine/ir/salary.ts 聚合。
 *  expiresAt = capturedAt + 90 天（Engine 派生，过期照显标「数据较旧」）。 */
export interface SalaryBenchmarkEntry {
  id: string // benchmark_{capturedAt}_{seq}（Engine 按文件行序派生；跨组 key 用 ${id}:${role}:${city}）
  role: string
  city: string
  expTier: SalaryExpTier
  salary?: number // 月薪 K（税前）；单点
  salaryRange?: { min: number; max: number } // 月薪区间；salary/salaryRange 至少其一
  sampleN?: number // 来源样本量；缺省聚合按 1 计
  source: string // 来源链接
  note?: string // 原始口径备注（年薪来源换算月薪后登记）
  capturedAt: string
  expiresAt: string
}

// ─── Company Intelligence Layer v0.1：公司事实 → 职业价值评分（契约 references/company-assessment-contract-v0.1.md）──

export type CompanyFactType =
  | 'CERTIFICATION'   // 企业资质
  | 'FINANCING'       // 融资
  | 'PATENT'          // 专利/技术壁垒
  | 'INDUSTRY_STATUS' // 行业地位
  | 'GROWTH'          // 成长性（营收/团队）
  | 'OPPORTUNITY'     // 职业机会（招聘活跃/岗位）
  | 'RISK'            // 风险（经营异常/诉讼/失信）

export type CompanyDimension = 'credibility' | 'growth' | 'technology' | 'opportunity' | 'stability'

/** 公司事实（Layer 1，Agent 采集）：id = 稳定引用（同 constraintRef 模式）；value 枚举值域见契约 §4 */
export interface CompanyFact {
  id: string
  type: CompanyFactType
  value: string
  evidence: { source: string; url?: string }
  collectedAt?: string
}

export type AssessmentStatus = 'EVALUATED' | 'PARTIAL' | 'INSUFFICIENT_DATA'

/** 参与计分的信号（Group 去重后）：points = 维度贡献（引用 factId，不复制事实） */
export interface CompanySignal {
  factId: string
  factType: CompanyFactType
  value: string
  points: Partial<Record<CompanyDimension, number>>
  evidence: { source: string; url?: string }
}

/** 职业价值评估（Layer 3，Engine 确定性派生；version/ruleVersion/assessedAt = 「为什么去年 85 现在 78」的可审计锚点） */
export interface CompanyAssessment {
  version: 'v0.1'
  ruleVersion: string
  assessedAt: string
  status: AssessmentStatus
  qualityScore: number | null   // INSUFFICIENT_DATA → null（未知 ≠ 中等）
  dimensions: Record<CompanyDimension, number>
  signals: CompanySignal[]
  degradedFacts: { factId: string; value: string; reason: 'NO_EVIDENCE' | 'UNKNOWN_VALUE' }[]
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
  /** 声明侧别名（Skill Representation v0.1 契约形态；v0.1 无数据源，来源登记后续，消费端已支持） */
  aliases?: string[]
  /** 工具词（注册时 Engine 从 name 括号确定性派生：「电气制图与接线设计（SolidWorks/Creo/AutoCAD）」→ SolidWorks/Creo/AutoCAD） */
  tools?: string[]
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
  satisfied: { name: string; level: number; via?: string }[] // 声明水平 ≥3（可独立产出）；via = 命中键（工具词/别名，UI 显示来源）
  transferable: { name: string; level: number; via?: string }[] // 声明水平 1-2（有基础需补强）
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
/**
 * 投递行动记录（ADR-019 + Application Contract v0.1：用户行动事实，Engine Registration）。
 * - 不拥有职业判断：禁止 matchScore/reason/gaps（属 Decision）——核心不变量
 * - 岗位信息只引用 jobId，不复制；displayFallback 仅 Job 删除后历史展示用
 * - Producer：User 创建/推进，Engine 登记 id/时间戳，Agent 禁止
 */
export interface ApplicationRecord {
  id: string // application_{YYYYMMDD}_{NNNNN}（Engine Registration，Agent/UI 不写）
  personId: string // 归属 person_id（person_001，按人过滤）
  jobId: string // Job Reference（必填——Application 是岗位的行动记录）
  decisionId?: string // Decision Reference（可选——从决策发起时挂）
  status: ApplicationStatus
  createdAt: string // 用户「开始投递流程」事件时间（Engine 登记，ISO）
  submittedAt?: string // SUBMITTED 事件时间（用户确认投出时登记，ISO）
  displayFallback?: ApplicationDisplayFallback // 投出时登记——仅 Job 删除后展示，不构成 Job 数据副本
  notes?: string // 用户备注（自由文本）
}

/** 投递记录视图（RPC 响应投影——allowedTransitions = 状态机合法推进选项，UI 状态推进下拉的数据源） */
export interface ApplicationView extends ApplicationRecord {
  allowedTransitions: ApplicationStatus[]
}

/** 历史展示 fallback（ADR-019 Decision 7：允许 title/company，禁止 constraints/matchScore/analysis） */
export interface ApplicationDisplayFallback {
  company: string
  position: string
}

/** 创建请求（Contract §7：createdBy 恒为 'user'——Agent 禁止创建） */
export interface CreateApplicationRequest {
  jobId: string
  decisionId?: string
  personId: string
}

/** 会话（SDK resume 用；messages 只存于运行时，不持久化）
 *  personId 语义（2026-08-23 修复：会话归属漂移）：
 *  - 引擎 personId（person_001 稳定标识）——正常归属
 *  - `ui:{id}` —— UI 本地 Person 尚未落盘引擎的占位归属（落盘后由 setPersonPersonId 迁移为真 personId）
 *  - `unassigned` —— 存量迁移时无法可靠考证归属（显式未知，禁止静默错挂） */
export interface Session {
  id: string
  title: string
  personId: string
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

/** 工具来源（Tool Runtime 第二阶段）：运行时治理概念（trace/permission/budget/audit），
 *  不进 prompt、不进工具描述——Agent 认知层只见能力动词；协议与供应商标识只存在于审计面。 */
export type ToolSource = 'builtin' | 'hosted' | 'mcp' | 'data'

/**
 * 引擎 → 前端 Agent 事件（WS agent.event 帧 data；权限事件已换为 requestId——canUseTool
 * promise 留在引擎挂起表；session_id 供前端会话存 resume 凭据；thinking_* 归一化自
 * SDK thinking_tokens 系统消息与 thinking 内容块——思考提示 + 折叠思考块展示）
 * tool_start/tool_done 的 source = 工具来源，tool_done 的 evidence = 证据引用
 * （均 additive 可选，v2.9 存量事件无此字段仍合法；evidence 生产方写入——Tool Evidence Contract）
 */
/** Evidence Sufficiency 声明校验摘要（ADR-035——done 事件 additive 载荷：company_research
 * 完成时携带；维度/状态值域见 evidence-sufficiency-contract-v0.1；本类型只承载投影形状，校验逻辑在
 * runtime/evidence-sufficiency-validator.ts（ir 不反向依赖 runtime——单向依赖纪律）） */
export interface SufficiencyValidationSummary {
  valid: boolean
  issues: string[]
  state: string
  nextAction: string
}

export type AgentRuntimeEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string; source?: ToolSource }
  | { type: 'tool_done'; name: string; source?: ToolSource; evidence?: ToolEvidence[] }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_stop' }
  | { type: 'permission_request'; tool: string; requestId: string }
  | { type: 'question_request'; question: AgentQuestion }
  | { type: 'session_id'; sessionId: string }
  | { type: 'done'; result: string; sufficiency?: SufficiencyValidationSummary }
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

/** Person Health（ADR-031 Person Projection Health Boundary——Accepted 冻结，2026-08-22）。
 *  单一计算源：UI/Agent/CI 一律经 personHealth()/`person/health` RPC 判定，
 *  禁止消费端各自发明健康逻辑。纯读派生零写入（Health 永不自动修复）。
 *  **verdict 不代表数据正确性，仅代表系统一致性**——healthy = 事实-投影-事件链路自洽，
 *  不隐含「职业建议正确」（职业选择正确性属 Human Authority，不在 Health 判定域）。 */
export interface PersonHealthCheck {
  id: string // 稳定 id（H1-identity.md-missing / H2-pref-nokeys / H3-skill_inventory.md / H4-role-xxx）
  type: 'H1' | 'H2' | 'H3' | 'H4'
  severity: 'error' | 'warn'
  message: string
  /** 检查引用的资产侧（ADR-031：H2 联合信息——如 ["promotion:promo_001", "projection:preference.city"]） */
  refs?: string[]
}
export interface PersonHealth {
  personId: string
  name: string
  verdict: 'healthy' | 'warning' | 'error'
  checks: PersonHealthCheck[]
  summary: string
}

/** 工具指标投影（Phase 4B ToolStats 统一指标板：logs/traces 聚合，纯读派生不落盘。
 *  只输出计数/耗时聚合与时间戳——trace 文件含任务原文，RPC 永不回传查询内容（隐私红线）。
 *  聚合源：tool-*.jsonl（工具级审计事件，含 source/provider/durationMs）+
 *  会话命名空间 trace（web_search/nbs/nbs_profile/exa：cache_hit/budget_exhausted/fallback/http_call）。 */
export interface ToolStatEntry {
  /** 工具名（认知层名，如 QueryMacroStats/WebSearch/Read） */
  name: string
  source: ToolSource
  /** 供应商标识（审计面；builtin 无） */
  provider?: string
  /** 执行次数（tool_done + tool_error） */
  calls: number
  /** 失败次数（tool_error） */
  errors: number
  /** 平均耗时（ms；无样本 → null） */
  avgDurationMs: number | null
  /** 最大耗时（ms；无样本 → null） */
  maxDurationMs: number | null
}

export interface ToolStats {
  /** 按工具（trace 出现序；无 trace → []） */
  byTool: ToolStatEntry[]
  /** 按来源（builtin/hosted/mcp/data 汇总；无 trace → []） */
  bySource: { source: ToolSource; calls: number; errors: number; avgDurationMs: number | null }[]
  /** 外部 HTTP 调用次数（Provider Stability http_call；v0.1 起落盘） */
  externalCalls: number
  /** 缓存命中（会话级：web_search/nbs/nbs_profile/exa cache_hit） */
  cacheHits: number
  /** 预算用尽（会话级 budget_exhausted） */
  budgetExhausted: number
  /** WebSearch 守卫降级（fallback） */
  fallbacks: number
  /** 最早 trace 时间（ISO）；无 trace → null */
  since: string | null
  /** 最晚 trace 时间（ISO）；无 trace → null */
  lastAt: string | null
}
