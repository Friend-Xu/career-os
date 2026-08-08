/**
 * Agent Task & Context IR（ADR-020 + references/agent-task-contract-v0.1.md，Engine↔UI 共享契约）。
 * - Task Request 是瞬态请求契约（发送时冻结，不落盘）；三生命周期分离：
 *   TaskRequest（runtime）→ Session（history）→ Artifact/Decision（business state）
 * - Output Boundary：decision | artifact | none；禁止 application（ADR-019 用户行动事实）、
 *   company_assessment（ADR-018 纯 projection 无写入口）
 * - contextRefs 是领域对象引用，禁止 file/markdown/workspace_path
 */

/** 冻结枚举（Task Type Registry，9 型）——完整语义表见契约文档 §3 */
export type AgentTaskType =
  | 'job_analysis'
  | 'company_research'
  | 'decision_reassessment'
  | 'decision_review'
  | 'resume_generation'
  | 'resume_adaptation'
  | 'interview_preparation'
  | 'explanation'
  | 'career_direction'

/** Output Boundary：允许 decision/artifact/none；application/company_assessment 禁止 */
export type OutputTarget = 'decision' | 'artifact' | 'none'

/** v0.1 仅 user_action（scheduled/system_event 留位置——契约 §5 trigger） */
export type TaskTrigger = 'user_action'

/** 白名单数组（引擎无 enum——类型 + 校验值同源；RPC 边界校验消费） */
export const AGENT_TASK_TYPES: AgentTaskType[] = [
  'job_analysis',
  'company_research',
  'decision_reassessment',
  'decision_review',
  'resume_generation',
  'resume_adaptation',
  'interview_preparation',
  'explanation',
  'career_direction',
]

export const CONTEXT_REF_TYPES: ContextReference['type'][] = ['job', 'company', 'resume', 'decision']

export const OUTPUT_TARGETS: OutputTarget[] = ['decision', 'artifact', 'none']

/** Context Policy（Registry 语义表代码化——validator 消费；required 缺失 = TaskRejected） */
export interface ContextPolicy {
  required: ContextReference['type'][]
  optional: ContextReference['type'][]
  emptyAllowed: boolean
}

export const CONTEXT_POLICY: Record<AgentTaskType, ContextPolicy> = {
  job_analysis: { required: ['job'], optional: ['company', 'resume'], emptyAllowed: false },
  company_research: { required: ['company'], optional: [], emptyAllowed: false },
  decision_reassessment: { required: ['decision'], optional: [], emptyAllowed: false },
  decision_review: { required: ['decision'], optional: [], emptyAllowed: false },
  resume_generation: { required: [], optional: ['resume'], emptyAllowed: true },
  resume_adaptation: { required: ['job', 'resume'], optional: [], emptyAllowed: false },
  interview_preparation: { required: ['job'], optional: ['resume', 'company'], emptyAllowed: false },
  explanation: { required: [], optional: [], emptyAllowed: true },
  career_direction: { required: [], optional: ['resume'], emptyAllowed: true },
}

/** TaskRejected reason（契约 §6 失败语义：required 缺失 ≠ 引用不存在，语义分离） */
export type TaskRejectedReason = 'INVALID_CONTEXT_REFERENCE' | 'MISSING_REQUIRED_CONTEXT'

/** Context Assembly 失败返回（RPC 错误，不进入 runtime，不创建 Session） */
export interface AgentTaskRejected {
  reason: TaskRejectedReason
  refs: { type: ContextReference['type']; id: string; error: string }[]
}

/** 领域对象引用（禁 file/markdown/workspace_path——Context Contract 面向领域对象不面向存储结构） */
export interface ContextReference {
  type: 'job' | 'company' | 'resume' | 'decision'
  id: string
}

/** UI → Engine 的瞬态请求契约（发送时冻结，不落盘） */
export interface AgentTaskRequest {
  taskType: AgentTaskType
  contextRefs?: ContextReference[]
  outputTarget?: OutputTarget
  trigger: TaskTrigger
}

/** Engine 解析后的引用（snapshot = 解析时登记的当前标识，非 optimistic lock） */
export interface ResolvedContextReference {
  type: 'job' | 'company' | 'resume' | 'decision'
  id: string
  label?: string
  snapshot?: {
    kind: 'version' | 'timestamp' // resume=version / job/company/decision=timestamp
    value: string
  }
  provenance: {
    kind: string // 来源通道（如 'jd-analysis' / 'resume-artifact'）
    label: string // 展示标签（如「岗位分析」）
  }
}

/** Engine 为一次 Task 执行生成的可审计上下文声明（Reference Manifest，非 Knowledge Dump；
 *  双消费方：Agent prompt 注入 + UI「本次分析依据」投影） */
export interface AgentContextBundle {
  references: ResolvedContextReference[]
  generatedAt: string
}
