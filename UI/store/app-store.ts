import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { useToastStore } from './toast-store'
import { useAttentionStore } from './attention-store'
import type {
  Application,
  ApplicationRecord,
  ChatMessage,
  Company,
  DecisionRecord,
  DecisionStage,
  HealthReport,
  MainWidthMode,
  NavPageId,
  PendingPermission,
  Person,
  ResumeVersion,
  RewriteFeedbackReason,
  RewriteState,
  Session,
  StageStatus,
} from '../types'
import {
  COMPANIES,
  DECISIONS,
  PERSONS,
  RESUMES,
  SESSIONS,
  STAGES,
} from '../data/mock-data'
import type { AgentRuntimeEvent, CareerClaim, ClaimCoverageRow, ConstraintMatchRow, DecisionAggregate, DecisionHistory, EvidenceItem, GapResult, InitCandidate, JDAnalysisProposal, JobRecord, Role, Skill, Validation } from '../../engine/ir/schema.ts'
import type { ResumeDocument, ResumeStatus, ResumeExportRecord, ResumeProposal } from '../../engine/ir/resume.ts'
import type { PortfolioProject, PortfolioProposal } from '../../engine/ir/portfolio.ts'
import type { InterviewQa, InterviewProposal } from '../../engine/ir/interview.ts'
import type { CoverLetter, CoverLetterProposal } from '../../engine/ir/cover-letter.ts'
import type { ArtifactSummary } from '../../engine/ir/artifact-summary.ts'
import type { ArtifactTimelineEvent } from '../../engine/ir/artifact-timeline.ts'
import type { TraceabilityContext } from '../../engine/ir/traceability.ts'
import type { ResumeDiff } from '../../engine/storage/resume-watcher.ts'
import type { CareerContext } from '../../engine/ir/context.ts'
import type { ResponsibilityCoverage } from '../../engine/runtime/evidence-coverage.ts'
import {
  EVENTS,
  createEngineClient,
  type AgentProviderView,
  type DecisionView,
  type EngineClient,
  type EngineStatus,
  type GraphResult,
  type JobView,
  type MapSettings,
} from './engine-client'

/** 引擎公司档案（带 validation 降级标记）；mock COMPANIES 无 validation，结构兼容 */
type CompanyView = Company & { validation?: Validation }

/** 按人构造决策链进度：人 1 走完三步（演示主线），其余人差异化。 */
function makePersonStages(statusMap: Record<string, StageStatus>): DecisionStage[] {
  return STAGES.map((s) => ({
    ...s,
    status: statusMap[s.id] ?? 'pending',
    completedAt: s.status === 'completed' && statusMap[s.id] === 'completed' ? s.completedAt : undefined,
  }))
}

function buildInitialPersonStages(): Record<number, DecisionStage[]> {
  return {
    1: makePersonStages({
      direction: 'completed',
      transfer: 'completed',
      city: 'completed',
      company: 'current',
    }),
    2: makePersonStages({ direction: 'completed', transfer: 'current' }),
  }
}

function freshPersonStages(): DecisionStage[] {
  return makePersonStages({ direction: 'current' })
}

// ─── 会话消息写入（权限/提问反馈进对话流；sessions 持久化（partialize 白名单），流式占位带 streaming 标记）──

/** 权限决策挂起：requestPermission 返回的 promise 由审批动作 resolve（真实流接入后 await 此值） */
let resolvePending: ((ok: boolean) => void) | null = null

function appendToSession(sessionId: string, message: ChatMessage): void {
  useAppStore.setState((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id === sessionId
        ? { ...sess, updatedAt: message.timestamp, messages: [...sess.messages, message] }
        : sess,
    ),
  }))
}

/** 审批结果以 system 消息反馈进对话流（角色 system 渲染为居中浅注，非气泡） */
function appendSystemMessage(sessionId: string, text: string): void {
  appendToSession(sessionId, {
    id: `msg-${Date.now()}`,
    role: 'system',
    content: text,
    timestamp: new Date().toISOString(),
  })
}

/** 权限请求消息的工具 chip 状态流转：waiting_approval → done（放行）/ denied（拒绝） */
function patchToolCallStatus(
  sessions: Session[],
  pending: PendingPermission,
  status: 'done' | 'denied',
): Session[] {
  return sessions.map((s) =>
    s.id === pending.sessionId
      ? {
        ...s,
        messages: s.messages.map((m) => ({
          ...m,
          toolCalls: m.toolCalls?.map((t) =>
            t.name === pending.toolName && t.status === 'waiting_approval'
              ? { ...t, status }
              : t,
          ),
        })),
      }
      : s,
  )
}

interface AppState {
  currentPersonId: number;
  currentPage: NavPageId;
  agentPanelOpen: boolean;
  /** JD 建档 Dialog（侧栏「新增 JD」与主区「增加 JD」共用同一打开入口） */
  jdAddOpen: boolean;
  mainWidthMode: MainWidthMode;
  commandPaletteOpen: boolean;
  engineStatus: EngineStatus;
  poolGraph: GraphResult | null;
  sessions: Session[];
  currentSessionId: string;
  /** 当前人初始化采集会话 id（startInitializationSession 创建时记录；person 完成/reset 后失效） */
  initSessionId: string | null;
  /** 各会话运行中的 Agent 任务（归属 session：同会话单任务互斥，跨会话并行）——状态条/停止按钮的驱动源 */
  sessionTasks: Record<string, { taskId: string; messageId: string; startedAt: number; type?: string }>;
  /** 任务心跳时间源（有任务时每秒 tick；消息内/顶部状态条/会话列表共用，不持久化） */
  now: number;
  /** Agent 设置（引擎 config.json 同步；apiKey 留空 = 使用本机 claude CLI 登录态，不持久化） */
  agentSettings: { model: string; apiKey: string; baseUrl: string; enabled: boolean; providers: AgentProviderView[]; map: MapSettings; documentVision: { model: string; apiKey: string }; permissionMode: string };
  /** 可用模型列表（引擎 settings/models：apiKey 配置时来自 API 提取；模型切换器 options） */
  availableModels: { source: 'api' | 'cli' | 'api_error'; models: string[]; error?: 'auth' | 'no_endpoint' | 'network' };
  /** 投递记录（ADR-019：用户行动事实资产，引擎 applications/list 实时派生，不持久化——Engine Registry 是唯一事实源） */
  applications: Application[];
  /** 简历版本（初始 mock；「选择 JD 派生」新建版本写入，持久化） */
  resumes: ResumeVersion[];
  decisions: DecisionView[];
  /** 决策聚合视图（V1.5）：引擎实时派生，不持久化——offline/未建 context 时为空数组 */
  contexts: DecisionAggregate[];
  /** 知识层（V2）：技能词表 + 岗位清单（引擎实时派生，不持久化；status 标注 RPC 成败——视图按诚实空态消费） */
  knowledge: { skills: Skill[]; roles: Role[]; status: 'idle' | 'ready' | 'error' };
  /** 岗位（Job，M1）：JD 一等数据对象，引擎实时派生（jobs/ 目录），投递卡片展开/匹配用 */
  jobs: JobView[];
  /** 证据资产（M2）：Evidence Inventory 全量条目（evidence/ 目录，引擎实时派生） */
  evidence: EvidenceItem[];
  /** 岗位证据覆盖缓存（M2：jobId → ResponsibilityCoverage[]，按岗位拉取） */
  evidenceCoverage: Record<string, ResponsibilityCoverage[]>;
  /** 岗位门槛匹配投影缓存（主线 3：jobId → ConstraintMatchRow[]，按岗位拉取；UI 只投影不解释） */
  constraintRows: Record<string, ConstraintMatchRow[]>;
  /** Claim 资产（M3-0）：表达 IR 全量条目（claims/ 目录，引擎实时派生 + usable——可消费性引擎推导） */
  claims: (CareerClaim & { usable: boolean })[];
  /** 岗位 Claim 表达候选缓存（M3-1：jobId → ClaimCoverageRow[]，按岗位拉取） */
  claimCoverage: Record<string, ClaimCoverageRow[]>;
  /** 简历版本（M3.5）：resumes/documents/ 引擎实时派生（版本系统 IR + lifecycle） */
  resumeVersions: ResumeDocument[];
  /** 提案（M3.5.6）：proposals/ 引擎实时派生（AI 建议层——Human Approval Console 数据源） */
  proposals: ResumeProposal[];
  /** 四 Artifact 类级 Summary（M4-5.1）：artifacts/summaries 引擎实时派生（UI projection——Assets 视图数据源） */
  artifactSummaries: ArtifactSummary[];
  /** Portfolio 项目（M4-1）：portfolio/projects/ 引擎实时派生 */
  portfolioProjects: PortfolioProject[];
  /** Portfolio 提案（M4-1）：portfolio/proposals/ 引擎实时派生（Proposal Center 数据源） */
  portfolioProposals: PortfolioProposal[];
  /** Interview QA（M4-2）：interviews/ 引擎实时派生 */
  interviewQas: InterviewQa[];
  /** Interview 提案（M4-2）：interviews/proposals/ 引擎实时派生 */
  interviewProposals: InterviewProposal[];
  /** Cover Letter（M4-3）：cover-letters/ 引擎实时派生 */
  coverLetters: CoverLetter[];
  /** Cover Letter 提案（M4-3）：cover-letters/proposals/ 引擎实时派生 */
  coverLetterProposals: CoverLetterProposal[];
  /** AI Read Model（M3.5.4）：CareerContext 投影——Studio provenance/validation 数据源（引擎实时派生） */
  careerContext: CareerContext | null;
  /** 健康投影（契约 v1，引擎实时计算；offline 时页面用 mock 兜底） */
  health: HealthReport | null;
  companies: CompanyView[];
  persons: Person[];
  personStages: Record<number, DecisionStage[]>;
  agentDraft: string;
  agentContextFiles: string[];
  pendingPrompt: string | null;
  personSwitchDialogOpen: boolean;
  pendingPersonId: number | null;
  personCreateDialogOpen: boolean;
  activeResumeId: string;
  infopoolFilter: string;
  companiesFilter: string;
  applicationsFilter: string;
  locateTarget: string | null;
  /** 岗位页选中的岗位（跳转定位：新增投递保存后 → 岗位页选中） */
  selectedJobId: string | null;
  /** 公司页选中的公司（侧栏列表选中 → 档案 Dialog；locateTarget 定位共用） */
  selectedCompanyId: string | null;
  /** 工作台子视图（驾驶舱内部导航：Dashboard/方向/城市/决策记录） */
  workbenchView: 'dashboard' | 'directions' | 'cities' | 'decisions' | 'profile';
  /** 简历中心视图（M3.5.5：三空间——Draft Workspace / Resume Studio / Resume Assets） */
  resumesView: 'workspace' | 'studio' | 'assets';
  /** Artifact Studio 视图（M4-5：Assets 概览 / Proposals 提案中心 / Evolution 演化时间线——v0.3 信息架构四区按 slice 落地） */
  artifactsView: 'assets' | 'proposals' | 'evolution';
  /** 四 Artifact 演化 Timeline（M4-5.3）：artifacts/timeline 引擎实时派生（已确定性排序，UI 不重排） */
  timelineEvents: ArtifactTimelineEvent[];
  /** 表达单元溯源（M4-5.4）：Traceability Panel 数据源（浮层临时数据，不持久化；null = 未查询） */
  traceability: TraceabilityContext | null;
  /** 当前选中的简历版本（M3.5.5：共享 Artifact——Studio/Agent/导出跳转定位；由侧栏/页面/Agent 共同读写） */
  selectedResumeId: string | null;
  /** 当前选中的草稿（预留：Agent 定位编辑区；M3.5.5 暂不深度使用） */
  selectedDraftId: string | null;
  /** 公司空间子视图（档案：卡片+尽调正文 / 地图：散点定位） */
  companiesView: 'profile' | 'map';
  /** 挂起的权限请求（授权弹窗数据源）；null = 无待决授权 */
  pendingPermission: PendingPermission | null;
  /** 批量放行：sessionId → 本会话内已自动放行的工具名（随会话持久化，刷新不丢） */
  approvedTools: Record<string, string[]>;
  /** 简历 AI 改写任务（浮层状态机，不持久化；在线走真实 agent，离线由页面降级规则候选） */
  rewrite: RewriteState;

  currentPerson: () => Person;
  setPage: (page: NavPageId) => void;
  setPerson: (personId: number) => void;
  confirmPersonSwitch: (keepSession: boolean) => void;
  cancelPersonSwitch: () => void;
  setPersonCreateDialogOpen: (open: boolean) => void;
  setActiveResumeId: (id: string) => void;
  addPerson: (person: Omit<Person, 'id'>) => number;
  /** 回填引擎 person_id（person/session/create 成功后的稳定标识，owner 协议引用键） */
  setPersonPersonId: (id: number, personId: string) => void;
  archivePerson: (personId: number) => void;
  /** 重置初始化（生命周期 v0.1）：引擎清 intake/extraction/events/snapshot + 本地 init 状态回退 pending；manifest/身份保留 */
  resetInitialization: (personId: number) => Promise<void>;
  /** 完成初始化（用户声明基础信息达到可用状态，非封闭）：manifest init_state → completed + 本地 initStatus → active */
  completeInitialization: (personId: number) => Promise<void>;
  /** 物理删除 Person（dev/测试清理）：引擎 persons/{id}/ 整目录移除 + 本地状态清理；引擎离线拒绝（避免本地删了被 persons/list 复活） */
  deletePerson: (personId: number) => Promise<void>;
  toggleAgentPanel: () => void;
  setAgentPanelOpen: (open: boolean) => void;
  setJdAddOpen: (open: boolean) => void;
  setMainWidthMode: (mode: MainWidthMode) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setAgentDraft: (draft: string) => void;
  setPendingPrompt: (prompt: string | null) => void;
  startAnalysis: (prompt: string) => void;
  /** 任务启动入口（工作台 Action）：新 Session（主题现场）+ 立即执行——按钮即意图，不等用户二次确认；
   *  type=任务识别（P2 状态条显示）；与 sendAgentMessage（聊天入口，当前现场）职责分离 */
  startAgentTask: (prompt: string, opts?: { type?: string; title?: string }) => void;
  expandToFullAgent: () => void;
  /** silent=true：task 进引擎但不渲染为 user 消息——Agent 回复成为首条可见消息（Agent 主动开场）；taskType=任务识别（P2 状态显示） */
  sendAgentMessage: (content: string, opts?: { silent?: boolean; taskType?: string }) => void;
  /** 初始化会话：Agent 主动进入初始化助手角色（内部指令不外显，输入框保持干净） */
  startInitializationSession: (ctx: {
    personName: string
    sourceMode: 'resume' | 'interview'
    interests?: string[]
    personId?: string
  }) => void;
  /** 初始化会话状态机（Initialization Shell）：welcome/discovering/summary/resolution/compiled */
  initSessionState: 'welcome' | 'discovering' | 'summary' | 'resolution' | 'compiled';
  setInitSessionState: (state: 'welcome' | 'discovering' | 'summary' | 'resolution' | 'compiled') => void;
  /** 初始化采集候选（切片 2.2：extraction/candidates.md 投影；右侧「正在收集的信息」数据源） */
  initCandidates: InitCandidate[];
  setInitCandidates: (candidates: InitCandidate[]) => void;
  /** 从引擎重拉候选（刷新/重进入初始化空间后恢复右侧） */
  loadInitCandidates: (personId: string) => Promise<void>;
  /** 候选裁决（切片 2.3）：确认/拒绝/修改 → candidates.md + resolution 事件 + 本地投影更新 */
  resolveInitCandidate: (
    candidateId: string,
    action: 'confirmed' | 'rejected' | 'modified',
    modifiedContent?: string,
  ) => Promise<void>;
  setCurrentSession: (id: string) => void;
  setSelectedCompanyId: (id: string | null) => void;
  setWorkbenchView: (view: 'dashboard' | 'directions' | 'cities' | 'decisions' | 'profile') => void;
  setCompaniesView: (view: 'profile' | 'map') => void;
  /** 简历中心三空间切换（M3.5.5） */
  setArtifactsView: (view: 'assets' | 'proposals' | 'evolution') => void;
  /** 简历中心视图（M3.5.5：三空间） */
  setResumesView: (view: 'workspace' | 'studio' | 'assets') => void;
  /** 选中简历版本（M3.5.5：切到 studio 并定位——Agent/Deep Link/导出跳转共用） */
  selectResume: (id: string) => void;
  createSession: (title?: string) => string;
  /** 停止当前会话运行中的 Agent 任务（agent/cancel RPC + 占位消息标记「已停止」） */
  cancelCurrentTask: () => void;
  /** 从引擎拉取 Agent 设置（config.json）到 agentSettings */
  loadAgentSettings: () => Promise<void>;
  /** 拉取可用模型列表（模型切换器 options；可选 params 传临时 apiKey/baseUrl——「提取模型」按钮用，缺省引擎配置） */
  loadAvailableModels: (params?: { apiKey?: string; baseUrl?: string }) => Promise<void>;
  /** 保存 Agent 设置到引擎 config.json（apiKey 空串 = 清除；下次任务生效） */
  saveAgentSettings: (patch: {
    model?: string
    apiKey?: string
    baseUrl?: string
    enabled?: boolean
    providers?: AgentProviderView[]
    map?: { apiKey?: string; securityJsCode?: string }
    /** Document Extraction 视觉模型（PDF 图片型提取；写 config.json document.vision） */
    documentVision?: { model?: string; apiKey?: string }
    /** 工具授权模式：bypassPermissions = 自动授权所有工具；ask = 逐个询问 */
    permissionMode?: 'acceptEdits' | 'ask' | 'bypassPermissions'
  }) => Promise<void>;
  /** 模型切换器：仅内存生效（跟随发送），持久化走 saveAgentSettings */
  setAgentModel: (model: string) => void;
  /** 权限消费入口（真实 Agent 流 + 演示共用）：会话内已批量放行 → 立即放行；否则挂起弹窗等待决策 */
  requestPermission: (toolName: string, description: string) => Promise<boolean>;
  approvePermission: () => void;
  denyPermission: () => void;
  approveAllPermissions: () => void;
  simulatePermissionRequest: (toolName: string, description: string) => void;
  simulateQuestionRequest: (question: string, options: string[]) => void;
  answerQuestion: (messageId: string, answer: string) => void;
  /** 简历 AI 改写：指令 + 目标岗位上下文 → 真实 agent 任务（事件经 rewriteTaskId 路由到 rewrite 状态） */
  startRewrite: (text: string, instruction: string, jdContext: string) => Promise<void>;
  cancelRewrite: () => void;
  resetRewrite: () => void;
  /** 2B：rewrite 用户决策事件上报（只记录不学习，契约 Resume-Feedback-Contract-v1） */
  reportRewriteFeedback: (fb: { action: 'apply' | 'reject'; reason?: RewriteFeedbackReason }) => void;
  /** 简历导出 PDF：引擎 Edge headless 渲染；未连接 → 抛错（页面降级 window.print） */
  exportResume: (html: string) => Promise<{ pdf: string; fileName: string }>;
  /** 推进投递状态（用户确认；引擎侧状态跃迁校验 + SUBMITTED 登记 submittedAt/displayFallback；离线抛错） */
  updateApplicationStatus: (id: string, status: Application['status']) => Promise<void>;
  /** 创建投递记录（用户「开始投递流程」→ PREPARING；createdBy 恒为 'user'，Agent 禁止创建） */
  createApplication: (params: { jobId: string; decisionId?: string }) => Promise<ApplicationRecord>;
  /** 删除投递记录（仅 PREPARING 可物理删除；其余推进 WITHDRAWN） */
  deleteApplication: (id: string) => Promise<void>;
  /** 新建简历版本（选择 JD 派生的壳版本：挂 targetCompany/Position，模块复制模板作为编辑起点） */
  createResumeVersion: (params: { name: string; targetCompany?: string; targetPosition?: string }) => string | undefined;
  /** 局部修改决策记录：引擎写回 md → 自动重扫广播；引擎离线抛错（组件 toast） */
  updateDecision: (id: string, fields: Record<string, string>) => Promise<void>;
  /** 新建岗位（M1 只有 create）：引擎写 jobs/{id}.md → jobsChanged 自动重拉 */
  createJob: (params: {
    company: string
    title: string
    location?: string
    salary?: string
    jdSource?: string
    requirements?: string
    jdText?: string
  }) => Promise<JobRecord>;
  /** 岗位能力覆盖（Signal Layer：Job.responsibilities.capabilities 对齐源，可解释匹配不做百分比） */
  matchJob: (jobId: string, personName: string) => Promise<GapResult>;
  /** 岗位门槛匹配投影（约束四态；结果缓存 constraintRows[jobId]——UI 只投影不解释） */
  fetchConstraintMatch: (jobId: string, personId: string) => Promise<void>;
  /** 岗位证据覆盖（M2：evidenceExpectations × Inventory，三态；结果缓存 evidenceCoverage[jobId]） */
  fetchJobCoverage: (jobId: string) => Promise<void>;
  /** 岗位 Claim 表达候选（M3-1：responsibility → 关联 trusted evidence → 可消费 Claims；缓存 claimCoverage[jobId]） */
  fetchClaimCoverage: (jobId: string) => Promise<void>;
  /** 克隆简历版本（M3.5：新 draft + lineage.parent + createdBy=user） */
  cloneResume: (id: string) => Promise<ResumeDocument>;
  /** 状态转移（M3.5：状态机校验 + operations 审计；exported 仅 export 链） */
  transitionResume: (id: string, targetStatus: ResumeStatus) => Promise<ResumeDocument>;
  /** 导出简历版本（M3.5：exportResumePdf + ExportRecord + status=exported；与旧 HTML 导出 exportResume 区分） */
  exportResumeVersion: (id: string) => Promise<{ result: { pdf: string; fileName: string }; record: ResumeExportRecord }>;
  /** 版本对比（M3.5：identity diff） */
  diffResumes: (a: string, b: string) => Promise<ResumeDiff>;
  /** 接受提案（M3.5.6：引擎确定性应用 → 新版本；成功即产生 v4；reason 可选——M3.5.7 决策反馈） */
  acceptProposal: (id: string, reason?: string) => Promise<ResumeDocument>;
  /** 拒绝提案（M3.5.6：pending → rejected，可选原因；单向不 reopen） */
  rejectProposal: (id: string, reason?: string) => Promise<ResumeProposal>;
  /** 接受 Portfolio 提案（M4-1：P-01~P-07 校验 → FactItem.statement 改写 + status=draft + transitions 追加） */
  acceptPortfolioProposal: (id: string, reason?: string) => Promise<PortfolioProject>;
  /** 拒绝 Portfolio 提案（M4-1：pending → rejected，单向不 reopen） */
  rejectPortfolioProposal: (id: string, reason?: string) => Promise<PortfolioProposal>;
  /** 接受 Interview 提案（M4-2：I-01~I-08 校验 → AnswerStatement.text 改写 + status=draft） */
  acceptInterviewProposal: (id: string, reason?: string) => Promise<InterviewQa>;
  /** 拒绝 Interview 提案（M4-2：pending → rejected，单向不 reopen） */
  rejectInterviewProposal: (id: string, reason?: string) => Promise<InterviewProposal>;
  /** 接受 Cover Letter 提案（M4-3：CL-01~CL-08 校验 → NarrativeUnit.text 适配 + status=draft） */
  acceptCoverLetterProposal: (id: string, reason?: string) => Promise<CoverLetter>;
  /** 拒绝 Cover Letter 提案（M4-3：pending → rejected，单向不 reopen） */
  rejectCoverLetterProposal: (id: string, reason?: string) => Promise<CoverLetterProposal>;
  /** 表达单元溯源（M4-5.4：只读定位——查看 ≠ 产生 Artifact state；结果缓存进 traceability，null 清空） */
  loadTraceability: (scopeId: string, unitId: string) => Promise<TraceabilityContext | null>;
  /** 删除岗位（引擎删 jobs/{id}.md → jobsChanged 自动重拉；删除当前选中则清空） */
  deleteJob: (id: string) => Promise<void>;
  /** 删除公司档案（引擎删 companies/{id}.md → companiesChanged 自动重拉；删除当前选中则清空） */
  deleteCompany: (id: string) => Promise<void>;
  /** 删除简历版本（本地 resumes 过滤；删除当前版本回退到第一份） */
  deleteResumeVersion: (id: string) => void;
  addDecision: (record: DecisionRecord) => void;
  markCompanyContacted: (id: string) => void;
  setInfopoolFilter: (filter: string) => void;
  setCompaniesFilter: (filter: string) => void;
  setApplicationsFilter: (filter: string) => void;
  setLocateTarget: (target: string | null) => void;
  setSelectedJobId: (id: string | null) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      currentPersonId: 1,
      currentPage: 'workbench',
      agentPanelOpen: false,
      jdAddOpen: false,
      mainWidthMode: 'narrow',
      commandPaletteOpen: false,
      engineStatus: 'offline',
      poolGraph: null,
      sessions: SESSIONS,
      currentSessionId: 's-current',
      initSessionId: null,
      sessionTasks: {},
      now: Date.now(),
      agentSettings: { model: '', apiKey: '', baseUrl: '', enabled: true, providers: [], map: { provider: 'amap' }, documentVision: { model: 'glm-4.6v-flash', apiKey: '' }, permissionMode: 'bypassPermissions' },
      availableModels: { source: 'cli', models: [] },
      applications: [],
      deletedAppJobIds: [],
      resumes: RESUMES,
      decisions: DECISIONS,
      contexts: [],
      knowledge: { skills: [], roles: [], status: 'idle' },
      jobs: [],
      evidence: [],
      /** 岗位证据覆盖缓存（jobId → ResponsibilityCoverage[]；M2 层3 三态） */
      evidenceCoverage: {},
      constraintRows: {},
      /** Claim 资产（M3-0）：表达 IR 全量条目（claims/ 目录，引擎实时派生 + usable） */
      claims: [],
      /** 岗位 Claim 表达候选缓存（jobId → ClaimCoverageRow[]；M3-1 第三段） */
      claimCoverage: {},
      /** 简历版本（M3.5）：引擎实时派生（resumes/documents/） */
      resumeVersions: [],
      proposals: [],
      /** 四 Artifact 类级 Summary（M4-5.1）：引擎实时派生（offline 为空数组——页面诚实空态） */
      artifactSummaries: [],
      portfolioProjects: [],
      portfolioProposals: [],
      interviewQas: [],
      interviewProposals: [],
      coverLetters: [],
      coverLetterProposals: [],
      /** AI Read Model（M3.5.4）：CareerContext 投影（引擎实时派生；offline 为 null） */
      careerContext: null,
      health: null,
      companies: COMPANIES,
      persons: PERSONS,
      personStages: buildInitialPersonStages(),
      agentDraft: '',
      agentContextFiles: ['profile.md', 'decision.md', 'company DB'],
      pendingPrompt: null,
      personSwitchDialogOpen: false,
      pendingPersonId: null,
      personCreateDialogOpen: false,
      initSessionState: 'welcome',
      initCandidates: [],
      activeResumeId: 'r-dji',
      infopoolFilter: 'all',
      companiesFilter: 'all',
      applicationsFilter: '全部',
      locateTarget: null,
      selectedJobId: null,
      selectedCompanyId: null,
      workbenchView: 'dashboard',
      companiesView: 'profile',
      resumesView: 'workspace',
      artifactsView: 'assets',
      timelineEvents: [],
      traceability: null,
      selectedResumeId: null,
      selectedDraftId: null,
      pendingPermission: null,
      approvedTools: {},
      rewrite: { status: 'idle', text: '' },

  currentPerson: () => {
    const { currentPersonId, persons } = get()
    return persons.find((p) => p.id === currentPersonId) ?? persons[0]
  },

  setPage: (page) => {
    const state = get()
    // AI 面板全局交互模型：页面不决定面板开合（消除「切页自动弹面板」），
    // 只由显式动作（把手/⌘B/AI 动作）改变 agentPanelOpen，状态跨页保持。
    // 决策 Agent / 简历中心 / 信息池：全屏主区（Agent 页主区即 AI，无面板区）
    if (page === 'agent' || page === 'resumes' || page === 'infopool') {
      set({ currentPage: page, mainWidthMode: 'fullscreen' })
      return
    }
    // 投递管理 / 设置：宽档
    if (page === 'applications' || page === 'settings') {
      set({ currentPage: page, mainWidthMode: 'wide' })
      return
    }
    // 工作台 / 公司 / JD：默认宽档
    set({
      currentPage: page,
      mainWidthMode: page === 'workbench' ? 'wide' : state.mainWidthMode,
    })
  },

  setPerson: (personId) => {
    const { currentPersonId, sessions, currentSessionId } = get()
    if (personId === currentPersonId) return
    const session = sessions.find((s) => s.id === currentSessionId)
    if (session && session.messages.length > 0) {
      set({ personSwitchDialogOpen: true, pendingPersonId: personId })
      return
    }
    set({ currentPersonId: personId })
  },

  confirmPersonSwitch: (keepSession) => {
    const { pendingPersonId, currentSessionId, sessions } = get()
    if (pendingPersonId == null) return
    if (!keepSession) {
      set({
        currentPersonId: pendingPersonId,
        pendingPersonId: null,
        personSwitchDialogOpen: false,
        sessions: sessions.map((s) =>
          s.id === currentSessionId ? { ...s, messages: [] } : s,
        ),
      })
    } else {
      set({
        currentPersonId: pendingPersonId,
        pendingPersonId: null,
        personSwitchDialogOpen: false,
      })
    }
  },

  cancelPersonSwitch: () => {
    set({ personSwitchDialogOpen: false, pendingPersonId: null })
  },

  setPersonCreateDialogOpen: (open) => set({ personCreateDialogOpen: open }),

  setActiveResumeId: (id) => set({ activeResumeId: id }),

  addPerson: (person) => {
    const nextId = get().persons.reduce((m, p) => Math.max(m, p.id), 0) + 1
    const full: Person = { ...person, id: nextId }
    set((state) => ({
      persons: [...state.persons, full],
      personStages: { ...state.personStages, [nextId]: freshPersonStages() },
      currentPersonId: nextId,
    }))
    return nextId
  },

  setPersonPersonId: (id, personId) => {
    set((state) => ({
      persons: state.persons.map((p) => (p.id === id ? { ...p, personId } : p)),
    }))
  },

  archivePerson: (personId) => {
    if (personId === get().currentPersonId) return
    set((state) => ({
      persons: state.persons.map((p) =>
        p.id === personId ? { ...p, archived: true } : p,
      ),
    }))
  },

  /** 重置初始化（生命周期 v0.1）：引擎清子资产 + 本地 init 状态回退 pending；manifest/身份保留 */
  resetInitialization: async (personId) => {
    const { persons, currentPersonId } = get()
    const target = persons.find((p) => p.id === personId)
    if (!target?.personId) {
      useToastStore.getState().push('warning', '该档案未落盘引擎，无需重置')
      return
    }
    if (!engine || get().engineStatus !== 'connected') {
      useToastStore.getState().push('warning', '引擎离线：重置需连接引擎')
      return
    }
    try {
      await engine.resetPerson(target.personId)
      set((state) => ({
        persons: state.persons.map((p) => (p.id === personId ? { ...p, initStatus: 'pending' } : p)),
        ...(currentPersonId === personId ? { initSessionState: 'welcome', initCandidates: [] } : {}),
      }))
      useToastStore.getState().push('success', `已重置「${target.name}」的初始化，可重新采集`)
    } catch (err) {
      useToastStore.getState().push('warning', `重置失败：${err instanceof Error ? err.message : String(err)}`)
    }
  },

  /** 完成初始化（用户声明基础信息达到可用状态，非封闭）：manifest init_state → completed；Banner/初始化空间随之消失 */
  completeInitialization: async (personId) => {
    const { persons } = get()
    const target = persons.find((p) => p.id === personId)
    if (!target?.personId) {
      useToastStore.getState().push('warning', '该档案未落盘引擎，无需完成')
      return
    }
    if (!engine || get().engineStatus !== 'connected') {
      useToastStore.getState().push('warning', '引擎离线：完成初始化需连接引擎')
      return
    }
    try {
      await engine.completePersonInit(target.personId)
      set((state) => ({
        persons: state.persons.map((p) => (p.id === personId ? { ...p, initStatus: 'active' } : p)),
      }))
      // Attention：初始化完成 → 引导第一个推理任务（一次事件；方向角标由派生状态持续反映）
      useAttentionStore.getState().addAttention({
        id: 'init-complete',
        level: 'success',
        title: `「${target.name}」基础档案已建立`,
        description: '可以开始探索适合你的职业方向',
        target: { page: 'workbench', view: 'directions' },
        source: 'system',
      })
      useToastStore.getState().push('success', `「${target.name}」职业档案已建立——可从工作台「探索职业方向」开始分析`)
    } catch (err) {
      useToastStore.getState().push('warning', `完成失败：${err instanceof Error ? err.message : String(err)}`)
    }
  },

  /** 物理删除 Person（dev/测试清理）：引擎整目录移除 + 本地状态清理；引擎离线拒绝（本地删除会被 persons/list 复活） */
  deletePerson: async (personId) => {
    const { persons, currentPersonId } = get()
    const target = persons.find((p) => p.id === personId)
    if (!target) return
    if (!engine || get().engineStatus !== 'connected') {
      useToastStore.getState().push('warning', '引擎离线：无法删除（本地删除会在下次同步复活）')
      return
    }
    try {
      if (target.personId) await engine.deletePerson(target.personId)
      const remaining = persons.filter((p) => p.id !== personId)
      set({
        persons: remaining,
        currentPersonId: currentPersonId === personId ? remaining[0]?.id ?? currentPersonId : currentPersonId,
        ...(currentPersonId === personId ? { initSessionState: 'welcome', initCandidates: [] } : {}),
      })
      useToastStore.getState().push('success', `已删除「${target.name}」及其全部资产`)
    } catch (err) {
      useToastStore.getState().push('warning', `删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  },

  toggleAgentPanel: () => {
    const { agentPanelOpen, mainWidthMode, currentPage } = get()
    if (currentPage === 'agent' || currentPage === 'resumes') return
    const nextOpen = !agentPanelOpen
    let nextMode = mainWidthMode
    if (!nextOpen && mainWidthMode === 'narrow') nextMode = 'wide'
    if (nextOpen && mainWidthMode === 'wide') nextMode = 'narrow'
    set({ agentPanelOpen: nextOpen, mainWidthMode: nextMode })
  },

  setAgentPanelOpen: (open) => set({ agentPanelOpen: open }),

  setJdAddOpen: (open) => set({ jdAddOpen: open }),

  setMainWidthMode: (mode) => {
    if (mode === 'fullscreen') {
      set({ mainWidthMode: mode, agentPanelOpen: false })
    } else if (mode === 'wide') {
      set({ mainWidthMode: mode, agentPanelOpen: false })
    } else {
      set({ mainWidthMode: mode, agentPanelOpen: true })
    }
  },

  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

  setAgentDraft: (draft) => set({ agentDraft: draft }),

  setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),

  startAnalysis: (prompt) => {
    set({
      agentPanelOpen: true,
      agentDraft: prompt,
      pendingPrompt: prompt,
      mainWidthMode: 'narrow',
    })
  },

  startAgentTask: (prompt, opts) => {
    // 新任务 = 新现场（不污染现有会话历史）；任务标题作 session 名，可回溯
    get().createSession(opts?.title ?? 'AI 任务')
    set({ agentPanelOpen: true, mainWidthMode: 'narrow' })
    get().sendAgentMessage(prompt, { taskType: opts?.type })
  },

  setInitSessionState: (state) => set({ initSessionState: state }),

  setInitCandidates: (candidates) => set({ initCandidates: candidates }),

  loadInitCandidates: async (personId) => {
    if (!engine || useAppStore.getState().engineStatus !== 'connected') return
    try {
      const list = await engine.listCandidates(personId)
      useAppStore.setState({ initCandidates: list })
    } catch {
      // offline/旧引擎：保持现有
    }
  },

  resolveInitCandidate: async (candidateId, action, modifiedContent) => {
    const pid = pendingInitPersonId()
    if (!pid || !engine || useAppStore.getState().engineStatus !== 'connected') return
    try {
      const res = await engine.resolveCandidate({ personId: pid, candidateId, action, modifiedContent })
      if (res) {
        useAppStore.setState((s) => ({
          initCandidates: s.initCandidates.map((c) =>
            c.id === candidateId
              ? {
                  ...c,
                  status: res.status as InitCandidate['status'],
                  content: action === 'modified' && modifiedContent ? modifiedContent : c.content,
                }
              : c,
          ),
        }))
      }
    } catch {
      // 裁决失败保持现状（可重试）
    }
  },

  /** 初始化会话：Agent 主动进入初始化助手角色——内部指令不外显（silent），输入框保持干净 */
  startInitializationSession: (ctx: {
    personName: string
    sourceMode: 'resume' | 'interview'
    interests?: string[]
    personId?: string
  }) => {
    const { personName, sourceMode, interests, personId } = ctx
    const resumeChannel = sourceMode === 'resume'
    const lines = [
      `你是「${personName}」的初始化助手（${resumeChannel ? '简历通道' : '访谈通道'}）。`,
      '任务：帮助用户建立第一份职业档案（认知基线）——整理"我做过什么 / 掌握什么能力 / 想探索什么方向"，不是替用户做职业决策。',
      '开场白（直接说出，不要分析）："你好，我会帮你建立一份职业档案。这里记录的不只是简历，而是你做过什么、积累了什么能力，以及未来想探索什么方向。这些信息以后会成为职业分析的基础。我们先从你的经历开始。"',
      '上下文隔离（必须遵守）：当前初始化对象是「' + personName + '」，一个全新的 Person——没有历史档案。workspace 中 persons/person_001/（"我"）是另一个人的档案，禁止读取或引用其内容；不要使用全局画像索引作为当前人的数据。只从与用户的对话中采集信息，用户所述以本次对话为准。',
      resumeChannel
        ? personId
          ? `采集：先读取 persons/${personId}/documents/resumes/extraction/ 目录中最新编号（resume-00X 中编号最大）的 resume-*.md 文件——这是用户上传简历的提取结果，从中提取候选事实（教育/经历/技能，标注来源：简历）并逐条向用户展示；若该目录为空，先引导用户粘贴简历文本。再补问简历外的项目与非正式经历。`
          : '采集：先引导用户提供简历（粘贴文本），提取候选事实（教育/经历/技能，标注来源：简历）并逐条向用户展示；再补问简历外的项目与非正式经历。'
        : '采集：渐进式提问，一轮一个问题：教育 → 工作经历 → 项目经历 → 技能 → 约束。',
      '规则：只能提取候选事实（每轮回答后简短说明"我把它整理为候选信息，稍后可在清单里确认"），不能直接写入档案；不要使用"阶段/进度"表述。',
      '候选输出（必须遵守）：每次把信息整理为候选时，回复中必须包含一行标记（直接输出文本行，不要放入代码块或加粗）：候选标记：{类别}｜{内容}｜{来源}。类别只能是：教育、经历、技能、约束、兴趣；来源只能是：用户描述、简历。教育类目必须附加第四段结构化载荷（其余类目省略）：候选标记：教育｜{内容}｜{来源}｜学校=…；专业=…；学历=…；起=…；止=…。学历取值只能是：高中、大专、本科、硕士、博士；学校/专业/年份与内容一致；年份为数字（如 2019）。',
      '示例回复格式：',
      '好的，机械设计本科——我把它整理为候选信息，稍后可在清单里确认。',
      '候选标记：教育｜机械设计制造及其自动化本科｜用户描述｜学校=某大学；专业=机械设计制造及其自动化；学历=本科；起=2015；止=2019',
      '接下来聊聊工作经历：你目前的工作经历是怎样的？',
      '注意：缺少候选标记行 = 该条信息不会被系统收集。',
      '主题推进：聊完一个大主题（如经历）后做一次简短总结："我目前理解你是……，这个理解准确吗？"——用户修正后再进入下一主题。',
      `收尾（用户确认完所有候选后执行）：将用户**已确认**的技能候选（category=技能）写入 persons/${personId}/snapshot/current/skill_inventory.md（快照资产，引擎据此派生 Person.skills；找不到该文件 = 画像技能空白）。文件格式严格如下：`,
      '```markdown',
      '---',
      `id: ${personId}`,
      'status: v1',
      '---',
      '',
      '## 分析摘要',
      '',
      '| 字段 | 值 |',
      '|------|-----|',
      '| skill_count | N |',
      '',
      '## A. 技能清单',
      '',
      '| skill_id | 技能 | level | usage_context |',
      '|----------|------|-------|---------------|',
      '| skill_001 | 机械设计 | applied-professional | 结构设计 |',
      '```',
      '规则：只写用户确认的技能；skill_id 从 skill_001 递增；level 只许 applied-professional / applied-intermediate / applied / applied-basic（对应熟练/胜任/掌握/入门，引擎映射 4/3/3/2，其他词不识别）；语言能力等非专业技能不进技能清单；若该文件已有内容，按用户本次确认结果修订（status 递增 v2、v3…）。',
      ...(personId
        ? [`采集记录：本会话的对话会持续写入 persons/${personId}/intake/session-001.md（原始对话记录）。如果该文件已有内容，先阅读它了解已采集部分并继续；禁止修改该文件（引擎负责写入）。`]
        : []),
      ...(interests && interests.length > 0
        ? [`当前关注方向（用户自报，非决策，仅作背景参考）：${interests.join('、')}。`]
        : []),
    ].join('\n')
    set({
      currentPage: 'agent',
      agentPanelOpen: false,
      mainWidthMode: 'fullscreen',
      initSessionState: 'discovering',
    })
    // 独立会话承载初始化采集（绑定当前人；不污染旧会话/其他任务）
    const initSessionId = get().createSession(`「${personName}」初始化采集`)
    set({ initSessionId })
    get().sendAgentMessage(lines, { silent: true })
  },

  expandToFullAgent: () => {
    set({
      currentPage: 'agent',
      agentPanelOpen: false,
      mainWidthMode: 'fullscreen',
    })
  },

  sendAgentMessage: (content, opts) => {
    const { sessions, engineStatus } = get()
    // Person Capability Gate：当前人初始化中且非初始化会话 → 拒绝新消息（历史可看，发送前拦截）
    const currentPerson = get().currentPerson()
    const gateSessionId = get().currentSessionId
    if (currentPerson.initStatus === 'pending' && gateSessionId !== get().initSessionId) {
      useToastStore.getState().push('warning', `完成「${currentPerson.name}」的基础档案后可继续对话`)
      return
    }
    // 无会话自动创建（Session = 协作现场）：任何发送路径都不丢消息，null 永不进入任务路由
    let sessionId = gateSessionId
    if (!sessionId) sessionId = get().createSession()
    const now = new Date().toISOString()
    if (!opts?.silent) {
      const userMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content,
        timestamp: now,
      }
      set({
        agentDraft: '',
        pendingPrompt: null,
        sessions: sessions.map((s) =>
          s.id === sessionId
            ? { ...s, updatedAt: now, messages: [...s.messages, userMsg] }
            : s,
        ),
      })
    } else {
      // silent：task 进引擎但不渲染 user 消息——Agent 回复成为首条可见消息（主动开场）
      set({ agentDraft: '', pendingPrompt: null })
    }

    // 真实 Agent 流（引擎在线）：task 直接发 prompt，Agent 在 workspace 根自读信息池；
    // 有 SDK 会话凭据则 resume 续接（会话连续性）
    // 单会话单任务：运行中禁止发送由 UI 层保证（输入框禁用），store 不做兜底
    if (engineStatus === 'connected') {
      const session = sessions.find((s) => s.id === sessionId)
      void runAgentTask(sessionId, content, session?.sdkSessionId, opts?.taskType)
      // 初始化会话落盘：用户真实消息追加（silent 的内部指令不落盘）
      const pid = pendingInitPersonId()
      if (pid && !opts?.silent) void appendSessionTurnToEngine(pid, 'user', content)
      return
    }

    // 离线降级：保留演示 mock 回复（不假死）
    const assistantMsg: ChatMessage = {
      id: `msg-${Date.now() + 1}`,
      role: 'assistant',
      content: opts?.silent
        ? '你好，我会帮你建立一份职业档案。这里记录的不只是简历，而是你做过什么、积累了什么能力，以及未来想探索什么方向。\n\n（引擎离线，演示模式：这是模拟开场。连接引擎后即可开始真实采集对话。）\n\n先从你的经历开始：你最高学历是什么？'
        : '已接收你的请求。正在结合 profile、决策链与公司库进行分析…\n\n（引擎离线，演示模式：此处为模拟回复。确认后可写入决策记录。）',
      timestamp: now,
      toolCalls: opts?.silent
        ? []
        : [
            { name: 'read_profile', status: 'done' },
            { name: 'read_decisions', status: 'done' },
          ],
    }
    useAppStore.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, updatedAt: now, messages: [...sess.messages, assistantMsg] }
          : sess,
      ),
    }))
  },

  setCurrentSession: (id) => set({ currentSessionId: id }),

  createSession: (title = '新会话'): string => {
    const id = `s-${Date.now()}`
    const now = new Date().toISOString()
    // 归属当前展示的人（currentPerson().id 而非 currentPersonId：引擎拉取后 id 重排，
    // 裸 currentPersonId 可能漂移导致新会话不进侧栏列表）
    const personId = get().currentPerson().id
    const session: Session = {
      id,
      title,
      personId,
      createdAt: now,
      updatedAt: now,
      archived: false,
      messages: [],
    }
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
    }))
    return id
  },

  cancelCurrentTask: () => {
    const { currentSessionId, sessionTasks } = get()
    const task = sessionTasks[currentSessionId]
    if (!task) return
    void engine?.cancelAgent(task.taskId)
    const route = agentTasks.get(task.taskId)
    if (route) {
      // 占位消息标记停止（内容为空 → 「已停止」；已有流式内容 → 追加停止标记）
      patchStreamingMessage(route.sessionId, route.messageId, (m) => ({
        ...m,
        isThinking: false,
        streaming: false,
        content: m.content === '' ? '（已停止）' : `${m.content}\n\n（已停止）`,
      }))
      agentTasks.delete(task.taskId)
    }
    set((state) => {
      const next = { ...state.sessionTasks }
      delete next[currentSessionId]
      return { sessionTasks: next }
    })
  },

  loadAgentSettings: async () => {
    if (!engine) return
    try {
      const s = await engine.getAgentSettings()
      set({
        agentSettings: {
          model: s.model ?? '',
          apiKey: s.apiKey ?? '',
          baseUrl: s.baseUrl ?? '',
          enabled: s.enabled !== false,
          providers: s.providers ?? [],
          map: s.map ?? { provider: 'amap' },
          documentVision: {
            model: s.document?.vision?.model ?? 'glm-4.6v-flash',
            apiKey: s.document?.vision?.apiKey ?? '',
          },
          permissionMode: s.permissionMode ?? 'bypassPermissions',
        },
      })
    } catch {
      // 离线/引擎未实现：保持现有
    }
  },

  loadAvailableModels: async (params) => {
    if (!engine) return
    try {
      const m = await engine.getAvailableModels(params)
      set({ availableModels: m })
    } catch {
      // 离线：保持空（切换器仅自由输入）
    }
  },

  saveAgentSettings: async (patch) => {
    if (!engine) throw new Error('引擎未连接')
    await engine.updateAgentSettings({
      model: patch.model,
      apiKey: patch.apiKey,
      baseUrl: patch.baseUrl,
      enabled: patch.enabled,
      providers: patch.providers,
      map: patch.map,
      permissionMode: patch.permissionMode,
      ...(patch.documentVision !== undefined
        ? { document: { vision: { provider: 'zhipu' as const, ...patch.documentVision } } }
        : {}),
    })
    set((s) => ({
      agentSettings: {
        model: patch.model !== undefined ? patch.model : s.agentSettings.model,
        apiKey: patch.apiKey !== undefined ? patch.apiKey : s.agentSettings.apiKey,
        baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : s.agentSettings.baseUrl,
        enabled: patch.enabled !== undefined ? patch.enabled : s.agentSettings.enabled,
        providers: patch.providers !== undefined ? patch.providers : s.agentSettings.providers,
        map: patch.map !== undefined ? { ...s.agentSettings.map, ...patch.map } : s.agentSettings.map,
        documentVision:
          patch.documentVision !== undefined
            ? { ...s.agentSettings.documentVision, ...patch.documentVision }
            : s.agentSettings.documentVision,
        permissionMode:
          patch.permissionMode !== undefined ? patch.permissionMode : s.agentSettings.permissionMode,
      },
    }))
  },

  /** 模型切换器：仅内存生效（跟随发送），持久化走 saveAgentSettings。
   * 选模型时同步该模型所属服务商的 apiKey/baseUrl（Agent 任务凭证来源） */
  setAgentModel: (model) =>
    set((s) => {
      const provider = s.agentSettings.providers.find((p) => (p.models ?? []).includes(model))
      return {
        agentSettings: {
          ...s.agentSettings,
          model,
          ...(provider
            ? { apiKey: provider.apiKey ?? '', baseUrl: provider.baseUrl ?? '' }
            : {}),
        },
      }
    }),

  updateApplicationStatus: async (id, status) => {
    if (!engine) throw new Error('引擎未连接')
    const updated = await engine.updateApplicationStatus(id, status)
    set((state) => ({
      applications: state.applications.map((a) => (a.id === id ? updated : a)),
    }))
  },

  createApplication: async ({ jobId, decisionId }) => {
    if (!engine) throw new Error('引擎未连接')
    const personId = get().currentPerson().personId ?? ''
    const app = await engine.createApplication({ jobId, personId, ...(decisionId ? { decisionId } : {}) })
    set((state) => ({ applications: [app, ...state.applications] }))
    return app
  },

  deleteApplication: async (id) => {
    if (!engine) throw new Error('引擎未连接')
    await engine.deleteApplication(id)
    set((state) => ({ applications: state.applications.filter((a) => a.id !== id) }))
  },

  createResumeVersion: ({ name, targetCompany, targetPosition }) => {
    // Person Capability Gate：初始化完成前简历无画像依据，拒绝派生
    const person = get().currentPerson()
    if (person.initStatus === 'pending') {
      useToastStore.getState().push('warning', `完成「${person.name}」的基础档案后可生成简历`)
      return
    }
    const personId = get().currentPersonId
    const id = `r-${Date.now()}`
    // 模板模块：该人第一份版本深拷贝（编辑起点），id 重生成避免冲突
    const template = RESUMES.find((r) => r.personId === personId)
    const modules = (template?.modules ?? []).map((m, i) => ({
      ...m,
      id: `m-${Date.now()}-${i}`,
    }))
    set((state) => ({
      resumes: [
        {
          id,
          name,
          personId,
          updatedAt: new Date().toISOString().slice(0, 10),
          parentId: template?.id,
          targetCompany,
          targetPosition,
          modules,
        },
        ...state.resumes,
      ],
      activeResumeId: id,
    }))
    // Attention：简历派生完成 → 引导查看（操作反馈由 toast 承担，此卡负责「去哪里看」）
    useAttentionStore.getState().addAttention({
      id: `resume-created-${id}`,
      level: 'info',
      title: `简历版本「${name}」已创建`,
      description:
        targetCompany && targetPosition ? `目标：${targetCompany} · ${targetPosition}` : targetCompany ? `目标：${targetCompany}` : undefined,
      target: { page: 'resumes' },
      source: 'system',
    })
    return id
  },

  updateDecision: async (id, fields) => {
    if (!engine) throw new Error('引擎未连接')
    await engine.updateDecision(id, fields)
  },

  createJob: async (params) => {
    if (!engine) throw new Error('引擎未连接')
    // ADR-019 Decision 2：JD 建档不产生投递记录——Application 创建 = 用户显式「开始投递流程」
    return engine.createJob(params)
  },

  matchJob: async (jobId, personName) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.matchJob(jobId, personName)
  },

  fetchConstraintMatch: async (jobId, personId) => {
    if (!engine) return
    try {
      const rows = await engine.constraintMatch(jobId, personId)
      set((state) => ({ constraintRows: { ...state.constraintRows, [jobId]: rows } }))
    } catch {
      // offline：保持现有缓存
    }
  },

  fetchJobCoverage: async (jobId) => {
    if (!engine) return
    try {
      const coverage = await engine.jobCoverage(jobId)
      set((state) => ({ evidenceCoverage: { ...state.evidenceCoverage, [jobId]: coverage } }))
    } catch {
      // offline：保持现有缓存
    }
  },

  fetchClaimCoverage: async (jobId) => {
    if (!engine) return
    try {
      const coverage = await engine.claimCoverage(jobId)
      set((state) => ({ claimCoverage: { ...state.claimCoverage, [jobId]: coverage } }))
    } catch {
      // offline：保持现有缓存
    }
  },

  /** 克隆简历版本（M3.5：新 draft + lineage.parent；watcher 广播后重拉） */
  cloneResume: async (id) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.cloneResume(id)
  },

  /** 状态转移（M3.5：状态机校验；exported 仅 export 链） */
  transitionResume: async (id, targetStatus) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.transitionResume(id, targetStatus)
  },

  /** 导出简历版本（M3.5：ExportRecord 绑定 + status=exported） */
  exportResumeVersion: async (id) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.exportResumeVersion(id)
  },

  /** 版本对比（M3.5：identity diff——claimId 变化 = removed+added，不丢 provenance） */
  diffResumes: async (a, b) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.diffResumes(a, b)
  },

  /** 接受提案（M3.5.6：checksum 强校验 → 确定性应用 → v4；引擎广播后重拉视图） */
  acceptProposal: async (id, reason) => {
    if (!engine) throw new Error('引擎未连接')
    const doc = await engine.acceptProposal(id, reason)
    void pullProposals()
    void pullResumes()
    void pullCareerContext()
    return doc
  },

  /** 拒绝提案（M3.5.6：pending → rejected，审计保留；重新建议 = AI 写新提案） */
  rejectProposal: async (id, reason) => {
    if (!engine) throw new Error('引擎未连接')
    const p = await engine.rejectProposal(id, reason)
    void pullProposals()
    return p
  },

  /** 接受 Portfolio 提案（M4-1：引擎校验 + 确定性应用 + transitions 追加；广播后重拉） */
  acceptPortfolioProposal: async (id, reason) => {
    if (!engine) throw new Error('引擎未连接')
    const project = await engine.acceptPortfolioProposal(id, reason)
    void pullPortfolio()
    return project
  },

  /** 拒绝 Portfolio 提案（M4-1：pending → rejected，审计保留） */
  rejectPortfolioProposal: async (id, reason) => {
    if (!engine) throw new Error('引擎未连接')
    const p = await engine.rejectPortfolioProposal(id, reason)
    void pullPortfolio()
    return p
  },

  /** 接受 Interview 提案（M4-2：引擎校验 + AnswerStatement.text 改写 + status=draft） */
  acceptInterviewProposal: async (id, reason) => {
    if (!engine) throw new Error('引擎未连接')
    const qa = await engine.acceptInterviewProposal(id, reason)
    void pullInterview()
    return qa
  },

  /** 拒绝 Interview 提案（M4-2：pending → rejected，审计保留） */
  rejectInterviewProposal: async (id, reason) => {
    if (!engine) throw new Error('引擎未连接')
    const p = await engine.rejectInterviewProposal(id, reason)
    void pullInterview()
    return p
  },

  /** 接受 Cover Letter 提案（M4-3：引擎校验 + NarrativeUnit.text 适配 + status=draft） */
  acceptCoverLetterProposal: async (id, reason) => {
    if (!engine) throw new Error('引擎未连接')
    const letter = await engine.acceptCoverLetterProposal(id, reason)
    void pullCoverLetter()
    return letter
  },

  /** 拒绝 Cover Letter 提案（M4-3：pending → rejected，审计保留） */
  rejectCoverLetterProposal: async (id, reason) => {
    if (!engine) throw new Error('引擎未连接')
    const p = await engine.rejectCoverLetterProposal(id, reason)
    void pullCoverLetter()
    return p
  },

  /** 表达单元溯源（M4-5.4）：拉取 TraceabilityContext（引擎只读定位，无副作用） */
  loadTraceability: async (scopeId, unitId) => {
    if (!engine) return null
    try {
      const ctx = await engine.getTraceability({ artifact: 'cover-letter', scopeId, unitId })
      useAppStore.setState({ traceability: ctx })
      return ctx
    } catch {
      return null
    }
  },

  deleteJob: async (id) => {
    if (!engine) throw new Error('引擎未连接')
    await engine.deleteJob(id)
    const { selectedJobId } = get()
    if (selectedJobId === id) set({ selectedJobId: null })
  },

  deleteCompany: async (id) => {
    if (!engine) throw new Error('引擎未连接')
    await engine.deleteCompany(id)
    const { selectedCompanyId } = get()
    if (selectedCompanyId === id) set({ selectedCompanyId: null })
  },

  deleteResumeVersion: (id) => {
    const { resumes, activeResumeId } = get()
    const remaining = resumes.filter((r) => r.id !== id)
    set({
      resumes: remaining,
      activeResumeId: activeResumeId === id ? (remaining[0]?.id ?? '') : activeResumeId,
    })
  },

  addDecision: (record) => {
    // Person Capability Gate：初始化完成前决策无画像依据，拒绝写入
    const person = get().currentPerson()
    if (person.initStatus === 'pending') {
      useToastStore.getState().push('warning', `完成「${person.name}」的基础档案后可写入决策`)
      return
    }
    // ADR-008：决策链语义降级——决策写入不推进阶段（决策是分析记录，非流程步骤）。
    // 引擎 connected：真相在引擎（写 md → data.decisions.changed 事件 → pullChains 重拉）。
    set((state) => ({
      decisions: [record, ...state.decisions],
    }))
  },

  markCompanyContacted: (id) => {
    set((state) => ({
      companies: state.companies.map((c) =>
        c.id === id ? { ...c, contacted: true } : c,
      ),
    }))
  },

  setInfopoolFilter: (filter) => set({ infopoolFilter: filter }),

  setCompaniesFilter: (filter) => set({ companiesFilter: filter }),

  setApplicationsFilter: (filter) => set({ applicationsFilter: filter }),

  setLocateTarget: (target) => set({ locateTarget: target }),
  setSelectedJobId: (id) => set({ selectedJobId: id }),
  setSelectedCompanyId: (id) => set({ selectedCompanyId: id }),
  setWorkbenchView: (view) => set({ workbenchView: view }),
  setCompaniesView: (view) => set({ companiesView: view }),
  /** 简历中心三空间切换（M3.5.5） */
  setResumesView: (view) => set({ resumesView: view }),
  setArtifactsView: (view) => set({ artifactsView: view }),
  /** 选中简历版本（M3.5.5：切到 studio 视图并定位） */
  selectResume: (id) => set({ selectedResumeId: id, resumesView: 'studio' }),

  requestPermission: (toolName, description) => {
    const sessionId = get().currentSessionId
    // 会话内已批量放行（'*' 通配 = 本次会话全部工具）或已放行该工具 → 不弹窗，直接放行并反馈
    const approved = get().approvedTools[sessionId]
    if (approved?.includes('*') || approved?.includes(toolName)) {
      appendSystemMessage(sessionId, `已自动放行工具「${toolName}」（会话内已授权）`)
      return Promise.resolve(true)
    }
    set({ pendingPermission: { toolName, description, sessionId } })
    return new Promise<boolean>((resolve) => {
      resolvePending = resolve
    })
  },

  approvePermission: () => {
    const pending = get().pendingPermission
    if (!pending) return
    resolvePending?.(true)
    resolvePending = null
    set({
      pendingPermission: null,
      sessions: patchToolCallStatus(get().sessions, pending, 'done'),
    })
    appendSystemMessage(pending.sessionId, `已放行工具「${pending.toolName}」`)
  },

  denyPermission: () => {
    const pending = get().pendingPermission
    if (!pending) return
    resolvePending?.(false)
    resolvePending = null
    set({
      pendingPermission: null,
      sessions: patchToolCallStatus(get().sessions, pending, 'denied'),
    })
    // permission_denied 不是错误：提示换一种问法，不渲染红色错误
    appendSystemMessage(pending.sessionId, `已拒绝工具「${pending.toolName}」，可换一种问法`)
  },

  approveAllPermissions: () => {
    const pending = get().pendingPermission
    if (!pending) return
    const { approvedTools } = get()
    // '*' 通配：本次会话内后续所有工具请求自动放行（不再逐个弹窗）
    set({
      approvedTools: {
        ...approvedTools,
        [pending.sessionId]: [...(approvedTools[pending.sessionId] ?? []), '*'],
      },
    })
    get().approvePermission()
  },

  /** 演示入口：模拟一次权限请求（真实 LLM 流接入后由 permission_request 事件自动触发） */
  simulatePermissionRequest: (toolName, description) => {
    const sessionId = get().currentSessionId
    // 会话内已批量放行：不再弹窗，直接自动放行反馈
    if (get().approvedTools[sessionId]?.includes(toolName)) {
      void get().requestPermission(toolName, description)
      return
    }
    appendToSession(sessionId, {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: `Agent 请求调用工具「${toolName}」`,
      timestamp: new Date().toISOString(),
      toolCalls: [{ name: toolName, status: 'waiting_approval' }],
    })
    void get().requestPermission(toolName, description)
  },

  /** 演示入口：模拟一次 AskUserQuestion 提问卡片（真实 LLM 流接入后由 Agent 提问触发） */
  simulateQuestionRequest: (question, options) => {
    const now = new Date().toISOString()
    appendToSession(get().currentSessionId, {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: question,
      timestamp: now,
      question: { id: `q-${Date.now()}`, question, options, answered: false },
    })
  },

  answerQuestion: (messageId, answer) => {
    const { sessions, currentSessionId } = get()
    const now = new Date().toISOString()
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: answer,
      timestamp: now,
    }
    set({
      sessions: sessions.map((s) =>
        s.id === currentSessionId
          ? {
            ...s,
            updatedAt: now,
            messages: [
              ...s.messages.map((m) =>
                m.id !== messageId || !m.question
                  ? m
                  : { ...m, question: { ...m.question, answered: true, answer } },
              ),
              userMsg,
            ],
          }
          : s,
      ),
    })
    // 真实 Agent 流：回答送达 Agent。
    // 任务还活着 → answerAgent 即时通道；任务已结束（CLI 提问后立即放弃，实测常态）
    // → resume 原会话续接发送回答（模型在恢复的上下文中看到回答）。
    const active = [...agentTasks.entries()].find(([, t]) => t.sessionId === currentSessionId)
    if (active) {
      void engine?.answerAgent(active[0], answer)
      return
    }
    const session = useAppStore.getState().sessions.find((s) => s.id === currentSessionId)
    const question = sessions
      .find((s) => s.id === currentSessionId)
      ?.messages.find((m) => m.id === messageId)?.question?.question
    if (session?.sdkSessionId !== undefined && question !== undefined) {
      void runAgentTask(currentSessionId, `用户回答了你的问题「${question}」：${answer}。请确认收到并继续。`, session.sdkSessionId)
    }
  },

  startRewrite: async (text, instruction, jdContext) => {
    if (!engine || get().engineStatus !== 'connected') return
    try {
      const { taskId } = await engine.startAgent({ task: buildRewritePrompt(text, instruction, jdContext) })
      rewriteTaskId = taskId
      const selectedTextHash = await sha256Hex(text)
      set({ rewrite: { status: 'thinking', text: '', requestId: taskId, selectedTextHash } })
    } catch (err) {
      set({
        rewrite: {
          status: 'error',
          text: '',
          error: { code: 'unknown', message: err instanceof Error ? err.message : String(err), retryable: true },
        },
      })
    }
  },

  cancelRewrite: () => {
    if (rewriteTaskId !== null) void engine?.cancelAgent(rewriteTaskId)
    rewriteTaskId = null
    set({ rewrite: { status: 'idle', text: '' } })
  },

  resetRewrite: () => {
    rewriteTaskId = null
    set({ rewrite: { status: 'idle', text: '' } })
  },

  /** 2B：rewrite 用户决策事件上报（只记录不学习——契约 Resume-Feedback-Contract-v1） */
  reportRewriteFeedback: (fb: { action: 'apply' | 'reject'; reason?: RewriteFeedbackReason }) => {
    const r = get().rewrite
    if (!engine || get().engineStatus !== 'connected') return
    if (!r.requestId || !r.selectedTextHash) return // 规则候选/非 AI 改写不上报
    void engine.reportRewriteFeedback({
      requestId: r.requestId,
      action: fb.action,
      reason: fb.reason,
      selectedTextHash: r.selectedTextHash,
    })
  },

  exportResume: async (html) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.exportResume(html)
  },
    }),
    // ─── 会话持久化（sessions/currentSessionId/initSessionId 进 partialize）─────────────
    // 刷新恢复语义：sdkSessionId 随会话保存 → 继续发送时 agent/start resume 续接 CLI 上下文。
    // streaming 占位消息（流式中断）恢复时收尾为「连接中断」——重连后引擎任务可能已在后台完成并落盘产物。
    {
      name: 'career-os',
      version: 2,
      // 模型 B（角色 = 人）：旧 schema 是岗位角色，不兼容，直接重置
      migrate: () => undefined,
      // AgentPanel 是会话级 UI 状态，不持久化（丢弃旧 localStorage 值，避免默认展开）
      merge: (persisted, current) => {
        const p = persisted as Record<string, unknown>
        if (p && typeof p === 'object' && 'agentPanelOpen' in p) delete p.agentPanelOpen
        const merged = { ...current, ...(p as object) } as AppState
        // 断流收尾幂等：localStorage 未写回时重复标记结果一致
        return { ...merged, sessions: markInterruptedSessions(merged.sessions) }
      },
      partialize: (s) => ({
        currentPersonId: s.currentPersonId,
        currentPage: s.currentPage,
        mainWidthMode: s.mainWidthMode,
        sessions: s.sessions,
        currentSessionId: s.currentSessionId,
        initSessionId: s.initSessionId,
        resumes: s.resumes,
        decisions: s.decisions,
        companies: s.companies,
        persons: s.persons,
        personStages: s.personStages,
        activeResumeId: s.activeResumeId,
        infopoolFilter: s.infopoolFilter,
        companiesFilter: s.companiesFilter,
        applicationsFilter: s.applicationsFilter,
      }),
      storage: createJSONStorage(() => createDebouncedLocalStorage()),
    },
  ),
)

/** 防抖持久化写：text_delta 流式高频 setState → 300ms 合并写 localStorage；beforeunload 同步 flush 收尾不丢 */
function createDebouncedLocalStorage(): StateStorage {
  const name = 'career-os'
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: string | null = null
  const flush = () => {
    if (timer === undefined || pending === null) return
    clearTimeout(timer)
    timer = undefined
    localStorage.setItem(name, pending)
    pending = null
  }
  window.addEventListener('beforeunload', flush)
  return {
    getItem: (n) => localStorage.getItem(n),
    setItem: (n, value) => {
      pending = value
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        localStorage.setItem(n, pending!)
        pending = null
        timer = undefined
      }, 300)
    },
    removeItem: (n) => localStorage.removeItem(n),
  }
}

/** 刷新恢复：流式占位中（streaming: true）的消息已断流——收尾为「连接中断」，不再假装运行中 */
function markInterruptedSessions(sessions: Session[]): Session[] {
  return sessions.map((s) => ({
    ...s,
    messages: s.messages.map((m) => {
      if (m.role === 'assistant' && m.streaming) {
        return {
          ...m,
          streaming: false,
          isThinking: false,
          content: m.content === '' ? '（连接中断）' : `${m.content}\n\n（连接中断）`,
        }
      }
      return m
    }),
  }))
}

// ─── 引擎接线（桥接联调）：连接 → 拉取真实数据 → 订阅变更信号 ─────────────
// 事件是通知，状态是可拉的资源：data.decisions.changed 只作信号，数据经 RPC 拉取。
// 离线降级：连接失败/断开 → engineStatus offline，UI 保持 mock/现有数据不假死。

let engine: EngineClient | null = null

export function getEngine(): EngineClient | null {
  return engine
}

// ─── 真实 Agent 流（engine agent.event 消费；sessions 已持久化，任务映射 sessionTasks 为运行时态随刷新清空）──

/** 活跃任务：taskId → 所属会话 + 流式占位消息（一次一任务；done/error 清理） */
const agentTasks = new Map<string, { sessionId: string; messageId: string }>()

/** 任务心跳：有任一会话任务时每秒 tick store.now（状态条/会话列表共用时间源）；全空自动停 */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
function ensureHeartbeat(): void {
  if (heartbeatTimer !== null) return
  heartbeatTimer = setInterval(() => {
    const st = useAppStore.getState().sessionTasks
    if (Object.keys(st).length === 0) {
      clearInterval(heartbeatTimer!)
      heartbeatTimer = null
      return
    }
    useAppStore.setState({ now: Date.now() })
  }, 1000)
}

/** 简历 AI 改写任务 id（非会话任务：事件路由到 rewrite 状态而非会话消息） */
let rewriteTaskId: string | null = null

/** 2B：选中原文 SHA-256 截断 16 位（隐私：只存 hash 不存原文，契约 Resume-Feedback-Contract-v1 §4） */
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

/** 改写 prompt：只输出改写文本，避免污染浮层结果 */
function buildRewritePrompt(text: string, instruction: string, jdContext: string): string {
  return [
    '改写下面的简历文本片段，使其更符合目标岗位的招聘标准。',
    jdContext.length > 0 ? `目标岗位上下文：${jdContext}` : '',
    `要求：${instruction}`,
    '只输出改写后的文本本身，不要任何解释、前缀或引用标记。',
    '原文：',
    text,
  ]
    .filter(Boolean)
    .join('\n')
}

/** 流式消息 patch（text_delta 累积 / toolChips 流转，基于现值回调） */
function patchStreamingMessage(
  sessionId: string,
  messageId: string,
  fn: (m: ChatMessage) => ChatMessage,
): void {
  useAppStore.setState((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id === sessionId
        ? { ...sess, messages: sess.messages.map((m) => (m.id === messageId ? fn(m) : m)) }
        : sess,
    ),
  }))
}

/** 初始化会话落盘（切片 2.1）：当前人初始化中 + 引擎在线 → 追加对话轮次到 intake/session-001.md */
async function appendSessionTurnToEngine(personId: string, role: 'user' | 'assistant', content: string): Promise<void> {
  if (!engine || useAppStore.getState().engineStatus !== 'connected') return
  const person = useAppStore.getState().persons.find((p) => p.personId === personId)
  if (!person || person.initStatus !== 'pending') return
  try {
    await engine.appendSessionTurn({ personId, role, content })
  } catch {
    // 落盘失败不打断对话（过程资产，引擎 exists 校验兜底，不阻塞会话）
  }
}

/** 当前人（初始化中且有引擎 person_id）→ 对话轮次可落盘 */
function pendingInitPersonId(): string | undefined {
  const s = useAppStore.getState()
  const person = s.persons.find((p) => p.id === s.currentPersonId)
  return person?.initStatus === 'pending' && person.personId ? person.personId : undefined
}

/** Agent 候选标记行 → Candidate 输入（`候选标记：类别｜内容｜来源｜结构化载荷(可选)`；
 *  类别非法行忽略；教育类目第 4 段 = 键值段：学校=…；专业=…；学历=…；起=…；止=…） */
function parseCandidateMarks(content: string): { category: string; content: string; source: string; payload?: string }[] {
  const out: { category: string; content: string; source: string; payload?: string }[] = []
  const categoryMap: Record<string, string> = {
    教育: 'education',
    经历: 'experience',
    技能: 'skill',
    约束: 'constraint',
    兴趣: 'interest',
  }
  for (const line of content.split('\n')) {
    const m = line.match(/^候选标记：([^｜\n]+)｜(.+?)｜([^｜\n]+)(?:｜(.+))?/)
    if (!m) continue
    const category = categoryMap[m[1]!.trim()]
    if (!category) continue
    const source = m[3]!.trim().includes('简历') ? 'resume' : 'user_reported'
    const payload = m[4]?.trim()
    out.push({ category, content: m[2]!.trim(), source, payload: payload || undefined })
  }
  return out
}

/** 候选落盘 + 投影缓存（extraction/candidates.md append-only；Candidate ≠ Fact） */
async function persistCandidates(personId: string, candidates: { category: string; content: string; source: string; payload?: string }[]): Promise<void> {
  if (!engine || useAppStore.getState().engineStatus !== 'connected') return
  try {
    const added = await engine.appendCandidates({ personId, candidates })
    if (added.length > 0) {
      useAppStore.setState((s) => ({ initCandidates: [...s.initCandidates, ...added] }))
    }
  } catch {
    // 落盘失败不打断对话（候选是过程资产，可后续补齐）
  }
}

/** Agent「岗位分析提交：{JDAnalysisProposal JSON}」行 → Proposal（契约 v0.1：Agent 经此
 *  通道提交分析结果，jobs 写入归 Engine）。
 *  行内贪婪匹配——嵌套 JSON（context/constraints/capabilities 都是对象）非贪婪会在第一个
 *  `}` 截断，必须匹配到行尾最后一个 `}`。JSON 解析失败 → undefined，不打断对话 */
function parseJDAnalysisProposal(content: string): JDAnalysisProposal | undefined {
  for (const line of content.split('\n')) {
    const m = line.match(/岗位分析提交：(\{.*\})/)
    if (!m) continue
    try {
      const p = JSON.parse(m[1]!) as JDAnalysisProposal
      return p?.jobId ? p : undefined
    } catch {
      continue
    }
  }
  return undefined
}

/** 提交岗位分析 → jd/analyze-result → toast（written/skipped/issues） */
async function submitJDAnalysis(proposal: JDAnalysisProposal): Promise<void> {
  if (!engine || useAppStore.getState().engineStatus !== 'connected') return
  try {
    const r = await engine.jdAnalyzeResult(proposal)
    const push = useToastStore.getState().push
    if (r.written) {
      const skipped = r.skipped.length > 0 ? `（跳过 ${r.skipped.length} 项：${r.skipped[0]}）` : ''
      push('success', `岗位分析已写入${skipped}`)
    } else {
      push('info', '岗位分析未写入（无通过校验的字段）')
    }
  } catch {
    // 提交失败不打断对话（分析是过程产物，可后续重新分析）
  }
}

/** 发起真实 Agent 任务：startAgent → 占位消息 → 事件流按 taskId 路由到占位消息 */
async function runAgentTask(sessionId: string, content: string, resumeSessionId?: string, taskType?: string): Promise<void> {
  if (!engine) return
  // 会话内单任务互斥：已有运行中任务则拒绝（同 SDK session 双流会串上下文；UI 输入框已禁用，此处是并发边界校验）
  if (useAppStore.getState().sessionTasks[sessionId]) {
    useToastStore.getState().push('warning', '当前会话已有任务运行中，请等待完成或先停止')
    return
  }
  try {
    const { taskId } = await engine.startAgent({
      task: content,
      ...(useAppStore.getState().currentPerson().personId
        ? { personId: useAppStore.getState().currentPerson().personId }
        : {}),
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      ...(useAppStore.getState().agentSettings.model
        ? { model: useAppStore.getState().agentSettings.model }
        : {}),
      ...(useAppStore.getState().agentSettings.apiKey
        ? { apiKey: useAppStore.getState().agentSettings.apiKey }
        : {}),
      ...(useAppStore.getState().agentSettings.baseUrl
        ? { baseUrl: useAppStore.getState().agentSettings.baseUrl }
        : {}),
    })
    const messageId = `msg-${Date.now()}`
    appendToSession(sessionId, {
      id: messageId,
      role: 'assistant',
      content: '',
      isThinking: true, // 占位即亮指示器；thinking_stop / 首个 text_delta / tool_start 熄灭
      streaming: true, // 流式占位标记：持久化恢复时识别断流消息并收尾
      timestamp: new Date().toISOString(),
    })
    agentTasks.set(taskId, { sessionId, messageId })
    useAppStore.setState((s) => ({
      sessionTasks: {
        ...s.sessionTasks,
        [sessionId]: { taskId, messageId, startedAt: Date.now(), type: taskType },
      },
    }))
    ensureHeartbeat()
  } catch (err) {
    appendToSession(sessionId, {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
      error: { code: 'unknown', message: err instanceof Error ? err.message : String(err), retryable: true },
    })
  }
}

/** 事件处理器（connectEngine 注册一次）：引擎 Agent 事件 → 会话消息流 / 改写浮层 */
function handleAgentEvent(taskId: string, ev: AgentRuntimeEvent): void {
  // 改写任务分叉：事件路由到浮层状态（text_delta 累积改写结果；thinking 仅作状态提示不显示内容）
  if (rewriteTaskId === taskId) {
    switch (ev.type) {
      case 'text_delta':
        useAppStore.setState((s) => ({
          rewrite: { ...s.rewrite, status: 'streaming', text: s.rewrite.text + ev.text },
        }))
        break
      case 'done':
        rewriteTaskId = null
        useAppStore.setState((s) => {
          // R004：Agent 空输出 → empty_output（retryable），不做静默成功
          if (s.rewrite.text.trim().length === 0) {
            return {
              rewrite: {
                ...s.rewrite,
                status: 'error',
                error: { code: 'empty_output', message: '未生成改写内容，请重试', retryable: true },
              },
            }
          }
          return { rewrite: { ...s.rewrite, status: 'done' } }
        })
        break
      case 'error':
        rewriteTaskId = null
        useAppStore.setState((s) => ({ rewrite: { ...s.rewrite, status: 'error', error: ev.error } }))
        break
    }
    return
  }

  const task = agentTasks.get(taskId)
  if (!task) return
  const { sessionId, messageId } = task
  switch (ev.type) {
    case 'text_delta':
      // 无思考直达的轮次：首个文本即熄灭指示器
      patchStreamingMessage(sessionId, messageId, (m) => ({
        ...m,
        isThinking: false,
        content: m.content + ev.text,
      }))
      break
    case 'thinking_start':
      patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, isThinking: true }))
      break
    case 'thinking_delta':
      patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, thinking: (m.thinking ?? '') + ev.text }))
      break
    case 'thinking_stop':
      patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, isThinking: false }))
      break
    case 'tool_start':
      patchStreamingMessage(sessionId, messageId, (m) => ({
        ...m,
        isThinking: false,
        toolCalls: m.toolCalls?.some((t) => t.name === ev.name)
          ? m.toolCalls
          : [...(m.toolCalls ?? []), { name: ev.name, status: 'running' as const }],
      }))
      break
    case 'tool_done':
      patchStreamingMessage(sessionId, messageId, (m) => ({
        ...m,
        toolCalls: m.toolCalls?.map((t) => (t.name === ev.name ? { ...t, status: 'done' as const } : t)),
      }))
      break
    case 'permission_request': {
      // chip 置等待授权 + 弹窗决策（requestPermission 复用批量放行）→ 决策回传引擎
      patchStreamingMessage(sessionId, messageId, (m) => ({
        ...m,
        toolCalls: m.toolCalls?.map((t) =>
          t.name === ev.tool && t.status === 'running'
            ? { ...t, status: 'waiting_approval' as const }
            : t,
        ),
      }))
      void (async () => {
        const allow = await useAppStore.getState().requestPermission(ev.tool, `工具「${ev.tool}」请求执行`)
        void engine?.permissionAgent(taskId, ev.requestId, allow)
      })()
      break
    }
    case 'question_request':
      appendToSession(sessionId, {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: ev.question.question,
        timestamp: new Date().toISOString(),
        question: {
          id: `q-${Date.now()}`,
          question: ev.question.question,
          options: ev.question.options.map((o) => o.label),
          answered: false,
        },
      })
      break
    case 'session_id':
      useAppStore.setState((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId ? { ...sess, sdkSessionId: ev.sessionId } : sess,
        ),
      }))
      break
    case 'done': {
      // 初始化会话落盘：assistant 完整回复追加（delete 前取任务映射）
      const doneTask = agentTasks.get(taskId)
      const pid = pendingInitPersonId()
      if (doneTask) {
        const msg = useAppStore
          .getState()
          .sessions.find((s) => s.id === doneTask.sessionId)
          ?.messages.find((m) => m.id === doneTask.messageId)
        if (msg?.content) {
          // 岗位分析提交（契约 v0.1）：Agent 输出「岗位分析提交：{JSON}」→ jd/analyze-result
          // （所有会话统一处理——JD 分析是普通会话行为）
          const proposal = parseJDAnalysisProposal(msg.content)
          if (proposal) void submitJDAnalysis(proposal)
          if (pid) {
            void appendSessionTurnToEngine(pid, 'assistant', msg.content)
            // 切片 2.2：候选标记行 → extraction/candidates.md → 右侧投影
            const marks = parseCandidateMarks(msg.content)
            if (marks.length > 0) void persistCandidates(pid, marks)
          }
        }
      }
      patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, isThinking: false, streaming: false }))
      agentTasks.delete(taskId)
      useAppStore.setState((s) => {
        const next = { ...s.sessionTasks }
        if (next[task.sessionId]?.taskId === taskId) delete next[task.sessionId]
        return { sessionTasks: next }
      })
      break
    }
    case 'error':
      patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, isThinking: false, streaming: false }))
      appendToSession(sessionId, {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: ev.error.message,
        timestamp: new Date().toISOString(),
        error: ev.error,
      })
      agentTasks.delete(taskId)
      useAppStore.setState((s) => {
        const next = { ...s.sessionTasks }
        if (next[task.sessionId]?.taskId === taskId) delete next[task.sessionId]
        return { sessionTasks: next }
      })
      break
  }
}

async function pullDecisions(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listDecisions()
    useAppStore.setState({ decisions: list })
  } catch {
    // offline：保持现有数据
  }
}

/** 岗位列表（M1：引擎实时派生；jobsChanged 事件驱动重拉）
 *  ADR-019：建档不补投递记录——投递是用户行动事件，由「开始投递流程」创建 */
async function pullJobs(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listJobs()
    useAppStore.setState({ jobs: list })
  } catch {
    // offline：保持现有数据
  }
}

/** 投递记录（ADR-019 Step 4.1：Engine Registry 唯一事实源——applicationsChanged 事件驱动重拉） */
async function pullApplications(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listApplications()
    useAppStore.setState({ applications: list })
  } catch {
    // offline：保持现有数据
  }
}

/** 证据资产（M2）：evidence/list 全量拉取；evidenceChanged 事件驱动重拉 */
async function pullEvidence(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listEvidence()
    useAppStore.setState({ evidence: list })
  } catch {
    // offline：保持现有数据
  }
}

/** Claim 资产（M3-0）：claims/list 全量拉取（含 usable——可消费性引擎派生）；claimsChanged 事件驱动重拉 */
async function pullClaims(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listClaims()
    useAppStore.setState({ claims: list })
  } catch {
    // offline：保持现有数据
  }
}

/** 简历版本（M3.5）：resumes/list 全量拉取；resumesChanged 事件驱动重拉 */
async function pullResumes(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listResumes()
    useAppStore.setState({ resumeVersions: list })
  } catch {
    // offline：保持现有数据
  }
}

/** 提案（M3.5.6）：proposals/list 全量拉取；proposalsChanged 事件驱动重拉 */
async function pullProposals(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listProposals()
    useAppStore.setState({ proposals: list })
  } catch {
    // offline：保持现有数据
  }
}

/** 四 Artifact 类级 Summary（M4-5.1）：artifacts/summaries 拉取；任何 Artifact 域变更事件驱动重拉 */
async function pullArtifactSummaries(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listArtifactSummaries()
    useAppStore.setState({ artifactSummaries: list })
  } catch {
    // offline：保持现有数据
  }
}

/** 四 Artifact 演化 Timeline（M4-5.3）：artifacts/timeline 拉取（引擎已确定性排序，UI 不重排） */
async function pullArtifactTimeline(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listArtifactTimeline()
    useAppStore.setState({ timelineEvents: list })
  } catch {
    // offline：保持现有数据
  }
}

/** Portfolio（M4-1）：projects + proposals 全量拉取；portfolioChanged 事件驱动重拉 */
async function pullPortfolio(): Promise<void> {
  if (!engine) return
  try {
    const [projects, proposals] = await Promise.all([engine.listPortfolioProjects(), engine.listPortfolioProposals()])
    useAppStore.setState({ portfolioProjects: projects, portfolioProposals: proposals })
  } catch {
    // offline：保持现有数据
  }
}

/** Interview（M4-2）：QA + proposals 全量拉取；interviewChanged 事件驱动重拉 */
async function pullInterview(): Promise<void> {
  if (!engine) return
  try {
    const [qas, proposals] = await Promise.all([engine.listInterviewQas(), engine.listInterviewProposals()])
    useAppStore.setState({ interviewQas: qas, interviewProposals: proposals })
  } catch {
    // offline：保持现有数据
  }
}

/** Cover Letter（M4-3）：letters + proposals 全量拉取；coverLetterChanged 事件驱动重拉 */
async function pullCoverLetter(): Promise<void> {
  if (!engine) return
  try {
    const [letters, proposals] = await Promise.all([engine.listCoverLetters(), engine.listCoverLetterProposals()])
    useAppStore.setState({ coverLetters: letters, coverLetterProposals: proposals })
  } catch {
    // offline：保持现有数据
  }
}

/** AI Read Model（M3.5.4）：ai/context 拉取——Studio provenance/validation 数据源；资产变更时重拉 */
async function pullCareerContext(): Promise<void> {
  if (!engine) return
  try {
    const ctx = await engine.aiContext()
    useAppStore.setState({ careerContext: ctx })
  } catch {
    // offline：保持 null（Studio 显示诚实空态）
  }
}

/** 决策聚合视图（V1.5）：引擎实时派生（contexts/list），offline/未建 context 时保持空数组 */
async function pullContexts(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listContexts()
    useAppStore.setState({ contexts: list })
  } catch {
    // offline：保持空数组（聚合视图显示空态，不假死）
  }
}

/** 知识层（V2）：skill 词表 + 岗位档案（knowledge/graph）；RPC 失败 → status error，视图显示"知识层未就绪"空态 */
async function pullKnowledge(): Promise<void> {
  if (!engine) return
  try {
    const graph = await engine.knowledgeGraph()
    useAppStore.setState({ knowledge: { ...graph, status: 'ready' } })
  } catch {
    // 引擎旧代码无 knowledge/graph RPC：置 error，不拿空数据冒充"无档案"
    useAppStore.setState((s) => ({ knowledge: { ...s.knowledge, status: 'error' } }))
  }
}

/** 健康投影（契约 v1）：system/health RPC；失败保持 null（页面 mock 兜底，不假死） */
async function pullHealth(): Promise<void> {
  if (!engine) return
  try {
    const report = await engine.health()
    useAppStore.setState({ health: report })
  } catch {
    // offline/旧引擎：保持 null
  }
}

/** 引擎决策历史分组 → UI DecisionStage（status 语义：该类型是否有合法决策） */
function historyToPersonStages(history: DecisionHistory): DecisionStage[] {
  return history.groups.map((g) => ({
    id: g.type,
    label: g.label,
    status: g.decisionIds.length > 0 ? 'completed' : 'pending',
    ...(g.direction !== undefined ? { direction: g.direction } : {}),
    ...(g.city !== undefined ? { city: g.city } : {}),
    ...(g.decisionIds.length > 0 ? { decisionIds: g.decisionIds } : {}),
    ...(g.updatedAt ? { completedAt: g.updatedAt } : {}),
  }))
}

async function pullHistories(): Promise<void> {
  if (!engine) return
  try {
    const histories = await engine.listHistories()
    const persons = useAppStore.getState().persons
    const next: Record<number, DecisionStage[]> = {}
    for (const history of histories) {
      const person = persons.find((p) => p.name === history.person)
      if (person) next[person.id] = historyToPersonStages(history)
    }
    // 引擎是真相源：整体替换（引擎未建档的人无历史 → 消费方按空处理）
    useAppStore.setState({ personStages: next })
  } catch {
    // offline：保持现有数据
  }
}

async function pullCompanies(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listCompanies()
    useAppStore.setState({ companies: list })
  } catch {
    // offline：保持现有数据
  }
}

/** M6.5：真实主体接入——persons/list 扫描覆盖 mock；空列表保留现状（currentPerson 无空态兜底） */
async function pullPersons(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listPersons()
    if (list.length === 0) return
    // 保护初始化中的本地 Person：引擎 persons/ 尚无对应资产（切片 2 落盘前），不因引擎快照覆盖丢失
    const localPending = useAppStore
      .getState()
      .persons.filter((p) => p.initStatus === 'pending' && !list.some((e) => e.id === p.id))
    useAppStore.setState({ persons: [...list, ...localPending] })
  } catch {
    // offline：保持现有数据
  }
}

async function pullGraph(): Promise<void> {
  if (!engine) return
  try {
    const g = await engine.poolGraph()
    useAppStore.setState({ poolGraph: g })
  } catch {
    // offline：保持 mock
  }
}

// 引擎有效状态跟踪（connecting 不记录）：attention 只在 进入离线（含首屏）触发一次，
// 重连循环 connecting/offline 反复不重复弹卡；恢复在线自动清除
let lastEngineStatus: 'connected' | 'offline' | undefined

export function connectEngine(): void {
  if (engine) return
  engine = createEngineClient()
  engine.on('status', (s) => {
    const status = s as EngineStatus
    useAppStore.setState({ engineStatus: status })
    // Attention：进入离线（首次或从在线跌落）→ 重要提示；恢复后自动清除
    if (status === 'connected') {
      if (lastEngineStatus !== 'connected') {
        if (useAttentionStore.getState().attention?.id === 'engine-offline') {
          useAttentionStore.getState().dismissAttention()
        }
      }
      lastEngineStatus = 'connected'
    } else if (status === 'offline') {
      if (lastEngineStatus !== 'offline') {
        useAttentionStore.getState().addAttention({
          id: 'engine-offline',
          level: 'warning',
          title: '引擎离线——分析功能暂不可用',
          description: '离线期间可浏览数据；Agent 分析与写入需连接引擎。连接恢复后自动继续。',
          target: { page: 'settings' },
          source: 'system',
        })
      }
      lastEngineStatus = 'offline'
    }
    // R002：断线时进行中的改写任务 → transport_error（事件流不会再送达）
    if (s !== 'connected' && rewriteTaskId !== null) {
      rewriteTaskId = null
      useAppStore.setState((st) => ({
        rewrite: {
          ...st.rewrite,
          status: 'error',
          error: { code: 'transport_error', message: '连接中断，未完成改写', retryable: true },
        },
      }))
    }
    if (s === 'connected') {
      void pullDecisions()
      void pullPersons()
      void pullHistories()
      void pullCompanies()
      void pullGraph()
      void pullContexts()
      void pullKnowledge()
      void pullHealth()
      void pullJobs()
      void pullApplications()
      void pullEvidence()
      void pullClaims()
      void pullResumes()
      void pullCareerContext()
      void pullProposals()
      void pullArtifactSummaries()
      void pullArtifactTimeline()
      void pullPortfolio()
      void pullInterview()
      void pullCoverLetter()
      void useAppStore.getState().loadAgentSettings()
      void useAppStore.getState().loadAvailableModels()
    }
  })
  engine.on(EVENTS.decisionsChanged, () => {
    void pullDecisions()
    void pullHistories()
    void pullCompanies()
    void pullGraph()
    void pullContexts()
  })
  engine.on(EVENTS.jobsChanged, () => {
    void pullJobs()
    // 门槛匹配缓存失效：JD 分析写入门槛段后重算（下次打开岗位时重拉）
    useAppStore.setState({ constraintRows: {} })
  })
  engine.on(EVENTS.applicationsChanged, () => {
    void pullApplications()
  })
  engine.on(EVENTS.evidenceChanged, () => {
    void pullEvidence()
    // 覆盖缓存失效：证据变更后按已缓存岗位重算（缓存键清空，下次打开岗位时重拉）
    useAppStore.setState({ evidenceCoverage: {} })
  })
  engine.on(EVENTS.claimsChanged, () => {
    void pullClaims()
    // Claim 表达候选缓存失效：Claim 变更后清空，下次打开岗位时重拉
    useAppStore.setState({ claimCoverage: {} })
  })
  engine.on(EVENTS.resumesChanged, () => {
    void pullResumes()
    void pullCareerContext() // 版本变化影响 Context 投影
  })
  engine.on(EVENTS.proposalsChanged, () => void pullProposals())
  // M4-5.1/5.2/5.3：Artifact 域任一变更 → 数据 + 类级 Summary + Timeline 重拉（UI projection 是派生数据，不缓存局部）
  engine.on(EVENTS.resumesChanged, () => {
    void pullArtifactSummaries()
    void pullArtifactTimeline()
  })
  engine.on(EVENTS.proposalsChanged, () => {
    void pullArtifactSummaries()
    void pullArtifactTimeline()
  })
  engine.on(EVENTS.portfolioChanged, () => {
    void pullPortfolio()
    void pullArtifactSummaries()
    void pullArtifactTimeline()
  })
  engine.on(EVENTS.interviewChanged, () => {
    void pullInterview()
    void pullArtifactSummaries()
    void pullArtifactTimeline()
  })
  engine.on(EVENTS.coverLetterChanged, () => {
    void pullCoverLetter()
    void pullArtifactSummaries()
    void pullArtifactTimeline()
  })
  engine.on(EVENTS.companiesChanged, () => {
    void pullCompanies()
    void pullGraph()
  })
  engine.on(EVENTS.personsChanged, () => {
    // P1 Person Aggregate：identity/career_profile/skill_inventory 变化 → 重拉 persons/list
    //（pullPersons 保护初始化中的本地 Person，不覆盖丢失）
    void pullPersons()
    void pullGraph()
  })
  engine.on(EVENTS.poolChanged, () => void pullGraph())
  engine.onAgentEvent(handleAgentEvent)
  engine.connect()
}
