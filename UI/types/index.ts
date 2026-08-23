/**
 * 契约源引用：engine/ir/schema.ts（引擎 ↔ UI 共享契约源）
 * 仅 `import type`（编译期擦除，validator 运行时代码不进前端 bundle）。
 * 异名实体用别名 re-export，UI 其余代码从本文件取类型，零改动。
 */
import type {
  AgentError,
  AgentErrorCode,
  AgentRuntimeEvent,
  HealthReport,
  Person,
  DecisionRecord,
  CompanyRecord,
  PoolNode,
  PoolEdge,
  ApplicationRecord,
  ApplicationView,
  Session as EngineSession,
  ChatMessage as EngineChatMessage,
  RiskLevel,
  ApplicationStatus,
  FollowUpState,
  ToolCallInfo,
  ToolCallStatus,
  GapResult,
  EvidenceItem,
  CareerClaim,
  ClaimCoverageRow,
  ToolStats,
  ToolStatEntry,
  ToolSource,
  ToolEvidence,
} from '../../engine/ir/schema.ts';
import type { ResumeDocument, ResumeBullet, ResumeSection, ResumeIdentityEntry } from '../../engine/ir/resume.ts';
import type { AgentContextBundle } from '../../engine/ir/agent-task.ts';
import type { ArtifactSummary, ArtifactType } from '../../engine/ir/artifact-summary.ts';
import type { ArtifactTimelineEvent, ArtifactTimelineEventType } from '../../engine/ir/artifact-timeline.ts';
import type { TraceabilityContext, TraceSource } from '../../engine/ir/traceability.ts';
import type { ResponsibilityCoverage } from '../../engine/runtime/evidence-coverage.ts';

export type { Person };
export type { DecisionRecord };
export type { CompanyRecord as Company };
export type { PoolNode as InfoNode };
export type { PoolEdge as InfoEdge };
export type { ApplicationRecord as Application };
export type { ApplicationRecord };
export type { ApplicationView };
export type { GapResult };
export type { HealthReport };
export type { ToolStats };
export type { ToolStatEntry };
export type { ToolSource };
export type { ToolEvidence };
export type { RiskLevel };
export type { ApplicationStatus };
export type { FollowUpState };
export type { AgentError };
export type { AgentRuntimeEvent };
export type { EvidenceItem };
export type { ResponsibilityCoverage };
export type { CareerClaim };
export type { ClaimCoverageRow };
export type { ResumeDocument };
export type { ResumeBullet };
export type { ResumeSection };
export type { ResumeIdentityEntry };
export type { ArtifactSummary };
export type { ArtifactType };
export type { ArtifactTimelineEvent };
export type { ArtifactTimelineEventType };
export type { TraceabilityContext };
export type { TraceSource };

/**
 * UI 会话扩展（引擎契约字段之外，仅 UI 会话渲染用）：
 * 工具调用附加「等待授权 / 已拒绝」状态——引擎 ToolCallStatus 无此值，
 * 真实 LLM 流的 permission_request 事件由 UI 侧写入。
 * Omit 重定义（status 是加宽联合，interface 继承不允许加宽属性）。
 */
export type ToolCallStatusUi = ToolCallStatus | 'waiting_approval' | 'denied'
export type ToolCallInfoUi = Omit<ToolCallInfo, 'status'> & { status: ToolCallStatusUi }

/** AskUserQuestion 卡片：Agent 以选择题征询用户；点击选项回填用户消息并标记已作答 */
export interface QuestionCard {
  id: string
  question: string
  options: string[]
  answered: boolean
  answer?: string
}

/** 挂起的权限请求（授权弹窗数据源；sessionId 保证审批结果写入所属会话） */
export interface PendingPermission {
  toolName: string
  description: string
  sessionId: string
}

/** 简历 AI 改写任务状态（浮层状态机；running 事件流由 handleAgentEvent 分叉路由） */
export type RewriteStatus = 'idle' | 'thinking' | 'streaming' | 'done' | 'error'
/** UI 本地改写错误（引擎 AgentErrorCode 之外：R002 断线 / R004 空输出——不经引擎事件） */
export type RewriteErrorCode = AgentErrorCode | 'empty_output' | 'transport_error'
export interface RewriteError {
  code: RewriteErrorCode
  message: string
  retryable: boolean
}
export interface RewriteState {
  status: RewriteStatus
  text: string
  /** 2B：agent 任务 id（rewrite/feedback 关联） */
  requestId?: string
  /** 2B：选中原文 SHA-256 截断（隐私：不存原文） */
  selectedTextHash?: string
  error?: RewriteError
}

/** 2B：rewrite 用户决策事件（契约 Resume-Feedback-Contract-v1） */
export type RewriteFeedbackReason =
  | 'inaccurate_claim'
  | 'wrong_direction'
  | 'wording_preference'
  | 'missing_context'
  | 'other'

export type ChatMessage = Omit<EngineChatMessage, 'toolCalls'> & {
  toolCalls?: ToolCallInfoUi[]
  question?: QuestionCard
  /** Agent 运行错误（引擎 agent.event error；页面渲染错误卡） */
  error?: AgentError
  /** 思考中指示（引擎 thinking_start 后、thinking 文本或回复未达前；首条 text_delta/tool_start 熄灭） */
  isThinking?: boolean
  /** 流式占位中（占位创建至 done/error/cancel 收尾；持久化恢复时据此识别断流消息） */
  streaming?: boolean
}

/**
 * UI 扩展 Session：messages 使用 UI ChatMessage（会话持久化于本地，刷新可恢复）；
 * sdkSessionId = SDK 会话凭据（resume 用）；contextBundle = ADR-020 显式上下文
 * （执行期快照，随执行记录存活——UI 只投影不解释）；status = 最近一次任务的异常
 * 终止标记（rejected/failed——正常流程不写，避免与 sessionTasks 双轨）
 */
export type Session = Omit<EngineSession, 'messages'> & {
  messages: ChatMessage[]
  sdkSessionId?: string
  contextBundle?: AgentContextBundle
  status?: 'rejected' | 'failed'
}

export type StageStatus = 'completed' | 'current' | 'pending' | 'skipped';

/**
 * M4-5.2：Proposal Center 的 UI View Model（Diff 统一的是 Presentation Contract，
 * 不统一 Artifact Semantics——四 adapter Concrete First 投影，生命周期只存在于 UI）。
 * 禁止扩展成事实模型：beforeFact/afterFact/confidence/ownershipDelta 永不出现。
 */
export interface DiffChange {
  before: string
  after: string
  /** AI 解释（proposal change 的 reason——展示给评审人，非事实模型字段） */
  reason?: string
}

export interface ArtifactDiffViewModel {
  artifactType: ArtifactType
  proposalId: string
  /** adapter 生成的展示标题（源 Artifact 定位） */
  title: string
  changes: DiffChange[]
  /** 展示性定位锚点（各 adapter 语义：claimId / factId / statementId / unitId） */
  anchors?: string[]
  canAccept: boolean
  canReject: boolean
}

export type MainWidthMode = 'narrow' | 'wide' | 'fullscreen';

export type NavPageId =
  | 'workbench'
  | 'agent'
  | 'infopool'
  | 'companies'
  | 'jobs'
  | 'applications'
  | 'artifacts'
  | 'resumes'
  | 'settings';

export interface DecisionStage {
  id: string;
  label: string;
  status: StageStatus;
  completedAt?: string;
  direction?: string;
  city?: string;
  nextActions?: string[];
  /** 该阶段全部合法决策 id（引擎链投影透传；阶段点击 → 决策列表） */
  decisionIds?: string[];
}

export interface Park {
  id: number;
  city: string;
  name: string;
  industry: string;
  lat: number;
  lon: number;
  source: string;
  year: number;
  companies: string[];
}

export interface ResumeVersion {
  id: string;
  name: string;
  personId: number;
  parentId?: string;
  updatedAt: string;
  targetCompany?: string;
  targetPosition?: string;
  modules: ResumeModule[];
  /** 演示数据标记（mock-data 合成人设——非真实档案派生，UI 展示「演示」角标） */
  isDemo?: boolean;
}

export interface ResumeModule {
  id: string;
  title: string;
  content: string;
  order: number;
  /** 身份事实字段条目（M5.2 G6 非 claim 通道；profile/education 等模块用——字段级渲染与编辑） */
  identity?: ResumeIdentityEntry[];
  /** 经历条目（Resume Entry Contract v0.2：工作经历/项目经验模块——条目头 + 描述 + 表述行；与 content 互斥） */
  entries?: ResumeEntry[];
}

/** 经历条目（Entry Contract v0.2）：事实头（title/role/period）+ 描述（项目概述/职责范围，事实通道）+ 表述行（行级 block 契约） */
export interface ResumeEntry {
  id: string;
  title: string;
  role?: string;
  period?: string;
  description?: string;
  content: string;
}

export interface PoolHealth {
  totalNodes: number;
  isolatedNodes: number;
  missingFields: number;
  healthPercent: number;
  lastUpdated: string;
}

export interface ApplicationStats {
  interviewing: number;
  applied: number;
  contacted: number;
  replied: number;
  offered: number;
  rejected: number;
  totalTargetCompanies: number;
  pendingFollowups: number;
}

export interface NextAction {
  label: string
  page: NavPageId
  jobId?: string
  prompt?: string
}

export interface CommandItem {
  id: string;
  label: string;
  group: string;
  path?: NavPageId;
  keywords?: string[];
  action?: () => void;
}
