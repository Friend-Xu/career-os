export type StageStatus = 'completed' | 'current' | 'pending' | 'skipped';

export type RiskLevel = 'low' | 'medium' | 'high';

export type ApplicationStatus =
  | '已评估'
  | '已投递'
  | '已联系'
  | '已回复'
  | '面试中'
  | '已录取'
  | '已拒绝';

export type FollowupUrgency = 'urgent' | 'overdue' | 'waiting' | 'cooled';

export type MainWidthMode = 'narrow' | 'wide' | 'fullscreen';

export type NavPageId =
  | 'workbench'
  | 'agent'
  | 'infopool'
  | 'companies'
  | 'applications'
  | 'resumes'
  | 'settings';

export interface Person {
  id: number;
  name: string;          // 对应 profiles/{name}.md（人）
  color: string;
  emoji: string;
  matchScore: number;    // 综合画像匹配度
  riskLevel: RiskLevel;
  archived: boolean;
  profilePath: string;
  targetRoles?: string[]; // 目标岗位列表（创建人向导推荐确认）
}

export interface DecisionStage {
  id: string;
  label: string;
  status: StageStatus;
  completedAt?: string;
  direction?: string;
  city?: string;
  nextActions?: string[];
}

export interface DecisionRecord {
  id: string;
  title: string;
  skill: string;
  direction: string;
  directionMatch: number;
  directionConfidence: 'high' | 'medium' | 'low';
  city: string;
  cityScore: number;
  salaryFeasible: boolean;
  riskLevel: RiskLevel;
  keyRisk: string;
  status: string;
  profile: string;
  summary: string;
  createdAt: string;
  protocolVersion: string;
}

export interface Company {
  id: string;
  name: string;
  city: string;
  industry: string;
  matchScore: number;
  riskLevel: RiskLevel;
  source: string;
  tags: string[];
  contacted: boolean;
  parkId?: number;
}

export interface Application {
  id: number;
  personId: number;
  company: string;
  position: string;
  sourceDecision?: string;
  status: ApplicationStatus;
  appliedAt?: string;
  followupDue?: string;
  urgency: FollowupUrgency;
  notes?: string;
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

export interface Session {
  id: string;
  title: string;
  personId: number;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  messages: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  thinking?: string;
  reportCard?: DecisionRecord;
  toolCalls?: { name: string; status: 'running' | 'done' | 'error' }[];
}

export interface InfoNode {
  id: string;
  label: string;
  type: 'person' | 'decision' | 'direction' | 'city' | 'company';
  riskLevel?: RiskLevel;
  matchScore?: number;
  x?: number;
  y?: number;
}

export interface InfoEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  strength: 'high' | 'medium' | 'low';
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
