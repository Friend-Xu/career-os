import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  Application,
  ApplicationStatus,
  ChatMessage,
  Company,
  DecisionRecord,
  DecisionStage,
  FollowupUrgency,
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
  APPLICATIONS,
  COMPANIES,
  DECISIONS,
  PERSONS,
  RESUMES,
  SESSIONS,
  STAGES,
} from '../data/mock-data'
import type { AgentRuntimeEvent, CareerClaim, ClaimCoverageRow, DecisionAggregate, DecisionChain, EvidenceItem, GapResult, JobRecord, Role, Skill, Validation } from '../../engine/ir/schema.ts'
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

// ─── 会话消息写入（权限/提问反馈进对话流；sessions 不持久化，不入 partialize）──

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
  /** 当前运行中的 Agent 任务（sessionId 归属；无任务为 null，不持久化）——停止按钮的驱动源 */
  activeTask: { taskId: string; sessionId: string } | null;
  /** Agent 设置（引擎 config.json 同步；apiKey 留空 = 使用本机 claude CLI 登录态，不持久化） */
  agentSettings: { model: string; apiKey: string; baseUrl: string; enabled: boolean; providers: AgentProviderView[]; map: MapSettings };
  /** 可用模型列表（引擎 settings/models：apiKey 配置时来自 API 提取；模型切换器 options） */
  availableModels: { source: 'api' | 'cli' | 'api_error'; models: string[]; error?: 'auth' | 'no_endpoint' | 'network' };
  applications: Application[];
  /** 显式删除过投递的 jobId（建档自动占位不回补；persist） */
  deletedAppJobIds: string[];
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
  workbenchView: 'dashboard' | 'directions' | 'cities' | 'decisions';
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
  /** 批量放行：sessionId → 本会话内已自动放行的工具名（sessions 不持久化，随会话消亡） */
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
  archivePerson: (personId: number) => void;
  toggleAgentPanel: () => void;
  setAgentPanelOpen: (open: boolean) => void;
  setJdAddOpen: (open: boolean) => void;
  setMainWidthMode: (mode: MainWidthMode) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setAgentDraft: (draft: string) => void;
  setPendingPrompt: (prompt: string | null) => void;
  startAnalysis: (prompt: string) => void;
  expandToFullAgent: () => void;
  sendAgentMessage: (content: string) => void;
  setCurrentSession: (id: string) => void;
  setSelectedCompanyId: (id: string | null) => void;
  setWorkbenchView: (view: 'dashboard' | 'directions' | 'cities' | 'decisions') => void;
  setCompaniesView: (view: 'profile' | 'map') => void;
  /** 简历中心三空间切换（M3.5.5） */
  setArtifactsView: (view: 'assets' | 'proposals' | 'evolution') => void;
  /** 简历中心视图（M3.5.5：三空间） */
  setResumesView: (view: 'workspace' | 'studio' | 'assets') => void;
  /** 选中简历版本（M3.5.5：切到 studio 并定位——Agent/Deep Link/导出跳转共用） */
  selectResume: (id: string) => void;
  createSession: (title?: string) => void;
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
  updateApplicationStatus: (id: number, status: Application['status']) => void;
  /** 新增投递记录（手动录入；id 自动分配，persist 持久化） */
  addApplication: (app: Omit<Application, 'id'>) => void;
  /** 删除投递记录（误操作撤销） */
  deleteApplication: (id: number) => void;
  /** 新建简历版本（选择 JD 派生的壳版本：挂 targetCompany/Position，模块复制模板作为编辑起点） */
  createResumeVersion: (params: { name: string; targetCompany?: string; targetPosition?: string }) => string;
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
      activeTask: null,
      agentSettings: { model: '', apiKey: '', baseUrl: '', enabled: true, providers: [], map: { provider: 'amap' } },
      availableModels: { source: 'cli', models: [] },
      applications: APPLICATIONS,
      deletedAppJobIds: [],
      resumes: RESUMES,
      decisions: DECISIONS,
      contexts: [],
      knowledge: { skills: [], roles: [], status: 'idle' },
      jobs: [],
      evidence: [],
      /** 岗位证据覆盖缓存（jobId → ResponsibilityCoverage[]；M2 层3 三态） */
      evidenceCoverage: {},
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

  archivePerson: (personId) => {
    if (personId === get().currentPersonId) return
    set((state) => ({
      persons: state.persons.map((p) =>
        p.id === personId ? { ...p, archived: true } : p,
      ),
    }))
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

  expandToFullAgent: () => {
    set({
      currentPage: 'agent',
      agentPanelOpen: false,
      mainWidthMode: 'fullscreen',
    })
  },

  sendAgentMessage: (content) => {
    const { sessions, currentSessionId, engineStatus } = get()
    const now = new Date().toISOString()
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
        s.id === currentSessionId
          ? { ...s, updatedAt: now, messages: [...s.messages, userMsg] }
          : s,
      ),
    })

    // 真实 Agent 流（引擎在线）：task 直接发 prompt，Agent 在 workspace 根自读信息池；
    // 有 SDK 会话凭据则 resume 续接（会话连续性）
    // 单会话单任务：运行中禁止发送由 UI 层保证（输入框禁用），store 不做兜底
    if (engineStatus === 'connected') {
      const session = sessions.find((s) => s.id === currentSessionId)
      void runAgentTask(currentSessionId, content, session?.sdkSessionId)
      return
    }

    // 离线降级：保留演示 mock 回复（不假死）
    const assistantMsg: ChatMessage = {
      id: `msg-${Date.now() + 1}`,
      role: 'assistant',
      content:
        '已接收你的请求。正在结合 profile、决策链与公司库进行分析…\n\n（引擎离线，演示模式：此处为模拟回复。确认后可写入决策记录。）',
      timestamp: now,
      toolCalls: [
        { name: 'read_profile', status: 'done' },
        { name: 'read_decisions', status: 'done' },
      ],
    }
    useAppStore.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === currentSessionId
          ? { ...sess, updatedAt: now, messages: [...sess.messages, assistantMsg] }
          : sess,
      ),
    }))
  },

  setCurrentSession: (id) => set({ currentSessionId: id }),

  createSession: (title = '新会话') => {
    const id = `s-${Date.now()}`
    const now = new Date().toISOString()
    const session: Session = {
      id,
      title,
      personId: get().currentPersonId,
      createdAt: now,
      updatedAt: now,
      archived: false,
      messages: [],
    }
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
    }))
  },

  cancelCurrentTask: () => {
    const { activeTask } = get()
    if (!activeTask) return
    void engine?.cancelAgent(activeTask.taskId)
    const task = agentTasks.get(activeTask.taskId)
    if (task) {
      // 占位消息标记停止（内容为空 → 「已停止」；已有流式内容 → 追加停止标记）
      patchStreamingMessage(task.sessionId, task.messageId, (m) => ({
        ...m,
        isThinking: false,
        content: m.content === '' ? '（已停止）' : `${m.content}\n\n（已停止）`,
      }))
      agentTasks.delete(activeTask.taskId)
    }
    set({ activeTask: null })
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
    await engine.updateAgentSettings(patch)
    set((s) => ({
      agentSettings: {
        model: patch.model !== undefined ? patch.model : s.agentSettings.model,
        apiKey: patch.apiKey !== undefined ? patch.apiKey : s.agentSettings.apiKey,
        baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : s.agentSettings.baseUrl,
        enabled: patch.enabled !== undefined ? patch.enabled : s.agentSettings.enabled,
        providers: patch.providers !== undefined ? patch.providers : s.agentSettings.providers,
        map: patch.map !== undefined ? { ...s.agentSettings.map, ...patch.map } : s.agentSettings.map,
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

  updateApplicationStatus: (id, status) => {
    set((state) => ({
      applications: state.applications.map((a) =>
        a.id === id ? { ...a, status } : a,
      ),
    }))
  },

  addApplication: (app) => {
    set((state) => ({
      applications: [
        { ...app, id: Math.max(0, ...state.applications.map((a) => a.id)) + 1 },
        ...state.applications,
      ],
    }))
  },

  deleteApplication: (id) => {
    set((state) => {
      const target = state.applications.find((a) => a.id === id)
      // 显式删除 → 该 job 建档占位不回补（pullJobs 补账跳过）
      const deletedAppJobIds = target?.jobId && !state.deletedAppJobIds.includes(target.jobId)
        ? [...state.deletedAppJobIds, target.jobId]
        : state.deletedAppJobIds
      return {
        applications: state.applications.filter((a) => a.id !== id),
        deletedAppJobIds,
      }
    })
  },

  createResumeVersion: ({ name, targetCompany, targetPosition }) => {
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
    return id
  },

  updateDecision: async (id, fields) => {
    if (!engine) throw new Error('引擎未连接')
    await engine.updateDecision(id, fields)
  },

  createJob: async (params) => {
    if (!engine) throw new Error('引擎未连接')
    const job = await engine.createJob(params)
    // 三模块联动：建档 → 投递空间自动占位「已评估」（同 job 去重；公司占位由引擎建档联带）
    const { currentPersonId, applications } = get()
    if (!applications.some((a) => a.jobId === job.id)) {
      set((state) => ({
        applications: [
          {
            id: Math.max(0, ...state.applications.map((a) => a.id)) + 1,
            personId: currentPersonId,
            company: job.company,
            position: job.title,
            jobId: job.id,
            status: '已评估',
            urgency: 'waiting',
          },
          ...state.applications,
        ],
      }))
    }
    return job
  },

  matchJob: async (jobId, personName) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.matchJob(jobId, personName)
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
    // 引擎 connected：决策真相在引擎（写 md → data.decisions.changed 事件 → pullChains 重拉），
    // 本地只保留内存写入（演示模式不写引擎），不本地推进阶段——避免与引擎派生打架。
    // 引擎 offline：演示模式本地推进（当前 stage 完成 → 下一 pending 置 current）。
    const { currentPersonId, personStages, engineStatus } = get()
    const stages = personStages[currentPersonId]
    let nextStages = stages
    if (engineStatus !== 'connected' && stages) {
      const idx = stages.findIndex((s) => s.status === 'current')
      nextStages = stages.map((s, i) => {
        if (idx >= 0 && i === idx) {
          return {
            ...s,
            status: 'completed' as const,
            completedAt: new Date().toISOString().slice(0, 10),
          }
        }
        if (idx >= 0 && i === idx + 1 && s.status === 'pending') {
          return { ...s, status: 'current' as const }
        }
        return s
      })
    }
    set((state) => ({
      decisions: [record, ...state.decisions],
      personStages: { ...personStages, [currentPersonId]: nextStages },
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
    // 会话内已批量放行 → 不弹窗，直接放行并反馈
    if (get().approvedTools[sessionId]?.includes(toolName)) {
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
    set({
      approvedTools: {
        ...approvedTools,
        [pending.sessionId]: [...(approvedTools[pending.sessionId] ?? []), pending.toolName],
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
    {
      name: 'career-os',
      version: 2,
      // 模型 B（角色 = 人）：旧 schema 是岗位角色，不兼容，直接重置
      migrate: () => undefined,
      // AgentPanel 是会话级 UI 状态，不持久化（丢弃旧 localStorage 值，避免默认展开）
      merge: (persisted, current) => {
        const p = persisted as Record<string, unknown>
        if (p && typeof p === 'object' && 'agentPanelOpen' in p) delete p.agentPanelOpen
        return { ...current, ...(p as object) }
      },
      partialize: (s) => ({
        currentPersonId: s.currentPersonId,
        currentPage: s.currentPage,
        mainWidthMode: s.mainWidthMode,
        applications: s.applications,
        deletedAppJobIds: s.deletedAppJobIds,
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
    },
  ),
)

// ─── 引擎接线（桥接联调）：连接 → 拉取真实数据 → 订阅变更信号 ─────────────
// 事件是通知，状态是可拉的资源：data.decisions.changed 只作信号，数据经 RPC 拉取。
// 离线降级：连接失败/断开 → engineStatus offline，UI 保持 mock/现有数据不假死。

let engine: EngineClient | null = null

export function getEngine(): EngineClient | null {
  return engine
}

// ─── 真实 Agent 流（engine agent.event 消费；sessions 不持久化，任务映射随会话消亡）──

/** 活跃任务：taskId → 所属会话 + 流式占位消息（一次一任务；done/error 清理） */
const agentTasks = new Map<string, { sessionId: string; messageId: string }>()

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

/** 发起真实 Agent 任务：startAgent → 占位消息 → 事件流按 taskId 路由到占位消息 */
async function runAgentTask(sessionId: string, content: string, resumeSessionId?: string): Promise<void> {
  if (!engine) return
  try {
    const { taskId } = await engine.startAgent({
      task: content,
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
      timestamp: new Date().toISOString(),
    })
    agentTasks.set(taskId, { sessionId, messageId })
    useAppStore.setState({ activeTask: { taskId, sessionId } })
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
    case 'done':
      patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, isThinking: false }))
      agentTasks.delete(taskId)
      if (useAppStore.getState().activeTask?.taskId === taskId) useAppStore.setState({ activeTask: null })
      break
    case 'error':
      patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, isThinking: false }))
      appendToSession(sessionId, {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: ev.error.message,
        timestamp: new Date().toISOString(),
        error: ev.error,
      })
      agentTasks.delete(taskId)
      if (useAppStore.getState().activeTask?.taskId === taskId) useAppStore.setState({ activeTask: null })
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
 *  三模块联动补账：无投递占位且未被显式删除的 JD → 自动补「已评估」占位记录 */
async function pullJobs(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listJobs()
    const { currentPersonId, applications, deletedAppJobIds } = useAppStore.getState()
    const missing = list.filter(
      (j) => !applications.some((a) => a.jobId === j.id) && !deletedAppJobIds.includes(j.id),
    )
    let apps = applications
    if (missing.length > 0) {
      const maxId = Math.max(0, ...applications.map((a) => a.id))
      apps = [
        ...missing.map((j, i) => ({
          id: maxId + 1 + i,
          personId: currentPersonId,
          company: j.company,
          position: j.title,
          jobId: j.id,
          status: '已评估' as ApplicationStatus,
          urgency: 'waiting' as FollowupUrgency,
        })),
        ...applications,
      ]
    }
    useAppStore.setState({ jobs: list, applications: apps })
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

/** 引擎决策链 6 阶段中文名 → UI DecisionStage.id */
const STAGE_ID_BY_NAME: Record<DecisionChain['stages'][number]['stage'], string> = {
  方向探索: 'direction',
  转行评估: 'transfer',
  城市评估: 'city',
  公司筛选: 'company',
  JD分析: 'jd',
  简历定制: 'resume',
}

/** 引擎链投影 → UI 阶段（label 直接用引擎中文名；direction/city 挂在当前阶段） */
function chainToPersonStages(chain: DecisionChain): DecisionStage[] {
  return chain.stages.map((s) => ({
    id: STAGE_ID_BY_NAME[s.stage],
    label: s.stage,
    status: s.status,
    ...(s.direction !== undefined ? { direction: s.direction } : {}),
    ...(s.city !== undefined ? { city: s.city } : {}),
    ...(s.decisionIds !== undefined ? { decisionIds: s.decisionIds } : {}),
  }))
}

async function pullChains(): Promise<void> {
  if (!engine) return
  try {
    const chains = await engine.listChains()
    const persons = useAppStore.getState().persons
    const next: Record<number, DecisionStage[]> = {}
    for (const chain of chains) {
      const person = persons.find((p) => p.name === chain.person)
      if (person) next[person.id] = chainToPersonStages(chain)
    }
    // 引擎是真相源：整体替换（引擎未建档的人无链 → 消费方按空链处理）
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

async function pullGraph(): Promise<void> {
  if (!engine) return
  try {
    const g = await engine.poolGraph()
    useAppStore.setState({ poolGraph: g })
  } catch {
    // offline：保持 mock
  }
}

export function connectEngine(): void {
  if (engine) return
  engine = createEngineClient()
  engine.on('status', (s) => {
    useAppStore.setState({ engineStatus: s as EngineStatus })
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
      void pullChains()
      void pullCompanies()
      void pullGraph()
      void pullContexts()
      void pullKnowledge()
      void pullHealth()
      void pullJobs()
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
    void pullChains()
    void pullCompanies()
    void pullGraph()
    void pullContexts()
  })
  engine.on(EVENTS.jobsChanged, () => void pullJobs())
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
  engine.on(EVENTS.poolChanged, () => void pullGraph())
  engine.onAgentEvent(handleAgentEvent)
  engine.connect()
}
