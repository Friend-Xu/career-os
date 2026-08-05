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
  /** 决策链投影（按人分组的 computeChain 派生视图，6 阶段状态机） */
  chain: 'decisions/chain',
  /** 决策聚合视图（V1.5：DecisionContext 问题绑定 + 运行时组装，不落盘） */
  contexts: 'contexts/list',
  /** 知识层（V2）：技能词表 + 岗位清单（Skill[] + Role[]，图谱节点派生） */
  knowledgeGraph: 'knowledge/graph',
  /** 差距分析（V2）：params { person, roleId } → GapResult（满足/可迁移/缺失清单，纯派生不打分） */
  knowledgeGap: 'knowledge/gap',
  /** 公司档案列表（完整 CompanyRecord，含 validation 标记） */
  listCompanies: 'companies/list',
  /** 单个公司档案全文（params: { id } → { id, markdown }；尽调详情正文渲染用） */
  companyGet: 'companies/get',
  /** 人列表（投影） */
  listPersons: 'persons/list',
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
  /** companies/ 目录变更后推送（不含数据，客户端用 companies/list 拉快照） */
  companiesChanged: 'data.companies.changed',
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
