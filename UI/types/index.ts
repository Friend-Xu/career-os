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
  Session,
  ChatMessage,
  RiskLevel,
  ApplicationStatus,
  FollowupUrgency,
} from '../../engine/ir/schema.ts';

export type { Person };
export type { DecisionRecord };
export type { CompanyRecord as Company };
export type { PoolNode as InfoNode };
export type { PoolEdge as InfoEdge };
export type { Application };
export type { Session };
export type { ChatMessage };
export type { RiskLevel };
export type { ApplicationStatus };
export type { FollowupUrgency };

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
