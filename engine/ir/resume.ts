/**
 * ResumeDocument IR（M3-2.1：Assembly 输出前形态，契约 RESUME-ASSEMBLY-M3-v0.2）。
 * - Assembly 只负责"怎么摆"不负责"写什么"：内容全部来自 ExpressionSentence（claimId 必填），
 *   Assembly 禁止修改 Sentence / 新增 Claim / 重新选择 Evidence（契约 §3 内容边界）
 * - bullet 携带 expectation 锚点元数据："为什么这条 bullet 出现在这份简历"可全链回溯
 * - Skills 章节不由 Assembly 创建内容：assetRefs 引用现有资产，Assembly 不编造技能
 */
export type ResumeStatus = 'draft' | 'review' | 'exported' | 'archived'
export type ResumeSectionType = 'summary' | 'experience' | 'projects' | 'skills' | 'education' | 'profile' | 'target_intent'

/** 身份信息条目（M5.2 G6：非 claim 内容——profile/education/experience/target_intent 段的身份事实，Assembly 不校验 claim 锚定） */
export interface ResumeIdentityEntry {
  label?: string // 条目标签（如"University-A | 机械工程"或公司名）
  body?: string // 描述（如职责摘要/定位语）
}

/** bullet 溯源元数据（v0.2 冻结 #1）：选择理由锚点——目标岗位要求 X → 选 Claim Y */
export interface ResumeBulletMeta {
  expectationId?: string // EvidenceExpectation 锚点
  languageFamily?: string // 生成时语言族（mechanical.design 等）
  generatedAt?: string // 生成时间
}

/** 主链 bullet：Sentence 必须来自 Claim（claimId 必填——防"直接写 Resume Sentence"入口） */
export interface ResumeBullet {
  sentence: string
  claimId: string
  metadata?: ResumeBulletMeta
}

/** 经历条目（版本层，Resume Entry Contract v0.2）：事实头 + description（项目概述/职责范围，事实通道）+ bullet（claim 驱动同现行） */
export interface ResumeEntry {
  title: string
  role?: string
  period?: string
  /** 条目描述（v0.2）：项目概述（做什么/解决什么问题）或职责范围概述——事实通道，不校验 claim 锚定 */
  description?: string
  bullets: ResumeBullet[]
}

/** 章节：bullets 为 Claim 驱动内容；assetRefs 为资产引用（Skills 专用——Assembly 不创建技能内容）；
 *  identity 为身份信息（M5.2 G6，非 claim 通道）；entries 为条目化内容（经历段专用，与 bullets 互斥） */
export interface ResumeSection {
  type: ResumeSectionType
  title: string
  bullets: ResumeBullet[]
  entries?: ResumeEntry[]
  assetRefs?: string[] // 资产引用（技能名/资产 id），来源现有资产
  identity?: ResumeIdentityEntry[] // 身份段条目（profile/education/experience/target_intent 专用——不与 claim 混合）
}

/** 一份简历的完整 IR（draft → review → exported → archived 生命周期；status 即 lifecycleStatus，M3-2 冻结名） */
export interface ResumeDocument {
  id: string // 简历版本 id（对齐 UI resumes 版本）
  status: ResumeStatus
  person: string
  /** 显示名（promote 时继承 WorkingCopy.name——用户编辑内容；空 = 回退系统 ID 切片） */
  name?: string
  targetId?: string // M6.3：目标机会实体引用（target_xxx）——Target 是 M6 职业机会实体
  targetJobId?: string // 原始 JD 标识（source_jd_id，M6.3 起降级为输入来源资产，不再直接依赖 jobs/）
  templateId: string // 模板版本化（v0.2 冻结 #5）：换模板可重渲染，PDF 可复现
  templateVersion: string
  sections: ResumeSection[]
  generatedAt: string
  lineage?: ResumeLineage // M3.5：派生链（append-only 历史）
  operations?: ResumeOperation[] // M3.5：生命周期操作审计（append-only）
  validation?: ResumeValidation // M3.5.4：assemble 快照（Context 投影展示；重算需反推 manifest 不可靠）
}

// ─── ADR-023：Working Copy（创作层——用户持续编辑对象，发布前非资产）──

export type WorkingCopyStatus = 'active' | 'ready_for_promote' | 'promoted'

/** 表达块（用户文本 + 可选多源 claim 引用；unbound 合法——provenance 是增强不是负担） */
export interface WorkingBlock {
  id: string
  text: string
  provenanceLinks?: string[] // 多源 claim 引用（一表达多 claim）；Assembly 时映射单主 claimId
  expectationId?: string // 表达锚（P4.1——apply rewrite 时引擎写入：表达对应岗位期望 E；重诊断据此判定表达已写入）
}

/** 经历条目（Resume Entry Contract v0.2）：事实头（title/role/period/description）+ 表述块（claim 通道）。
 *  条目头与描述 = 事实通道（同 identity 语义：不产生 bullet、不校验 claim 锚定） */
export interface WorkingEntry {
  id: string
  title: string // 公司名或项目名
  role?: string // 职位/角色
  period?: string // 时间段（自由文本，如 2023.07-2025.03）
  description?: string // 条目描述（v0.2）：项目概述/职责范围——事实通道，单行序列化
  blocks: WorkingBlock[]
}

/** 段（层级：WorkingCopy → Section → Entry → Block；条目化段（工作经历/项目经验）用 entries，
 *  平铺段（专业摘要/技能）用 blocks——两形态互斥（Resume Entry Contract §1）） */
export interface WorkingSection {
  id: string
  title: string
  blocks: WorkingBlock[]
  entries?: WorkingEntry[]
  /** M5.2 G6 身份事实通道（非 claim）：字段条目（如 姓名/目标职位/年限/城市）——
   *  promote 时映射 ResumeSection.identity，不产生 bullet、不产生 UNBOUND_BLOCK */
  identity?: ResumeIdentityEntry[]
}

/** 段内全部表述块（条目化段 = entries[].blocks；平铺段 = blocks）——引擎按块定位统一走此函数 */
export function blocksOf(s: WorkingSection): WorkingBlock[] {
  return [...(s.entries ?? []).flatMap((e) => e.blocks), ...s.blocks]
}

/** 用户创作对象（resumes/working-copies/；promote → ResumeDocument Candidate） */
export interface WorkingCopy {
  id: string // wc_{YYYYMMDD}_{NNNNN}，引擎登记
  owner: string // person_id
  /** 显示名（用户编辑内容，非系统身份——多副本区分；空 = 回退系统 ID 切片） */
  name?: string
  sections: WorkingSection[]
  targetContext?: { jobId?: string } // 目标岗位/JD 引用（编辑与优化共享）
  status: WorkingCopyStatus
  revision: number // 双写协商（UI/Engine）——local > engine push；engine > local 询问合并
  updatedAt: string
}

// ─── M3.5：Version Management（契约 RESUME-VERSION-M3-v0.2）──

/** 派生链（append-only 历史；sourceResumeIds 为 merge 预留，v0.1 只使用 parent） */
export interface ResumeLineage {
  parentResumeId?: string
  sourceResumeIds?: string[]
  derivationType: 'jd_generate' | 'clone' | 'user_edit' | 'ai_revision'
  createdBy: 'ai' | 'user'
}

/** 生命周期操作审计（append-only；id 可引用——"为什么变 review" → operation_001） */
export interface ResumeOperation {
  id: string
  actor: 'ai' | 'user' | 'system'
  action: 'create' | 'clone' | 'submit_review' | 'export' | 'archive' | 'attempt_change_status' | 'apply_proposal'
  rejected?: boolean // AI 越界尝试被拒时 true
  note?: string // 补充说明（apply_proposal 记录 proposal id——Proposal 双向追溯）
  at: string // ISO
}

/** 简历验证（三态非二值；issues 让 UI 与 AI 都知道"为什么"） */
export type ResumeValidationStatus = 'valid' | 'warning' | 'invalid'
export interface ResumeValidationIssue {
  code: string // CLAIM_NOT_FOUND / CLAIM_NOT_USABLE / CLAIM_NOT_IN_SELECTOR / SKILL_NO_ASSET / OVERRIDE_NOT_USER ...
  message: string
  target: string
}
export interface ResumeValidation {
  status: ResumeValidationStatus
  issues: ResumeValidationIssue[]
}

/** Draft Claim 引用（Mode A 默认 / Mode B 仅 overrideSource=user|proposal 进入——AI 句子是 suggestion 非默认） */
export interface DraftClaimRef {
  claimId: string
  section: ResumeSectionType
  expectationId?: string
  sentenceOverride?: string
  overrideSource?: 'user' | 'ai' | 'proposal' // proposal = 用户已确认的 AI 建议（M3.5.6 Proposal Layer 应用链）
}

/** Draft Manifest（AI 输出层 ≠ 系统 IR：AI 写 Draft，引擎组装 ResumeDocument） */
export interface ResumeDraftManifest {
  id: string // 暂存文件名（无 .md）
  type: 'resume_draft'
  person?: string // 归属人（AI 草稿缺省 ''；Proposal 应用链继承源版本——防组装版本 person 缺失标 invalid）
  targetId?: string // M6.3：目标机会实体（target_xxx）
  targetJobId?: string // 原始 JD 标识（历史；新 manifest 优先 targetId）
  templateId: string
  templateVersion?: string // 缺省 '1.0'
  parentResumeId?: string // clone 派生时
  derivationType?: 'jd_generate' | 'clone' | 'user_edit' | 'ai_revision' // 缺省：parent ? clone : jd_generate（Proposal 应用链显式 ai_revision）
  claims: DraftClaimRef[]
  skills: string[] // asset 引用
  identitySections?: { type: 'profile' | 'education' | 'experience' | 'target_intent'; title: string; entries: ResumeIdentityEntry[] }[] // M5.2 G6：身份信息（非 claim，用户身份事实）
}

// ─── M3-2.3：Export（契约 RESUME-EXPORT-M3-v0.1）──

export type ResumeExportFormat = 'pdf' | 'markdown' | 'html'

/** 导出记录：复现三元组（Document + Template + RendererVersion）+ checksum——"这个 PDF 怎么生成的"可回答 */
export interface ResumeExportRecord {
  id: string // 导出记录 id
  documentId: string // 来源 ResumeDocument
  templateId: string // 复现三元组
  templateVersion: string
  rendererVersion: string // 渲染器版本（基础设施，不进 ResumeDocument）
  format: ResumeExportFormat
  exportedAt: string // ISO
  checksum?: string // 输出文件哈希（可校验产物 = 输入 × 版本）
}

// ─── M3.5.6：Proposal Layer（契约 PROPOSAL-LAYER-M3-v0.1）──

export type ProposalType = 'improve' | 'adapt_jd' | 'replace_sentence'
export type ProposalStatus = 'pending' | 'accepted' | 'rejected'

/** 单条修改建议：oldSentence 必须与源版本 bullet 精确匹配（防幻觉） */
export interface ProposalChange {
  targetClaimId: string
  section: ResumeSectionType
  oldSentence: string
  suggestedSentence: string
  reason: string
  expectationId?: string
  suggestedSource?: 'ai' | 'standard_rule' | 'user' // 建议来源（扩展点；缺省 'ai'）
}

/** AI 建议书：AI 只能写 Proposal，不能写 ResumeDocument（AI Action 闭环） */
export interface ResumeProposal {
  id: string // proposal_YYYYMMDD_NNNNN（引擎登记）
  sourceResumeId: string // 源版本（唯一来源）
  sourceChecksum?: string // 源版本内容快照（引擎登记时计算，accept 时强校验）
  type: ProposalType
  targetJobId?: string // adapt_jd 必填；其余缺省沿用源版本
  changes: ProposalChange[]
  status: ProposalStatus // 引擎管理；AI 写文件只能产生 pending
  validation?: ResumeValidation // 复用 ResumeValidation（三态，不新建类型）
  createdBy: 'ai' // 本层固定：Proposal 是 AI 建议的唯一通道
  createdAt?: string // 引擎登记时间（ISO）
  decidedAt?: string // accept/reject 时间（ISO）
  acceptReason?: string // accepted 可选理由（M3.5.7：Human Preference Signal——"为什么成功"，与 rejectReason 对称）
  rejectReason?: string // rejected 可选原因（用户填）
  resultResumeId?: string // accepted 且已生成新版本后回填（双向追溯）
}
