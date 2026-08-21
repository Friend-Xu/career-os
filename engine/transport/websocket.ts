/**
 * WebSocket 桥（第 3 步）：RPC 分派 + 事件广播。
 * - 契约：protocol.ts 定稿（RpcRequest/RpcResponse/ServerEvent + METHODS/EVENTS），严格按此实现
 * - 权限：仅本机回环（个人使用；监听地址 = config.server.host，另拒绝非回环远端）
 * - 分派失败：未注册方法 → method_not_found；非 RPC 帧 → invalid_request；处理器异常 → internal_error
 * - 端口：EADDRINUSE 时日志警告后 +1 递增重试（最多 5 次），仍失败抛 ServerError fail fast
 * - 广播：ServerEvent 单帧发给所有连接客户端（事件是通知，状态走 RPC 拉取）
 */
import { WebSocketServer, type WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG_PATH, defaultConfig, type AgentProvider, type EngineConfig, type PermissionMode } from '../config.ts'
import type { Workspace } from '../storage/workspace.ts'
import type { Logger } from '../logger.ts'
import type { ApplicationStatus, DecisionAggregate, DecisionHistory, DecisionRecord, ConstraintMatchRow, DecisionCandidate, EvidenceRef, GapResult, JDAnalysisProposal, JDIntelligenceResult, Person, PersonSkill, ResumeRewriteContext } from '../ir/schema.ts'
import { DecisionRuntime } from '../runtime/decision-runtime.ts'
import { AgentRuntime, type AgentStartParams } from '../runtime/agent-runtime.ts'
import {
  AGENT_TASK_TYPES,
  CONTEXT_REF_TYPES,
  OUTPUT_TARGETS,
  type AgentContextBundle,
  type AgentTaskRejected,
  type AgentTaskRequest,
  type AgentTaskType,
  type ContextReference,
  type OutputTarget,
} from '../ir/agent-task.ts'
import {
  abortWorkflow,
  advanceWorkflow,
  compileStageTask,
  getWorkflow,
  onEvaluationDone,
  onExplorationDone,
  onFactCollectionReady,
  onRecommendationDone,
  restageWorkflow,
  scanWorkflows,
  STAGE_IDS,
  startWorkflow,
  WORKFLOW_TYPES,
  type StageId,
  type WorkflowType,
} from '../storage/workflow-registry.ts'
import { validateContextPolicy } from '../agent/context/validator.ts'
import { resolveContextRefs, type RegistryStore } from '../agent/context/resolver.ts'
import { assembleContextBundle } from '../agent/context/assembler.ts'
import { buildContextSystemPrompt } from '../agent/context/prompt.ts'

/** TaskRejected → RPC error message（RPC 通道仅 code+message——reason/refs 编码进 message，UI 按前缀识别） */
function taskRejectedMessage(rejected: AgentTaskRejected): string {
  const refs = rejected.refs.map((r) => `${r.type} ${r.id || '(无)'} ${r.error}`).join('; ')
  return `TaskRejected: ${rejected.reason}${refs ? `: ${refs}` : ''}`
}
import { buildAggregates } from '../runtime/decision-aggregate.ts'
import { computeGap } from '../runtime/gap-calculator.ts'
import { parseJdConstraint } from '../runtime/jd-constraint.ts'
import { matchEducation, matchExperience } from '../runtime/constraint-matcher.ts'
import { buildDecisionCandidate, constraintRefOf, resolveGapDisplay } from '../runtime/decision-draft.ts'
import { buildResumeRewriteContext, parseNarrativeSections } from '../runtime/resume-context.ts'
import { parseCompanyFacts } from '../runtime/company-fact-parser.ts'
import { computeCompanyAssessment } from '../runtime/company-assessment.ts'
import { computeJDMatchScore } from '../runtime/jd-match-score.ts'
import { composeAutoSummaryTable, writeDecisionRecord, type DecisionNarrativeDraft } from '../storage/decision-writer.ts'
import { splitFrontmatter } from '../storage/artifact-registry.ts'
import { analyzeJob } from '../runtime/jd-intelligence.ts'
import { generateHealthReport } from '../health/checker.ts'
import { exportPdf } from '../export/pdf.ts'
import { recordRewriteFeedback } from '../feedback/writer.ts'
import { scanContexts } from '../storage/context-watcher.ts'
import { scanKnowledge } from '../storage/knowledge-watcher.ts'
import { appendCandidates, appendSessionTurn, completePersonInit, createPersonSession, deletePerson, listCandidates, resetPerson, resolveCandidate, scanPersons, upsertSummaryStrengths } from '../storage/person-watcher.ts'
import { projectPersonSnapshots } from '../storage/person-snapshot-projection.ts'
import { createResumeArtifact } from '../storage/pdf-artifact.ts'
import { extractLocalText, extractVisionPages } from '../runtime/document/pdf-import.ts'
import { ZhipuVisionProvider } from '../runtime/document/vision-provider.ts'
import { archiveCurrentSnapshot, listSnapshotVersions } from '../storage/snapshot-archive.ts'
import { buildCandidates, type CandidateTrigger } from '../runtime/ledger-candidate.ts'
import { commitLedgerEvent, readLedgerEvents, commitDecisionLedgerEvent } from '../storage/ledger-writer.ts'
import { projectDecision } from '../ir/decision-projection.ts'
import { detectDecisionChange } from '../runtime/decision-change-detector.ts'
import { whyChanged, replayDecision, whyChangedRecently } from '../runtime/evolution-query.ts'
import { updateDecisionFile, readDecisionFile } from '../storage/decision-editor.ts'
import { createJobFile, deleteJobFile, scanJobs, type CreateJobParams } from '../storage/job-watcher.ts'
import { scanTargets } from '../storage/target-watcher.ts'
import { scanCandidatePool, upsertCandidatePool, type CandidatePoolInput } from '../storage/candidate-pool.ts'
import { scanJobLeads, upsertJobLeads, type JobLeadInput } from '../storage/job-leads.ts'
import { scanSalaryBenchmarks, upsertSalaryBenchmarks, type SalaryBenchmarkInput } from '../storage/salary-benchmarks.ts'
import { buildSalaryValuationCard } from '../ir/salary.ts'
import { writeJDAnalysis } from '../storage/jd-analysis-writer.ts'
import { validateJDAnalysisProposal } from '../runtime/jd-analysis-validator.ts'
import { scanEvidence } from '../storage/evidence-watcher.ts'
import { scanClaims } from '../storage/claim-watcher.ts'
import {
  approveClaimProposal,
  createClaimProposal,
  rejectClaimProposal,
  scanClaimProposals,
  type ClaimProposalInput,
} from '../storage/claim-proposal-registry.ts'
import {
  approveOpportunityProposal,
  applyOpportunityProposal,
  bindClaimToBlock,
  buildBridgeContext,
  buildClaimBridgeContext,
  rejectOpportunityProposal,
  scanOpportunityProposals,
  submitClaimBridge,
  submitOpportunityProposal,
} from '../storage/opportunity-proposal-registry.ts'
import { decideStrengthProposal, scanStrengthProposals } from '../storage/strength-proposal-registry.ts'
import { decideDerivationProposal, scanDerivationProposals } from '../storage/derivation-proposal-registry.ts'
import {
  promoteToDocumentCandidate,
  scanWorkingCopies,
  upsertWorkingCopy,
  workingCopyToDocument,
  type WorkingCopyInput,
} from '../storage/working-copy-registry.ts'
import { scanResumes, transitionResumeStatusFile, cloneResumeFile, diffResumes, markResumeExported } from '../storage/resume-watcher.ts'
import { indexEvidence, canUseClaim } from '../storage/claim-policy.ts'
import { computeClaimCoverage } from '../runtime/claim-coverage.ts'
import { selectExpressionCandidates } from '../runtime/claim-selector.ts'
import { exportResumePdf, serializeExportRecord } from '../export/resume-export.ts'
import { buildCareerContext } from '../context/career-context.ts'
import { computeEvidenceCoverage } from '../runtime/evidence-coverage.ts'
import { computeResumeAlignment } from '../runtime/resume-alignment.ts'
import { computeOpportunities } from '../runtime/opportunity.ts'
import { acceptProposalFile, rejectProposalFile, scanProposals } from '../storage/proposal-watcher.ts'
import {
  acceptPortfolioProposal,
  rejectPortfolioProposal,
  scanPortfolioProjects,
  scanPortfolioProposals,
  transitionPortfolioProject,
} from '../storage/portfolio-watcher.ts'
import type { PortfolioStatus } from '../ir/portfolio.ts'
import {
  acceptInterviewProposal,
  rejectInterviewProposal,
  scanInterviewProposals,
  scanInterviewQas,
  transitionInterviewQa,
} from '../storage/interview-watcher.ts'
import type { InterviewStatus } from '../ir/interview.ts'
import {
  acceptCoverLetterProposal,
  rejectCoverLetterProposal,
  scanCoverLetterProposals,
  scanCoverLetters,
  transitionCoverLetter,
} from '../storage/cover-letter-watcher.ts'
import type { CoverLetterStatus } from '../ir/cover-letter.ts'
import { buildArtifactSummaries } from '../artifact-summary/index.ts'
import { buildArtifactTimeline } from '../artifact-timeline/index.ts'
import { buildCoverLetterTraceability } from '../artifact-traceability/cover-letter-traceability.ts'
import { deleteCompanyFile, readCompanyFile, type CompanyView, type ProjectionStore } from '../storage/projection.ts'
import { extractJdFields } from '../runtime/jd-extract.ts'
import {
  applicationView,
  createApplication,
  deleteApplication,
  linkApplicationDecision,
  listApplications,
  updateApplicationStatus,
} from '../storage/application-registry.ts'
import type { CreateApplicationRequest } from '../ir/schema.ts'
import { METHODS, EVENTS, type RpcRequest, type RpcResponse, type ServerEvent } from './protocol.ts'
import { listStageArtifacts, readStageArtifact, resolveStageArtifact, type StageArtifactRejection } from '../storage/stage-artifact-registry.ts'
import { DIRECTION_SPEC, EVALUATION_SPEC } from '../storage/artifact-type-registry.ts'
import { registerDecisionIdentity } from '../storage/decision-registry.ts'

/** intake 边界判定（契约 v0.2 §1.6）：本次执行新产生的提案文件 = 当前目录 - 启动时快照（纯函数，可单测） */
export function freshIntakeFiles(current: string[], intake: string[]): string[] {
  return current.filter((f) => !intake.includes(f))
}

/** 登记拒绝 → error.engine 广播 message（契约 v0.2 §1.5：管线错误对用户可见）。
 *  纯格式化（可单测）；broadcast + logger 接线由 done 钩子闭包完成。 */
export function formatRegistrationRejectionMessage(artifactType: string, rejected: StageArtifactRejection[]): string {
  const lines = rejected.map((r) => `${r.proposalFile}（${r.code}：${r.reason}）`)
  return `阶段产出登记被拒（${artifactType}）${rejected.length} 条：\n${lines.join('\n')}`
}

/** 端口占用递增兜底次数（config.server.port 起最多 +5） */
const MAX_PORT_RETRIES = 5

/** 端口监听失败（递增耗尽）→ main.ts 以 ❌ 风格输出 */
export class ServerError extends Error {
  constructor(message: string) {
    super(`❌ server：${message}`)
    this.name = 'ServerError'
  }
}

/** 桥的查询入口（main 注入；投影服务实现，RPC 处理器从 store 取数） */
export interface BridgeStore {
  init(): unknown
  listDecisions(): unknown
  rescan(): unknown
  listCompanies(): unknown
  listPersons(): unknown
  graph(): unknown
}

export interface ServerHandle {
  port: number
  broadcast(event: ServerEvent): void
  /** 优雅关闭：中止全部活跃 Agent 任务（SDK close → CLI 子进程终止） */
  shutdown(): void
}

function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function isRpcRequest(v: unknown): v is RpcRequest {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as RpcRequest).id === 'string' &&
    typeof (v as RpcRequest).method === 'string'
  )
}

/**
 * decision/history 处理器派生：listDecisions() 按 profile 分组 → 每人对该人决策调 computeHistory。
 * 空历史过滤：computeHistory 内部已排除 invalid 决策（Validation.status === 'invalid'），
 * 无任何决策类型（groups 为空）即该人无合法决策 → 不返回。
 */
export function computeHistories(decisions: DecisionRecord[], runtime: DecisionRuntime): DecisionHistory[] {
  const byPerson = new Map<string, DecisionRecord[]>()
  for (const d of decisions) {
    if (!d.profile) continue // v2.0 旧记录无 profile，无法归属人
    const list = byPerson.get(d.profile)
    if (list) list.push(d)
    else byPerson.set(d.profile, [d])
  }
  const histories: DecisionHistory[] = []
  for (const person of [...byPerson.keys()].sort()) {
    const history = runtime.computeHistory(byPerson.get(person)!, person)
    if (history.groups.length > 0) histories.push(history)
  }
  return histories
}

/** contexts/list 处理器派生：context 目录扫描 + 决策投影 → 按 context 组装聚合（纯函数，不落盘） */
export function listContexts(workspace: Workspace, store: BridgeStore): DecisionAggregate[] {
  return buildAggregates(scanContexts(workspace), store.listDecisions() as DecisionRecord[])
}

/** knowledge/gap 处理器派生：roleId 找 Role + person 找画像技能声明 → computeGap（纯派生，不落盘） */
/** 公司档案 md → CompanyAssessment 附加（Projection Artifact，不写回 markdown）：
 *  无 `## 公司事实` 段 → null（未评估 ≠ 0 分）；有段 → 确定性计分。
 *  契约 company-assessment-contract-v0.1 §7/§8——storage 不 import runtime，组装在 transport 层。 */
export function attachCompanyAssessments(workspace: Workspace, views: CompanyView[]): CompanyView[] {
  return views.map((v) => {
    const md = workspace.read(`companies/${v.id}.md`)
    const { facts } = parseCompanyFacts(md, v.id)
    return { ...v, assessment: facts.length === 0 ? null : computeCompanyAssessment(facts) }
  })
}

export function computeKnowledgeGap(workspace: Workspace, params: { person: string; roleId: string }): GapResult {
  const { skills, roles } = scanKnowledge(workspace)
  const role = roles.find((r) => r.id === params.roleId)
  if (!role) throw new Error(`角色不存在：${params.roleId}`)
  const personSkills = personSkillsOf(workspace, params.person)
  return computeGap({ role, person: params.person, personSkills, skills })
}

/** M6.6.5：Person 技能声明唯一来源 = persons/（skill_inventory.md 派生）；旧 profiles 失去输入权 */
function personSkillsOf(workspace: Workspace, person: string): PersonSkill[] {
  return scanPersons(workspace).find((p) => p.name === person)?.skills ?? []
}

/** jd/analyze 处理器：JobRecord + Person Aggregate → JDIntelligenceResult（Contract 形态，不产生 user_decision） */
export function computeJdAnalysis(workspace: Workspace, params: { jobId: string; personId: string }): JDIntelligenceResult {
  const job = scanJobs(workspace).find((j) => j.record.id === params.jobId)
  if (!job) throw new Error(`岗位不存在：${params.jobId}`)
  const person = scanPersons(workspace).find((p) => p.personId === params.personId)
  if (!person) throw new Error(`人不存在：${params.personId}`)
  const { skills } = scanKnowledge(workspace)
  return analyzeJob({ job: job.record, person, skills, prefCities: defaultConfig().prefCities ?? [] })
}

/** person/session/create 入参校验（RPC 边界：用户输入校验，fail fast） */
function createPersonSessionParams(params: unknown): { name: string; sourceMode: 'resume' | 'interview' } {
  const p = (params ?? {}) as Record<string, unknown>
  const name = typeof p.name === 'string' ? p.name.trim() : ''
  const sourceMode = p.sourceMode
  if (!name) throw new Error('name 必填')
  if (sourceMode !== 'resume' && sourceMode !== 'interview') throw new Error('sourceMode 必须为 resume 或 interview')
  return { name, sourceMode }
}

/** person/session/append 入参校验（RPC 边界） */
function appendSessionTurnParams(params: unknown): { personId: string; role: 'user' | 'assistant'; content: string; timestamp?: string } {
  const p = (params ?? {}) as Record<string, unknown>
  const personId = typeof p.personId === 'string' ? p.personId.trim() : ''
  const role = p.role
  const content = typeof p.content === 'string' ? p.content.trim() : ''
  if (!personId) throw new Error('personId 必填')
  if (role !== 'user' && role !== 'assistant') throw new Error('role 必须为 user 或 assistant')
  if (!content) throw new Error('content 必填')
  const timestamp = typeof p.timestamp === 'string' ? p.timestamp : undefined
  return { personId, role, content, timestamp }
}

/** person/session/candidates 入参校验（RPC 边界：candidates 数组，category/content 校验） */
function appendCandidatesParams(params: unknown): { personId: string; candidates: { category: string; content: string; source: string; payload?: string }[] } {
  const p = (params ?? {}) as Record<string, unknown>
  const personId = typeof p.personId === 'string' ? p.personId.trim() : ''
  if (!personId) throw new Error('personId 必填')
  if (!Array.isArray(p.candidates)) throw new Error('candidates 必须为数组')
  const categories = ['education', 'experience', 'skill', 'constraint', 'interest']
  const sources = ['user_reported', 'resume']
  const candidates = (p.candidates as unknown[])
    .map((c) => {
      const raw = (c ?? {}) as Record<string, unknown>
      return {
        category: typeof raw.category === 'string' ? raw.category : '',
        content: typeof raw.content === 'string' ? raw.content : '',
        source: typeof raw.source === 'string' ? raw.source : 'user_reported',
        payload: typeof raw.payload === 'string' && raw.payload.trim() ? raw.payload.trim() : undefined,
      }
    })
    .filter((c) => categories.includes(c.category) && c.content.trim() && sources.includes(c.source))
  return { personId, candidates }
}

/** person/candidates/resolve 入参校验（RPC 边界：action 白名单；modified 需内容） */
function resolveCandidateParams(params: unknown): { personId: string; candidateId: string; action: 'confirmed' | 'rejected' | 'modified'; modifiedContent?: string } {
  const p = (params ?? {}) as Record<string, unknown>
  const personId = typeof p.personId === 'string' ? p.personId.trim() : ''
  const candidateId = typeof p.candidateId === 'string' ? p.candidateId.trim() : ''
  const action = p.action
  if (!personId) throw new Error('personId 必填')
  if (!candidateId) throw new Error('candidateId 必填')
  if (action !== 'confirmed' && action !== 'rejected' && action !== 'modified') throw new Error('action 必须为 confirmed/rejected/modified')
  const modifiedContent = typeof p.modifiedContent === 'string' ? p.modifiedContent.trim() : undefined
  if (action === 'modified' && !modifiedContent) throw new Error('modified 需提供 modifiedContent')
  return { personId, candidateId, action, modifiedContent }
}

/** person/directions/list 入参校验（RPC 边界；workflowId 可选过滤） */
function directionsListParams(params: unknown): { personId: string; workflowId?: string } {
  const p = (params ?? {}) as Record<string, unknown>
  const personId = typeof p.personId === 'string' ? p.personId.trim() : ''
  if (!personId) throw new Error('personId 必填')
  const workflowId = typeof p.workflowId === 'string' && p.workflowId.trim() ? p.workflowId.trim() : undefined
  return { personId, workflowId }
}

/** person/directions/resolve 入参校验（RPC 边界：action 白名单；directionId 在 person 命名空间内） */
function directionsResolveParams(params: unknown): { personId: string; directionId: string; action: 'confirm' | 'reject' } {
  const p = (params ?? {}) as Record<string, unknown>
  const personId = typeof p.personId === 'string' ? p.personId.trim() : ''
  const directionId = typeof p.directionId === 'string' ? p.directionId.trim() : ''
  const action = p.action
  if (!personId) throw new Error('personId 必填')
  if (!directionId) throw new Error('directionId 必填')
  if (action !== 'confirm' && action !== 'reject') throw new Error('action 必须为 confirm/reject')
  return { personId, directionId, action }
}

/** person/evaluations/get 入参校验（RPC 边界；evaluationId 在 person 命名空间内） */
function evaluationsGetParams(params: unknown): { personId: string; evaluationId: string } {
  const p = (params ?? {}) as Record<string, unknown>
  const personId = typeof p.personId === 'string' ? p.personId.trim() : ''
  const evaluationId = typeof p.evaluationId === 'string' ? p.evaluationId.trim() : ''
  if (!personId) throw new Error('personId 必填')
  if (!evaluationId) throw new Error('evaluationId 必填')
  return { personId, evaluationId }
}

/** jd/analyze 入参校验（RPC 边界：用户输入校验，fail fast） */
function jdAnalyzeParams(v: unknown): { jobId: string; personId: string } {
  if (typeof v !== 'object' || v === null) throw new Error('jd/analyze 需要 params { jobId, personId }')
  const p = v as Record<string, unknown>
  if (typeof p.jobId !== 'string' || p.jobId.length === 0) throw new Error('params.jobId 缺失（岗位 id）')
  if (typeof p.personId !== 'string' || p.personId.length === 0) throw new Error('params.personId 缺失（person_xxx）')
  return { jobId: p.jobId, personId: p.personId }
}

/** knowledge/gap 入参校验（RPC 边界：用户输入校验，fail fast） */
function gapParams(v: unknown): { person: string; roleId: string } {
  if (typeof v !== 'object' || v === null) throw new Error('knowledge/gap 需要 params { person, roleId }')
  const p = v as Record<string, unknown>
  if (typeof p.person !== 'string' || p.person.length === 0) throw new Error('params.person 缺失（画像名）')
  if (typeof p.roleId !== 'string' || p.roleId.length === 0) throw new Error('params.roleId 缺失（岗位 id）')
  return { person: p.person, roleId: p.roleId }
}

/** decisions/update 入参校验（RPC 边界：用户输入校验，fail fast） */
function updateDecisionParams(v: unknown): { id: string; fields: Record<string, string> } {
  if (typeof v !== 'object' || v === null) throw new Error('decisions/update 需要 params { id, fields }')
  const p = v as Record<string, unknown>
  if (typeof p.id !== 'string' || p.id.length === 0) throw new Error('params.id 缺失（决策文件名）')
  if (typeof p.fields !== 'object' || p.fields === null || Array.isArray(p.fields)) {
    throw new Error('params.fields 应为对象 { 字段: 值 }')
  }
  const fields: Record<string, string> = {}
  for (const [k, val] of Object.entries(p.fields)) {
    if (typeof val !== 'string') throw new Error(`params.fields.${k} 应为字符串`)
    fields[k] = val
  }
  return { id: p.id, fields }
}

/** jobs/create 入参校验（RPC 边界：用户输入校验，fail fast） */
function createJobParams(v: unknown): CreateJobParams {
  if (typeof v !== 'object' || v === null) throw new Error('jobs/create 需要 params { company, title, ... }')
  const p = v as Record<string, unknown>
  if (typeof p.company !== 'string' || p.company.length === 0) throw new Error('params.company 缺失（公司名）')
  if (typeof p.title !== 'string' || p.title.length === 0) throw new Error('params.title 缺失（岗位名）')
  const out: CreateJobParams = { company: p.company, title: p.title }
  for (const k of ['location', 'salary', 'jdSource', 'requirements', 'jdText'] as const) {
    if (p[k] !== undefined) {
      if (typeof p[k] !== 'string') throw new Error(`params.${k} 应为字符串`)
      out[k] = p[k] as string
    }
  }
  return out
}

/** jobs/get / jobs/match / jobs/delete / companies/get / companies/delete 的 id 提取（RPC 边界） */
function jobIdParams(v: unknown): string {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>).id !== 'string') {
    throw new Error('params.id 缺失')
  }
  return (v as Record<string, unknown>).id as string
}

/** targets/get 入参校验（RPC 边界：id 必填 string 非空——target id 来自 frontmatter，非目录名） */
function targetGetParams(v: unknown): string {
  const id = typeof v === 'object' && v !== null ? (v as Record<string, unknown>).id : undefined
  if (typeof id !== 'string' || id.length === 0) throw new Error('params.id 缺失（target id）')
  return id
}

/** applications/create 入参校验（RPC 边界）：createdBy 必须 'user'——Agent 禁止创建（Step 3.2） */
function createApplicationParams(v: unknown): CreateApplicationRequest {
  if (typeof v !== 'object' || v === null) throw new Error('applications/create 需要 params { jobId, personId, createdBy }')
  const p = v as Record<string, unknown>
  if (typeof p.jobId !== 'string' || p.jobId.length === 0) throw new Error('params.jobId 缺失（岗位引用）')
  if (typeof p.personId !== 'string' || p.personId.length === 0) throw new Error('params.personId 缺失（归属人）')
  if (p.createdBy !== 'user') throw new Error(`params.createdBy 必须为 'user'（收到 ${JSON.stringify(p.createdBy)}——Agent 禁止创建 Application）`)
  const out: CreateApplicationRequest = { jobId: p.jobId, personId: p.personId }
  if (p.decisionId !== undefined) {
    if (typeof p.decisionId !== 'string') throw new Error('params.decisionId 应为字符串')
    out.decisionId = p.decisionId
  }
  return out
}

/** applications/update-status 入参校验（RPC 边界）：id + status 字符串 */
function updateApplicationStatusParams(v: unknown): { id: string; status: string } {
  if (typeof v !== 'object' || v === null) throw new Error('applications/update-status 需要 params { id, status }')
  const p = v as Record<string, unknown>
  if (typeof p.id !== 'string' || p.id.length === 0) throw new Error('params.id 缺失')
  if (typeof p.status !== 'string' || p.status.length === 0) throw new Error('params.status 缺失')
  return { id: p.id, status: p.status }
}

/** decision/narrative-submit 入参校验（RPC 边界）：narrative 可选对象，各段可选字符串 */
function narrativeParams(v: unknown): DecisionNarrativeDraft {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('params.narrative 需为对象')
  const out: DecisionNarrativeDraft = {}
  for (const key of ['summary', 'understanding', 'preparationPlan', 'resumeAdvice'] as const) {
    const val = (v as Record<string, unknown>)[key]
    if (val === undefined) continue
    if (typeof val !== 'string') throw new Error(`narrative.${key} 需为字符串`)
    out[key] = val
  }
  return out
}

/** snapshot/archive 入参校验（RPC 边界：reason 白名单字符，sourceRefs 字符串数组） */
function snapshotArchiveParams(v: unknown): { personId: string; reason: string; trigger?: string; sourceRefs?: string[] } {
  if (typeof v !== 'object' || v === null) throw new Error('snapshot/archive 需要 params { personId, reason }')
  const p = v as Record<string, unknown>
  if (typeof p.personId !== 'string' || p.personId.length === 0) throw new Error('params.personId 缺失（person_xxx）')
  if (typeof p.reason !== 'string' || p.reason.length === 0) throw new Error('params.reason 缺失（归档原因，如 skill_update）')
  let sourceRefs: string[] | undefined
  if (p.sourceRefs !== undefined) {
    if (!Array.isArray(p.sourceRefs) || !p.sourceRefs.every((s) => typeof s === 'string')) {
      throw new Error('params.sourceRefs 需为字符串数组')
    }
    sourceRefs = p.sourceRefs as string[]
  }
  return {
    personId: p.personId,
    reason: p.reason,
    ...(typeof p.trigger === 'string' && p.trigger.length > 0 ? { trigger: p.trigger } : {}),
    ...(sourceRefs ? { sourceRefs } : {}),
  }
}

/** snapshot/versions 入参校验（RPC 边界：personId 缺失 fail fast） */
function snapshotVersionsParams(v: unknown): string {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>).personId !== 'string') {
    throw new Error('snapshot/versions 需要 params { personId }')
  }
  return (v as Record<string, unknown>).personId as string
}

/** 通用 personId 提取（RPC 边界：缺失 fail fast） */
function personIdParams(v: unknown): string {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>).personId !== 'string') {
    throw new Error('需要 params { personId }')
  }
  return (v as Record<string, unknown>).personId as string
}

/** workflow/start 入参校验（RPC 边界：type/personId/statement fail fast） */
function workflowStartParams(v: unknown): { type: WorkflowType; personId: string; statement: string } {
  if (typeof v !== 'object' || v === null) throw new Error('需要 params { type, personId, statement }')
  const p = v as Record<string, unknown>
  const type = p.type
  const personId = p.personId
  const statement = p.statement
  if (typeof type !== 'string' || !WORKFLOW_TYPES.includes(type as WorkflowType)) {
    throw new Error(`type 非法（合法：${WORKFLOW_TYPES.join('/')}）`)
  }
  if (typeof personId !== 'string' || !/^person_\d{3}$/.test(personId)) {
    throw new Error('personId 应为 person_XXX')
  }
  if (typeof statement !== 'string' || statement.trim().length === 0) throw new Error('statement 必填（用户目标原文）')
  return { type: type as WorkflowType, personId, statement: statement.trim() }
}

/** workflow/advance 入参校验（gateId 可选） */
function workflowAdvanceParams(v: unknown): { workflowId: string; gateId?: string } {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>).workflowId !== 'string') {
    throw new Error('需要 params { workflowId }')
  }
  const gateId = (v as Record<string, unknown>).gateId
  if (gateId !== undefined && typeof gateId !== 'string') throw new Error('gateId 应为字符串')
  return { workflowId: (v as Record<string, unknown>).workflowId as string, ...(typeof gateId === 'string' ? { gateId } : {}) }
}

/** workflow/get|abort 的 workflowId 提取 */
function workflowIdParams(v: unknown): string {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>).workflowId !== 'string') {
    throw new Error('需要 params { workflowId }')
  }
  return (v as Record<string, unknown>).workflowId as string
}

/** person/summary-strengths/upsert 入参校验（RPC 边界：personId + items 数组
 *  { text, claimIds, evidenceIds }——引用数组可为空数组） */
function summaryStrengthsParams(v: unknown): { personId: string; items: { text: string; claimIds: string[]; evidenceIds: string[] }[] } {
  if (typeof v !== 'object' || v === null) throw new Error('需要 params { personId, items }')
  const p = v as Record<string, unknown>
  const personId = typeof p.personId === 'string' ? p.personId : ''
  if (!personId) throw new Error('personId 必填')
  if (!Array.isArray(p.items)) throw new Error('items 必填（{ text, claimIds, evidenceIds }[]）')
  const items = (p.items as unknown[]).map((it) => {
    if (typeof it !== 'object' || it === null) throw new Error('items 元素必须是 { text, claimIds, evidenceIds }')
    const r = it as Record<string, unknown>
    if (typeof r.text !== 'string') throw new Error('items 元素需要 text')
    const ids = (v: unknown): string[] => {
      if (!Array.isArray(v)) throw new Error('items 元素的 claimIds/evidenceIds 必须是字符串数组')
      return (v as unknown[]).map((x) => {
        if (typeof x !== 'string') throw new Error('引用必须是字符串 id')
        return x
      })
    }
    return { text: r.text, claimIds: ids(r.claimIds ?? []), evidenceIds: ids(r.evidenceIds ?? []) }
  })
  return { personId, items }
}

/** person/strength-proposals/decide 入参校验（RPC 边界：id + action 白名单；reason 可选） */
function strengthProposalDecideParams(v: unknown): { id: string; action: 'accept' | 'reject'; reason?: string } {
  if (typeof v !== 'object' || v === null) throw new Error('需要 params { id, action }')
  const p = v as Record<string, unknown>
  const id = typeof p.id === 'string' ? p.id : ''
  if (!id) throw new Error('id 必填')
  if (p.action !== 'accept' && p.action !== 'reject') throw new Error('action 必须是 accept / reject')
  return { id, action: p.action, ...(typeof p.reason === 'string' && p.reason ? { reason: p.reason } : {}) }
}

/** resumes/derivation-proposals/list 入参校验（RPC 边界：可选过滤字段） */
function derivationProposalListParams(v: unknown): { owner?: string; sourceWcId?: string; jobId?: string } {
  if (typeof v !== 'object' || v === null) return {}
  const p = v as Record<string, unknown>
  return {
    ...(typeof p.owner === 'string' && p.owner ? { owner: p.owner } : {}),
    ...(typeof p.sourceWcId === 'string' && p.sourceWcId ? { sourceWcId: p.sourceWcId } : {}),
    ...(typeof p.jobId === 'string' && p.jobId ? { jobId: p.jobId } : {}),
  }
}

/** resumes/derivation-proposals/decide 入参校验（RPC 边界：id + action 白名单；reason 可选） */
function derivationProposalDecideParams(v: unknown): { id: string; action: 'accept' | 'reject'; reason?: string } {
  if (typeof v !== 'object' || v === null) throw new Error('需要 params { id, action }')
  const p = v as Record<string, unknown>
  const id = typeof p.id === 'string' ? p.id : ''
  if (!id) throw new Error('id 必填')
  if (p.action !== 'accept' && p.action !== 'reject') throw new Error('action 必须是 accept / reject')
  return { id, action: p.action, ...(typeof p.reason === 'string' && p.reason ? { reason: p.reason } : {}) }
}

/** resume/extract 入参校验（RPC 边界：pdfBase64 或 pages 至少其一） */
function extractResumeParams(v: unknown): { pdfBase64?: string; pages?: string[] } {
  if (typeof v !== 'object' || v === null) throw new Error('需要 params { pdfBase64 } 或 { pages }')
  const p = v as Record<string, unknown>
  const pdfBase64 = typeof p.pdfBase64 === 'string' ? p.pdfBase64 : undefined
  const pages = Array.isArray(p.pages)
    ? (p.pages as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
    : undefined
  if (!pdfBase64 && (!pages || pages.length === 0)) throw new Error('需要 params.pdfBase64 或 params.pages（非空）')
  return { ...(pdfBase64 ? { pdfBase64 } : {}), ...(pages && pages.length > 0 ? { pages } : {}) }
}

/** person/session/resume 入参校验（RPC 边界：personId + text|pdfBase64 fail fast；extraction 可选） */
function saveResumeOriginalParams(v: unknown): {
  personId: string
  fileName?: string
  text?: string
  pdfBase64?: string
  extraction?: { method: 'text' | 'vision'; model?: string }
} {
  if (typeof v !== 'object' || v === null) throw new Error('需要 params { personId, text | pdfBase64 }')
  const p = v as Record<string, unknown>
  if (typeof p.personId !== 'string') throw new Error('params.personId 缺失')
  const text = typeof p.text === 'string' ? p.text : undefined
  const pdfBase64 = typeof p.pdfBase64 === 'string' ? p.pdfBase64 : undefined
  if ((!text || !text.trim()) && !pdfBase64) throw new Error('需要 params.text 或 params.pdfBase64（其一非空）')
  let extraction: { method: 'text' | 'vision'; model?: string } | undefined
  if (p.extraction !== undefined) {
    const e = p.extraction as Record<string, unknown>
    if (typeof e !== 'object' || e === null || !['text', 'vision'].includes(e.method as string)) {
      throw new Error('params.extraction 应为 { method: text|vision }')
    }
    extraction = {
      method: e.method as 'text' | 'vision',
      ...(typeof e.model === 'string' && e.model ? { model: e.model as string } : {}),
    }
  }
  return {
    personId: p.personId,
    fileName: typeof p.fileName === 'string' && p.fileName ? p.fileName : undefined,
    text,
    pdfBase64,
    extraction,
  }
}

/** ledger/candidates 入参校验（RPC 边界：版本对 + personId） */
function ledgerVersionsParams(v: unknown): { personId: string; fromId: string; toId: string } {
  if (typeof v !== 'object' || v === null) throw new Error('ledger/* 需要 params { personId, fromId, toId }')
  const p = v as Record<string, unknown>
  if (typeof p.personId !== 'string' || p.personId.length === 0) throw new Error('params.personId 缺失')
  if (typeof p.fromId !== 'string' || typeof p.toId !== 'string' || p.fromId.length === 0 || p.toId.length === 0) {
    throw new Error('params.fromId/toId 缺失（快照版本 id）')
  }
  return { personId: p.personId, fromId: p.fromId, toId: p.toId }
}

/** ledger/commit 入参校验（RPC 边界：结构校验；why/confirmation 不变量在引擎函数层） */
function ledgerCommitParams(v: unknown): {
  personId: string
  fromId: string
  toId: string
  unit: string
  trigger: CandidateTrigger
  attribution: { why: string; sourceRefs?: string[] }
  confirmation: { type: 'user_confirmation' | 'decision_confirmation' | 'evidence_confirmation'; ref: string }
} {
  const base = ledgerVersionsParams(v)
  const p = v as Record<string, unknown>
  if (typeof p.unit !== 'string' || p.unit.length === 0) throw new Error('params.unit 缺失（变化单位）')
  const t = p.trigger as Record<string, unknown> | undefined
  if (!t || !['snapshot_change', 'decision_changed', 'external_event'].includes(String(t.type))) {
    throw new Error('params.trigger.type 非法（snapshot_change | decision_changed | external_event）')
  }
  const a = p.attribution as Record<string, unknown> | undefined
  if (!a || typeof a.why !== 'string') throw new Error('params.attribution.why 缺失')
  const c = p.confirmation as Record<string, unknown> | undefined
  if (!c || !['user_confirmation', 'decision_confirmation', 'evidence_confirmation'].includes(String(c.type)) || typeof c.ref !== 'string') {
    throw new Error('params.confirmation 非法（type + ref）')
  }
  let sourceRefs: string[] | undefined
  if (a.sourceRefs !== undefined) {
    if (!Array.isArray(a.sourceRefs) || !a.sourceRefs.every((s) => typeof s === 'string')) throw new Error('params.attribution.sourceRefs 需为字符串数组')
    sourceRefs = a.sourceRefs as string[]
  }
  let refs: string[] | undefined
  if (t.refs !== undefined) {
    if (!Array.isArray(t.refs) || !t.refs.every((s) => typeof s === 'string')) throw new Error('params.trigger.refs 需为字符串数组')
    refs = t.refs as string[]
  }
  return {
    ...base,
    unit: p.unit,
    trigger: { type: t.type as CandidateTrigger['type'], ...(typeof t.source === 'string' && t.source.length > 0 ? { source: t.source } : {}), ...(refs ? { refs } : {}) },
    attribution: { why: a.why, ...(sourceRefs ? { sourceRefs } : {}) },
    confirmation: { type: c.type as 'user_confirmation', ref: c.ref },
  }
}

/** evolution/why-changed 入参校验（RPC 边界：personId + unit） */
function evolutionUnitParams(v: unknown): { personId: string; unit: string } {
  if (typeof v !== 'object' || v === null) throw new Error('evolution/why-changed 需要 params { personId, unit }')
  const p = v as Record<string, unknown>
  if (typeof p.personId !== 'string' || p.personId.length === 0) throw new Error('params.personId 缺失')
  if (typeof p.unit !== 'string' || p.unit.length === 0) throw new Error('params.unit 缺失（变化单位）')
  return { personId: p.personId, unit: p.unit }
}

/** evolution/recent 入参校验（days 可选，默认 30，上限 3650 防手误） */
function evolutionRecentParams(v: unknown): { personId: string; days: number } {
  if (typeof v !== 'object' || v === null) throw new Error('evolution/recent 需要 params { personId, days? }')
  const p = v as Record<string, unknown>
  if (typeof p.personId !== 'string' || p.personId.length === 0) throw new Error('params.personId 缺失')
  const days = p.days === undefined ? 30 : Number(p.days)
  if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new Error('params.days 非法（1-3650）')
  return { personId: p.personId, days }
}

/** decision/commit 入参校验（RPC 边界：结构校验；why/防漂移不变量在引擎函数层） */
function decisionCommitParams(v: unknown): {
  personId: string
  decisionId: string
  changeUnit: string
  changeType: 'decision' | 'preference' | 'constraint'
  before?: string
  after: string
  trigger: CandidateTrigger
  attribution: { why: string; sourceRefs?: string[] }
  confirmation: { type: 'user_confirmation' | 'decision_confirmation' | 'evidence_confirmation'; ref: string }
} {
  if (typeof v !== 'object' || v === null) throw new Error('decision/commit 需要 params { personId, decisionId, changeUnit, after, … }')
  const p = v as Record<string, unknown>
  if (typeof p.personId !== 'string' || p.personId.length === 0) throw new Error('params.personId 缺失')
  if (typeof p.decisionId !== 'string' || p.decisionId.length === 0) throw new Error('params.decisionId 缺失')
  if (!['direction_target', 'city_constraint', 'salary_constraint', 'jd_strategy'].includes(String(p.changeUnit))) {
    throw new Error('params.changeUnit 非法（direction_target | city_constraint | salary_constraint | jd_strategy）')
  }
  if (!['decision', 'preference', 'constraint'].includes(String(p.changeType))) throw new Error('params.changeType 非法')
  if (typeof p.after !== 'string' || p.after.length === 0) throw new Error('params.after 缺失')
  const t = p.trigger as Record<string, unknown> | undefined
  if (!t || !['snapshot_change', 'decision_changed', 'external_event'].includes(String(t.type))) {
    throw new Error('params.trigger.type 非法')
  }
  const a = p.attribution as Record<string, unknown> | undefined
  if (!a || typeof a.why !== 'string') throw new Error('params.attribution.why 缺失')
  const c = p.confirmation as Record<string, unknown> | undefined
  if (!c || !['user_confirmation', 'decision_confirmation', 'evidence_confirmation'].includes(String(c.type)) || typeof c.ref !== 'string') {
    throw new Error('params.confirmation 非法（type + ref）')
  }
  let sourceRefs: string[] | undefined
  if (a.sourceRefs !== undefined) {
    if (!Array.isArray(a.sourceRefs) || !a.sourceRefs.every((s) => typeof s === 'string')) throw new Error('params.attribution.sourceRefs 需为字符串数组')
    sourceRefs = a.sourceRefs as string[]
  }
  let refs: string[] | undefined
  if (t.refs !== undefined) {
    if (!Array.isArray(t.refs) || !t.refs.every((s) => typeof s === 'string')) throw new Error('params.trigger.refs 需为字符串数组')
    refs = t.refs as string[]
  }
  return {
    personId: p.personId,
    decisionId: p.decisionId,
    changeUnit: p.changeUnit as string,
    changeType: p.changeType as 'decision',
    ...(typeof p.before === 'string' && p.before.length > 0 ? { before: p.before } : {}),
    after: p.after,
    trigger: { type: t.type as CandidateTrigger['type'], ...(typeof t.source === 'string' && t.source.length > 0 ? { source: t.source } : {}), ...(refs ? { refs } : {}) },
    attribution: { why: a.why, ...(sourceRefs ? { sourceRefs } : {}) },
    confirmation: { type: c.type as 'user_confirmation', ref: c.ref },
  }
}

/** jd/analyze-result 入参校验（RPC 边界：外部 Agent 输入，结构粗校验——字段级合法性
 *  归 validateJDAnalysisProposal（reject 降级写入，不抛错）） */
function jdAnalyzeResultParams(v: unknown): JDAnalysisProposal {
  if (typeof v !== 'object' || v === null) throw new Error('jd/analyze-result 需要 params（JDAnalysisProposal）')
  const p = v as Record<string, unknown>
  const jobId = typeof p.jobId === 'string' ? p.jobId.trim() : ''
  if (!jobId) throw new Error('params.jobId 缺失（岗位 id）')
  return {
    jobId,
    artifactVersion: p.artifactVersion === 2 ? 2 : (p.artifactVersion as never),
    context: (p.context ?? {}) as JDAnalysisProposal['context'],
    constraints: (p.constraints ?? {}) as JDAnalysisProposal['constraints'],
    capabilities: Array.isArray(p.capabilities) ? (p.capabilities as JDAnalysisProposal['capabilities']) : [],
    generatedAt: typeof p.generatedAt === 'string' ? p.generatedAt : new Date().toISOString(),
  }
}

/** jobs/extract 入参校验（RPC 边界：用户输入校验，fail fast） */
function extractJdParams(v: unknown): { jdText: string } {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>).jdText !== 'string') {
    throw new Error('jobs/extract 需要 params { jdText }')
  }
  const text = (v as Record<string, unknown>).jdText as string
  if (text.trim().length === 0) throw new Error('params.jdText 缺失（JD 原文）')
  return { jdText: text }
}

/** jobs/match：岗位技能来源 = 岗位智能段 capabilities（jd-analysis 产物，唯一匹配输入）→ computeGap → GapResult。
 *  Signal Layer：可解释匹配，不做百分比。
 *  Artifact Boundary：不消费 roles.md（长期岗位知识资产，服务图谱/差距分析；实例匹配只认本次 JD 分析——
 *  roles 存在 ≠ JD 已分析，接入会让未分析岗位伪造匹配结果）；不 fallback 长句 statement（长句与技能词
 *  对齐必然全 miss，伪造缺口）。未分析岗位 → role.skills 空 → 空 gap，UI 显示「尚未完成岗位分析」。 */
export function computeJobMatch(workspace: Workspace, jobId: string, person: string): GapResult {
  const job = scanJobs(workspace).find((j) => j.record.id === jobId)
  if (!job) throw new Error(`岗位不存在：${jobId}`)
  const { skills } = scanKnowledge(workspace)
  const role = {
    id: job.record.id,
    name: job.record.title,
    company: job.record.company,
    // capabilities 为对齐源（ai 分析产物）；无 → 空（岗位未分析，不产出匹配）
    skills: (() => {
      const seen = new Set<string>()
      return job.record.responsibilities
        // Capability Matching Boundary：只消费 hard 能力（soft 责任单元不产出硬匹配；undefined = 旧 5 列格式，兼容消费）
        .filter((r) => r.category === undefined || r.category === 'hard')
        .flatMap((r) => r.capabilities.map((name) => ({ name, essential: r.priority === 'must', source: 'JD' })))
        .filter((s) => {
          if (seen.has(s.name)) return false
          seen.add(s.name)
          return true
        })
    })(),
  }
  const personSkills = personSkillsOf(workspace, person)
  return computeGap({ role, person, personSkills, skills })
}

/** jobs/constraint-match：岗位门槛段 → JDConstraintIR → 逐维度投影行（UI 只投影不解释）。
 *  学历 = matchEducation 四态；专业/经验 = 门槛值 + 画像事实 + 待确认状态（匹配规则 Policy 层未全定义，
 *  Engine 不猜——Unknown ≠ False）。无门槛段/全 preferred → 空数组（UI 显示「暂无明确门槛要求」）。 */
export function computeConstraintMatch(workspace: Workspace, jobId: string, personId: string): ConstraintMatchRow[] {
  const job = scanJobs(workspace).find((j) => j.record.id === jobId)
  if (!job) throw new Error(`岗位不存在：${jobId}`)
  const person = scanPersons(workspace).find((p) => p.personId === personId)
  if (!person) throw new Error(`人不存在：${personId}`)
  const ir = parseJdConstraint(workspace.read(`jobs/${jobId}.md`))
  const confirmed = (person.education ?? []).filter((e) => e.status === 'confirmed')
  const evidenceOf = (entries: typeof confirmed): EvidenceRef[] =>
    entries.map((e) => ({ source: 'education' as const, id: e.candidateId ?? `education:${e.school}` }))
  const rows: ConstraintMatchRow[] = []

  if (ir.education) {
    const r = matchEducation(person.education, ir.education)
    const degrees = confirmed.filter((e) => e.degree).map((e) => e.degree)
    rows.push({
      id: constraintRefOf('education', ir.education.rawValues.join('；')),
      dim: 'education',
      requirement: ir.education.rawValues.join('；'),
      person: degrees.length > 0 ? [...new Set(degrees)].join('、') : '未登记',
      personEvidence: evidenceOf(confirmed.filter((e) => e.degree)),
      status: r.status,
      note: r.status === 'NEEDS_CONFIRMATION' ? (degrees.length === 0 ? '画像未登记学历——需确认' : '门槛含无法归一化的表述——需确认') : undefined,
    })
  }
  if (ir.major) {
    const majors = confirmed.map((e) => e.major).filter((m): m is string => Boolean(m))
    rows.push({
      id: constraintRefOf('major', ir.major.rawValues.join('；')),
      dim: 'major',
      requirement: ir.major.rawValues.join('；'),
      person: majors.length > 0 ? majors.join('、') : '未登记',
      personEvidence: evidenceOf(confirmed.filter((e) => e.major)),
      status: 'NEEDS_CONFIRMATION',
      note: majors.length === 0 ? '画像未登记专业——需确认' : '相关专业判定规则未定义——需人工确认',
    })
  }
  if (ir.experience) {
    const r = matchExperience(person.education, person.experiences, ir.experience)
    rows.push({
      id: constraintRefOf('experience', ir.experience.rawValue),
      dim: 'experience',
      requirement: ir.experience.rawValue,
      person: r.evidence.person ?? '未登记',
      personEvidence: r.personEvidence,
      status: r.status,
      note: r.note,
    })
  }
  return rows
}

/** jobs/decision-draft：岗位匹配行 → DecisionCandidate（门槛行非 MATCHED + 能力未声明行 → 差距清单；
 *  只引用不复制；Producer = Engine——Agent/UI 不可改写回写） */
export function computeDecisionCandidate(workspace: Workspace, jobId: string, personId: string): DecisionCandidate {
  const person = scanPersons(workspace).find((p) => p.personId === personId)
  if (!person) throw new Error(`人不存在：${personId}`)
  const constraints = computeConstraintMatch(workspace, jobId, personId)
  const match = computeJobMatch(workspace, jobId, person.name)
  return buildDecisionCandidate(jobId, constraints, match.missing)
}

/** decision/resume-context：决策记录 → ResumeRewriteContext（差距/证据回源 Engine 匹配行——权威语义；
 *  叙述段解析 Engine 自家格式——resume-writing 只消费结构化上下文，不解析 decisions/ markdown） */
export function computeResumeRewriteContext(workspace: Workspace, decisionId: string, personId: string): ResumeRewriteContext {
  const md = workspace.read(`decisions/${decisionId}.md`)
  const { meta } = splitFrontmatter(md)
  const jobId = meta.subject_id
  if (!jobId) throw new Error(`决策记录缺少 subject_id：${decisionId}`)
  const person = scanPersons(workspace).find((p) => p.personId === personId)
  if (!person) throw new Error(`人不存在：${personId}`)
  const candidate = computeDecisionCandidate(workspace, jobId, personId)
  const rows = computeConstraintMatch(workspace, jobId, personId)
  const missing = computeJobMatch(workspace, jobId, person.name).missing
  const evidenceByRef = new Map(rows.map((r) => [r.id, r.personEvidence]))
  return buildResumeRewriteContext(jobId, resolveGapDisplay(candidate, rows, missing), evidenceByRef, parseNarrativeSections(md))
}

/** resume/export 入参校验（RPC 边界） */
function resumeHtmlParams(v: unknown): string {
  if (typeof v !== 'object' || v === null) throw new Error('resume/export 需要 params { html }')
  const p = v as Record<string, unknown>
  if (typeof p.html !== 'string' || p.html.length === 0) throw new Error('params.html 缺失（打印 HTML）')
  if (p.html.length > 500_000) throw new Error('params.html 过大（>500KB）')
  return p.html
}

/** 端口监听：EADDRINUSE → logger.warn + 端口 +1 重试，最多递增 MAX_PORT_RETRIES 次；其余错误立即抛 */
async function listenWithRetry(opts: { host: string; port: number; logger: Logger }): Promise<{ wss: WebSocketServer; port: number }> {
  const { host, port, logger } = opts
  for (let i = 0; i <= MAX_PORT_RETRIES; i++) {
    const target = port + i
    const wss = new WebSocketServer({ host, port: target })
    try {
      await new Promise<void>((resolve, reject) => {
        wss.once('listening', () => resolve())
        wss.once('error', reject)
      })
      return { wss, port: target }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE') throw err // 权限/地址等其他绑定错误 fail fast
      if (i === MAX_PORT_RETRIES) break
      logger.warn(`端口 ${target} 被占用（EADDRINUSE），递增重试 ${target + 1}`)
    }
  }
  throw new ServerError(`端口 ${port}-${port + MAX_PORT_RETRIES} 全部被占用，已递增重试 ${MAX_PORT_RETRIES} 次`)
}

/** agent/start 入参校验（RPC 边界：用户输入校验，fail fast） */
function agentStartParams(v: unknown): AgentStartParams {
  if (typeof v !== 'object' || v === null) throw new Error('agent/start 需要 params { task, ... }')
  const p = v as Record<string, unknown>
  if (typeof p.task !== 'string' || p.task.length === 0) throw new Error('params.task 缺失（任务指令）')
  const out: AgentStartParams = { task: p.task }
  // ADR-020 TaskRequest：taskType 枚举 / contextRefs 领域引用 / outputTarget / trigger（v0.1 边界校验）
  if (p.taskType !== undefined) {
    if (!AGENT_TASK_TYPES.includes(p.taskType as AgentTaskType)) {
      throw new Error(`params.taskType 非法（合法：${AGENT_TASK_TYPES.join('/')}）`)
    }
    out.taskType = p.taskType as AgentTaskType
  }
  if (p.contextRefs !== undefined) {
    if (!Array.isArray(p.contextRefs)) throw new Error('params.contextRefs 应为数组')
    out.contextRefs = (p.contextRefs as unknown[]).map((ref) => {
      if (typeof ref !== 'object' || ref === null) throw new Error('contextRefs 项应为 { type, id }')
      const r = ref as Record<string, unknown>
      if (!CONTEXT_REF_TYPES.includes(r.type as ContextReference['type'])) {
        throw new Error(`contextRefs.type 非法（合法：${CONTEXT_REF_TYPES.join('/')}）`)
      }
      if (typeof r.id !== 'string' || r.id.length === 0) throw new Error('contextRefs.id 应为非空字符串')
      return { type: r.type as ContextReference['type'], id: r.id }
    })
  }
  if (p.outputTarget !== undefined) {
    if (!OUTPUT_TARGETS.includes(p.outputTarget as OutputTarget)) {
      throw new Error(`params.outputTarget 非法（合法：${OUTPUT_TARGETS.join('/')}）`)
    }
    out.outputTarget = p.outputTarget as OutputTarget
  }
  if (p.trigger !== undefined) {
    if (p.trigger !== 'user_action') throw new Error('params.trigger 应为 user_action（v0.1 仅此）')
    out.trigger = p.trigger
  }
  if (p.personId !== undefined) {
    if (typeof p.personId !== 'string' || p.personId.length === 0) {
      throw new Error('params.personId 应为非空字符串（person_XXX）')
    }
    out.personId = p.personId
  }
  if (p.context !== undefined) {
    if (typeof p.context !== 'string') throw new Error('params.context 应为字符串')
    out.context = p.context
  }
  // Workflow Stage Boundary Token（Agent Execution Boundary Repair P0-C）：
  // workflowId + stageId 成对传递（引擎侧校验，UI 误发 stage 也会被拒）
  if (p.workflowId !== undefined) {
    if (typeof p.workflowId !== 'string' || !/^workflow_\d{8}_\d{5}$/.test(p.workflowId)) {
      throw new Error('params.workflowId 非法（workflow_YYYYMMDD_NNNNN）')
    }
    out.workflowId = p.workflowId
  }
  if (p.stageId !== undefined) {
    if (!STAGE_IDS.includes(p.stageId as StageId)) {
      throw new Error(`params.stageId 非法（合法：${STAGE_IDS.join('/')}）`)
    }
    out.stageId = p.stageId as StageId
  }
  if (p.resumeSessionId !== undefined) {
    if (typeof p.resumeSessionId !== 'string') throw new Error('params.resumeSessionId 应为字符串')
    out.resumeSessionId = p.resumeSessionId
  }
  if (p.permissionMode !== undefined) {
    if (!['acceptEdits', 'ask', 'bypassPermissions'].includes(p.permissionMode as string)) {
      throw new Error('params.permissionMode 应为 acceptEdits/ask/bypassPermissions')
    }
    out.permissionMode = p.permissionMode as AgentStartParams['permissionMode']
  }
  if (p.allowedTools !== undefined) {
    if (!Array.isArray(p.allowedTools) || p.allowedTools.some((t) => typeof t !== 'string')) {
      throw new Error('params.allowedTools 应为 string[]')
    }
    out.allowedTools = p.allowedTools as string[]
  }
  if (p.maxTurns !== undefined) {
    if (typeof p.maxTurns !== 'number' || p.maxTurns < 1) throw new Error('params.maxTurns 应为正整数')
    out.maxTurns = p.maxTurns
  }
  if (p.model !== undefined) {
    if (typeof p.model !== 'string') throw new Error('params.model 应为字符串')
    out.model = p.model
  }
  if (p.apiKey !== undefined) {
    if (typeof p.apiKey !== 'string') throw new Error('params.apiKey 应为字符串')
    out.apiKey = p.apiKey
  }
  if (p.baseUrl !== undefined) {
    if (typeof p.baseUrl !== 'string') throw new Error('params.baseUrl 应为字符串')
    try {
      new URL(p.baseUrl)
    } catch {
      throw new Error('params.baseUrl 应为合法 URL（如 https://api.anthropic.com）')
    }
    out.baseUrl = p.baseUrl
  }
  return out
}

/** settings/update 入参校验（RPC 边界：undefined = 不修改该字段） */
function settingsUpdateParams(v: unknown): {
  model?: string
  apiKey?: string
  baseUrl?: string
  enabled?: boolean
  providers?: AgentProvider[]
  permissionMode?: PermissionMode
  allowedTools?: string[]
  maxTurns?: number
  map?: { apiKey?: string; securityJsCode?: string }
  document?: { vision?: { provider?: 'zhipu'; model?: string; apiKey?: string } }
} {
  if (typeof v !== 'object' || v === null) throw new Error('settings/update 需要 params 对象')
  const p = v as Record<string, unknown>
  const out: NonNullable<ReturnType<typeof settingsUpdateParams>> = {}
  if (p.model !== undefined) {
    if (typeof p.model !== 'string') throw new Error('params.model 应为字符串')
    out.model = p.model
  }
  if (p.apiKey !== undefined) {
    if (typeof p.apiKey !== 'string') throw new Error('params.apiKey 应为字符串')
    out.apiKey = p.apiKey
  }
  if (p.baseUrl !== undefined) {
    if (typeof p.baseUrl !== 'string') throw new Error('params.baseUrl 应为字符串')
    try {
      new URL(p.baseUrl)
    } catch {
      throw new Error('params.baseUrl 应为合法 URL（如 https://api.anthropic.com）')
    }
    out.baseUrl = p.baseUrl
  }
  if (p.enabled !== undefined) {
    if (typeof p.enabled !== 'boolean') throw new Error('params.enabled 应为布尔')
    out.enabled = p.enabled
  }
  if (p.providers !== undefined) {
    if (!Array.isArray(p.providers)) throw new Error('params.providers 应为数组')
    for (const item of p.providers) {
      if (typeof item !== 'object' || item === null) throw new Error('params.providers 每项应为对象')
      const pr = item as Record<string, unknown>
      if (typeof pr.id !== 'string' || pr.id.length === 0) throw new Error('params.providers[].id 应为非空字符串')
      if (pr.enabled !== undefined && typeof pr.enabled !== 'boolean') throw new Error('params.providers[].enabled 应为布尔')
      if (pr.models !== undefined && (!Array.isArray(pr.models) || pr.models.some((m) => typeof m !== 'string'))) {
        throw new Error('params.providers[].models 应为 string[]')
      }
    }
    out.providers = p.providers as AgentProvider[]
  }
  if (p.permissionMode !== undefined) {
    if (!['acceptEdits', 'ask', 'bypassPermissions'].includes(p.permissionMode as string)) {
      throw new Error('params.permissionMode 应为 acceptEdits/ask/bypassPermissions')
    }
    out.permissionMode = p.permissionMode as PermissionMode
  }
  if (p.allowedTools !== undefined) {
    if (!Array.isArray(p.allowedTools) || p.allowedTools.length === 0 || p.allowedTools.some((t) => typeof t !== 'string')) {
      throw new Error('params.allowedTools 应为非空 string[]')
    }
    out.allowedTools = p.allowedTools as string[]
  }
  if (p.maxTurns !== undefined) {
    if (typeof p.maxTurns !== 'number' || p.maxTurns < 1) throw new Error('params.maxTurns 应为正整数')
    out.maxTurns = p.maxTurns
  }
  if (p.map !== undefined) {
    if (typeof p.map !== 'object' || p.map === null || Array.isArray(p.map)) {
      throw new Error('params.map 应为对象 { apiKey?, securityJsCode? }')
    }
    const m = p.map as Record<string, unknown>
    if (m.apiKey !== undefined && typeof m.apiKey !== 'string') throw new Error('params.map.apiKey 应为字符串')
    if (m.securityJsCode !== undefined && typeof m.securityJsCode !== 'string') {
      throw new Error('params.map.securityJsCode 应为字符串')
    }
    out.map = {
      ...(m.apiKey !== undefined ? { apiKey: m.apiKey as string } : {}),
      ...(m.securityJsCode !== undefined ? { securityJsCode: m.securityJsCode as string } : {}),
    }
  }
  if (p.document !== undefined) {
    if (typeof p.document !== 'object' || p.document === null || Array.isArray(p.document)) {
      throw new Error('params.document 应为对象 { vision? }')
    }
    const d = p.document as Record<string, unknown>
    if (d.vision !== undefined) {
      if (typeof d.vision !== 'object' || d.vision === null || Array.isArray(d.vision)) {
        throw new Error('params.document.vision 应为对象 { provider?, model?, apiKey? }')
      }
      const v = d.vision as Record<string, unknown>
      if (v.provider !== undefined && v.provider !== 'zhipu') throw new Error('params.document.vision.provider 当前仅支持 zhipu')
      if (v.model !== undefined && typeof v.model !== 'string') throw new Error('params.document.vision.model 应为字符串')
      if (v.apiKey !== undefined && typeof v.apiKey !== 'string') throw new Error('params.document.vision.apiKey 应为字符串')
      out.document = {
        vision: {
          ...(v.provider !== undefined ? { provider: v.provider as 'zhipu' } : {}),
          ...(v.model !== undefined ? { model: v.model as string } : {}),
          ...(v.apiKey !== undefined ? { apiKey: v.apiKey as string } : {}),
        },
      }
    }
  }
  return out
}

/** settings/models 入参（可选）：临时 apiKey/baseUrl——未保存也能提取模型（「提取模型」按钮）；
 * 缺省用引擎配置 config.agent.apiKey/baseUrl */
function settingsModelsParams(v: unknown): { apiKey?: string; baseUrl?: string } {
  if (v === undefined || v === null) return {}
  const p = v as Record<string, unknown>
  const out: { apiKey?: string; baseUrl?: string } = {}
  if (p.apiKey !== undefined) {
    if (typeof p.apiKey !== 'string') throw new Error('params.apiKey 应为字符串')
    out.apiKey = p.apiKey
  }
  if (p.baseUrl !== undefined) {
    if (typeof p.baseUrl !== 'string') throw new Error('params.baseUrl 应为字符串')
    try {
      new URL(p.baseUrl)
    } catch {
      throw new Error('params.baseUrl 应为合法 URL（如 https://api.anthropic.com）')
    }
    out.baseUrl = p.baseUrl
  }
  return out
}

/** 可用模型列表：只从 API 提取（不预制）——有 apiKey 时探测端点拉真实可用模型；
 * 无 key（CLI 模式）→ 空列表（模型由 claude CLI 决定，UI 仅自由输入）。
 * 探测链（第三方兼容网关差异适配，外部 API 边界）：Anthropic 标准 /v1/models →
 * OpenAI 风格 /models → baseUrl 以 /anthropic 结尾时去掉后缀探测根 /models（DeepSeek 类网关：
 * 兼容端点无模型列表，原生端点有）。401/403 直接判定 Key 无效（其余路径必同结果），
 * 404/405 视为该路径不存在继续探测。 */
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com'

async function listAvailableModels(
  apiKey?: string,
  baseUrl?: string,
): Promise<{ source: 'api' | 'cli' | 'api_error'; models: string[]; error?: 'auth' | 'no_endpoint' | 'network' }> {
  if (apiKey === undefined || apiKey === '') return { source: 'cli', models: [] }
  const base = (baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const candidates = [
    `${base}/v1/models`,
    `${base}/models`,
    ...(base.endsWith('/anthropic') ? [`${base.slice(0, -'/anthropic'.length)}/models`] : []),
  ]
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers })
      if (res.ok) {
        const json = (await res.json()) as { data: { id: string }[] }
        if (Array.isArray(json.data)) return { source: 'api', models: json.data.map((m) => m.id) }
        return { source: 'api_error', models: [], error: 'no_endpoint' }
      }
      if (res.status === 401 || res.status === 403) return { source: 'api_error', models: [], error: 'auth' }
      if (res.status !== 404 && res.status !== 405) {
        return { source: 'api_error', models: [], error: 'no_endpoint' }
      }
    } catch {
      return { source: 'api_error', models: [], error: 'network' }
    }
  }
  return { source: 'api_error', models: [], error: 'no_endpoint' }
}

/** agent/answer|cancel|permission 的 taskId 提取（RPC 边界） */
function taskIdParams(v: unknown): string {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>).taskId !== 'string') {
    throw new Error('params.taskId 缺失')
  }
  return (v as Record<string, unknown>).taskId as string
}

/** agent/permission 的 requestId + allow 提取（RPC 边界） */
function permissionParams(v: unknown): { taskId: string; requestId: string; allow: boolean } {
  const taskId = taskIdParams(v)
  const p = v as Record<string, unknown>
  if (typeof p.requestId !== 'string' || p.requestId.length === 0) throw new Error('params.requestId 缺失')
  if (typeof p.allow !== 'boolean') throw new Error('params.allow 应为 boolean')
  return { taskId, requestId: p.requestId, allow: p.allow }
}

/**
 * Agent 技能身份注入：任务启动前引导 Agent 阅读技能文件（人设 + 协议来源）。
 * 不注入时模型仅凭 cwd 猜身份（曾出现把自己当成"公司分析助手"的开场白）。
 * 同时注入工作区初始化状态：SKILL.md 的首次检查依赖 CLAUDE_PROJECT_DIR 环境变量，
 * 引擎 spawn 的 CLI 进程未设置该变量 → Agent 会把已初始化工作区误判为"首次使用"，
 * 此处用真实文件状态直接覆盖该检查。
 */
function buildSkillIdentity(skillsDir: string, workspaceRoot: string, person?: { name: string; personId: string }): string {
  const indexExists = existsSync(join(workspaceRoot, 'INDEX.md'))
  const initState = indexExists
    ? `当前工作区已初始化（${join(workspaceRoot, 'INDEX.md')} 存在），直接跳过 SKILL.md 中的"首次运行检查"步骤。`
    : `当前工作区尚未初始化（缺 ${join(workspaceRoot, 'INDEX.md')}），按 SKILL.md 的"首次运行检查"执行初始化。`
  // 当前分析对象（系统事实，非委托身份责任）：Agent 的决策产物必须继承此 person_id（ADR-014）
  const personState = person
    ? `当前分析对象：${person.name}（${person.personId}）。你产出的所有决策记录（decisions/*.md）frontmatter 的 person_id 必须等于 ${person.personId}，不得使用其他名字或留空。`
    : ''
  try {
    const skill = readFileSync(join(skillsDir, 'SKILL.md'), 'utf8')
    return [
      '你是 Career OS 的职业决策助手（技能：career-advisor）。',
      personState,
      `你的完整协议与工作流程定义在技能文件 ${join(skillsDir, 'SKILL.md')}（本任务工作目录下可访问），开始处理任务前请先阅读它。`,
      initState,
      '技能概述（节选）：',
      skill.slice(0, 1500),
    ].filter(Boolean).join('\n')
  } catch {
    return `你是 Career OS 的职业决策助手，请依据工作区中的 profiles/、decisions/ 等数据为用户提供职业决策建议。${initState}`
  }
}

export async function startServer(opts: {
  config: EngineConfig
  workspace: Workspace
  logger: Logger
  store: BridgeStore
  runtime: DecisionRuntime
}): Promise<ServerHandle> {
  const { config, workspace, logger, store, runtime } = opts
  const { wss, port } = await listenWithRetry({ host: config.server.host, port: config.server.port, logger })

  // 事件广播（先定义：Agent 事件推送与监听器共用）
  const broadcast = (event: ServerEvent): void => {
    const payload = JSON.stringify(event)
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload)
    }
  }
  // Agent 事件推送：广播（个人工具单客户端；与 data.* 事件同语义）
  // Stage Task 完成钩子（BUG-006 修复）：带 workflowId/stageId 的任务 done →
  //   fact_collection 调 onFactCollectionReady（确定性 guard：候选不足 → failed，不信任 Agent 自报）
  //   direction_exploration 调 onExplorationDone（契约 v0.2 §4.1：intake 内提案登记 → guard）
  //   → 广播 workflowChanged（UI 重拉投影）。引擎侧闭环，不依赖 UI 事件处理。
  // intake（§1.6）：agent/start 时记录 directions/ 既有文件名快照；done 只消费快照外新文件——
  //   历史提案（含此前登记失败的）不被后续 done 自动重复消费。
  const stageTasks = new Map<string, { workflowId: string; stageId: StageId; personId: string; intake: string[] }>()
  /** 本次执行新产生的提案文件（§1.6 intake boundary：当前目录 - 启动时快照；目录缺失 → 空） */
  const currentDirectionFiles = (personId: string): string[] => {
    try {
      return workspace.listMarkdown(`persons/${personId}/directions`)
    } catch {
      return []
    }
  }
  /** 本次执行新产生的评估提案文件（§1.6 intake boundary 模式延伸到 evaluations/） */
  const currentEvaluationFiles = (personId: string): string[] => {
    try {
      return workspace.listMarkdown(`persons/${personId}/evaluations`)
    } catch {
      return []
    }
  }
  /** 本次执行新产生的决策文件（§3.3 intake boundary 模式延伸到 decisions/；decisions/ 全局目录不按 person 分） */
  const currentDecisionFiles = (): string[] => {
    try {
      return workspace.listMarkdown('decisions')
    } catch {
      return []
    }
  }
  const agentRuntime = new AgentRuntime(logger, (taskId, ev) => {
    broadcast({ event: EVENTS.agentEvent, taskId, data: ev })
    if (ev.type === 'done') {
      const ref = stageTasks.get(taskId)
      if (ref) {
        stageTasks.delete(taskId)
        if (ref.stageId === 'fact_collection') {
          const next = onFactCollectionReady(workspace, ref.workflowId)
          if (next) {
            logger.info(`Stage 完成钩子：${ref.workflowId} fact_collection → ${next.stages.find((s) => s.id === 'fact_collection')?.status}（Agent 任务 ${taskId} done）`)
            broadcast({ event: EVENTS.workflowChanged })
          }
        } else if (ref.stageId === 'direction_exploration') {
          const result = onExplorationDone(workspace, ref.workflowId, freshIntakeFiles(currentDirectionFiles(ref.personId), ref.intake))
          if (result.workflow) {
            // §1.5：登记拒绝 → logger.error + error.engine（管线错误用户可见；提案保留原样）
            if (result.rejected.length > 0) {
              const message = formatRegistrationRejectionMessage(DIRECTION_SPEC.artifactType, result.rejected)
              logger.error(message)
              broadcast({ event: EVENTS.engineError, data: { message } })
            }
            const status = result.workflow.stages.find((s) => s.id === 'direction_exploration')?.status
            logger.info(`Stage 完成钩子：${ref.workflowId} direction_exploration → ${status}（登记 ${result.registered.length} 条，拒绝 ${result.rejected.length} 条；Agent 任务 ${taskId} done）`)
            broadcast({ event: EVENTS.workflowChanged })
          }
        } else if (ref.stageId === 'direction_evaluation') {
          const result = onEvaluationDone(workspace, ref.workflowId, freshIntakeFiles(currentEvaluationFiles(ref.personId), ref.intake))
          if (result.workflow) {
            if (result.rejected.length > 0) {
              const message = formatRegistrationRejectionMessage(EVALUATION_SPEC.artifactType, result.rejected)
              logger.error(message)
              broadcast({ event: EVENTS.engineError, data: { message } })
            }
            const status = result.workflow.stages.find((s) => s.id === 'direction_evaluation')?.status
            logger.info(`Stage 完成钩子：${ref.workflowId} direction_evaluation → ${status}（登记 ${result.registered.length} 条，拒绝 ${result.rejected.length} 条；Agent 任务 ${taskId} done）`)
            broadcast({ event: EVENTS.workflowChanged })
          }
        } else if (ref.stageId === 'recommendation') {
          // v0.3 §3.3：先幂等补登记（watcher 可能已登记）→ 再扫 intake 内新决策（已是系统 ID）→ onRecommendationDone 校验归属
          registerDecisionIdentity(workspace)
          const result = onRecommendationDone(workspace, ref.workflowId, freshIntakeFiles(currentDecisionFiles(), ref.intake))
          if (result.workflow) {
            const status = result.workflow.stages.find((s) => s.id === 'recommendation')?.status
            logger.info(`Stage 完成钩子：${ref.workflowId} recommendation → ${status}（关联决策 ${result.decisions.length} 条；Agent 任务 ${taskId} done）`)
            broadcast({ event: EVENTS.workflowChanged })
          }
        }
      }
    }
  })

  const handlers: Record<string, (params?: unknown) => unknown> = {
    [METHODS.init]: () => store.init(),
    [METHODS.listDecisions]: () => store.listDecisions(),
    [METHODS.rescan]: () => store.rescan(),
    [METHODS.updateDecision]: (params) => {
      const { id, fields } = updateDecisionParams(params)
      // M7.3：变更时点检测——写回前/后各取一次投影，Detector 生成认知变化候选（不写 Ledger）
      const rel = `decisions/${id}.md`
      const beforeMd = workspace.read(rel)
      const result = updateDecisionFile(workspace, id, fields)
      const afterMd = workspace.read(rel)
      const before = projectDecision(beforeMd, id, '')
      const after = projectDecision(afterMd, id, '')
      return { ...result, candidates: detectDecisionChange(before, after) }
    },
    [METHODS.listCompanies]: () => attachCompanyAssessments(workspace, store.listCompanies() as CompanyView[]),
    [METHODS.companyGet]: (params) => readCompanyFile(workspace, jobIdParams(params)),
    [METHODS.decisionGet]: (params) => readDecisionFile(workspace, jobIdParams(params)),
    [METHODS.targetsList]: () => scanTargets(workspace).map((t) => ({
      ...t.record,
      ...(t.validation ? { validation: t.validation } : {}),
    })),
    [METHODS.targetsGet]: (params) => {
      const id = targetGetParams(params)
      const target = scanTargets(workspace).find((t) => t.record.id === id)
      if (!target) throw new Error(`目标不存在：${id}`)
      return target.record
    },
    [METHODS.candidatesList]: () => scanCandidatePool(workspace).map((p) => ({
      ...p.record,
      ...(p.validation ? { validation: p.validation } : {}),
    })),
    [METHODS.candidatesUpsert]: (params) => {
      const entries = (params as { entries?: unknown }).entries
      return upsertCandidatePool(workspace, entries as CandidatePoolInput[])
    },
    [METHODS.jobLeadsList]: () => scanJobLeads(workspace),
    [METHODS.jobLeadsUpsert]: (params) => {
      const p = params as { company?: unknown; leads?: unknown }
      return upsertJobLeads(workspace, String(p.company ?? ''), p.leads as JobLeadInput[])
    },
    [METHODS.salaryBenchmarksList]: () => scanSalaryBenchmarks(workspace),
    [METHODS.salaryBenchmarksUpsert]: (params) => {
      const p = params as { entries?: unknown }
      return upsertSalaryBenchmarks(workspace, p.entries as SalaryBenchmarkInput[])
    },
    [METHODS.salaryValuation]: (params) => {
      const personId = personIdParams(params)
      const person = (store.listPersons() as Person[]).find((p) => p.personId === personId)
      if (!person) throw new Error(`人员不存在：${personId}`)
      return buildSalaryValuationCard(person, scanSalaryBenchmarks(workspace))
    },
    [METHODS.listPersons]: () => store.listPersons(),
    [METHODS.upsertSummaryStrengths]: (params) => {
      const p = summaryStrengthsParams(params)
      return upsertSummaryStrengths(workspace, p.personId, p.items)
    },
    [METHODS.createPersonSession]: (params) => createPersonSession(workspace, createPersonSessionParams(params)),
    [METHODS.appendSessionTurn]: (params) => appendSessionTurn(workspace, appendSessionTurnParams(params)),
    [METHODS.appendCandidates]: (params) => appendCandidates(workspace, appendCandidatesParams(params)),
    [METHODS.listCandidates]: (params) => listCandidates(workspace, personIdParams(params)),
    // resolve 确认 → Registration（facts/）→ 立即投影三件快照（实时归位：确认一条归位一条，会话中断不丢）
    [METHODS.resolveCandidate]: (params) => {
      const p = resolveCandidateParams(params)
      const result = resolveCandidate(workspace, p)
      if (result && result.status === 'confirmed') {
        const written = projectPersonSnapshots(workspace, p.personId)
        if (written.length > 0) {
          logger.info(`快照投影：${p.personId} 已归位 ${written.join('、')}（候选 ${p.candidateId} 确认触发）`)
        }
      }
      return result
    },
    [METHODS.resetPerson]: (params) => resetPerson(workspace, personIdParams(params)),
    [METHODS.completePersonInit]: (params) => completePersonInit(workspace, personIdParams(params)),
    [METHODS.deletePerson]: (params) => deletePerson(workspace, personIdParams(params)),
    // ─── v0.2 方向池（Stage Artifact Lifecycle：投影 + 用户裁决；§4.3 幂等语义由 storage 层保证）──
    [METHODS.directionsList]: (params) => {
      const p = directionsListParams(params)
      return listStageArtifacts(workspace, DIRECTION_SPEC, p.personId, p.workflowId ? { workflowId: p.workflowId } : {})
    },
    [METHODS.directionsResolve]: (params) => {
      const p = directionsResolveParams(params)
      const result = resolveStageArtifact(workspace, DIRECTION_SPEC, p.personId, p.directionId, p.action)
      // 契约 §五：裁决复用 workflow.changed（仅真实状态变更广播；同动作幂等不打扰）
      if (result.ok && !result.unchanged) {
        logger.info(`方向裁决：${p.personId} ${p.directionId} → ${result.artifact.state}`)
        broadcast({ event: EVENTS.workflowChanged })
      }
      return result
    },
    // ─── v0.3 评估明细（Stage 3 投影：只读——评估由 Agent 产出 + Engine 登记，UI 不裁决）──
    [METHODS.evaluationsList]: (params) => {
      const p = directionsListParams(params)
      return listStageArtifacts(workspace, EVALUATION_SPEC, p.personId, p.workflowId ? { workflowId: p.workflowId } : {})
    },
    [METHODS.evaluationsGet]: (params) => {
      const p = evaluationsGetParams(params)
      const artifact = readStageArtifact(workspace, EVALUATION_SPEC, p.personId, p.evaluationId)
      if (!artifact) throw new Error(`评估明细不存在：${p.evaluationId}`)
      return { id: p.evaluationId, markdown: workspace.read(`${EVALUATION_SPEC.dir(p.personId)}/${p.evaluationId}.md`) }
    },
    // ─── Workflow Control Plane（Career Workflow Contract v0.1：Engine 单方写 workflows/，UI 只投影）──
    [METHODS.workflowStart]: (params) => startWorkflow(workspace, workflowStartParams(params)),
    [METHODS.workflowGet]: (params) => {
      const wf = getWorkflow(workspace, workflowIdParams(params))
      if (!wf) throw new Error(`workflow 不存在：${workflowIdParams(params)}`)
      return wf
    },
    [METHODS.workflowList]: (params) => scanWorkflows(workspace, params ? personIdParams(params) : undefined),
    [METHODS.workflowAdvance]: (params) => {
      const p = workflowAdvanceParams(params)
      return advanceWorkflow(workspace, p.workflowId, p.gateId)
    },
    [METHODS.workflowAbort]: (params) => abortWorkflow(workspace, workflowIdParams(params)),
    [METHODS.workflowRestage]: (params) => {
      const workflow = restageWorkflow(workspace, workflowIdParams(params))
      logger.info(`workflow/restage：${workflow.id} currentStage → running（用户重跑当前阶段；方向池不重置）`)
      broadcast({ event: EVENTS.workflowChanged })
      return workflow
    },
    [METHODS.resumeExtract]: (params) => {
      const p = extractResumeParams(params)
      // 双通道：pdfBase64 → 本地文本层（免费离线）；pages → 逐页视觉（UI 已渲染多页图）
      if (p.pages) {
        const vision = config.document.vision?.apiKey
          ? new ZhipuVisionProvider({
              apiKey: config.document.vision.apiKey,
              model: config.document.vision.model ?? 'glm-4.6v-flash',
            })
          : null
        if (!vision) {
          return { status: 'failed', method: 'vision', text: '', error: '视觉模型未配置（设置 → Document Extraction）' }
        }
        return extractVisionPages(p.pages, vision)
      }
      return extractLocalText(Buffer.from(p.pdfBase64 ?? '', 'base64'))
    },
    [METHODS.saveResumeOriginal]: (params) => {
      const p = saveResumeOriginalParams(params)
      if (p.extraction?.method === 'vision' && !p.extraction.model) {
        p.extraction = { ...p.extraction, model: config.document.vision?.model ?? 'glm-4.6v-flash' }
      }
      return createResumeArtifact(workspace, p)
    },
    [METHODS.snapshotArchive]: (params) => {
      const p = snapshotArchiveParams(params)
      return archiveCurrentSnapshot(workspace, p.personId, p)
    },
    [METHODS.snapshotVersions]: (params) => listSnapshotVersions(workspace, snapshotVersionsParams(params)),
    [METHODS.ledgerCandidates]: (params) => {
      const p = ledgerVersionsParams(params)
      return buildCandidates(workspace, p.personId, { fromId: p.fromId, toId: p.toId, trigger: { type: 'snapshot_change' } })
    },
    [METHODS.ledgerCommit]: (params) => {
      const p = ledgerCommitParams(params)
      return commitLedgerEvent(workspace, p.personId, p)
    },
    [METHODS.ledgerReject]: (params) => {
      ledgerVersionsParams(params)
      return { rejected: true } // 显式否定无副作用（v1：拒绝 = 不 commit）
    },
    [METHODS.ledgerList]: (params) => readLedgerEvents(workspace, snapshotVersionsParams(params)),
    [METHODS.decisionCommit]: (params) => {
      const p = decisionCommitParams(params)
      return commitDecisionLedgerEvent(workspace, p.personId, p)
    },
    [METHODS.evolutionWhyChanged]: (params) => {
      const p = evolutionUnitParams(params)
      return whyChanged(workspace, p.personId, p.unit)
    },
    [METHODS.evolutionReplay]: (params) => replayDecision(workspace, snapshotVersionsParams(params)),
    [METHODS.evolutionRecent]: (params) => {
      const p = evolutionRecentParams(params)
      return whyChangedRecently(workspace, p.personId, p.days)
    },
    [METHODS.poolGraph]: () => store.graph(),
    [METHODS.decisionHistory]: () => computeHistories(store.listDecisions() as DecisionRecord[], runtime),
    [METHODS.contexts]: () => listContexts(workspace, store),
    [METHODS.knowledgeGraph]: () => scanKnowledge(workspace),
    [METHODS.knowledgeGap]: (params) => computeKnowledgeGap(workspace, gapParams(params)),
    [METHODS.jdAnalyze]: (params) => computeJdAnalysis(workspace, jdAnalyzeParams(params)),
    [METHODS.health]: () => generateHealthReport(workspace, store as ProjectionStore),
    [METHODS.resumeExport]: (params) => exportPdf(resumeHtmlParams(params)),
    [METHODS.agentStart]: (params) => {
      const p = agentStartParams(params)
      // ADR-020 Context Assembly（Commit B）：policy 校验 → 引用解析 → Bundle。
      // Rejected = RPC 错误（message 前缀 `TaskRejected: <reason>`——RPC 通道仅 code+message，
      // reason 语义编码进 message），不进入 runtime；taskType 缺省 = 旧调用不装配（兼容）
      let bundle: AgentContextBundle | undefined
      if (p.taskType !== undefined) {
        const req: AgentTaskRequest = {
          taskType: p.taskType,
          contextRefs: p.contextRefs,
          outputTarget: p.outputTarget,
          trigger: p.trigger ?? 'user_action',
        }
        const rejected = validateContextPolicy(req)
        if (rejected) throw new Error(taskRejectedMessage(rejected))
        const resolved = resolveContextRefs(workspace, store as unknown as RegistryStore, p.contextRefs ?? [])
        if ('reason' in resolved) throw new Error(taskRejectedMessage(resolved))
        bundle = assembleContextBundle(resolved.resolved)
      }
      // 当前分析对象（系统事实）：personId → person 快照（name）；注入任务上下文供 Agent 传递归属（ADR-014）
      const person = p.personId
        ? (store.listPersons() as Person[]).find((x) => x.personId === p.personId)
        : undefined
      // 技能身份注入：人设 + 当前分析对象 + 协议引导拼在任务前（不注入会因缺上下文导致身份漂移）；
      // Task Context（Commit C）：bundle 作为 identity 之后的一个 section 拼入同一 context 通道
      const identity = buildSkillIdentity(
        config.paths.skills,
        workspace.paths.root,
        person ? { name: person.name, personId: person.personId ?? p.personId! } : undefined,
      )
      const taskContext = bundle ? buildContextSystemPrompt(p.taskType!, bundle) : ''
      // Workflow Stage Envelope（P0-C）：workflowId+stageId → 引擎 Stage Boundary 三重校验 →
      // 编译 Envelope 注入（系统级边界，与用户消息分离；校验失败 throw = Agent 启动被拒）
      let stageEnvelope = ''
      if (p.workflowId !== undefined && p.stageId !== undefined) {
        const compiled = compileStageTask(workspace, p.workflowId, p.stageId as StageId)
        stageEnvelope = compiled.envelope
      }
      const taskId = agentRuntime.start(
        { ...p, context: [identity, stageEnvelope, taskContext, p.context].filter(Boolean).join('\n\n') },
        {
          permissionMode: config.agent.permissionMode,
          allowedTools: config.agent.allowedTools,
          maxTurns: config.agent.maxTurns,
          model: config.agent.enabled === false ? undefined : config.agent.model,
          apiKey: config.agent.enabled === false ? undefined : config.agent.apiKey,
          baseUrl: config.agent.enabled === false ? undefined : config.agent.baseUrl,
        },
        workspace.paths.root,
      )
      // 注册 Stage Task 完成钩子（BUG-006：Agent done → 按 stage 分派状态钩子 → workflowChanged）
      if (p.workflowId !== undefined && p.stageId !== undefined) {
        const wf = getWorkflow(workspace, p.workflowId)
        // intake（§1.6 模式延伸到 v0.3）：start 时快照各 Stage 产出目录既有文件名，done 只消费快照外新文件
        let intake: string[] = []
        if (p.stageId === 'direction_exploration') {
          try {
            intake = workspace.listMarkdown(`persons/${wf?.personId ?? p.personId ?? ''}/directions`)
          } catch {
            intake = []
          }
        } else if (p.stageId === 'direction_evaluation') {
          try {
            intake = workspace.listMarkdown(`persons/${wf?.personId ?? p.personId ?? ''}/evaluations`)
          } catch {
            intake = []
          }
        } else if (p.stageId === 'recommendation') {
          try {
            intake = workspace.listMarkdown('decisions')
          } catch {
            intake = []
          }
        }
        stageTasks.set(taskId, {
          workflowId: p.workflowId,
          stageId: p.stageId as StageId,
          personId: wf?.personId ?? p.personId ?? '',
          intake,
        })
      }
      return {
        taskId,
        ...(bundle ? { contextBundle: bundle } : {}),
      }
    },
    [METHODS.settingsGet]: () => ({
      model: config.agent.model,
      apiKey: config.agent.apiKey,
      baseUrl: config.agent.baseUrl,
      enabled: config.agent.enabled !== false,
      providers: config.agent.providers,
      permissionMode: config.agent.permissionMode,
      allowedTools: config.agent.allowedTools,
      maxTurns: config.agent.maxTurns,
      map: config.map,
      document: config.document,
    }),
    [METHODS.settingsUpdate]: (params) => {
      const patch = settingsUpdateParams(params)
      // 更新内存（下次任务立即生效）
      if (patch.model !== undefined) config.agent.model = patch.model || undefined
      if (patch.apiKey !== undefined) config.agent.apiKey = patch.apiKey || undefined
      if (patch.baseUrl !== undefined) config.agent.baseUrl = patch.baseUrl || undefined
      if (patch.enabled !== undefined) config.agent.enabled = patch.enabled
      if (patch.providers !== undefined) config.agent.providers = patch.providers
      if (patch.permissionMode !== undefined) config.agent.permissionMode = patch.permissionMode
      if (patch.allowedTools !== undefined) config.agent.allowedTools = patch.allowedTools
      if (patch.maxTurns !== undefined) config.agent.maxTurns = patch.maxTurns
      if (patch.map !== undefined) config.map = { provider: config.map.provider, ...patch.map }
      if (patch.document !== undefined) {
        config.document = { vision: { provider: 'zhipu', ...config.document.vision, ...patch.document.vision } }
        if (!config.document.vision?.apiKey) delete config.document.vision?.apiKey
      }
      // 写回 config.json（保持其他字段不动；空串 → 删除该字段）
      const full = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8')) as Record<string, unknown>
      const agent = (full.agent ?? {}) as Record<string, unknown>
      const { map: mapPatch, document: documentPatch, ...agentPatch } = patch
      for (const [k, v] of Object.entries(agentPatch)) {
        if (v === '') delete agent[k]
        else agent[k] = v
      }
      full.agent = agent
      // map 段独立写回（provider 保持不动，只更新 apiKey / securityJsCode）
      if (mapPatch) {
        const map = (full.map ?? { provider: 'amap' }) as Record<string, unknown>
        if (mapPatch.apiKey === '') delete map.apiKey
        else map.apiKey = mapPatch.apiKey
        if (mapPatch.securityJsCode === '') delete map.securityJsCode
        else map.securityJsCode = mapPatch.securityJsCode
        full.map = map
      }
      // document 段独立写回（vision 子段：空 apiKey → 删除）
      if (documentPatch?.vision) {
        const doc = (full.document ?? {}) as Record<string, unknown>
        const vision = (doc.vision ?? { provider: 'zhipu' }) as Record<string, unknown>
        for (const [k, v] of Object.entries(documentPatch.vision)) {
          if (v === '') delete vision[k]
          else vision[k] = v
        }
        doc.vision = vision
        full.document = doc
      }
      writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(full, null, 2) + '\n', 'utf8')
      return { ok: true }
    },
    [METHODS.settingsModels]: (params) => {
      const p = settingsModelsParams(params)
      return listAvailableModels(p.apiKey ?? config.agent.apiKey, p.baseUrl ?? config.agent.baseUrl)
    },
    [METHODS.agentAnswer]: (params) => {
      const taskId = taskIdParams(params) // 返回字符串，不可解构
      const p = params as Record<string, unknown>
      if (typeof p.text !== 'string' || p.text.length === 0) throw new Error('params.text 缺失（回答内容）')
      agentRuntime.answer(taskId, p.text)
      return {}
    },
    [METHODS.agentCancel]: (params) => {
      agentRuntime.cancel(taskIdParams(params))
      return {}
    },
    [METHODS.agentPermission]: (params) => {
      const { taskId, requestId, allow } = permissionParams(params)
      agentRuntime.permission(taskId, requestId, allow)
      return {}
    },
    [METHODS.rewriteFeedback]: (params) => {
      recordRewriteFeedback(join(config.paths.logs, 'feedback'), params)
      return {}
    },
    [METHODS.createJob]: (params) => {
      const job = createJobFile(workspace, createJobParams(params))
      // 建档联带占位公司（companies/ 无 watcher，显式广播；jobs 由 watchJobs 广播）
      broadcast({ event: EVENTS.companiesChanged })
      return job
    },
    [METHODS.deleteJob]: (params) => {
      deleteJobFile(workspace, jobIdParams(params))
      return {}
    },
    [METHODS.listApplications]: () => listApplications(workspace).map(applicationView),
    [METHODS.createApplication]: (params) => {
      const app = createApplication(workspace, createApplicationParams(params))
      broadcast({ event: EVENTS.applicationsChanged })
      return applicationView(app)
    },
    [METHODS.updateApplicationStatus]: (params) => {
      const { id, status } = updateApplicationStatusParams(params)
      const app = updateApplicationStatus(workspace, id, status as ApplicationStatus)
      broadcast({ event: EVENTS.applicationsChanged })
      return applicationView(app)
    },
    [METHODS.deleteApplication]: (params) => {
      deleteApplication(workspace, jobIdParams(params))
      broadcast({ event: EVENTS.applicationsChanged })
      return {}
    },
    [METHODS.linkApplicationDecision]: (params) => {
      const id = jobIdParams(params)
      const p = params as Record<string, unknown>
      if (typeof p.decisionId !== 'string' || p.decisionId.length === 0) throw new Error('params.decisionId 缺失')
      const app = linkApplicationDecision(workspace, id, p.decisionId)
      broadcast({ event: EVENTS.applicationsChanged })
      return applicationView(app)
    },
    [METHODS.jobCoverage]: (params) => {
      const id = jobIdParams(params)
      const job = scanJobs(workspace).find((j) => j.record.id === id)
      if (!job) throw new Error(`岗位不存在：${id}`)
      return computeEvidenceCoverage(job.record, scanEvidence(workspace).map((e) => e.record))
    },
    [METHODS.listEvidence]: () => scanEvidence(workspace).map((e) => ({
      ...e.record,
      ...(e.validation ? { validation: e.validation } : {}),
    })),
    [METHODS.listClaims]: () => {
      const evidenceById = indexEvidence(scanEvidence(workspace).map((e) => e.record))
      return scanClaims(workspace).map((c) => ({
        ...c.record,
        usable: canUseClaim(c.record, evidenceById),
        ...(c.validation ? { validation: c.validation } : {}),
      }))
    },
    [METHODS.claimCoverage]: (params) => {
      const id = jobIdParams(params)
      const job = scanJobs(workspace).find((j) => j.record.id === id)
      if (!job) throw new Error(`岗位不存在：${id}`)
      return computeClaimCoverage(job.record, scanEvidence(workspace).map((e) => e.record), scanClaims(workspace).map((c) => c.record))
    },
    [METHODS.claimSelect]: (params) => {
      const id = jobIdParams(params)
      const job = scanJobs(workspace).find((j) => j.record.id === id)
      if (!job) throw new Error(`岗位不存在：${id}`)
      return selectExpressionCandidates(job.record, scanEvidence(workspace).map((e) => e.record), scanClaims(workspace).map((c) => c.record))
    },
    [METHODS.claimProposalCreate]: (params) => {
      const p = params as Record<string, unknown>
      const input: ClaimProposalInput = {
        source: p?.source as ClaimProposalInput['source'],
        evidenceRefs: Array.isArray(p?.evidenceRefs) ? (p.evidenceRefs as unknown[]).filter((x): x is string => typeof x === 'string') : [],
        proposedClaim: {
          statement: typeof (p?.proposedClaim as Record<string, unknown> | undefined)?.statement === 'string' ? ((p.proposedClaim as Record<string, unknown>).statement as string) : '',
          ...(typeof (p?.proposedClaim as Record<string, unknown> | undefined)?.section === 'string'
            ? { section: ((p.proposedClaim as Record<string, unknown>).section as string) }
            : {}),
          ...(typeof (p?.proposedClaim as Record<string, unknown> | undefined)?.expectationId === 'string'
            ? { expectationId: ((p.proposedClaim as Record<string, unknown>).expectationId as string) }
            : {}),
        },
        explanation: typeof p?.explanation === 'string' ? p.explanation : '',
      }
      const proposal = createClaimProposal(workspace, input)
      broadcast({ event: EVENTS.claimProposalsChanged })
      return proposal
    },
    [METHODS.claimProposalList]: () => scanClaimProposals(workspace),
    [METHODS.claimProposalApprove]: (params) => {
      const result = approveClaimProposal(workspace, jobIdParams(params))
      broadcast({ event: EVENTS.claimProposalsChanged })
      broadcast({ event: EVENTS.claimsChanged })
      return result
    },
    [METHODS.claimProposalReject]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const updated = rejectClaimProposal(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.claimProposalsChanged })
      return updated
    },
    [METHODS.workingCopyList]: () => scanWorkingCopies(workspace),
    [METHODS.workingCopyUpsert]: (params) => {
      const p = params as Record<string, unknown>
      /** 块白名单透传（丢字段 = 内容静默丢失——同 identity/entries 通道语义） */
      const mapBlocks = (raw: unknown): { id: string; text: string; provenanceLinks?: string[]; expectationId?: string }[] =>
        Array.isArray(raw)
          ? (raw as Record<string, unknown>[]).map((b) => ({
              id: typeof b?.id === 'string' ? b.id : '',
              text: typeof b?.text === 'string' ? b.text : '',
              ...(Array.isArray(b?.provenanceLinks) ? { provenanceLinks: (b.provenanceLinks as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
              ...(typeof b?.expectationId === 'string' ? { expectationId: b.expectationId } : {}),
            }))
          : []
      const sections = Array.isArray(p?.sections)
        ? (p.sections as Record<string, unknown>[]).map((s) => ({
            id: typeof s?.id === 'string' ? s.id : '',
            title: typeof s?.title === 'string' ? s.title : '',
            blocks: mapBlocks(s?.blocks),
            // 条目化段（Resume Entry Contract v0.2）：条目头 + 描述 + 块透传——丢字段 = 结构静默丢失
            ...(Array.isArray(s?.entries)
              ? {
                  entries: (s.entries as Record<string, unknown>[]).map((e) => ({
                    id: typeof e?.id === 'string' ? e.id : '',
                    title: typeof e?.title === 'string' ? e.title : '',
                    ...(typeof e?.role === 'string' ? { role: e.role } : {}),
                    ...(typeof e?.period === 'string' ? { period: e.period } : {}),
                    ...(typeof e?.description === 'string' ? { description: e.description } : {}),
                    blocks: mapBlocks(e?.blocks),
                  })),
                }
              : {}),
            // 身份事实通道（M5.2 G6）：字段条目随 section 透传——丢字段会把身份段变空
            ...(Array.isArray(s?.identity)
              ? {
                  identity: (s.identity as Record<string, unknown>[]).map((e) => ({
                    ...(typeof e?.label === 'string' ? { label: e.label } : {}),
                    ...(typeof e?.body === 'string' ? { body: e.body } : {}),
                  })),
                }
              : {}),
          }))
        : []
      const input: WorkingCopyInput = {
        ...(typeof p?.id === 'string' ? { id: p.id } : {}),
        owner: typeof p?.owner === 'string' ? p.owner : '',
        ...(typeof p?.name === 'string' ? { name: p.name } : {}),
        sections,
        revision: typeof p?.revision === 'number' ? p.revision : 0,
        ...(p?.targetContext && typeof (p.targetContext as Record<string, unknown>)?.jobId === 'string'
          ? { targetContext: { jobId: ((p.targetContext as Record<string, unknown>).jobId as string) } }
          : {}),
      }
      const result = upsertWorkingCopy(workspace, input)
      if (result.status !== 'conflict') broadcast({ event: EVENTS.workingCopiesChanged })
      return result
    },
    [METHODS.workingCopyPromote]: (params) => {
      const document = promoteToDocumentCandidate(workspace, jobIdParams(params))
      broadcast({ event: EVENTS.workingCopiesChanged })
      broadcast({ event: EVENTS.resumesChanged })
      return document
    },
    [METHODS.workingCopyAlignment]: (params) => {
      const p = params as Record<string, unknown>
      const wcId = typeof p?.wcId === 'string' ? p.wcId : ''
      const jobId = typeof p?.jobId === 'string' ? p.jobId : ''
      if (!wcId || !jobId) throw new Error('wcId/jobId 必填')
      const wc = scanWorkingCopies(workspace).find((w) => w.id === wcId)
      if (!wc) throw new Error(`工作副本不存在：${wcId}`)
      const job = scanJobs(workspace).find((j) => j.record.id === jobId)
      if (!job) throw new Error(`岗位不存在：${jobId}`)
      const document = workingCopyToDocument(wc, workspace)
      return computeResumeAlignment({
        job: job.record,
        evidenceItems: scanEvidence(workspace).map((e) => e.record),
        resumeDocument: document,
        claims: scanClaims(workspace).map((c) => c.record),
      })
    },
    [METHODS.workingCopyOpportunities]: (params) => {
      const p = params as Record<string, unknown>
      const wcId = typeof p?.wcId === 'string' ? p.wcId : ''
      const jobId = typeof p?.jobId === 'string' ? p.jobId : ''
      if (!wcId || !jobId) throw new Error('wcId/jobId 必填')
      const wc = scanWorkingCopies(workspace).find((w) => w.id === wcId)
      if (!wc) throw new Error(`工作副本不存在：${wcId}`)
      const job = scanJobs(workspace).find((j) => j.record.id === jobId)
      if (!job) throw new Error(`岗位不存在：${jobId}`)
      const document = workingCopyToDocument(wc, workspace)
      return computeOpportunities({
        job: job.record,
        evidenceItems: scanEvidence(workspace).map((e) => e.record),
        claims: scanClaims(workspace).map((c) => c.record),
        resumeDocument: document,
        wc,
      })
    },
    [METHODS.opportunityContext]: (params) => {
      const p = params as Record<string, unknown>
      const wcId = typeof p?.wcId === 'string' ? p.wcId : ''
      const opportunityId = typeof p?.opportunityId === 'string' ? p.opportunityId : ''
      if (!wcId || !opportunityId) throw new Error('opportunityId/wcId 必填')
      return buildBridgeContext(workspace, wcId, opportunityId)
    },
    [METHODS.opportunityProposalSubmit]: (params) => {
      const p = params as Record<string, unknown>
      const opportunityId = typeof p?.opportunityId === 'string' ? p.opportunityId : ''
      const wcId = typeof p?.wcId === 'string' ? p.wcId : ''
      const changes = Array.isArray(p?.changes) ? (p.changes as Record<string, unknown>[]) : []
      if (!opportunityId || !wcId) throw new Error('opportunityId/wcId 必填')
      const proposal = submitOpportunityProposal(workspace, {
        opportunityId,
        wcId,
        changes: changes.map((c) => ({
          ...(typeof c.blockId === 'string' ? { blockId: c.blockId } : {}),
          before: typeof c.before === 'string' ? c.before : '',
          after: typeof c.after === 'string' ? c.after : '',
          operation: c.operation as 'rewrite' | 'insert' | 'delete',
        })),
      })
      broadcast({ event: EVENTS.opportunityProposalsChanged })
      return proposal
    },
    [METHODS.opportunityProposalList]: () => scanOpportunityProposals(workspace),
    [METHODS.opportunityProposalApprove]: (params) => {
      const proposal = approveOpportunityProposal(workspace, jobIdParams(params))
      broadcast({ event: EVENTS.opportunityProposalsChanged })
      return proposal
    },
    [METHODS.opportunityProposalReject]: (params) => {
      const p = params as Record<string, unknown>
      const proposal = rejectOpportunityProposal(workspace, jobIdParams(params), typeof p?.reason === 'string' ? p.reason : undefined)
      broadcast({ event: EVENTS.opportunityProposalsChanged })
      return proposal
    },
    [METHODS.opportunityProposalApply]: (params) => {
      const result = applyOpportunityProposal(workspace, jobIdParams(params))
      if (result.status === 'applied') {
        // 不变量 3：apply 后重新诊断——信号通知客户端重拉机会投影（闭环）
        broadcast({ event: EVENTS.workingCopiesChanged })
        broadcast({ event: EVENTS.opportunitiesChanged })
      }
      return result
    },
    [METHODS.listStrengthProposals]: (params) => {
      const p = params as Record<string, unknown> | null
      const personId = typeof p?.personId === 'string' && p.personId ? p.personId : undefined
      return scanStrengthProposals(workspace, personId)
    },
    [METHODS.decideStrengthProposal]: (params) => {
      const p = strengthProposalDecideParams(params)
      const proposal = decideStrengthProposal(workspace, p.id, p.action, p.reason)
      broadcast({ event: EVENTS.strengthProposalsChanged })
      if (p.action === 'accept') broadcast({ event: EVENTS.personsChanged })
      return proposal
    },
    [METHODS.listDerivationProposals]: (params) => {
      const p = derivationProposalListParams(params)
      return scanDerivationProposals(workspace, p)
    },
    [METHODS.decideDerivationProposal]: (params) => {
      const p = derivationProposalDecideParams(params)
      const proposal = decideDerivationProposal(workspace, p.id, p.action, p.reason)
      broadcast({ event: EVENTS.derivationProposalsChanged })
      if (p.action === 'accept') broadcast({ event: EVENTS.workingCopiesChanged })
      return proposal
    },
    [METHODS.claimBridgeContext]: (params) => {
      const p = params as Record<string, unknown>
      const wcId = typeof p?.wcId === 'string' ? p.wcId : ''
      const opportunityId = typeof p?.opportunityId === 'string' ? p.opportunityId : ''
      const evidenceIds = Array.isArray(p?.evidenceIds) ? p.evidenceIds.filter((x): x is string => typeof x === 'string') : []
      if (!wcId || !opportunityId) throw new Error('opportunityId/wcId 必填')
      return buildClaimBridgeContext(workspace, wcId, opportunityId, evidenceIds)
    },
    [METHODS.claimBridgeSubmit]: (params) => {
      const p = params as Record<string, unknown>
      const opportunityId = typeof p?.opportunityId === 'string' ? p.opportunityId : ''
      const wcId = typeof p?.wcId === 'string' ? p.wcId : ''
      const evidenceCandidates = Array.isArray(p?.evidenceCandidates) ? p.evidenceCandidates.filter((x): x is string => typeof x === 'string') : []
      const statement = typeof p?.statement === 'string' ? p.statement : ''
      const explanation = typeof p?.explanation === 'string' ? p.explanation : ''
      if (!opportunityId || !wcId) throw new Error('opportunityId/wcId 必填')
      const proposal = submitClaimBridge(workspace, { opportunityId, wcId, evidenceCandidates, statement, explanation })
      broadcast({ event: EVENTS.claimProposalsChanged })
      return proposal
    },
    [METHODS.claimBind]: (params) => {
      const p = params as Record<string, unknown>
      const wcId = typeof p?.wcId === 'string' ? p.wcId : ''
      const blockId = typeof p?.blockId === 'string' ? p.blockId : ''
      const claimId = typeof p?.claimId === 'string' ? p.claimId : ''
      if (!wcId || !blockId || !claimId) throw new Error('wcId/blockId/claimId 必填')
      const result = bindClaimToBlock(workspace, wcId, blockId, claimId)
      if (result.status === 'bound') {
        // 绑定后重诊断：块有 claim 锚 → covered（resolved 达成）——信号通知客户端重拉
        broadcast({ event: EVENTS.workingCopiesChanged })
        broadcast({ event: EVENTS.opportunitiesChanged })
      }
      return result
    },
    [METHODS.listResumes]: () => scanResumes(workspace).map((r) => ({
      ...r.record,
      ...(r.validation ? { validation: r.validation } : {}),
    })),
    [METHODS.resumeAlignment]: (params) => {
      const p = params as Record<string, unknown>
      const resumeId = typeof p?.resumeId === 'string' ? p.resumeId : ''
      const jobId = typeof p?.jobId === 'string' ? p.jobId : ''
      if (!resumeId || !jobId) throw new Error('resumes/alignment 需要 params { resumeId, jobId }')
      const resume = scanResumes(workspace).find((r) => r.record.id === resumeId)
      if (!resume) throw new Error(`简历版本不存在：${resumeId}`)
      const job = scanJobs(workspace).find((j) => j.record.id === jobId)
      if (!job) throw new Error(`岗位不存在：${jobId}`)
      return computeResumeAlignment({
        job: job.record,
        evidenceItems: scanEvidence(workspace).map((e) => e.record),
        resumeDocument: resume.record,
        claims: scanClaims(workspace).map((c) => c.record),
      })
    },
    [METHODS.getResume]: (params) => {
      const id = jobIdParams(params)
      const r = scanResumes(workspace).find((x) => x.record.id === id)
      if (!r) throw new Error(`简历版本不存在：${id}`)
      return r.record
    },
    [METHODS.cloneResume]: (params) => {
      const id = jobIdParams(params)
      const r = scanResumes(workspace).find((x) => x.record.id === id)
      if (!r) throw new Error(`简历版本不存在：${id}`)
      const clone = cloneResumeFile(workspace, r.record)
      broadcast({ event: EVENTS.resumesChanged })
      return clone
    },
    [METHODS.transitionResume]: (params) => {
      const p = params as Record<string, unknown>
      const id = jobIdParams(params)
      const target = p?.targetStatus
      if (typeof target !== 'string' || !['draft', 'review', 'exported', 'archived'].includes(target)) {
        throw new Error('params.targetStatus 缺失/非法（draft/review/exported/archived）')
      }
      const file = scanResumes(workspace).find((x) => x.record.id === id)?.sourceFile
      if (!file) throw new Error(`简历版本不存在：${id}`)
      const next = transitionResumeStatusFile(workspace, file, target as 'draft' | 'review' | 'exported' | 'archived', 'user')
      broadcast({ event: EVENTS.resumesChanged })
      return next
    },
    [METHODS.diffResumes]: (params) => {
      const p = params as Record<string, unknown>
      const a = typeof p?.a === 'string' ? p.a : ''
      const b = typeof p?.b === 'string' ? p.b : ''
      const ra = scanResumes(workspace).find((x) => x.record.id === a)?.record
      const rb = scanResumes(workspace).find((x) => x.record.id === b)?.record
      if (!ra || !rb) throw new Error('params.a/params.b 简历版本不存在')
      return diffResumes(ra, rb)
    },
    [METHODS.exportResume]: async (params) => {
      const id = jobIdParams(params)
      const r = scanResumes(workspace).find((x) => x.record.id === id)
      if (!r) throw new Error(`简历版本不存在：${id}`)
      const { result, record } = await exportResumePdf(r.record) // 失败抛错——不产生 exported 状态
      workspace.write(`resumes/exports/${record.id}.md`, serializeExportRecord(record))
      markResumeExported(workspace, r.sourceFile) // 绑定 ExportRecord 后系统流转 exported
      broadcast({ event: EVENTS.resumesChanged })
      return { result, record }
    },
    [METHODS.listProposals]: () => scanProposals(workspace).map((p) => ({
      ...p.record,
      ...(p.validation ? { validation: p.validation } : {}),
    })),
    [METHODS.acceptProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const { document } = acceptProposalFile(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.resumesChanged })
      broadcast({ event: EVENTS.proposalsChanged })
      return document
    },
    [METHODS.rejectProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const updated = rejectProposalFile(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.proposalsChanged })
      return updated
    },
    [METHODS.listPortfolioProjects]: () => scanPortfolioProjects(workspace).map((p) => ({
      ...p.record,
      ...(p.issues.length > 0 ? { issues: p.issues } : {}),
    })),
    [METHODS.listPortfolioProposals]: () => scanPortfolioProposals(workspace).map((p) => ({
      ...p.record,
      ...(p.issues.length > 0 ? { issues: p.issues } : {}),
    })),
    [METHODS.transitionPortfolio]: (params) => {
      const p = params as Record<string, unknown>
      const target = p?.targetStatus
      if (typeof target !== 'string' || !['draft', 'reviewed', 'published'].includes(target)) {
        throw new Error('params.targetStatus 缺失/非法（draft/reviewed/published）')
      }
      const updated = transitionPortfolioProject(workspace, jobIdParams(params), target as PortfolioStatus)
      broadcast({ event: EVENTS.portfolioChanged })
      return updated
    },
    [METHODS.acceptPortfolioProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const { project } = acceptPortfolioProposal(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.portfolioChanged })
      return project
    },
    [METHODS.rejectPortfolioProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const updated = rejectPortfolioProposal(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.portfolioChanged })
      return updated
    },
    [METHODS.listInterviewQas]: () => scanInterviewQas(workspace).map((q) => ({
      ...q.record,
      ...(q.issues.length > 0 ? { issues: q.issues } : {}),
    })),
    [METHODS.listInterviewProposals]: () => scanInterviewProposals(workspace).map((p) => ({
      ...p.record,
      ...(p.issues.length > 0 ? { issues: p.issues } : {}),
    })),
    [METHODS.transitionInterview]: (params) => {
      const p = params as Record<string, unknown>
      const target = p?.targetStatus
      if (typeof target !== 'string' || !['draft', 'reviewed', 'ready'].includes(target)) {
        throw new Error('params.targetStatus 缺失/非法（draft/reviewed/ready）')
      }
      const updated = transitionInterviewQa(workspace, jobIdParams(params), target as InterviewStatus)
      broadcast({ event: EVENTS.interviewChanged })
      return updated
    },
    [METHODS.acceptInterviewProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const { qa } = acceptInterviewProposal(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.interviewChanged })
      return qa
    },
    [METHODS.rejectInterviewProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const updated = rejectInterviewProposal(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.interviewChanged })
      return updated
    },
    [METHODS.listCoverLetters]: () => scanCoverLetters(workspace).map((c) => ({
      ...c.record,
      ...(c.issues.length > 0 ? { issues: c.issues } : {}),
    })),
    [METHODS.listCoverLetterProposals]: () => scanCoverLetterProposals(workspace).map((p) => ({
      ...p.record,
      ...(p.issues.length > 0 ? { issues: p.issues } : {}),
    })),
    [METHODS.transitionCoverLetter]: (params) => {
      const p = params as Record<string, unknown>
      const target = p?.targetStatus
      if (typeof target !== 'string' || !['draft', 'reviewed', 'ready'].includes(target)) {
        throw new Error('params.targetStatus 缺失/非法（draft/reviewed/ready）')
      }
      const updated = transitionCoverLetter(workspace, jobIdParams(params), target as CoverLetterStatus)
      broadcast({ event: EVENTS.coverLetterChanged })
      return updated
    },
    [METHODS.acceptCoverLetterProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const { coverLetter } = acceptCoverLetterProposal(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.coverLetterChanged })
      return coverLetter
    },
    [METHODS.rejectCoverLetterProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const updated = rejectCoverLetterProposal(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.coverLetterChanged })
      return updated
    },
    [METHODS.listArtifactSummaries]: () => buildArtifactSummaries(workspace),
    [METHODS.listArtifactTimeline]: () => buildArtifactTimeline(workspace),
    [METHODS.artifactTraceability]: (params) => {
      const p = params as Record<string, unknown>
      const artifact = p?.artifact
      const scopeId = typeof p?.scopeId === 'string' ? p.scopeId : ''
      const unitId = typeof p?.unitId === 'string' ? p.unitId : ''
      if (artifact !== 'cover-letter') {
        throw new Error('params.artifact 仅支持 cover-letter（v0.1 唯一 Reference adoption）')
      }
      if (!scopeId || !unitId) throw new Error('params.scopeId/unitId 缺失')
      return buildCoverLetterTraceability(workspace, scopeId, unitId)
    },
    [METHODS.aiContext]: (params) => {
      const p = params as Record<string, unknown> | undefined
      const jobId = typeof p?.jobId === 'string' ? p.jobId : undefined
      return buildCareerContext(workspace, jobId ? { jobId } : {})
    },
    [METHODS.deleteCompany]: (params) => {
      deleteCompanyFile(workspace, jobIdParams(params))
      broadcast({ event: EVENTS.companiesChanged })
      return {}
    },
    [METHODS.listJobs]: () => scanJobs(workspace).map((j) => ({
      ...j.record,
      ...(j.validation ? { validation: j.validation } : {}),
    })),
    [METHODS.getJob]: (params) => {
      const id = jobIdParams(params)
      const job = scanJobs(workspace).find((j) => j.record.id === id)
      if (!job) throw new Error(`岗位不存在：${id}`)
      return job.record
    },
    [METHODS.matchJob]: (params) => {
      const p = params as Record<string, unknown>
      if (typeof p?.person !== 'string' || p.person.length === 0) throw new Error('params.person 缺失（画像名）')
      return computeJobMatch(workspace, jobIdParams(params), p.person)
    },
    [METHODS.constraintMatch]: (params) => {
      const p = params as Record<string, unknown>
      if (typeof p?.personId !== 'string' || p.personId.length === 0) throw new Error('params.personId 缺失')
      return computeConstraintMatch(workspace, jobIdParams(params), p.personId)
    },
    [METHODS.jobMatchScore]: (params) => {
      const p = params as Record<string, unknown>
      const jobId = jobIdParams(params)
      if (typeof p?.personId !== 'string' || p.personId.length === 0) throw new Error('params.personId 缺失')
      const person = scanPersons(workspace).find((x) => x.personId === p.personId)
      if (!person) throw new Error(`人不存在：${p.personId}`)
      const job = scanJobs(workspace).find((j) => j.record.id === jobId)
      if (!job) throw new Error(`岗位不存在：${jobId}`)
      // 纯投影：复用既有确定性匹配产物（能力三元组 + 门槛四态）→ 规则表合成；城市冲突 = FLAG 非否决
      return computeJDMatchScore({
        jobId,
        personId: p.personId,
        gap: computeJobMatch(workspace, jobId, person.name),
        constraints: computeConstraintMatch(workspace, jobId, p.personId),
        jobLocation: job.record.location,
        preferredCity: person.preference?.city,
      })
    },
    [METHODS.decisionDraft]: (params) => {
      const p = params as Record<string, unknown>
      if (typeof p?.personId !== 'string' || p.personId.length === 0) throw new Error('params.personId 缺失')
      return computeDecisionCandidate(workspace, jobIdParams(params), p.personId)
    },
    [METHODS.narrativeSubmit]: (params) => {
      const p = params as Record<string, unknown>
      if (typeof p?.personId !== 'string' || p.personId.length === 0) throw new Error('params.personId 缺失')
      const jobId = jobIdParams(params)
      const person = scanPersons(workspace).find((x) => x.personId === p.personId)
      if (!person) throw new Error(`人不存在：${p.personId}`)
      const candidate = computeDecisionCandidate(workspace, jobId, p.personId)
      const rows = computeConstraintMatch(workspace, jobId, p.personId)
      const missing = computeJobMatch(workspace, jobId, person.name).missing
      const displayRows = resolveGapDisplay(candidate, rows, missing)
      const narrative = narrativeParams(p.narrative)
      if (!narrative.summary) {
        // 一键存档（2026-08-16 简化）：摘要表由引擎按当前岗位/公司/缺口数据确定性组装——
        // 用户叙述走 AI 面板，不进提交表单
        const job = scanJobs(workspace).find((j) => j.record.id === jobId)
        const company = job
          ? (store.listCompanies() as CompanyView[]).find((c) => c.name === job.record.company || c.aliases?.includes(job.record.company))
          : undefined
        if (!company?.riskLevel) {
          throw new Error('公司档案缺失风险评级（请先完成公司尽调）——无法自动生成决策摘要')
        }
        const riskLabel: Record<string, string> = { low: '低', medium: '中', high: '中高', risk: '高' }
        const skillGaps = displayRows.filter((r) => r.actionCategory === 'SKILL_GAP')
        const keyRisk =
          skillGaps.length > 0
            ? `技能缺口：${skillGaps.slice(0, 3).map((r) => r.requirement).join('/')}${skillGaps.length > 3 ? '等' : ''}`
            : '暂无明确技能缺口'
        narrative.summary = composeAutoSummaryTable({
          direction: job?.record.title ?? '-',
          profile: person.name,
          riskLevel: riskLabel[company.riskLevel] ?? company.riskLevel,
          keyRisk,
        })
      }
      const decisionId = writeDecisionRecord(workspace, {
        jobId,
        personId: p.personId,
        displayRows,
        narrative,
      })
      broadcast({ event: EVENTS.decisionsChanged })
      return { decisionId }
    },
    [METHODS.resumeContext]: (params) => {
      const p = params as Record<string, unknown>
      if (typeof p?.personId !== 'string' || p.personId.length === 0) throw new Error('params.personId 缺失')
      return computeResumeRewriteContext(workspace, jobIdParams(params), p.personId)
    },
    [METHODS.jdAnalyzeResult]: (params) => {
      const proposal = jdAnalyzeResultParams(params)
      const issues = validateJDAnalysisProposal(proposal)
      return writeJDAnalysis(workspace, proposal, issues)
    },
    [METHODS.extractJd]: async (params) => ({
      result: await extractJdFields(extractJdParams(params).jdText, {
        cwd: workspace.paths.root,
        model: config.agent.model,
        logger,
      }),
    }),
  }

  function respond(ws: WebSocket, resp: RpcResponse): void {
    ws.send(JSON.stringify(resp))
  }

  wss.on('connection', (ws, req: IncomingMessage) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      logger.warn(`拒绝非本机连接：${req.socket.remoteAddress}`)
      ws.close(1008, '仅允许本机回环连接')
      return
    }

    ws.on('message', (raw) => {
      let msg: unknown
      try {
        msg = JSON.parse(String(raw))
      } catch {
        respond(ws, { id: '', error: { code: 'invalid_request', message: '非 JSON 帧' } })
        return
      }
      if (!isRpcRequest(msg)) {
        respond(ws, { id: '', error: { code: 'invalid_request', message: '缺少 id/method' } })
        return
      }
      const handler = handlers[msg.method]
      if (!handler) {
        respond(ws, { id: msg.id, error: { code: 'method_not_found', message: `未知方法 ${msg.method}` } })
        return
      }
      void (async () => {
        try {
          respond(ws, { id: msg.id, result: await handler(msg.params) })
        } catch (err) {
          logger.error(`RPC ${msg.method} 失败：${err instanceof Error ? err.message : String(err)}`)
          respond(ws, { id: msg.id, error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) } })
        }
      })()
    })
  })

  logger.info(`WebSocket 桥监听 ws://${config.server.host}:${port}`)

  return {
    port,
    broadcast,
    shutdown: () => agentRuntime.shutdown(),
  }
}
