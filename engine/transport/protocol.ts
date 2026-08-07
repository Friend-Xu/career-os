/**
 * 桥协议契约（WS，端口 5289）：RPC（request/response）+ 单向事件。
 * 消息均为 JSON 文本帧。契约先行——服务端与前端客户端各自按此实现。
 *
 * 事件驱动架构核心决策：事件是通知，状态是可拉的资源——数据变更发事件信号，
 * 客户端需要全量数据时主动 RPC 拉取；事件丢失由快照拉取兜底。
 */
import { ProtocolVersion } from '../ir/schema.ts'

/** 客户端 → 服务端：RPC 请求 */
export interface RpcRequest {
  id: string
  method: string
  params?: unknown
}

/** 服务端 → 客户端：RPC 响应（error 时 result 缺省） */
export interface RpcResponse {
  id: string
  result?: unknown
  error?: { code: string; message: string }
}

/** 服务端 → 客户端：单向事件（数据变更信号）；agent.event 帧带 taskId 标识任务归属 */
export interface ServerEvent {
  event: string
  taskId?: string
  data?: unknown
}

export const METHODS = {
  /** 握手：返回协议/版本/工作区路径 */
  init: 'system/init',
  /** 全量决策记录（含 validation 标记） */
  listDecisions: 'decisions/list',
  /** 触发一次全量重扫描（md → IR） */
  rescan: 'decisions/rescan',
  /** 局部修改决策记录（params: { id, fields } → 更新摘要表字段 → 写回 md → watcher 自动重扫广播；字段白名单见 decision-editor.UPDATEABLE_FIELDS） */
  updateDecision: 'decisions/update',
  /** 决策历史投影（按人分组的 computeHistory 派生视图，按类型分组无推进语义） */
  decisionHistory: 'decision/history',
  /** 决策聚合视图（V1.5：DecisionContext 问题绑定 + 运行时组装，不落盘） */
  contexts: 'contexts/list',
  /** 知识层（V2）：技能词表 + 岗位清单（Skill[] + Role[]，图谱节点派生） */
  knowledgeGraph: 'knowledge/graph',
  /** 差距分析（V2）：params { person, roleId } → GapResult（满足/可迁移/缺失清单，纯派生不打分） */
  knowledgeGap: 'knowledge/gap',
  /** JD 分析（M6.6.5 Contract 样板）：params { jobId, personId } → JDIntelligenceResult（options/unknowns/inputs，不产生 user_decision） */
  jdAnalyze: 'jd/analyze',
  /** JD 分析 Proposal 提交（契约 v0.1 冻结）：params JDAnalysisProposal → { issues, written, skipped }；
   *  Agent 经此通道提交分析结果（JSON），写入 jobs/{id}.md 的写入所有权归 Engine，Agent 无 Artifact 写权限 */
  jdAnalyzeResult: 'jd/analyze-result',
  /** 公司档案列表（完整 CompanyRecord，含 validation 标记） */
  listCompanies: 'companies/list',
  /** 单个公司档案全文（params: { id } → { id, markdown }；尽调详情正文渲染用） */
  companyGet: 'companies/get',
  /** 单个决策全文（params: { id } → { id, markdown }；评估详情抽屉渲染用，含明细段落/打分依据） */
  decisionGet: 'decisions/get',
  /** 人列表（投影） */
  listPersons: 'persons/list',
  /** 创建 Person + Initialization Session（切片 2.1：params { name, sourceMode } → { personId, sessionId }；生成 manifest.md + intake/session-001.md） */
  createPersonSession: 'person/session/create',
  /** 追加对话轮次到 intake/session-001.md（params { personId, role, content, timestamp? }；原始对话记录非事实层） */
  appendSessionTurn: 'person/session/append',
  /** 追加候选批次到 extraction/candidates.md（切片 2.2：params { personId, candidates[] } → InitCandidate[]；Candidate ≠ Fact） */
  appendCandidates: 'person/session/candidates',
  /** 候选列表（params { personId } → InitCandidate[]；extraction/ 缺失 → 空） */
  listCandidates: 'person/candidates/list',
  /** 候选裁决（切片 2.3：params { personId, candidateId, action, modifiedContent? } → { candidateId, action, status }；更新 candidates.md + 写 resolution 事件） */
  resolveCandidate: 'person/candidates/resolve',
  /** 重置初始化（Person 生命周期 v0.1：params { personId } → { personId }；清 intake/extraction/events/snapshot，manifest 保留，init_state 重置 in_progress） */
  resetPerson: 'person/reset',
  /** 完成初始化（用户声明基础信息达到可用状态，非封闭：params { personId } → { personId, initState: 'completed' }；manifest init_state → completed） */
  completePersonInit: 'person/session/complete',
  /** 物理删除 Person（dev/测试清理：params { personId } → { personId }；persons/{id}/ 整目录移除，不可恢复） */
  deletePerson: 'person/delete',
  /** PDF 提取（Document Ingestion：params { pdfBase64 } → ExtractionResult { status, method, text, error? }；文本层 → 渲染+视觉，失败建模为状态不抛错） */
  resumeExtract: 'resume/extract',
  /** 简历 Artifact 落盘（params { personId, fileName?, text? | pdfBase64?, extraction? } → { artifactId, format }；documents/resumes/resume-00X + meta + extraction md，编号递增不覆盖） */
  saveResumeOriginal: 'person/session/resume',
  /** 快照版本存档（M7.1：写入 current 前调用，params { personId, reason, trigger?, sourceRefs? } → SnapshotVersionManifest | null；增量 append-only） */
  snapshotArchive: 'snapshot/archive',
  /** 快照版本链（params: { personId } → SnapshotVersionManifest[] 正序；versions/ 缺失 → 空） */
  snapshotVersions: 'snapshot/versions',
  /** Ledger 候选生成（M7.2：params { personId, fromId, toId } → LedgerCandidate[]；diff 原语无副作用） */
  ledgerCandidates: 'ledger/candidates',
  /** Ledger 事件提交（M7.2：params { personId, fromId, toId, unit, trigger, attribution, confirmation } → LedgerEventRecord；不变量：refs 可读 + confirmation + why 非空） */
  ledgerCommit: 'ledger/commit',
  /** Ledger 候选拒绝（M7.2：params { personId, fromId, toId, unit } → { rejected: true }；显式否定无副作用——拒绝 = 不 commit） */
  ledgerReject: 'ledger/reject',
  /** Ledger 事件列表（params: { personId } → LedgerEventRecord[] 正序；ledger/ 缺失 → 空） */
  ledgerList: 'ledger/list',
  /** Decision 变化候选提交（M7.3：params { decisionId, changeUnit, changeType, before?, after, trigger, attribution, confirmation } → LedgerEventRecord；防漂移：after 须与决策文件当前投影一致） */
  decisionCommit: 'decision/commit',
  /** 演化查询·为什么变化（M7.4：params { personId, unit } → EvolutionChange[]；纯读投影不写资产） */
  evolutionWhyChanged: 'evolution/why-changed',
  /** 演化查询·决策回放（M7.4：params { personId } → DecisionReplay[]：事件 + 当时输入 + 当时未知） */
  evolutionReplay: 'evolution/replay',
  /** 演化查询·近期变化（M7.4：params { personId, days? } → RecentEvolution：近 N 天事件 + 无变化单位） */
  evolutionRecent: 'evolution/recent',
  /** 信息池图谱（PoolNode[] + PoolEdge[]，由 decisions/companies/profiles 派生） */
  poolGraph: 'pool/graph',
  /** 健康投影（HealthReport，契约 v1；CLI --doctor 与 UI 共用同一计算源） */
  health: 'system/health',
  /** 简历导出 PDF（params: { html } → { pdf: base64, fileName }；spawn 系统 Edge headless --print-to-pdf） */
  resumeExport: 'resume/export',
  /** 发起 Agent 任务（params: { task, context?, resumeSessionId?, permissionMode?, allowedTools?, maxTurns? } → { taskId }；流式事件经 agent.event 推送） */
  agentStart: 'agent/start',
  /** 回答 AskUserQuestion（params: { taskId, text }） */
  agentAnswer: 'agent/answer',
  /** 取消 Agent 任务（params: { taskId } → AbortController） */
  agentCancel: 'agent/cancel',
  /** 工具权限决策（params: { taskId, requestId, allow } → 引擎 resolve 挂起的 canUseTool） */
  agentPermission: 'agent/permission',
  /** 简历改写用户决策事件（params: { requestId, action, reason?, standardUsed?, selectedTextHash } → 追加 logs/feedback/rewrite-feedback.jsonl；契约 Resume-Feedback-Contract-v1，只记录不学习） */
  rewriteFeedback: 'rewrite/feedback',
  /** 新建岗位（params: { company, title, location?, salary?, jdSource?, requirements?, jdText? } → 写 jobs/{日期}-{公司}-{岗位}.md → JobRecord；M1 只有 create，修正走版本化写入后续） */
  createJob: 'jobs/create',
  /** 全量岗位列表（jobs/ 目录扫描 + 校验标记） */
  listJobs: 'jobs/list',
  /** 单个岗位（params: { id } → JobRecord） */
  getJob: 'jobs/get',
  /** 岗位要求覆盖（params: { jobId, person } → GapResult：Job.requirements 当 Role 喂 computeGap，复用知识层差距计算，可解释匹配不做百分比） */
  matchJob: 'jobs/match',
  /** JD 信息 AI 提取（params: { jdText } → JdExtractResult：粘贴 JD 自动回填建档表单） */
  extractJd: 'jobs/extract',
  /** 删除岗位（params: { id } → 删 jobs/{id}.md；watcher unlink 自动广播） */
  deleteJob: 'jobs/delete',
  /** 岗位证据覆盖（params: { id: jobId } → ResponsibilityCoverage[]：evidenceExpectations × Inventory，三态不做匹配分；M2） */
  jobCoverage: 'jobs/coverage',
  /** 全量证据条目（evidence/ 目录扫描 + 校验标记；M2） */
  listEvidence: 'evidence/list',
  /** 全量 Claim（claims/ 目录扫描 + 校验标记 + usable：canUseClaim 派生——Claim 没有可信度只有可消费性；M3-0） */
  listClaims: 'claims/list',
  /** 岗位上下文 Claim Coverage（params: { id: jobId } → ClaimCoverageRow[]：responsibility → 关联 trusted evidence → 可消费 Claims；M3-0） */
  claimCoverage: 'claims/coverage',
  /** 表达候选选择（params: { id: jobId } → ResponsibilityCandidates[]：ExpressionCandidate + SelectionReason + 可解释 priority；M3-1 Step 4，Resume 消费端输入） */
  claimSelect: 'claims/select',
  /** 全量简历版本（resumes/documents/ 扫描 + 校验标记；M3.5） */
  listResumes: 'resumes/list',
  /** 单个简历版本（params: { id } → ResumeDocument） */
  getResume: 'resumes/get',
  /** 克隆版本（params: { id } → 新 draft，lineage.parent + createdBy=user；不复制 status/operations） */
  cloneResume: 'resumes/clone',
  /** 状态转移（params: { id, targetStatus } → 状态机校验 + operations 审计；exported 仅 export 链） */
  transitionResume: 'resumes/transition',
  /** 版本对比（params: { a, b } → ResumeDiff：identity 对比含 claimId/expectationId，不丢 provenance） */
  diffResumes: 'resumes/diff',
  /** 导出简历版本（params: { id } → exportResumePdf + ExportRecord 持久化 + status=exported + operation 审计） */
  exportResume: 'resumes/export',
  /** 全量提案（proposals/ 扫描 + 校验标记；M3.5.6 AI 建议层） */
  listProposals: 'proposals/list',
  /** 接受提案（params: { id, reason? } → checksum 校验 → 确定性应用 → 新版本（lineage.parent + ai_revision + apply_proposal 审计）；成功即产生新版本，永不覆盖源；reason 可选写回 accept_reason——M3.5.7 决策反馈） */
  acceptProposal: 'proposals/accept',
  /** 拒绝提案（params: { id, reason? } → pending → rejected；单向不 reopen，审计保留） */
  rejectProposal: 'proposals/reject',
  /** 全量 Portfolio 项目（portfolio/projects/ 扫描；M4-1 集合型 Artifact） */
  listPortfolioProjects: 'portfolio/projects/list',
  /** 全量 Portfolio 提案（portfolio/proposals/ 扫描 + 校验标记；M4-1 Intent Layer） */
  listPortfolioProposals: 'portfolio/proposals/list',
  /** 项目状态转移（params: { id, targetStatus } → 单向状态机校验 + 演化记录追加；published 不可回退，修改必须走提案） */
  transitionPortfolio: 'portfolio/transition',
  /** 接受 Portfolio 提案（params: { id, reason? } → P-01~P-07 校验 → statement 改写 + version+1 + status=draft + transitions 追加；永不覆盖历史） */
  acceptPortfolioProposal: 'portfolio/proposals/accept',
  /** 拒绝 Portfolio 提案（params: { id, reason? } → pending → rejected；单向不 reopen，审计保留） */
  rejectPortfolioProposal: 'portfolio/proposals/reject',
  /** 全量 Interview QA（interviews/ 扫描；M4-2 问答资产——Fact/Expression/Strategy 三层） */
  listInterviewQas: 'interviews/list',
  /** 全量 Interview 提案（interviews/proposals/ 扫描 + 校验标记；M4-2 Intent Layer） */
  listInterviewProposals: 'interviews/proposals/list',
  /** QA 状态转移（params: { id, targetStatus } → 单向状态机校验 + 演化记录追加；ready 不可直接回退，修改必须走提案） */
  transitionInterview: 'interviews/transition',
  /** 接受 Interview 提案（params: { id, reason? } → I-01~I-08 校验 → AnswerStatement.text 改写 + status=draft + transitions 追加；永不覆盖历史） */
  acceptInterviewProposal: 'interviews/proposals/accept',
  /** 拒绝 Interview 提案（params: { id, reason? } → pending → rejected；单向不 reopen，审计保留） */
  rejectInterviewProposal: 'interviews/proposals/reject',
  /** 全量 Cover Letter（cover-letters/ 扫描；M4-3 第一个 Projection Artifact——NarrativeUnit 引用源 Artifact Fact Layer） */
  listCoverLetters: 'cover-letters/list',
  /** 全量 Cover Letter 提案（cover-letters/proposals/ 扫描 + 校验标记；M4-3 Intent Layer） */
  listCoverLetterProposals: 'cover-letters/proposals/list',
  /** Cover Letter 状态转移（params: { id, targetStatus } → 单向状态机校验 + 演化记录追加；ready 不可直接回退，修改必须走提案） */
  transitionCoverLetter: 'cover-letters/transition',
  /** 接受 Cover Letter 提案（params: { id, reason? } → CL-01~CL-07 校验 → NarrativeUnit.text 改写 + status=draft + transitions 追加；永不覆盖历史） */
  acceptCoverLetterProposal: 'cover-letters/proposals/accept',
  /** 拒绝 Cover Letter 提案（params: { id, reason? } → pending → rejected；单向不 reopen，审计保留） */
  rejectCoverLetterProposal: 'cover-letters/proposals/reject',
  /** AI Read Model（params 可选 { jobId } → CareerContext：全资产投影——AI 不直接读数据库结构；M3.5.4） */
  aiContext: 'ai/context',
  /** 删除公司档案（params: { id } → 删 companies/{id}.md；广播 data.companies.changed） */
  deleteCompany: 'companies/delete',
  /** 读取 Agent 设置（params: 无 → { model, apiKey, permissionMode, allowedTools, maxTurns }，来自 config.json） */
  settingsGet: 'settings/get',
  /** 更新 Agent 设置（params: { model?, apiKey?, permissionMode?, allowedTools?, maxTurns? }，undefined 字段不修改 → 写回 config.json + 更新内存，下次任务生效） */
  settingsUpdate: 'settings/update',
  /** 可用模型列表（params: 无 → { source: 'api'|'cli'|'api_error', models: string[] }；配置了 apiKey 时调 Anthropic /v1/models 拉真实模型，否则返回官方当前模型 ID） */
  settingsModels: 'settings/models',
  /** 四 Artifact 类级 Summary（M4-5.1 UI projection endpoint：Engine Context → ArtifactSummary[] → Cards；UI 不读文件，内部四 adapter Concrete First） */
  listArtifactSummaries: 'artifacts/summaries',
  /** 四 Artifact 演化 Timeline（M4-5.3 UI projection：Engine Events → Timeline Adapter → ArtifactTimelineEvent[]；确定性排序 at→order→id；Proposal 是 source 非事件） */
  listArtifactTimeline: 'artifacts/timeline',
  /** 表达单元溯源（M4-5.4 params: { artifact:'cover-letter', scopeId, unitId } → TraceabilityContext；只读定位——查看 ≠ 产生 Artifact state） */
  artifactTraceability: 'artifacts/traceability/context',
} as const

export const EVENTS = {
  /** decisions/ 目录变更后推送（不含数据，客户端用 decisions/list 拉快照） */
  decisionsChanged: 'data.decisions.changed',
  /** jobs/ 目录变更后推送（不含数据，客户端用 jobs/list 拉快照） */
  jobsChanged: 'data.jobs.changed',
  /** evidence/ 目录变更后推送（不含数据，客户端用 evidence/list 拉快照；M2） */
  evidenceChanged: 'data.evidence.changed',
  /** claims/ 目录变更后推送（不含数据，客户端用 claims/list 拉快照；M3-0） */
  claimsChanged: 'data.claims.changed',
  /** resumes/ 目录变更后推送（不含数据，客户端用 resumes/list 拉快照；M3.5） */
  resumesChanged: 'data.resumes.changed',
  /** proposals/ 目录变更后推送（不含数据，客户端用 proposals/list 拉快照；M3.5.6） */
  proposalsChanged: 'data.proposals.changed',
  /** portfolio/ 目录变更后推送（不含数据，客户端用 portfolio/projects|proposals/list 拉快照；M4-1） */
  portfolioChanged: 'data.portfolio.changed',
  /** interviews/ 目录变更后推送（不含数据，客户端用 interviews/list 拉快照；M4-2） */
  interviewChanged: 'data.interviews.changed',
  /** cover-letters/ 目录变更后推送（不含数据，客户端用 cover-letters/list 拉快照；M4-3） */
  coverLetterChanged: 'data.cover-letters.changed',
  /** companies/ 目录变更后推送（不含数据，客户端用 companies/list 拉快照） */
  companiesChanged: 'data.companies.changed',
  /** persons/ 目录变更后推送（不含数据，客户端用 persons/list 拉快照；P1 Person Aggregate 生命周期闭环） */
  personsChanged: 'data.persons.changed',
  poolChanged: 'data.pool.changed',
  engineError: 'error.engine',
  /** Agent 流式事件（data = { taskId, ...AgentEvent }；permission_request 已换为 requestId 形态） */
  agentEvent: 'agent.event',
} as const

export interface InitResult {
  protocol: string
  version: string
  workspace: string
  serverTime: string
}

export interface GraphResult {
  nodes: unknown[]
  edges: unknown[]
}

export const WS_PORT_DEFAULT = 5289
export const WS_URL_DEFAULT = `ws://127.0.0.1:${WS_PORT_DEFAULT}`

export { ProtocolVersion }
