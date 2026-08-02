/**
 * 契约源引用：engine/ir/schema.ts（引擎 ↔ UI 共享契约源）
 * 仅 `import type`（编译期擦除，validator 运行时代码不进前端 bundle）。
 * 异名实体用别名 re-export，UI 其余代码从本文件取类型，零改动。
 */
import type {
  Person,
  DecisionRecord,
  CompanyRecord,
  PoolNode,
  PoolEdge,
  Application,
  Session as EngineSession,
  ChatMessage as EngineChatMessage,
  RiskLevel,
  ApplicationStatus,
  FollowupUrgency,
  ToolCallInfo,
  ToolCallStatus,
} from '../../engine/ir/schema.ts';

export type { Person };
export type { DecisionRecord };
export type { CompanyRecord as Company };
export type { PoolNode as InfoNode };
export type { PoolEdge as InfoEdge };
export type { Application };
export type { RiskLevel };
export type { ApplicationStatus };
export type { FollowupUrgency };

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

export type ChatMessage = Omit<EngineChatMessage, 'toolCalls'> & {
  toolCalls?: ToolCallInfoUi[]
  question?: QuestionCard
}

/** UI 扩展 Session：messages 使用 UI ChatMessage（会话仅 UI 运行时，不落盘） */
export type Session = Omit<EngineSession, 'messages'> & { messages: ChatMessage[] }

export type StageStatus = 'completed' | 'current' | 'pending' | 'skipped';

export type MainWidthMode = 'narrow' | 'wide' | 'fullscreen';

export type NavPageId =
  | 'workbench'
  | 'agent'
  | 'infopool'
  | 'companies'
  | 'applications'
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
}

export interface ResumeModule {
  id: string;
  title: string;
  content: string;
  order: number;
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
  title: string;
  description: string;
  completedStages: string[];
  priorities: string[];
  prompt: string;
  stageId: string;
}

export interface TargetRoleRec {
  id: string;
  name: string;
  match: number;
  reason: string;
}

export interface CommandItem {
  id: string;
  label: string;
  group: string;
  path?: NavPageId;
  keywords?: string[];
  action?: () => void;
}
