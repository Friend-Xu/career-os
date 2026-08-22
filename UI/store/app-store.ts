import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { useToastStore } from './toast-store'
import { useAttentionStore } from './attention-store'
import { hasAgentPanelZone } from '../utils/agent-panel'
import type {
  Application,
  ApplicationView,
  ChatMessage,
  Company,
  DecisionRecord,
  DecisionStage,
  HealthReport,
  MainWidthMode,
  NavPageId,
  PendingPermission,
  Person,
  ResumeModule,
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
import type { AgentRuntimeEvent, CareerClaim, ClaimCoverageRow, CandidatePoolEntry, ConstraintMatchRow, DecisionAggregate, DecisionHistory, EvidenceItem, GapResult, InitCandidate, JDAnalysisProposal, JobLead, JobRecord, Role, SalaryBenchmarkEntry, Skill, Validation, PersonHealth, PromotionEvent } from '../../engine/ir/schema.ts'
import type { SalaryValuationCard } from '../../engine/ir/salary.ts'
import type { ResumeDocument, ResumeStatus, ResumeExportRecord, ResumeProposal } from '../../engine/ir/resume.ts'
import type { WorkingCopy } from '../../engine/ir/resume.ts'
import type { ClaimProposal } from '../../engine/storage/claim-proposal-registry.ts'
import type { WorkingCopyInput } from '../../engine/storage/working-copy-registry.ts'
import type { DecisionNarrativeDraft } from '../../engine/storage/decision-writer.ts'
import { buildSkeletonModules } from '../utils/resume-working-copy'
import type { PortfolioProject, PortfolioProposal } from '../../engine/ir/portfolio.ts'
import type { InterviewQa, InterviewProposal } from '../../engine/ir/interview.ts'
import type { CoverLetter, CoverLetterProposal } from '../../engine/ir/cover-letter.ts'
import type { ArtifactSummary } from '../../engine/ir/artifact-summary.ts'
import type { ArtifactTimelineEvent } from '../../engine/ir/artifact-timeline.ts'
import type { TraceabilityContext } from '../../engine/ir/traceability.ts'
import type { ResumeDiff } from '../../engine/storage/resume-watcher.ts'
import type { WorkflowState } from '../../engine/storage/workflow-registry.ts'
import type { StageArtifact } from '../../engine/ir/schema.ts'
import type { CareerContext } from '../../engine/ir/context.ts'
import type { AgentTaskRequest } from '../../engine/ir/agent-task.ts'
import type { ResponsibilityCoverage } from '../../engine/runtime/evidence-coverage.ts'
import type { ResponsibilityCandidates } from '../../engine/runtime/claim-selector.ts'
import type { ResumeAlignmentProjection } from '../../engine/runtime/resume-alignment.ts'
import type { Opportunity } from '../../engine/runtime/opportunity.ts'
import type { JDMatchScore } from '../../engine/runtime/jd-match-score.ts'
import type { OpportunityProposal } from '../../engine/storage/opportunity-proposal-registry.ts'
import type { StrengthProposal } from '../../engine/storage/strength-proposal-registry.ts'
import type { DerivationProposal } from '../../engine/storage/derivation-proposal-registry.ts'
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

/** 简历工作台视图（ADR-021 R0：Dashboard 落地页 + 四空间——编辑/优化/历史/素材） */
export type ResumeWorkspaceView = 'dashboard' | 'edit' | 'optimize' | 'history' | 'library'

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
  /** 后台 agent 任务（非会话簿记——CLI 桥类任务：机会提案/优势总结；done/error 时清除） */
  backgroundTasks: Record<string, { type: string; startedAt: number }>;
  /** 任务心跳时间源（有任务时每秒 tick；消息内/顶部状态条/会话列表共用，不持久化） */
  now: number;
  /** Agent 设置（引擎 config.json 同步；apiKey 留空 = 使用本机 claude CLI 登录态，不持久化） */
  agentSettings: { model: string; apiKey: string; baseUrl: string; enabled: boolean; providers: AgentProviderView[]; map: MapSettings; documentVision: { model: string; apiKey: string }; permissionMode: string };
  /** 可用模型列表（引擎 settings/models：apiKey 配置时来自 API 提取；模型切换器 options） */
  availableModels: { source: 'api' | 'cli' | 'api_error'; models: string[]; error?: 'auth' | 'no_endpoint' | 'network' };
  /** 投递记录视图（ADR-019：用户行动事实资产，引擎 applications/list 实时派生，不持久化——Engine Registry 是唯一事实源；allowedTransitions 随 RPC 返回） */
  applications: ApplicationView[];
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
  /** 岗位匹配度（契约 jd-match-score-contract-v0.1：规则合成投影，缓存 jobMatchScores[jobId]） */
  jobMatchScores: Record<string, JDMatchScore>;
  /** Claim 资产（M3-0）：表达 IR 全量条目（claims/ 目录，引擎实时派生 + usable——可消费性引擎推导） */
  claims: (CareerClaim & { usable: boolean })[];
  /** Claim 提案（P1.1）：claim-proposals/ 引擎实时派生（待确认表达——用户确认后登记为 Claim） */
  claimProposals: ClaimProposal[];
  strengthProposals: StrengthProposal[];
  /** 简历派生提案（优化空间派生模式）：derivation-proposals/ 引擎实时派生（整份派生候选——用户裁决后建副本） */
  derivationProposals: DerivationProposal[];
  /** 工作副本（ADR-023 P2.2）：resumes/working-copies/ 引擎实时派生（用户创作对象——编辑空间数据源） */
  workingCopies: WorkingCopy[];
  /** 当前编辑对象（P2.3：编辑空间读写的工作副本 id） */
  activeWorkingCopyId: string | null;
  /** 工作流（Career Workflow Contract v0.1）：workflows/ 引擎单方写，UI 只投影 + Human Action */
  workflows: WorkflowState[];
  /** 方向池投影（v0.2：workflowId → StageArtifact[]，Store 层按 workflow scope 管理——Artifact 归属 workflow_id+stage_id，
   *  组件按 active workflow 取 key，不做跨 workflow 过滤；person/directions/list 引擎实时派生） */
  directionsByWorkflow: Record<string, StageArtifact[]>;
  /** 评估明细投影（v0.3：workflowId → StageArtifact[]，同方向池 scope 管理；person/evaluations/list 引擎实时派生） */
  evaluationsByWorkflow: Record<string, StageArtifact[]>;
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
  /** 候选池（公司适配榜候选层；引擎 candidates/list） */
  candidates: CandidatePoolEntry[];
  /** 岗位线索（公司适配榜投递层；引擎 job-leads/list） */
  jobLeads: JobLead[];
  /** 薪资基准（二期 §7；引擎 salary-benchmarks/list） */
  salaryBenchmarks: SalaryBenchmarkEntry[];
  /** 个人估价卡投影（二期 §7.5；引擎 salary-benchmarks/valuation——三态对照 + 缺数据状态） */
  valuationCard: SalaryValuationCard | null;
  persons: Person[];
  /** Person Health（ADR-031：key = personId；单一计算源——UI 只投影 verdict，不发明健康判定） */
  personHealths: Record<string, PersonHealth>;
  /** Promotion 列表（ADR-032：key = personId；用户选定事实——Decision → User Choice → Domain Fact） */
  promotionsByPerson: Record<string, PromotionEvent[]>;
  personStages: Record<number, DecisionStage[]>;
  agentDraft: string;
  pendingPrompt: string | null;
  /** ADR-020：预置动作携带的 TaskRequest（startAnalysis 暂存，发送时合并——trigger 固定 user_action） */
  pendingTaskRequest?: AgentTaskRequest;
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
  /** 简历工作台视图（ADR-021 R0：Dashboard 落地页 + 四空间——编辑/优化/历史/素材） */
  resumeWorkspaceView: ResumeWorkspaceView;
  /** 优化空间子模式（诊断 = 逐条提案 / 派生 = 整份重写提案；Dashboard 深链入口可直达派生 tab） */
  resumeOptimizeMode: 'diagnose' | 'derive';
  /** 优化空间目标岗位深链意图（JD 空间「优化简历」按钮写入；优化空间挂载时消费并清除——一次性导航语义，不持久化） */
  resumeOptimizeJobId: string | null;
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
  companiesView: 'profile' | 'map' | 'leaderboard';
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
  /** 发起工作流（Career Workflow Contract v0.1）：workflow/start（Goal + Stage 1；Path A/B 由引擎判定） */
  startWorkflow: (statement: string) => Promise<void>;
  /** 用户确认 Gate 推进（workflow/advance：四步校验，失败拒绝 + toast 缺件） */
  advanceWorkflow: (workflowId: string, gateId?: string) => Promise<void>;
  /** 用户终止工作流（workflow/abort） */
  abortWorkflow: (workflowId: string) => Promise<void>;
  /** 方向裁决（v0.2：person/directions/resolve——UI 只表达 Human Action，状态机判定归引擎；
   *  同动作幂等成功 / 反动作 ALREADY_RESOLVED / 终态不可逆；结果经 workflowChanged → pullDirections 重投影） */
  resolveDirection: (directionId: string, action: 'confirm' | 'reject') => Promise<void>;
  /** 重新执行当前 Stage（v0.2 §4.2：waiting_gate(gate≠passed)/failed 出口——UI 不模拟 abort+start，
   *  restage 是 Engine 业务动作；方向池 append-only 不重置，DIRECTION_POOL_STATE 由引擎注入 Stage 任务） */
  restageWorkflow: (workflowId: string) => Promise<void>;
  toggleAgentPanel: () => void;
  setAgentPanelOpen: (open: boolean) => void;
  setJdAddOpen: (open: boolean) => void;
  setMainWidthMode: (mode: MainWidthMode) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setAgentDraft: (draft: string) => void;
  setPendingPrompt: (prompt: string | null) => void;
  startAnalysis: (prompt: string, taskRequest?: AgentTaskRequest) => void;
  /** 任务启动入口（工作台 Action）：新 Session（主题现场）+ 立即执行——按钮即意图，不等用户二次确认；
   *  type=任务识别（P2 状态条显示）；与 sendAgentMessage（聊天入口，当前现场）职责分离 */
  startAgentTask: (prompt: string, opts?: { type?: string; title?: string; taskRequest?: AgentTaskRequest }) => void;
  expandToFullAgent: () => void;
  /** silent=true：task 进引擎但不渲染为 user 消息——Agent 回复成为首条可见消息（Agent 主动开场）；taskType=任务识别（P2 状态显示）
   *  executionContext 双平面（BUG-010 裁决）：conversation=用户主动对话（受 Person Capability Gate）；
   *  workflow_stage=Workflow Stage 执行（控制平面任务，授权来源=用户创建 workflow——只受 Stage evaluator/gate 约束，不经过对话能力门禁） */
  sendAgentMessage: (content: string, opts?: { silent?: boolean; taskType?: string; taskRequest?: AgentTaskRequest; stageRef?: { workflowId: string; stageId: string }; executionContext?: 'conversation' | 'workflow_stage'; allowedTools?: string[] }) => void;
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
  /** 候选生成中（P0-1 确定性通道：简历/访谈 → Facts → Inbox；防重复触发） */
  generatingCandidates: boolean;
  /** 候选生成（P0-1 确定性通道）：source=resume（简历通道）| interview（无简历访谈通道）；
   *  返回新增候选数（内容去重幂等） */
  generateCandidatesFor: (personId: string, source: 'resume' | 'interview') => Promise<number>;
  /** Person Health（ADR-031）：单一计算源拉取当前人健康（UI 只投影 verdict） */
  pullPersonHealth: (personId: string) => Promise<void>;
  /** Promotion（ADR-032）：拉取当前人选定事实列表（UI 只投影，不判定） */
  pullPromotions: (personId: string) => Promise<void>;
  /** 设为求职目标城市（用户动作 → 引擎校验候选命中决策） */
  promoteCity: (personId: string, decisionId: string, city: string) => Promise<boolean>;
  /** 撤回目标城市（revoke，历史保留） */
  revokePromotion: (personId: string, promotionId: string) => Promise<boolean>;
  /** 候选裁决（切片 2.3）：确认/拒绝/修改 → candidates.md + resolution 事件 + 本地投影更新 */
  resolveInitCandidate: (
    candidateId: string,
    action: 'confirmed' | 'rejected' | 'modified',
    modifiedContent?: string,
  ) => Promise<void>;
  setCurrentSession: (id: string) => void;
  setSelectedCompanyId: (id: string | null) => void;
  setWorkbenchView: (view: 'dashboard' | 'directions' | 'cities' | 'decisions' | 'profile') => void;
  setCompaniesView: (view: 'profile' | 'map' | 'leaderboard') => void;
  /** 简历中心三空间切换（M3.5.5） */
  setArtifactsView: (view: 'assets' | 'proposals' | 'evolution') => void;
  /** 简历工作台视图切换（ADR-021 R0：四空间——编辑/优化/历史/素材；Dashboard 为默认落地不占 tab） */
  setResumeWorkspaceView: (view: ResumeWorkspaceView) => void;
  /** 切换优化空间子模式（诊断/派生） */
  setResumeOptimizeMode: (mode: 'diagnose' | 'derive') => void;
  setResumeOptimizeJobId: (jobId: string | null) => void;
  /** 选中简历版本（M3.5.5：切到历史空间并定位——Agent/Deep Link/导出跳转共用） */
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
  createApplication: (params: { jobId: string; decisionId?: string }) => Promise<ApplicationView>;
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
  /** 岗位匹配度（规则合成投影；结果缓存 jobMatchScores[jobId]） */
  fetchJobMatchScore: (jobId: string, personId: string) => Promise<void>;
  /** 岗位证据覆盖（M2：evidenceExpectations × Inventory，三态；结果缓存 evidenceCoverage[jobId]） */
  fetchJobCoverage: (jobId: string) => Promise<void>;
  /** 岗位 Claim 表达候选（M3-1：responsibility → 关联 trusted evidence → 可消费 Claims；缓存 claimCoverage[jobId]） */
  fetchClaimCoverage: (jobId: string) => Promise<void>;
  /** 提交决策叙述（M7：引擎写 decisions/ → 返回 decisionId；成功 toast「决策记录已写入」，失败 toast 错误信息） */
  submitDecisionNarrative: (params: { jobId: string; personId: string; narrative?: DecisionNarrativeDraft }) => Promise<{ decisionId: string }>;
  /** 岗位表达候选（M7：直通 engine.claimSelect——组件持本地 state，store 不缓存） */
  fetchClaimCandidates: (jobId: string) => Promise<ResponsibilityCandidates[]>;
  /** 克隆简历版本（M3.5：新 draft + lineage.parent + createdBy=user） */
  cloneResume: (id: string) => Promise<ResumeDocument>;
  /** 状态转移（M3.5：状态机校验 + operations 审计；exported 仅 export 链） */
  transitionResume: (id: string, targetStatus: ResumeStatus) => Promise<ResumeDocument>;
  /** 导出简历版本（M3.5：exportResumePdf + ExportRecord + status=exported；与旧 HTML 导出 exportResume 区分） */
  exportResumeVersion: (id: string) => Promise<{ result: { pdf: string; fileName: string }; record: ResumeExportRecord }>;
  /** Resume Alignment Projection（R2.2：四态矩阵——纯投影不落盘） */
  fetchResumeAlignment: (resumeId: string, jobId: string) => Promise<ResumeAlignmentProjection>;
  /** 版本对比（M3.5：identity diff） */
  diffResumes: (a: string, b: string) => Promise<ResumeDiff>;
  /** 接受提案（M3.5.6：引擎确定性应用 → 新版本；成功即产生 v4；reason 可选——M3.5.7 决策反馈） */
  acceptProposal: (id: string, reason?: string) => Promise<ResumeDocument>;
  /** 拒绝提案（M3.5.6：pending → rejected，可选原因；单向不 reopen） */
  rejectProposal: (id: string, reason?: string) => Promise<ResumeProposal>;
  /** 确认 Claim 提案（P1.1：二次校验 → 登记为表达资产 → { claimId }） */
  approveClaimProposal: (id: string) => Promise<{ claimId: string }>;
  /** 拒绝 Claim 提案（P1.1：丢弃，审计保留） */
  rejectClaimProposal: (id: string) => Promise<ClaimProposal>;
  /** 工作副本 upsert（P2.3：revision 协商——conflict 抛错，调用方提示合并） */
  upsertWorkingCopy: (input: WorkingCopyInput) => Promise<void>;
  /** 优势亮点 upsert（Summary Strength Contract v0.2：profile 引用型资产——保存 = 用户确认） */
  upsertSummaryStrengths: (personId: string, items: { text: string; claimIds: string[]; evidenceIds: string[] }[]) => Promise<void>;
  /** 优势亮点提案全量（Summary Strength Contract v0.2 §3：AI 总结候选——accept/reject 需用户裁决） */
  listStrengthProposals: (personId?: string) => Promise<StrengthProposal[]>;
  /** 优势提案裁决（accept → 并入优势亮点；reject → 审计保留） */
  decideStrengthProposal: (id: string, action: 'accept' | 'reject', reason?: string) => Promise<StrengthProposal>;
  /** 启动 AI 总结任务（agent CLI 桥：--strength-context 读池 → 候选 → --strength-submit 提交） */
  generateStrengthProposals: (personId: string) => Promise<string>;
  /** 派生提案全量（优化空间派生模式：owner/sourceWcId/jobId 过滤） */
  listDerivationProposals: (filter?: { owner?: string; sourceWcId?: string; jobId?: string }) => Promise<DerivationProposal[]>;
  /** 派生提案裁决（accept → 引擎创建新工作副本；reject → 审计保留） */
  decideDerivationProposal: (id: string, action: 'accept' | 'reject', reason?: string) => Promise<DerivationProposal>;
  /** 启动派生任务（agent CLI 桥：--derive-context 读池 → 整份派生候选 → --derive-submit 提交） */
  generateDerivation: (wcId: string, jobId: string) => Promise<string>;
  /** 取消后台任务（agent/cancel RPC + backgroundTasks 清理——CLI 桥类任务无会话簿记） */
  cancelBackgroundTask: (taskId: string) => Promise<void>;
  /** 创建版本（P2.3：promote → ResumeDocument Candidate） */
  promoteWorkingCopy: (id: string) => Promise<ResumeDocument>;
  /** 切换当前编辑对象（P2.3） */
  setActiveWorkingCopy: (id: string | null) => void;
  /** 工作副本对齐投影（P2.4：优化输入 = 当前创作对象——非版本选择） */
  fetchWorkingCopyAlignment: (wcId: string, jobId: string) => Promise<ResumeAlignmentProjection>;
  /** 工作副本机会投影（P3.2：一等对象「为什么值得改」） */
  fetchWorkingCopyOpportunities: (wcId: string, jobId: string) => Promise<Opportunity[]>;
  /** 机会 Proposal 全量（P3.3） */
  listOpportunityProposals: () => Promise<OpportunityProposal[]>;
  /** Claim 提案全量（P5.3：RPC 拉取——CLI 提交不经事件广播，轮询完成信号必须走 RPC） */
  listClaimProposals: () => Promise<ClaimProposal[]>;
  /** 生成改写候选（P3.6：机会 → agent 任务 → 候选登记） */
  generateOpportunityProposals: (opportunityId: string, wcId: string, personId: string) => Promise<string>;
  /** 采用机会 Proposal（P3.7：pending → approved——approve ≠ apply） */
  approveOpportunityProposal: (id: string) => Promise<OpportunityProposal>;
  /** 拒绝机会 Proposal（P3.7：pending → rejected——单向不 reopen） */
  rejectOpportunityProposal: (id: string, reason?: string) => Promise<OpportunityProposal>;
  /** 应用到简历（P3.8：approved → apply——revision check → 原子写盘；conflict 返回协作冲突非错误） */
  applyOpportunityProposal: (id: string) => Promise<
    { status: 'applied'; transactionId: string; newRevision: number } | { status: 'conflict'; transactionId: string; reason: string; expectedRevision: number; currentRevision: number }
  >;
  /** 生成资产化候选（P5.3：机会 → agent 任务 → ClaimProposal 登记 pending——AI 提供候选，用户决定资产） */
  generateAssetCandidate: (opportunityId: string, wcId: string, evidenceIds: string[], personId: string) => Promise<string>;
  /** 绑定 Claim 到工作副本块（P5.3：approve 后——Claim 已生成 ≠ 已绑定；conflict 可重试；幂等） */
  bindClaim: (wcId: string, blockId: string, claimId: string) => Promise<{
    status: 'bound' | 'conflict' | 'failed'
    claimId: string
    wcRevisionBefore: number
    wcRevisionAfter?: number
  }>;
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
  /** 草稿模块内容写回（R0 修复：编辑内容切页不丢——modules 本地 state 与 store 同步） */
  updateResumeModules: (id: string, modules: ResumeModule[]) => void;
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
      backgroundTasks: {},
      now: Date.now(),
      agentSettings: { model: '', apiKey: '', baseUrl: '', enabled: true, providers: [], map: { provider: 'amap' }, documentVision: { model: 'glm-4.6v-flash', apiKey: '' }, permissionMode: 'bypassPermissions' },
      availableModels: { source: 'cli', models: [] },
      applications: [],
      deletedAppJobIds: [],
      resumes: [], // mock RESUMES 已退出（导航/画像/简历页全部消费引擎 resumeVersions；保留字段兼容旧 persist）
      decisions: DECISIONS,
      contexts: [],
      knowledge: { skills: [], roles: [], status: 'idle' },
      jobs: [],
      evidence: [],
      /** 岗位证据覆盖缓存（jobId → ResponsibilityCoverage[]；M2 层3 三态） */
      evidenceCoverage: {},
      constraintRows: {},
      jobMatchScores: {},
      /** Claim 资产（M3-0）：表达 IR 全量条目（claims/ 目录，引擎实时派生 + usable） */
      claims: [],
      /** Claim 提案（P1.1）：待确认表达（claim-proposals/） */
      claimProposals: [],
      strengthProposals: [],
      derivationProposals: [],
      /** 工作副本（P2.2）：用户创作对象（working-copies/） */
      workingCopies: [],
      activeWorkingCopyId: null,
      /** 工作流（Career Workflow Contract v0.1）：Engine 单方写，UI 投影 */
      workflows: [],
      directionsByWorkflow: {},
      evaluationsByWorkflow: {},
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
      candidates: [],
      jobLeads: [],
      salaryBenchmarks: [],
      valuationCard: null,
      persons: PERSONS,
      personHealths: {},
      promotionsByPerson: {},
      personStages: buildInitialPersonStages(),
      agentDraft: '',
      pendingPrompt: null,
      pendingTaskRequest: undefined,
      personSwitchDialogOpen: false,
      pendingPersonId: null,
      personCreateDialogOpen: false,
      initSessionState: 'welcome',
      initCandidates: [],
      generatingCandidates: false,
      activeResumeId: 'r-dji',
      infopoolFilter: 'all',
      companiesFilter: 'all',
      applicationsFilter: '全部',
      locateTarget: null,
      selectedJobId: null,
      selectedCompanyId: null,
      workbenchView: 'dashboard',
      companiesView: 'profile',
      resumeWorkspaceView: 'dashboard',
      resumeOptimizeMode: 'diagnose',
      resumeOptimizeJobId: null,
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
      // 占位会话归位：该 Person 落盘引擎后，`ui:{id}` 占位归属迁移为真 personId（会话不丢）
      sessions: state.sessions.map((s) =>
        s.personId === `ui:${id}` ? { ...s, personId } : s,
      ),
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

  /** 发起工作流（Career Workflow Contract v0.1）：workflow/start——Goal + Stage 1；
   *  Path A（无候选）启动 fact_collection task；Path B（有 pending candidates）直接 waiting_gate（不重新收集） */
  startWorkflow: async (statement) => {
    const person = get().currentPerson()
    if (!person.personId) {
      useToastStore.getState().push('warning', '该档案未落盘引擎，无法发起工作流')
      return
    }
    if (!engine || get().engineStatus !== 'connected') {
      useToastStore.getState().push('warning', '引擎离线：发起工作流需连接引擎')
      return
    }
    try {
      const res = await engine.startWorkflow({ type: 'career_direction', personId: person.personId, statement })
      const wf = res.workflow
      // 新语义（P0-1/P1）：初始化完成后工作流从阶段 2 方向探索开始（阶段 1 事实收集已由初始化闭环完成）
      const stageIdx = (wf.stages?.findIndex((s) => s.id === wf.currentStage) ?? -1) + 1
      useToastStore.getState().push(
        'success',
        wf.currentStage === 'direction_exploration'
          ? `工作流已开始（阶段 ${stageIdx}/${wf.totalStages} 方向探索——Agent 正在工作）`
          : res.path === 'B'
            ? `工作流已开始（已有候选待确认——阶段 1/${wf.totalStages} 等待你的确认）`
            : `工作流已开始（阶段 1/${wf.totalStages} 事实收集——Agent 正在收集）`,
      )
      // 当前 Stage running → 发用户目标原文；Stage Envelope 由引擎按 workflowId/stageId 校验后注入
      // （Agent Execution Boundary：UI 不拼阶段指令，引擎是唯一 Stage 编译器）
      const cur = wf.stages?.find((s) => s.id === wf.currentStage)
      if (cur?.status === 'running' && wf.currentStage) {
        get().sendAgentMessage(statement, { silent: true, stageRef: { workflowId: wf.id, stageId: wf.currentStage }, executionContext: 'workflow_stage' })
      }
    } catch (err) {
      useToastStore.getState().push('warning', `发起工作流失败：${err instanceof Error ? err.message : String(err)}`)
    }
  },

  /** 用户确认 Gate 推进（workflow/advance）：四步校验由引擎裁决——用户只能表达"我要继续"，
   *  不能决定"系统已完成"；失败 → toast 缺件清单，不假装推进 */
  advanceWorkflow: async (workflowId, gateId) => {
    if (!engine || get().engineStatus !== 'connected') {
      useToastStore.getState().push('warning', '引擎离线：推进工作流需连接引擎')
      return
    }
    try {
      const res = await engine.advanceWorkflow(workflowId, gateId)
      if (!res.ok) {
        useToastStore.getState().push('warning', `无法推进：${res.code}${res.missing.length > 0 ? `——${res.missing.join('；')}` : ''}`)
        return
      }
      useToastStore.getState().push(
        'success',
        res.workflow.status === 'completed'
          ? '工作流已完成'
          : `已进入阶段 ${res.nextStage ?? ''}（${res.nextStage ? stageLabel(res.nextStage) : ''}）`,
      )
      // 新 Stage running：发简短提示；Stage Envelope 由引擎按 workflowId/stageId 校验后注入
      if (res.nextStage && res.workflow.status === 'active') {
        get().sendAgentMessage(`工作流已进入阶段 ${stageLabel(res.nextStage)}。`, { silent: true, stageRef: { workflowId: res.workflow.id, stageId: res.nextStage }, executionContext: 'workflow_stage' })
      }
      void pullWorkflows()
    } catch (err) {
      useToastStore.getState().push('warning', `推进失败：${err instanceof Error ? err.message : String(err)}`)
    }
  },

  /** 用户终止工作流（workflow/abort：append-only 审计） */
  abortWorkflow: async (workflowId) => {
    if (!engine || get().engineStatus !== 'connected') {
      useToastStore.getState().push('warning', '引擎离线：终止工作流需连接引擎')
      return
    }
    try {
      await engine.abortWorkflow(workflowId)
      useToastStore.getState().push('info', '工作流已终止（历史保留可审计）')
      void pullWorkflows()
    } catch (err) {
      useToastStore.getState().push('warning', `终止失败：${err instanceof Error ? err.message : String(err)}`)
    }
  },

  /** 方向裁决（v0.2 §4.3：UI 只表达 Human Action；引擎判定幂等/反动作/终态不可逆——
   *  UI 不维护 confirmed 计数与 allowed transition，投影以引擎结果为准） */
  resolveDirection: async (directionId, action) => {
    if (!engine || get().engineStatus !== 'connected') {
      useToastStore.getState().push('warning', '引擎离线：方向裁决需连接引擎')
      return
    }
    const personId = get().currentPerson().personId
    const active = get().workflows.find((w) => w.status === 'active')
    if (!personId || !active) return
    try {
      const res = await engine.resolveDirection(personId, directionId, action)
      if (res.ok) {
        useToastStore.getState().push(
          res.unchanged ? 'info' : 'success',
          res.unchanged
            ? `方向已${action === 'confirm' ? '保留' : '排除'}（重复操作，状态未变）`
            : `方向已${action === 'confirm' ? '保留' : '排除'}`,
        )
      } else if (res.code === 'ALREADY_RESOLVED') {
        useToastStore.getState().push('warning', `该方向已裁决（${res.currentState === 'confirmed' ? '已保留' : '已排除'}），终态不可逆`)
      } else {
        useToastStore.getState().push('warning', `方向不存在或已失效（${res.code}）`)
      }
      void pullDirections(active.id)
    } catch (err) {
      useToastStore.getState().push('warning', `裁决失败：${err instanceof Error ? err.message : String(err)}`)
    }
  },

  /** 重新执行当前 Stage（v0.2 §4.2：restage 是 Engine 业务动作——前置条件引擎裁决；
   *  restage 后立即触发 Stage 重跑（控制平面任务，executionContext workflow_stage——
   *  与 start/advance 的 Stage 触发同语义）；方向池保留（append-only），新 intake 由引擎按新快照建立） */
  restageWorkflow: async (workflowId) => {
    if (!engine || get().engineStatus !== 'connected') {
      useToastStore.getState().push('warning', '引擎离线：重新探索需连接引擎')
      return
    }
    try {
      const wf = await engine.restageWorkflow(workflowId)
      useToastStore.getState().push('info', '已重新进入当前阶段，Agent 将重新执行')
      if (wf.status === 'active' && wf.currentStage) {
        get().sendAgentMessage(`工作流已重新进入阶段 ${stageLabel(wf.currentStage)}。`, {
          silent: true,
          stageRef: { workflowId, stageId: wf.currentStage },
          executionContext: 'workflow_stage',
        })
      }
      void pullWorkflows()
    } catch (err) {
      useToastStore.getState().push('warning', `重新探索失败：${err instanceof Error ? err.message : String(err)}`)
    }
  },

  toggleAgentPanel: () => {
    const { agentPanelOpen, mainWidthMode, currentPage } = get()
    // 无面板区的页面（agent 主区即 AI / settings 纯设置）不响应——⌘B 与把手都经此判定，
    // 避免「UI 暴露动作但能力不存在」与状态污染
    if (!hasAgentPanelZone(currentPage)) return
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

  startAnalysis: (prompt, taskRequest) => {
    set({
      agentPanelOpen: true,
      agentDraft: prompt,
      pendingPrompt: prompt,
      pendingTaskRequest: taskRequest,
      mainWidthMode: 'narrow',
    })
  },
  startAgentTask: (prompt, opts) => {
    // 新任务 = 新现场（不污染现有会话历史）；任务标题作 session 名，可回溯
    get().createSession(opts?.title ?? 'AI 任务')
    set({ agentPanelOpen: true, mainWidthMode: 'narrow' })
    get().sendAgentMessage(prompt, { taskType: opts?.type, taskRequest: opts?.taskRequest })
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

  generateCandidatesFor: async (personId, source) => {
    if (!engine || useAppStore.getState().engineStatus !== 'connected') {
      useToastStore.getState().push('warning', '引擎离线：候选生成需连接引擎')
      return 0
    }
    useAppStore.setState({ generatingCandidates: true })
    try {
      const res = await engine.generateCandidates(personId, source)
      await useAppStore.getState().loadInitCandidates(personId)
      const n = res.added.length
      useToastStore.getState().push(
        n > 0 ? 'success' : 'info',
        n > 0
          ? `已生成 ${n} 条候选（${source === 'interview' ? '访谈' : '简历'}源），请在候选清单逐条确认`
          : '候选已是最新（无新增）——确认清单后即可推进初始化',
      )
      return n
    } catch (err) {
      useToastStore.getState().push('warning', `候选生成失败：${err instanceof Error ? err.message : String(err)}`)
      return 0
    } finally {
      useAppStore.setState({ generatingCandidates: false })
    }
  },

  pullPersonHealth: async (personId) => {
    if (!engine || useAppStore.getState().engineStatus !== 'connected') return
    try {
      const h = await engine.personHealth(personId)
      useAppStore.setState((s) => ({ personHealths: { ...s.personHealths, [personId]: h } }))
    } catch {
      // offline/旧引擎：保持现状（无角标 = 不假装健康判定）
    }
  },

  pullPromotions: async (personId) => {
    if (!engine || useAppStore.getState().engineStatus !== 'connected') return
    try {
      const list = await engine.listPromotions(personId)
      useAppStore.setState((s) => ({ promotionsByPerson: { ...s.promotionsByPerson, [personId]: list } }))
    } catch {
      // offline/旧引擎：保持现状
    }
  },

  promoteCity: async (personId, decisionId, city) => {
    if (!engine || useAppStore.getState().engineStatus !== 'connected') return false
    try {
      await engine.createCityPromotion(personId, decisionId, city)
      // 选定 → 引擎重投影（personsChanged）→ 画像/健康跟随刷新
      void useAppStore.getState().pullPromotions(personId)
      void pullPersons().then(() => void useAppStore.getState().pullPersonHealth(personId))
      useToastStore.getState().push('success', `已将「${city}」设为求职目标城市`)
      return true
    } catch (e) {
      useToastStore.getState().push('warning', `设置失败：${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  },

  revokePromotion: async (personId, promotionId) => {
    if (!engine || useAppStore.getState().engineStatus !== 'connected') return false
    try {
      await engine.revokePromotion(personId, promotionId)
      void useAppStore.getState().pullPromotions(personId)
      void pullPersons().then(() => void useAppStore.getState().pullPersonHealth(personId))
      useToastStore.getState().push('info', '已撤回目标城市（画像回退）')
      return true
    } catch (e) {
      useToastStore.getState().push('warning', `撤回失败：${e instanceof Error ? e.message : String(e)}`)
      return false
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
    // 上下文隔离指令：动态枚举已登记档案（排除当前初始化对象自身），禁止硬编码 person id
    const registeredOthers = get()
      .persons.filter((p) => p.personId && p.personId !== personId)
      .map((p) => `${p.name}（persons/${p.personId}/）`)
      .join('、')
    const isolationLine =
      registeredOthers.length > 0
        ? `上下文隔离（必须遵守）：当前初始化对象是「${personName}」，一个全新的 Person——没有历史档案。workspace 中已登记的其他档案：${registeredOthers}；禁止读取或引用它们的内容，也不要使用全局画像索引作为当前人的数据。只从与用户的对话中采集信息，用户所述以本次对话为准。`
        : `上下文隔离：当前初始化对象是「${personName}」，一个全新的 Person——没有历史档案。workspace 中没有其他已登记档案；不要使用全局画像索引作为当前人的数据。只从与用户的对话中采集信息，用户所述以本次对话为准。`
    const lines = [
      `你是「${personName}」的初始化助手（${resumeChannel ? '简历通道' : '访谈通道'}），角色定位：Interview / Clarify Agent。`,
      '任务：帮助用户建立第一份职业档案（认知基线）——澄清与补缺，不是替用户做职业决策，也不负责整理候选。',
      '开场白（直接说出，不要分析）："你好，我会帮你建立一份职业档案。这里记录的不只是简历，而是你做过什么、积累了什么能力，以及未来想探索什么方向。这些信息以后会成为职业分析的基础。我们先从你的经历开始。"',
      isolationLine,
      '候选事实不由本会话生产：简历/访谈候选由系统确定性生成并进入右侧候选清单（Candidate Inbox），用户确认后由引擎登记并投影画像。你只需要：① 引导用户查看并确认候选清单；② 澄清用户疑问；③ 补问简历/访谈中缺失的信息（项目细节、兴趣、偏好约束）。',
      '禁止输出「候选标记：」等协议行（Agent 已退出候选生产）；禁止自行写候选文件、快照、档案（persons/*/extraction、snapshot、facts、manifest 均归引擎）。',
      resumeChannel
        ? personId
          ? `资料：简历已由系统提取并生成候选——请用户查看右侧清单逐条确认；再补问简历外的项目/非正式经历、兴趣与偏好约束（用户的补充回答会写入访谈记录，系统可从记录再次生成候选）。`
          : '资料：引导用户粘贴简历文本（创建时为文本通道）；系统提取后生成候选清单，你负责引导确认与补问。'
        : '资料：通过一轮一个问题的方式对话（教育 → 工作经历 → 项目经历 → 技能 → 约束）；用户的回答会写入访谈记录，系统从记录生成候选入清单——你负责提问与答疑，回答被记录即完成本环节。',
      '规则：不要使用"阶段/进度"表述；不要自行声称完成——初始化完成由系统门禁裁决（快照三件齐备，引擎投影）；状态展示以右侧候选清单与系统提示为准。',
      '主题推进：聊完一个大主题（如经历）后做一次简短总结："我目前理解你是……，这个理解准确吗？"——用户修正后再进入下一主题。',
      '收尾（用户确认完所有候选后执行）：核对候选清单——教育/经历/技能/约束/兴趣中用户能提供的都已确认；若某类用户明确表示没有，如实记录（如"无工作经历"），不要编造。然后告诉用户"基础档案已按你的确认建立"——init 完成标记由引擎门禁裁决，不要自行声称完成。',
      ...(personId
        ? [`采集记录：本会话的对话由引擎持续写入 persons/${personId}/intake/session-001.md（原始对话记录）——你无需读取，本轮对话历史已包含全部已采集信息；该文件归引擎维护，你没有文件工具，也无需访问任何文件。`]
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
    // 机制防线（CLAUDE.md §8 Producer Ownership）：初始化访谈 Agent 零文件工具——
    // 候选/快照/档案文件归引擎（Candidate Inbox 确定性通道），Agent 只提问与答疑；
    // 物理隔离同时杜绝读他人档案（上下文隔离不再只靠 prompt）。
    get().sendAgentMessage(lines, { silent: true, allowedTools: [] })
  },

  expandToFullAgent: () => {
    set({
      currentPage: 'agent',
      agentPanelOpen: false,
      mainWidthMode: 'fullscreen',
    })
  },

  sendAgentMessage: (content, opts) => {
    const { sessions, engineStatus, pendingTaskRequest } = get()
    // ADR-020：发送合并预置 TaskRequest（startAnalysis 暂存；显式传参优先），发送后清空
    const taskRequest = opts?.taskRequest ?? pendingTaskRequest
    if (taskRequest) set({ pendingTaskRequest: undefined })
    // Person Capability Gate（仅 conversation 平面；BUG-010 裁决：workflow_stage 控制平面任务不经过对话能力门禁——
    // 授权来源 = 用户创建 workflow，Person 数据前置由 Stage evaluator/contract 下沉，UI 不提前猜）：
    // 当前人初始化中且非初始化会话 → 拒绝新消息（历史可看，发送前拦截）
    const isWorkflowStage = opts?.executionContext === 'workflow_stage'
    const currentPerson = get().currentPerson()
    const gateSessionId = get().currentSessionId
    if (!isWorkflowStage && currentPerson.initStatus === 'pending' && gateSessionId !== get().initSessionId) {
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
    // conversation 平面有 SDK 会话凭据则 resume 续接（会话连续性）；
    // workflow_stage 控制平面任务不续接（Artifact=Memory：阶段上下文 = Stage Envelope + 工作区，
    // 续接旧对话会把历史阶段长文灌入上下文 → 输出截断/行为漂移——2026-08-22 方向探索 3/3 失败定位）
    // 单会话单任务：运行中禁止发送由 UI 层保证（输入框禁用），store 不做兜底
    if (engineStatus === 'connected') {
      const session = sessions.find((s) => s.id === sessionId)
      void runAgentTask(sessionId, content, isWorkflowStage ? undefined : session?.sdkSessionId, opts?.taskType, taskRequest, opts?.stageRef, opts?.allowedTools)
      // 初始化会话落盘：用户真实消息追加（silent 的内部指令不落盘）
      const pid = pendingInitPersonId()
      if (pid && !opts?.silent) {
        void appendSessionTurnToEngine(pid, 'user', content)
        // I-2 无简历通道（P0-1 确定性通道）：访谈首轮回答后自动生成候选；
        // 已有候选则不再自动触发（补充性回答走面板「从访谈记录生成候选」手动重生成）
        const person = get().persons.find((p) => p.personId === pid)
        if (
          person?.sourceMode === 'interview' &&
          get().initCandidates.length === 0 &&
          !get().generatingCandidates
        ) {
          void get().generateCandidatesFor(pid, 'interview')
        }
      }
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
    // 归属当前展示的人：引擎 personId 稳定标识（persist 后不随 persons 数组重排漂移）；
    // 未落盘引擎的本地 Person 用 `ui:{id}` 占位（setPersonPersonId 落盘时批量迁移为真 personId）
    const person = get().currentPerson()
    const personId = person.personId ?? `ui:${person.id}`
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
    // 模板模块 = 档案身份 + 空骨架（演示简历不携带人设内容）；id 重生成避免冲突
    const template = RESUMES.find((r) => r.personId === personId)
    const modules = buildSkeletonModules(person).map((m, i) => ({
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
      // 派生后进入编辑空间（用户意图 = 编辑定制新草稿；ADR-021 R0 四空间）
      resumeWorkspaceView: 'edit',
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

  fetchJobMatchScore: async (jobId, personId) => {
    if (!engine) return
    try {
      const score = await engine.jobMatchScore(jobId, personId)
      set((state) => ({ jobMatchScores: { ...state.jobMatchScores, [jobId]: score } }))
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

  /** 提交决策叙述（M7：引擎写 decisions/ 完整字段；每次提交写新记录，UI 不拦截同名） */
  submitDecisionNarrative: async ({ jobId, personId, narrative }) => {
    if (!engine) throw new Error('引擎未连接')
    try {
      const { decisionId } = await engine.narrativeSubmit({ jobId, personId, ...(narrative ? { narrative } : {}) })
      useToastStore.getState().push('success', '决策记录已写入')
      return { decisionId }
    } catch (err) {
      useToastStore.getState().push('warning', `提交决策失败：${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  },

  /** 岗位表达候选（M7：直通 engine.claimSelect——纯派生不落盘，组件持本地 state） */
  fetchClaimCandidates: async (jobId) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.claimSelect(jobId)
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

  /** Resume Alignment Projection（R2.2：四态矩阵——纯投影不落盘） */
  fetchResumeAlignment: async (resumeId, jobId) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.fetchResumeAlignment(resumeId, jobId)
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

  /** 确认 Claim 提案（P1.1：二次校验 → 登记为表达资产；引擎广播后重拉两视图） */
  approveClaimProposal: async (id) => {
    if (!engine) throw new Error('引擎未连接')
    const result = await engine.approveClaimProposal(id)
    void pullClaimProposals()
    void pullClaims()
    void pullCareerContext()
    return result
  },

  /** 拒绝 Claim 提案（P1.1：待确认表达丢弃，审计保留） */
  rejectClaimProposal: async (id) => {
    if (!engine) throw new Error('引擎未连接')
    const p = await engine.rejectClaimProposal(id)
    void pullClaimProposals()
    return p
  },

  /** 生成资产化候选（P5.3：Agent 基于机会责任 + 用户选定证据构造 statement → claim-bridge-submit 登记） */
  generateAssetCandidate: async (opportunityId: string, wcId: string, evidenceIds: string[], personId: string) => {
    if (!engine) throw new Error('引擎未连接')
    const task = `你是 Career OS 的职业资产表达助手。当前任务：为机会 ${opportunityId} 生成表达资产候选（Claim 建议）。

背景：系统发现简历中某行表达缺少可信职业资产绑定（unsupported_claim——红线型：岗位期望有证据匹配，但表达未绑定 Claim）。

步骤：
1. Bash: 运行 \`./.local/node/node.exe ../engine/main.ts --claim-bridge-context ${opportunityId} ${wcId} ${evidenceIds.join(',')}\`（从项目根；用项目内便携 node，环境隔离）读取上下文 JSON（含 responsibilityStatement、evidence 回源全文、expectationId）
2. 基于 responsibilityStatement 与证据原文构造 1 条表达资产候选 statement（表达职业能力、忠于证据——数字/程度/角色均须来自证据原文，不得编造或升级能力级别）
3. 用 Write 写候选 JSON 到项目根 .local/claim-bridge-candidate-${opportunityId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json：{"opportunityId": "${opportunityId}", "wcId": "${wcId}", "evidenceCandidates": [${evidenceIds.map((e) => `"${e}"`).join(', ')}], "statement": "…", "explanation": "为什么这样表达（一句，用户语言）"}
4. Bash: 运行 \`./.local/node/node.exe ../engine/main.ts --claim-bridge-submit .local/claim-bridge-candidate-${opportunityId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json\` 提交。失败读错误（numeric_anchor/capability_anchor/证据校验），修正重试最多 1 次。
5. 输出一句话总结：候选提案 id 或失败原因。

硬约束：不得编造证据外的事实与数字；能力级别（主导/负责/参与）不得高于证据原文；除候选 JSON 外不得修改任何文件。`
    const res = await engine.startAgent({
      task,
      personId,
      allowedTools: ['Bash', 'Write', 'Read', 'Glob'],
      permissionMode: 'bypassPermissions',
      maxTurns: 15,
    })
    return res.taskId
  },

  /** 绑定 Claim 到工作副本块（P5.3：approve 后——Claim 已生成 ≠ 已绑定；conflict 可重试；幂等） */
  bindClaim: async (wcId: string, blockId: string, claimId: string) => {
    if (!engine) throw new Error('引擎未连接')
    const result = await engine.claimBind(wcId, blockId, claimId)
    void pullWorkingCopies()
    return result
  },

  /** 工作副本 upsert（P2.3：revision 协商——conflict 抛错，UI 提示「内容已在其他端更新」） */
  upsertWorkingCopy: async (input) => {
    if (!engine) throw new Error('引擎未连接')
    const result = await engine.upsertWorkingCopy(input)
    if (result.status === 'conflict') {
      throw new Error('内容已在其他端更新，请刷新后重试')
    }
    useAppStore.setState((s) => ({
      workingCopies: s.workingCopies.map((w) => (w.id === result.copy.id ? result.copy : w)),
    }))
  },

  /** 优势亮点 upsert（Summary Strength Contract v0.1：保存 = 用户确认；引擎校验 claim 锚定链） */
  upsertSummaryStrengths: async (personId, items) => {
    if (!engine) throw new Error('引擎未连接')
    const cleaned = await engine.upsertSummaryStrengths(personId, items)
    // 乐观更新本地（引擎 personsChanged 广播会再次刷新——双写无害，幂等）
    useAppStore.setState((s) => ({
      persons: s.persons.map((p) => (p.personId === personId ? { ...p, summaryStrengths: cleaned } : p)),
    }))
  },

  /** 优势亮点提案全量（AI 总结候选——accept/reject 需用户裁决，Agent 不能自批） */
  listStrengthProposals: async (personId) => {
    if (!engine) throw new Error('引擎未连接')
    const list = await engine.listStrengthProposals(personId)
    useAppStore.setState({ strengthProposals: list })
    return list
  },

  /** 优势提案裁决：accept → 引擎校验 + 并入优势亮点；reject → 审计保留 */
  decideStrengthProposal: async (id, action, reason) => {
    if (!engine) throw new Error('引擎未连接')
    const proposal = await engine.decideStrengthProposal(id, action, reason)
    useAppStore.setState((s) => ({
      strengthProposals: s.strengthProposals.map((p) => (p.id === id ? proposal : p)),
    }))
    return proposal
  },

  /** 取消后台任务（CLI 桥类任务无会话簿记——cancel RPC + 立即清理 backgroundTasks；done/error 兜底清理幂等） */
  cancelBackgroundTask: async (taskId: string) => {
    if (!engine) throw new Error('引擎未连接')
    await engine.cancelAgent(taskId)
    useAppStore.setState((s) => {
      const bg = { ...s.backgroundTasks }
      delete bg[taskId]
      return { backgroundTasks: bg }
    })
  },

  /** 启动 AI 总结任务（agent CLI 桥：--strength-context 读池 → 生成候选 → --strength-submit 提交；
   *  任务状态由 agent.event 流呈现，提交后 strengthProposalsChanged 广播驱动建议卡刷新） */
  generateStrengthProposals: async (personId: string) => {
    if (!engine) throw new Error('引擎未连接')
    const task = `你是 Career OS 的优势亮点总结助手。当前任务：为人员 ${personId} 总结优势亮点候选。

步骤：
1. Bash: 运行 \`./.local/node/node.exe ../engine/main.ts --strength-context ${personId}\`（从项目根；用项目内便携 node，环境隔离）读取上下文 JSON（claims 可用表述 + evidence 可信事实 + existingStrengths 已有优势）
2. 基于上下文总结 2-4 条优势候选：每条 = 结论句（能力维度 + 具体能力，20-40 字）+ 支撑引用（claimIds 从 claims 选经历支撑；evidenceIds 从 evidence 选技能/奖项支撑）。规则：结论句不编造上下文外的事实与数字；能力声明不得高于证据原文；existingStrengths 已覆盖的维度不重复提；市场规范 3 硬 1 软——优先有支撑的硬优势。
3. 用 Write 写候选 JSON 到项目根 .local/strength-candidate-${personId}.json：{"personId": "${personId}", "items": [{"text": "结论句", "claimIds": ["claim_xxx"], "evidenceIds": ["evidence_xxx"]}]}
4. Bash: 运行 \`./.local/node/node.exe ../engine/main.ts --strength-submit .local/strength-candidate-${personId}.json\` 提交。失败读错误（引用不存在/不可消费），修正重试最多 1 次。
5. 输出一句话总结：提案 id 或失败原因。

硬约束：不得修改除候选 JSON 外的任何文件；不得直接写优势亮点文件（登记必须用户接受提案后由引擎完成）。`
    const res = await engine.startAgent({
      task,
      personId,
      allowedTools: ['Bash', 'Write', 'Read', 'Glob'],
      permissionMode: 'bypassPermissions',
      maxTurns: 15,
    })
    // 后台任务登记（backgroundTasks）——done/error 事件清除；UI 用类型匹配显示运行态
    useAppStore.setState((s) => ({
      backgroundTasks: { ...s.backgroundTasks, [res.taskId]: { type: 'strength_summary', startedAt: Date.now() } },
    }))
    return res.taskId
  },

  /** 派生提案全量（RPC 拉取——CLI 提交经事件广播，但直接 RPC 保持调用一致性） */
  listDerivationProposals: async (filter) => {
    if (!engine) throw new Error('引擎未连接')
    const list = await engine.listDerivationProposals(filter)
    useAppStore.setState({ derivationProposals: list })
    return list
  },

  /** 派生提案裁决（accept → 引擎创建新工作副本并广播 workingCopiesChanged；reject → 审计保留） */
  decideDerivationProposal: async (id, action, reason) => {
    if (!engine) throw new Error('引擎未连接')
    const proposal = await engine.decideDerivationProposal(id, action, reason)
    useAppStore.setState((s) => ({
      derivationProposals: s.derivationProposals.map((p) => (p.id === id ? proposal : p)),
    }))
    if (action === 'accept') void pullWorkingCopies()
    return proposal
  },

  /** 启动派生任务（agent CLI 桥：--derive-context 读池 → 整份派生候选 → --derive-submit 提交；
   *  任务状态由 backgroundTasks 呈现，提交后 derivationProposalsChanged 广播驱动提案刷新） */
  generateDerivation: async (wcId: string, jobId: string) => {
    if (!engine) throw new Error('引擎未连接')
    const person = useAppStore.getState().currentPerson()
    const task = `你是 Career OS 的简历派生助手。当前任务：基于工作副本 ${wcId} 和目标岗位 JD ${jobId} 生成整份简历派生候选。

步骤：
1. Bash: 运行 \`./.local/node/node.exe ../engine/main.ts --derive-context ${wcId} ${jobId}\`（从项目根；用项目内便携 node，环境隔离）读取上下文 JSON（source 源副本模块 + job 岗位要求与 JD 原文 + claims 可用表达资产 + evidence 可信事实 + strengths 已有优势）
2. 基于上下文生成整份派生简历：保留源副本与 JD 对齐的内容，改写/补充不对齐部分。规则：内容不编造上下文外的事实与数字（能力声明不得高于证据原文）；能锚定的表达必须用 claims 里已存在的 claimId 标注（provenanceLinks），不编造 claimId；模块标题沿用中文规范（个人信息/个人优势/工作经历/项目经验/技能）；每模块 3-6 条表达，含量化指标与 JD 关键词；身份事实（姓名/联系方式）不编造——用占位符或不含。
3. 用 Write 写候选 JSON 到项目根 .local/derive-candidate-${wcId}.json：{"owner": "${person.personId ?? ''}", "sourceWcId": "${wcId}", "jobId": "${jobId}", "changeNotes": ["模块：改动说明（逐模块）"], "sections": [{"id": "sec_1", "title": "模块标题", "blocks": [{"id": "blk_1", "text": "表达内容", "provenanceLinks": ["claim_xxx"] 或 []}]}]}（blocks 是段落级表达数组；entries 可选用于条目化段，格式 {"title": "条目标题", "role": "岗位", "period": "时间段", "blocks": [...]}）
4. Bash: 运行 \`./.local/node/node.exe ../engine/main.ts --derive-submit .local/derive-candidate-${wcId}.json\` 提交。失败读错误（claim 不可消费/源副本不存在等），修正重试最多 1 次。
5. 输出一句话总结：提案 id 或失败原因。

硬约束：不得修改除候选 JSON 外的任何文件；不得直接创建工作副本（建副本必须用户接受提案后由引擎完成）。`
    const res = await engine.startAgent({
      task,
      personId: person.personId ?? undefined,
      allowedTools: ['Bash', 'Write', 'Read', 'Glob'],
      permissionMode: 'bypassPermissions',
      maxTurns: 20,
    })
    // 后台任务登记（backgroundTasks）——done/error 事件清除；UI 用类型匹配显示运行态（毛玻璃蒙版）
    useAppStore.setState((s) => ({
      backgroundTasks: { ...s.backgroundTasks, [res.taskId]: { type: 'resume_derive', startedAt: Date.now() } },
    }))
    return res.taskId
  },

  /** 创建版本（P2.3：promote → 版本空间可见） */
  promoteWorkingCopy: async (id) => {
    if (!engine) throw new Error('引擎未连接')
    const doc = await engine.promoteWorkingCopy(id)
    void pullWorkingCopies()
    void pullResumes()
    void pullCareerContext()
    return doc
  },

  setActiveWorkingCopy: (id) => set({ activeWorkingCopyId: id }),

  /** 工作副本对齐投影（P2.4） */
  fetchWorkingCopyAlignment: async (wcId, jobId) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.fetchWorkingCopyAlignment(wcId, jobId)
  },

  /** 工作副本机会投影（P3.2——一等对象「为什么值得改」；纯投影不落盘） */
  fetchWorkingCopyOpportunities: async (wcId, jobId) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.fetchWorkingCopyOpportunities(wcId, jobId)
  },

  /** 机会 Proposal 全量（P3.3） */
  listOpportunityProposals: async () => {
    if (!engine) throw new Error('引擎未连接')
    return engine.listOpportunityProposals()
  },

  listClaimProposals: async () => {
    if (!engine) throw new Error('引擎未连接')
    const list = await engine.listClaimProposals()
    useAppStore.setState({ claimProposals: list })
    return list
  },

  /** 生成改写候选（P3.6：机会 → agent 任务 → 候选登记；任务状态由 agent.event 流呈现） */
  generateOpportunityProposals: async (opportunityId: string, wcId: string, personId: string) => {
    if (!engine) throw new Error('引擎未连接')
    const task = `你是 Career OS 的简历表达改写助手。当前任务：为机会 ${opportunityId} 生成改写候选。

步骤：
1. Bash: 运行 \`./.local/node/node.exe ../engine/main.ts --opportunity-context ${opportunityId} ${wcId}\`（从项目根；用项目内便携 node，环境隔离）读取上下文 JSON（opportunity 含 suggestedAction、responsibilityStatement、evidence 回源、currentBlockText）
2. 依据 opportunity.suggestedAction 与 evidence 生成 1-2 个候选（changes 数组：{"blockId": "rewrite/delete 填块 id；insert 省略", "before": "改前文本；insert 空串", "after": "改后文本；delete 空串", "operation": "insert|rewrite|delete"}）。若 suggestedAction 是「补充证据或删除」，不要直接 delete——优先保留用户内容的方案（如改准确、降低声明强度）。
3. 用 Write 写候选 JSON 到项目根 .local/opportunity-candidate-${opportunityId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json：{"opportunityId": "${opportunityId}", "wcId": "${wcId}", "changes": [...]}
4. Bash: 运行 \`./.local/node/node.exe ../engine/main.ts --opportunity-submit .local/opportunity-candidate-${opportunityId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json\` 提交。失败读错误（numeric_anchor/capability_anchor/EMPTY_EDIT），修正重试最多 1 次。
5. 输出一句话总结：候选提案 id 或失败原因。

硬约束：不得编造 evidence 外的事实与数字；能力级别（主导/负责/参与）不得高于 evidence 原文；除候选 JSON 外不得修改任何文件。`
    const res = await engine.startAgent({
      task,
      personId,
      allowedTools: ['Bash', 'Write', 'Read', 'Glob'],
      permissionMode: 'bypassPermissions',
      maxTurns: 15,
    })
    return res.taskId
  },

  /** 采用机会 Proposal（P3.7：pending → approved——approve ≠ apply） */
  approveOpportunityProposal: async (id) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.approveOpportunityProposal(id)
  },

  /** 拒绝机会 Proposal（P3.7：pending → rejected——单向不 reopen，审计保留） */
  rejectOpportunityProposal: async (id, reason) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.rejectOpportunityProposal(id, reason)
  },

  /** 应用到简历（P3.8：approved → apply——revision check → 原子写盘；conflict 正常协作冲突非错误） */
  applyOpportunityProposal: async (id) => {
    if (!engine) throw new Error('引擎未连接')
    return engine.applyOpportunityProposal(id)
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

  /** 草稿模块内容写回（R0 修复：编辑内容切页不丢） */
  updateResumeModules: (id, modules) => {
    set((state) => ({
      resumes: state.resumes.map((r) =>
        r.id === id ? { ...r, modules, updatedAt: new Date().toISOString().slice(0, 10) } : r,
      ),
    }))
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
  setCompaniesView: (view) => set({ companiesView: view }),  /** 简历工作台四空间切换（ADR-021 R0） */
  setResumeWorkspaceView: (view) => set({ resumeWorkspaceView: view }),

  setResumeOptimizeMode: (mode) => set({ resumeOptimizeMode: mode }),
  setResumeOptimizeJobId: (jobId) => set({ resumeOptimizeJobId: jobId }),
  setArtifactsView: (view) => set({ artifactsView: view }),
  /** 选中简历版本（M3.5.5：切到历史空间并定位） */
  selectResume: (id) => set({ selectedResumeId: id, resumeWorkspaceView: 'history' }),

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
      version: 3,
      // v2 → v3：Session.personId 语义从 UI 数字 id（随 pullPersons 数组重排漂移）改为引擎 personId（string）。
      // 存量迁移：title「{name}」初始化采集 → 按 name 重归属；其余无法可靠考证 → 'unassigned'
      // （数据不删，显式未知，禁止静默错挂）。
      migrate: (persisted, version) => {
        if (version !== 2) return persisted
        const p = persisted as AppState
        const byName = new Map<string, string>()
        for (const person of p.persons ?? []) {
          if (person.personId) byName.set(person.name, person.personId)
        }
        const sessions = (p.sessions ?? []).map((s) => {
          if (typeof s.personId === 'string') return s
          const m = /^「(.+)」初始化采集$/.exec(s.title)
          const pid = m ? byName.get(m[1]!) : undefined
          return { ...s, personId: pid ?? 'unassigned' }
        })
        return { ...p, sessions }
      },
      // AgentPanel 是会话级 UI 状态，不持久化（丢弃旧 localStorage 值，避免默认展开）
      merge: (persisted, current) => {
        const p = persisted as Record<string, unknown>
        if (p && typeof p === 'object' && 'agentPanelOpen' in p) delete p.agentPanelOpen
        const merged = { ...current, ...(p as object) } as AppState
        // 旧 persist 的 mock 简历（ResumeVersion）不再注入——导航/画像/简历页全部消费引擎 resumeVersions
        if (Array.isArray(merged.resumes) && merged.resumes.length > 0) merged.resumes = []
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

/**
 * text_delta 批量汇聚（rAF 每帧 flush 一次）——2026-08-22 真机定位：
 * Agent 长输出（城市评估）高频 text_delta → 每帧多次 setState → React
 * `Maximum update depth exceeded`（控制台 7 errors）。语义不变（内容按序累积），
 * 只降 setState 频率；done/error 前必须 flush 保证最终内容完整。
 */
interface DeltaBuffer {
  sessionId: string
  messageId: string
  text: string
  raf: number | null
  pending: boolean
}
let deltaBuf: DeltaBuffer | null = null
let thinkingBuf: DeltaBuffer | null = null

function flushDeltaBuffer(): void {
  if (!deltaBuf?.pending) return
  const { sessionId, messageId, text } = deltaBuf
  // 清空缓冲后再 patch（rAF 回调与下一个 schedule 可能交错：text 已消费，不得再次 append）
  deltaBuf.text = ''
  deltaBuf.pending = false
  patchStreamingMessage(sessionId, messageId, (m) => ({
    ...m,
    isThinking: false,
    content: m.content + text,
  }))
}

function flushThinkingBuffer(): void {
  if (!thinkingBuf?.pending) return
  const { sessionId, messageId, text } = thinkingBuf
  thinkingBuf.text = ''
  thinkingBuf.pending = false
  patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, thinking: (m.thinking ?? '') + text }))
}

/** 通用 rAF 批量调度（delta/thinking 共用同一缓冲语义） */
function scheduleDelta(buf: DeltaBuffer | null, sessionId: string, messageId: string, text: string): DeltaBuffer {
  if (buf && (buf.sessionId !== sessionId || buf.messageId !== messageId)) {
    if (buf === deltaBuf) flushDeltaBuffer()
    else flushThinkingBuffer()
  }
  if (!buf || buf.sessionId !== sessionId || buf.messageId !== messageId) {
    buf = { sessionId, messageId, text, raf: null, pending: false }
  }
  buf.text += text
  buf.pending = true
  if (buf.raf === null) {
    buf.raf = requestAnimationFrame(() => {
      buf!.raf = null
      if (buf === deltaBuf) flushDeltaBuffer()
      else flushThinkingBuffer()
    })
  }
  return buf
}

function scheduleTextDelta(sessionId: string, messageId: string, text: string): void {
  deltaBuf = scheduleDelta(deltaBuf, sessionId, messageId, text)
}

function scheduleThinkingDelta(sessionId: string, messageId: string, text: string): void {
  thinkingBuf = scheduleDelta(thinkingBuf, sessionId, messageId, text)
}

/** 任务收尾前 flush 全部缓冲（保证最终内容完整不乱序） */
function flushStreamBuffers(): void {
  flushDeltaBuffer()
  flushThinkingBuffer()
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
 *  类别非法行忽略；教育类目第 4 段 = 键值段：学校=…；专业=…；学历=…；起=…；止=…；
 *  经历类目第 4 段 = 键值段：公司=…；岗位=…；起=…；止=…） */
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
async function runAgentTask(
  sessionId: string,
  content: string,
  resumeSessionId?: string,
  taskType?: string,
  taskRequest?: AgentTaskRequest,
  stageRef?: { workflowId: string; stageId: string },
  allowedTools?: string[],
): Promise<void> {
  if (!engine) return
  // 会话内单任务互斥：已有运行中任务则拒绝（同 SDK session 双流会串上下文；UI 输入框已禁用，此处是并发边界校验）
  if (useAppStore.getState().sessionTasks[sessionId]) {
    useToastStore.getState().push('warning', '当前会话已有任务运行中，请等待完成或先停止')
    return
  }
  try {
    const res = await engine.startAgent({
      task: content,
      ...(taskRequest ? { taskType: taskRequest.taskType, contextRefs: taskRequest.contextRefs, outputTarget: taskRequest.outputTarget } : {}),
      ...(useAppStore.getState().currentPerson().personId
        ? { personId: useAppStore.getState().currentPerson().personId }
        : {}),
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      ...(stageRef ? { workflowId: stageRef.workflowId, stageId: stageRef.stageId } : {}),
      ...(allowedTools !== undefined ? { allowedTools } : {}),
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
    // ADR-020：Bundle = 显式上下文（执行期快照）——存 Session（UI 只投影不解释），不塞 message
    if (res.contextBundle) {
      useAppStore.setState((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === sessionId ? { ...x, contextBundle: res.contextBundle, status: undefined } : x,
        ),
      }))
    }
    const taskId = res.taskId
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
    const message = err instanceof Error ? err.message : String(err)
    // ADR-020 D1：Rejected Task ≠ Failed Session——不删除交互事实（用户输入是真实事件），
    // 标记 session.status='rejected'（请求不满足系统契约未执行；failed = 执行失败，语义分离）
    if (message.startsWith('TaskRejected:')) {
      useAppStore.setState((s) => ({
        sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, status: 'rejected' } : x)),
      }))
    }
    appendToSession(sessionId, {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: message,
      timestamp: new Date().toISOString(),
      error: { code: 'unknown', message, retryable: true },
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
  if (!task) {
    // 后台任务（非会话簿记——CLI 桥类如机会提案/优势总结）：无占位消息可路由，
    // 但 done/error 必须清理 backgroundTasks（否则运行态卡片永不消失）
    if (ev.type === 'done' || ev.type === 'error') {
      useAppStore.setState((s) => {
        const bg = { ...s.backgroundTasks }
        delete bg[taskId]
        return { backgroundTasks: bg }
      })
    }
    return
  }
  const { sessionId, messageId } = task
  switch (ev.type) {
    case 'text_delta':
      // rAF 批量汇聚（高频 delta 每帧一次 setState——防止 Maximum update depth exceeded）
      scheduleTextDelta(sessionId, messageId, ev.text)
      break
    case 'thinking_start':
      patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, isThinking: true }))
      break
    case 'thinking_delta':
      scheduleThinkingDelta(sessionId, messageId, ev.text)
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
      flushStreamBuffers()
      agentTasks.delete(taskId)
      useAppStore.setState((s) => {
        const next = { ...s.sessionTasks }
        if (next[task.sessionId]?.taskId === taskId) delete next[task.sessionId]
        const bg = { ...s.backgroundTasks }
        delete bg[taskId]
        return { sessionTasks: next, backgroundTasks: bg }
      })
      break
    }
    case 'error':
      patchStreamingMessage(sessionId, messageId, (m) => ({ ...m, isThinking: false, streaming: false }))
      flushStreamBuffers()
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
        const bg = { ...s.backgroundTasks }
        delete bg[taskId]
        return { sessionTasks: next, backgroundTasks: bg }
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

/** 候选池（公司适配榜候选层；candidatesChanged 事件驱动重拉） */
async function pullCandidates(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listCandidatePool()
    useAppStore.setState({ candidates: list })
  } catch {
    // offline：保持现有数据
  }
}

/** 岗位线索（公司适配榜投递层；jobLeadsChanged 事件驱动重拉） */
async function pullJobLeads(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listJobLeads()
    useAppStore.setState({ jobLeads: list })
  } catch {
    // offline：保持现有数据
  }
}

/** 薪资基准（二期 §7；salaryBenchmarksChanged 事件驱动重拉） */
async function pullSalaryBenchmarks(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listSalaryBenchmarks()
    useAppStore.setState({ salaryBenchmarks: list })
  } catch {
    // offline：保持现有数据
  }
}

/** 个人估价卡（二期 §7.5；当前人 personId 驱动——缺省清空，UI 显式缺数据状态） */
async function pullValuationCard(): Promise<void> {
  if (!engine) return
  try {
    const personId = useAppStore.getState().currentPerson()?.personId
    if (!personId) {
      useAppStore.setState({ valuationCard: null })
      return
    }
    const card = await engine.salaryValuation(personId)
    useAppStore.setState({ valuationCard: card })
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

/** Claim 提案（P1.1）：claim-proposals/list 全量拉取；claimProposalsChanged 事件驱动重拉 */
async function pullClaimProposals(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listClaimProposals()
    useAppStore.setState({ claimProposals: list })
  } catch {
    // offline：保持现有数据
  }
}

/** 优势亮点提案（Summary Strength Contract v0.2 §3）：全量拉取；strengthProposalsChanged 事件驱动重拉 */
async function pullStrengthProposals(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listStrengthProposals()
    useAppStore.setState({ strengthProposals: list })
  } catch {
    // offline：保持现有数据
  }
}

/** 派生提案（优化空间派生模式）：全量拉取；derivationProposalsChanged 事件驱动重拉 */
async function pullDerivationProposals(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listDerivationProposals()
    useAppStore.setState({ derivationProposals: list })
  } catch {
    // offline：保持现有数据
  }
}

/** 工作副本（P2.2）：working-copies/list 全量拉取；workingCopiesChanged 事件驱动重拉 */
async function pullWorkingCopies(): Promise<void> {
  if (!engine) return
  try {
    const list = await engine.listWorkingCopies()
    useAppStore.setState({ workingCopies: list })
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

/** 工作流（Career Workflow Contract v0.1）：workflow/list 按当前人拉取；workflowChanged 事件驱动重拉 */
async function pullWorkflows(): Promise<void> {
  if (!engine) return
  try {
    const personId = useAppStore.getState().currentPerson().personId
    const list = await engine.listWorkflows(personId ?? undefined)
    useAppStore.setState({ workflows: list })
    // v0.2 方向池联动：active workflow 的方向池随工作流状态同步（Store 层 scope，组件不拉取）
    const active = list.find((w) => w.status === 'active')
    if (active) {
      void pullDirections(active.id)
      // v0.3 评估明细联动：Stage 3 完成后 workflowChanged → 重拉评估池（组件只取 key）
      void pullEvaluations(active.id)
    }
  } catch {
    // offline：保持现有数据
  }
}

/** 方向池投影（v0.2：person/directions/list 按 workflow 拉取；Store 层过滤，组件只取 key） */
async function pullDirections(workflowId: string): Promise<void> {
  if (!engine) return
  try {
    const personId = useAppStore.getState().currentPerson().personId
    if (!personId) return
    const list = await engine.listDirections(personId, workflowId)
    useAppStore.setState((s) => ({ directionsByWorkflow: { ...s.directionsByWorkflow, [workflowId]: list } }))
  } catch {
    // offline：保持现有数据
  }
}

/** 评估明细投影（v0.3：person/evaluations/list 按 workflow 拉取；Store 层过滤，组件只取 key） */
async function pullEvaluations(workflowId: string): Promise<void> {
  if (!engine) return
  try {
    const personId = useAppStore.getState().currentPerson().personId
    if (!personId) return
    const list = await engine.listEvaluations(personId, workflowId)
    useAppStore.setState((s) => ({ evaluationsByWorkflow: { ...s.evaluationsByWorkflow, [workflowId]: list } }))
  } catch {
    // offline：保持现有数据
  }
}

/** Stage 展示标签（UI 投影；契约 §2.3 阶段名） */
export function stageLabel(stageId: string): string {
  switch (stageId) {
    case 'fact_collection':
      return '事实收集'
    case 'direction_exploration':
      return '方向探索'
    case 'direction_evaluation':
      return '方向评估'
    case 'recommendation':
      return '形成推荐'
    default:
      return stageId
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
    // 保护初始化中的本地 Person：仅「尚未落盘引擎」（无 personId）的进行中 Person 需要保护
    // （创建向导 RPC 往返窗口/引擎离线创建）。已有 personId 的本地记录以引擎列表为唯一真相源——
    // 引擎无该资产 = 已删除或他工作区残留（localStorage 跨项目共享），丢弃，避免幽灵 Person 复活
    // 后 complete/reset 打到不存在的 manifest（person/session/complete: manifest 不存在）。
    const localPending = useAppStore
      .getState()
      .persons.filter((p) => p.initStatus === 'pending' && !p.personId && !list.some((e) => e.id === p.id))
    useAppStore.setState({ persons: [...list, ...localPending] })
    // 对账：currentPersonId 不在当前人员集合（持久化残留 / 引擎删除——如跨工作区数据库变化）→
    // 归位到集合首个（Engine state 唯一权威；本地进行中 Person 仍受保护）。
    // 失配时初始化候选确认等依赖 currentPersonId 的入口会静默失效（发现于 2026-08-22 I-1 重跑）。
    const all = [...list, ...localPending]
    const cur = useAppStore.getState().currentPersonId
    if (!all.some((p) => p.id === cur)) {
      useAppStore.setState({ currentPersonId: all[0]!.id })
    }
  } catch {
    // offline：保持现有数据
  }
}

/**
 * Person Health → Attention 投影（v0.4.2.1：ADR-031 最后一公里——系统主动告知自身健康状态）。
 * 边界（评审锁死）：只投影，不保存健康结果/不重复数据；明细由画像页 badge（person/health 实时）展示。
 * - attention id 固定 `person-health:{personId}`（单槽覆盖天然去重，多次刷新不堆积）
 * - healthy → 自动消失（若当前 attention 属本 person 健康投影——Attention Projection 随状态变化，
 *   不是 Health 自动修复）
 */
async function syncHealthAttention(personId: string): Promise<void> {
  if (!engine || useAppStore.getState().engineStatus !== 'connected') return
  try {
    const h = await engine.personHealth(personId)
    useAppStore.setState((s) => ({ personHealths: { ...s.personHealths, [personId]: h } }))
    const { attention, dismissAttention, addAttention } = useAttentionStore.getState()
    if (h.verdict === 'healthy') {
      if (attention?.id === `person-health:${personId}`) dismissAttention()
      return
    }
    addAttention({
      id: `person-health:${personId}`,
      level: 'warning',
      title: '画像一致性告警',
      description: `「${h.name}」有 ${h.checks.length} 项需要关注——查看画像详情`,
      target: { page: 'workbench', view: 'profile' },
      source: 'person_health',
    })
  } catch {
    // offline/旧引擎：保持现状
  }
}

/** 当前人的健康 → Attention（连接恢复/数据变化后调用） */
function syncCurrentPersonHealth(): void {
  const pid = useAppStore.getState().currentPerson().personId
  if (pid) void syncHealthAttention(pid)
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
      void pullPersons().then(() => {
        void pullValuationCard()
        syncCurrentPersonHealth()
      })
      void pullHistories()
      void pullCompanies()
      void pullGraph()
      void pullContexts()
      void pullKnowledge()
      void pullHealth()
      void pullJobs()
      void pullApplications()
      void pullCandidates()
      void pullJobLeads()
      void pullSalaryBenchmarks()
      void pullWorkflows()
      void pullEvidence()
      void pullClaims()
      void pullClaimProposals()
      void pullWorkingCopies()
      void pullResumes()
      void pullCareerContext()
      void pullProposals()
      void pullDerivationProposals()
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
  engine.on(EVENTS.claimProposalsChanged, () => void pullClaimProposals())
  engine.on(EVENTS.strengthProposalsChanged, () => void pullStrengthProposals())
  engine.on(EVENTS.derivationProposalsChanged, () => void pullDerivationProposals())
  engine.on(EVENTS.opportunitiesChanged, () => {
    void pullWorkingCopies() // apply 事务改写工作副本（含外部 apply 写入）
  })
  engine.on(EVENTS.engineError, (data: unknown) => {
    // 引擎管线错误（watcher 回调异常等）——全局错误卡，用户可见而非静默
    const message = (data as { message?: string } | undefined)?.message ?? '未知引擎错误'
    useAttentionStore.getState().addAttention({
      id: `engine-error-${Date.now()}`,
      level: 'warning',
      title: '引擎错误',
      description: message,
      source: 'system',
    })
  })
  engine.on(EVENTS.workingCopiesChanged, () => {
    void pullWorkingCopies()
    void pullResumes() // promote 可能产生版本
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
  engine.on(EVENTS.candidatesChanged, () => void pullCandidates())
  engine.on(EVENTS.jobLeadsChanged, () => void pullJobLeads())
  engine.on(EVENTS.salaryBenchmarksChanged, () => {
    void pullSalaryBenchmarks()
    void pullValuationCard()
  })
  engine.on(EVENTS.workflowChanged, () => {
    void pullWorkflows()
  })
  engine.on(EVENTS.personsChanged, () => {
    // P1 Person Aggregate：identity/career_profile/skill_inventory 变化 → 重拉 persons/list
    //（pullPersons 保护初始化中的本地 Person，不覆盖丢失）；估价卡档位/期望依赖画像 → 重拉后重算；
    // Health → Attention 投影（v0.4.2.1：数据变化后同步提醒）
    void pullPersons().then(() => {
      void pullValuationCard()
      syncCurrentPersonHealth()
    })
    void pullGraph()
  })
  engine.on(EVENTS.poolChanged, () => void pullGraph())
  engine.onAgentEvent(handleAgentEvent)
  engine.connect()
}
