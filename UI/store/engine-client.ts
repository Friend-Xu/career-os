/**
 * 引擎客户端（WS 桥）：RPC + 事件订阅 + 离线降级。
 * - 契约：engine/transport/protocol.ts（RPC 请求/响应 + ServerEvent）
 * - 事件是通知，状态是可拉的资源：data.* 事件只作信号，数据一律 RPC 拉取
 * - 离线：连接失败/断开 → status 'offline' + 指数退避重连；UI 在 offline 时保持
 *   mock 数据行为（渐进替换，不假死）
 */
import type {
  AgentRuntimeEvent,
  CompanyRecord,
  DecisionAggregate,
  DecisionHistory,
  DecisionRecord,
  EvidenceItem,
  GapResult,
  InitCandidate,
  JDIntelligenceResult,
  HealthReport,
  JobRecord,
  Person,
  PoolEdge,
  PoolNode,
  Role,
  Skill,
  Validation,
} from '../../engine/ir/schema.ts'
import type { ResponsibilityCoverage } from '../../engine/runtime/evidence-coverage.ts'
import type { CareerClaim, ClaimCoverageRow } from '../../engine/ir/schema.ts'
import type { ResumeDocument, ResumeStatus, ResumeExportRecord, ResumeProposal } from '../../engine/ir/resume.ts'
import type { ExtractionResult } from '../../engine/runtime/document/pdf-import.ts'
import type { PortfolioProject, PortfolioProposal, PortfolioStatus } from '../../engine/ir/portfolio.ts'
import type { InterviewQa, InterviewProposal, InterviewStatus } from '../../engine/ir/interview.ts'
import type { CoverLetter, CoverLetterProposal, CoverLetterStatus } from '../../engine/ir/cover-letter.ts'
import type { ResumeDiff } from '../../engine/storage/resume-watcher.ts'
import type { CareerContext } from '../../engine/ir/context.ts'
import type { ArtifactSummary } from '../../engine/ir/artifact-summary.ts'
import type { ArtifactTimelineEvent } from '../../engine/ir/artifact-timeline.ts'
import type { TraceabilityContext } from '../../engine/ir/traceability.ts'
import { EVENTS, METHODS } from '../../engine/transport/protocol.ts'

export type EngineStatus = 'connecting' | 'connected' | 'offline'

/** 模型服务商连接（设置页服务商卡片；models = 用户勾选启用列表） */
export interface AgentProviderView {
  id: string
  label?: string
  baseUrl?: string
  apiKey?: string
  enabled: boolean
  models?: string[]
}

export interface InitResult {
  protocol: string
  version: string
  workspace: string
  serverTime: string
}

export type DecisionView = DecisionRecord & { validation?: Validation }
export type JobView = JobRecord & { validation?: Validation }

/** 公司档案全文（companies/get 返回：markdown 原文，UI 截取 `## 尽调详情` 渲染） */
export interface CompanyDetail {
  id: string
  markdown: string
}

/** 地图服务配置（config.json map 段：provider + 高德 JS API key + 安全密钥） */
export interface MapSettings {
  provider: string
  apiKey?: string
  securityJsCode?: string
}

/** JD 信息提取结果（jobs/extract 返回：粘贴 JD 自动回填建档表单） */
export interface JdExtractResult {
  company: string
  title: string
  location?: string
  salary?: string
  requirements: string[]
}

export interface GraphResult {
  nodes: PoolNode[]
  edges: PoolEdge[]
}

export interface PoolStats {
  total: number
  isolated: number
  byType: Record<string, number>
  missing: number
}

/** 图谱派生统计（linked 孤立计算，健康角标/二级栏计数/健康卡共用） */
export function computePoolStats(graph: GraphResult): PoolStats {
  const linked = new Set<string>()
  for (const e of graph.edges) {
    linked.add(e.source)
    linked.add(e.target)
  }
  const byType: Record<string, number> = {}
  let isolated = 0
  for (const n of graph.nodes) {
    byType[n.type] = (byType[n.type] ?? 0) + 1
    if (!linked.has(n.id)) isolated++
  }
  return { total: graph.nodes.length, isolated, byType, missing: 0 }
}

interface RpcResponse {
  id: string
  result?: unknown
  error?: { code: string; message: string }
}

interface ServerEvent {
  event: string
  taskId?: string
  data?: unknown
}

const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15000

export class EngineClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, (resp: RpcResponse) => void>()
  private listeners = new Map<string, Set<(data: unknown) => void>>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = RETRY_BASE_MS
  private closedByUser = false

  status: EngineStatus = 'offline'

  constructor(private url: string) {}

  connect(): void {
    this.closedByUser = false
    this.open()
  }

  private open(): void {
    this.status = 'connecting'
    this.emit('status', this.status)
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.onopen = () => {
      this.status = 'connected'
      this.retryDelay = RETRY_BASE_MS
      this.emit('status', this.status)
    }
    ws.onmessage = (ev) => {
      let msg: RpcResponse | ServerEvent
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if ('event' in msg) {
        // agent.event 帧的 taskId 在帧顶层：合并进 data（事件路由按 taskId 归属任务）
        if (msg.event === EVENTS.agentEvent && typeof msg.taskId === 'string' && msg.data !== undefined) {
          this.emit(msg.event, { taskId: msg.taskId, ...(msg.data as object) })
        } else {
          this.emit(msg.event, msg.data)
        }
      } else if (msg.id && this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        resolve?.(msg)
      }
    }
    ws.onclose = () => {
      this.status = 'offline'
      this.emit('status', this.status)
      for (const resolve of this.pending.values()) {
        resolve({ id: '', error: { code: 'offline', message: '引擎连接已断开' } })
      }
      this.pending.clear()
      if (!this.closedByUser) this.scheduleRetry()
    }
    ws.onerror = () => {
      ws.close()
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS)
      this.open()
    }, this.retryDelay)
  }

  disconnect(): void {
    this.closedByUser = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.ws?.close()
    this.ws = null
    this.status = 'offline'
    this.emit('status', this.status)
  }

  rpc<T = unknown>(method: string, params?: unknown, timeoutMs = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('引擎未连接（offline）'))
        return
      }
      const id = `r${Date.now()}-${Math.random().toString(36).slice(2)}`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC 超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, (resp) => {
        clearTimeout(timer)
        if (resp.error) {
          reject(new Error(`${method}: ${resp.error.code} ${resp.error.message}`))
        } else {
          resolve(resp.result as T)
        }
      })
      this.ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }))
    })
  }

  on(event: string, cb: (data: unknown) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(cb)
    return () => set.delete(cb)
  }

  private emit(event: string, data: unknown): void {
    this.listeners.get(event)?.forEach((cb) => cb(data))
  }

  // ─── 契约方法（protocol.ts METHODS）─────────────────────────────────

  init(): Promise<InitResult> {
    return this.rpc<InitResult>(METHODS.init)
  }

  listDecisions(): Promise<DecisionView[]> {
    return this.rpc<DecisionView[]>(METHODS.listDecisions)
  }

  rescan(): Promise<{ count: number }> {
    return this.rpc<{ count: number }>(METHODS.rescan)
  }

  /** 局部修改决策记录（引擎写回 md → watcher 自动重扫 → data.decisions.changed 广播） */
  updateDecision(id: string, fields: Record<string, string>): Promise<{ id: string; updatedFields: string[] }> {
    return this.rpc<{ id: string; updatedFields: string[] }>(METHODS.updateDecision, { id, fields })
  }

  listHistories(): Promise<DecisionHistory[]> {
    return this.rpc<DecisionHistory[]>(METHODS.decisionHistory)
  }

  /** 新建岗位（M1 只有 create；返回 JobRecord） */
  createJob(params: {
    company: string
    title: string
    location?: string
    salary?: string
    jdSource?: string
    requirements?: string
    jdText?: string
  }): Promise<JobRecord> {
    return this.rpc<JobRecord>(METHODS.createJob, params)
  }

  /** 全量岗位列表（含校验标记） */
  listJobs(): Promise<JobView[]> {
    return this.rpc<JobView[]>(METHODS.listJobs)
  }

  /** 单个岗位 */
  getJob(id: string): Promise<JobRecord> {
    return this.rpc<JobRecord>(METHODS.getJob, { id })
  }

  /** 岗位能力覆盖（Signal Layer：Job.responsibilities.capabilities 对齐源，可解释匹配不做百分比） */
  matchJob(jobId: string, person: string): Promise<GapResult> {
    return this.rpc<GapResult>(METHODS.matchJob, { id: jobId, person })
  }

  /** JD 信息 AI 提取（粘贴 JD 自动回填建档表单；LLM 慢操作，超时放宽到 90s） */
  extractJd(jdText: string): Promise<JdExtractResult> {
    return this.rpc<{ result: JdExtractResult }>(METHODS.extractJd, { jdText }, 90_000).then((r) => r.result)
  }

  /** 岗位证据覆盖（M2：evidenceExpectations × Inventory，三态不做匹配分） */
  jobCoverage(jobId: string): Promise<ResponsibilityCoverage[]> {
    return this.rpc<ResponsibilityCoverage[]>(METHODS.jobCoverage, { id: jobId })
  }

  /** 全量证据条目（M2：evidence/ 目录扫描 + 校验标记） */
  listEvidence(): Promise<EvidenceItem[]> {
    return this.rpc<EvidenceItem[]>(METHODS.listEvidence)
  }

  /** 全量 Claim（M3-0：claims/ 目录扫描 + usable——可消费性由引擎派生，UI 不自行过滤） */
  listClaims(): Promise<(CareerClaim & { usable: boolean })[]> {
    return this.rpc<(CareerClaim & { usable: boolean })[]>(METHODS.listClaims)
  }

  /** 岗位上下文 Claim Coverage（M3-0：responsibility → 关联 trusted evidence → 可消费 Claims） */
  claimCoverage(jobId: string): Promise<ClaimCoverageRow[]> {
    return this.rpc<ClaimCoverageRow[]>(METHODS.claimCoverage, { id: jobId })
  }

  /** 全量简历版本（M3.5：resumes/documents/ 扫描 + 校验标记） */
  listResumes(): Promise<ResumeDocument[]> {
    return this.rpc<ResumeDocument[]>(METHODS.listResumes)
  }

  /** 单个简历版本（M3.5） */
  getResume(id: string): Promise<ResumeDocument> {
    return this.rpc<ResumeDocument>(METHODS.getResume, { id })
  }

  /** 克隆版本（M3.5：新 draft，lineage.parent + createdBy=user） */
  cloneResume(id: string): Promise<ResumeDocument> {
    return this.rpc<ResumeDocument>(METHODS.cloneResume, { id })
  }

  /** 状态转移（M3.5：状态机校验 + operations 审计；exported 仅 export 链） */
  transitionResume(id: string, targetStatus: ResumeStatus): Promise<ResumeDocument> {
    return this.rpc<ResumeDocument>(METHODS.transitionResume, { id, targetStatus })
  }

  /** 版本对比（M3.5：identity diff——claimId 变化 = removed+added，不丢 provenance） */
  diffResumes(a: string, b: string): Promise<ResumeDiff> {
    return this.rpc<ResumeDiff>(METHODS.diffResumes, { a, b })
  }

  /** 导出简历版本（M3.5：exportResumePdf + ExportRecord + status=exported；与旧 HTML 导出 exportResume 区分） */
  exportResumeVersion(id: string): Promise<{ result: { pdf: string; fileName: string }; record: ResumeExportRecord }> {
    return this.rpc<{ result: { pdf: string; fileName: string }; record: ResumeExportRecord }>(METHODS.exportResume, { id })
  }

  /** 全量提案（M3.5.6：proposals/ 扫描 + 校验标记——AI 建议层） */
  listProposals(): Promise<ResumeProposal[]> {
    return this.rpc<ResumeProposal[]>(METHODS.listProposals)
  }

  /** 接受提案（M3.5.6：checksum 强校验 → 确定性应用 → 新版本；成功即产生 v4，永不覆盖源；reason 可选——M3.5.7 决策反馈） */
  acceptProposal(id: string, reason?: string): Promise<ResumeDocument> {
    return this.rpc<ResumeDocument>(METHODS.acceptProposal, { id, ...(reason && reason.trim() ? { reason } : {}) })
  }

  /** 拒绝提案（M3.5.6：pending → rejected；可选原因，审计保留） */
  rejectProposal(id: string, reason?: string): Promise<ResumeProposal> {
    return this.rpc<ResumeProposal>(METHODS.rejectProposal, { id, ...(reason && reason.trim() ? { reason } : {}) })
  }

  /** AI Read Model（M3.5.4：全资产投影——Studio provenance/validation 数据源） */
  aiContext(jobId?: string): Promise<CareerContext> {
    return this.rpc<CareerContext>(METHODS.aiContext, jobId ? { jobId } : {})
  }

  /** 四 Artifact 类级 Summary（M4-5.1：Engine Context → ArtifactSummary[] → Cards；UI 不读文件） */
  listArtifactSummaries(): Promise<ArtifactSummary[]> {
    return this.rpc<ArtifactSummary[]>(METHODS.listArtifactSummaries)
  }

  /** 四 Artifact 演化 Timeline（M4-5.3：Engine Events → Timeline Adapter → ArtifactTimelineEvent[]；引擎已确定性排序，UI 不重排） */
  listArtifactTimeline(): Promise<ArtifactTimelineEvent[]> {
    return this.rpc<ArtifactTimelineEvent[]>(METHODS.listArtifactTimeline)
  }

  /** 表达单元溯源（M4-5.4：只读定位——查看 ≠ 产生 Artifact state） */
  getTraceability(params: { artifact: 'cover-letter'; scopeId: string; unitId: string }): Promise<TraceabilityContext> {
    return this.rpc<TraceabilityContext>(METHODS.artifactTraceability, params)
  }

  // ─── M4 Artifact 数据（M4-5.2 Proposal Center：四类 proposal 读取 + accept/reject 走原 watcher）──

  listPortfolioProjects(): Promise<PortfolioProject[]> {
    return this.rpc<PortfolioProject[]>(METHODS.listPortfolioProjects)
  }

  listPortfolioProposals(): Promise<PortfolioProposal[]> {
    return this.rpc<PortfolioProposal[]>(METHODS.listPortfolioProposals)
  }

  transitionPortfolio(id: string, targetStatus: PortfolioStatus): Promise<PortfolioProject> {
    return this.rpc<PortfolioProject>(METHODS.transitionPortfolio, { id, targetStatus })
  }

  acceptPortfolioProposal(id: string, reason?: string): Promise<PortfolioProject> {
    return this.rpc<PortfolioProject>(METHODS.acceptPortfolioProposal, { id, ...(reason && reason.trim() ? { reason } : {}) })
  }

  rejectPortfolioProposal(id: string, reason?: string): Promise<PortfolioProposal> {
    return this.rpc<PortfolioProposal>(METHODS.rejectPortfolioProposal, { id, ...(reason && reason.trim() ? { reason } : {}) })
  }

  listInterviewQas(): Promise<InterviewQa[]> {
    return this.rpc<InterviewQa[]>(METHODS.listInterviewQas)
  }

  listInterviewProposals(): Promise<InterviewProposal[]> {
    return this.rpc<InterviewProposal[]>(METHODS.listInterviewProposals)
  }

  transitionInterview(id: string, targetStatus: InterviewStatus): Promise<InterviewQa> {
    return this.rpc<InterviewQa>(METHODS.transitionInterview, { id, targetStatus })
  }

  acceptInterviewProposal(id: string, reason?: string): Promise<InterviewQa> {
    return this.rpc<InterviewQa>(METHODS.acceptInterviewProposal, { id, ...(reason && reason.trim() ? { reason } : {}) })
  }

  rejectInterviewProposal(id: string, reason?: string): Promise<InterviewProposal> {
    return this.rpc<InterviewProposal>(METHODS.rejectInterviewProposal, { id, ...(reason && reason.trim() ? { reason } : {}) })
  }

  listCoverLetters(): Promise<CoverLetter[]> {
    return this.rpc<CoverLetter[]>(METHODS.listCoverLetters)
  }

  listCoverLetterProposals(): Promise<CoverLetterProposal[]> {
    return this.rpc<CoverLetterProposal[]>(METHODS.listCoverLetterProposals)
  }

  transitionCoverLetter(id: string, targetStatus: CoverLetterStatus): Promise<CoverLetter> {
    return this.rpc<CoverLetter>(METHODS.transitionCoverLetter, { id, targetStatus })
  }

  acceptCoverLetterProposal(id: string, reason?: string): Promise<CoverLetter> {
    return this.rpc<CoverLetter>(METHODS.acceptCoverLetterProposal, { id, ...(reason && reason.trim() ? { reason } : {}) })
  }

  rejectCoverLetterProposal(id: string, reason?: string): Promise<CoverLetterProposal> {
    return this.rpc<CoverLetterProposal>(METHODS.rejectCoverLetterProposal, { id, ...(reason && reason.trim() ? { reason } : {}) })
  }

  /** 删除岗位（删 jobs/{id}.md，引擎 watcher 广播后 UI 自动重拉） */
  deleteJob(id: string): Promise<unknown> {
    return this.rpc(METHODS.deleteJob, { id })
  }

  /** 删除公司档案（删 companies/{id}.md，引擎广播 data.companies.changed） */
  deleteCompany(id: string): Promise<unknown> {
    return this.rpc(METHODS.deleteCompany, { id })
  }

  /** 单个公司档案全文（尽调详情正文渲染） */
  getCompanyDetail(id: string): Promise<CompanyDetail> {
    return this.rpc<CompanyDetail>(METHODS.companyGet, { id })
  }

  /** 单个决策全文（评估详情抽屉渲染；含评估明细段落/打分依据） */
  getDecisionDetail(id: string): Promise<CompanyDetail> {
    return this.rpc<CompanyDetail>(METHODS.decisionGet, { id })
  }

  listContexts(): Promise<DecisionAggregate[]> {
    return this.rpc<DecisionAggregate[]>(METHODS.contexts)
  }

  knowledgeGraph(): Promise<{ skills: Skill[]; roles: Role[] }> {
    return this.rpc<{ skills: Skill[]; roles: Role[] }>(METHODS.knowledgeGraph)
  }

  knowledgeGap(params: { person: string; roleId: string }): Promise<GapResult> {
    return this.rpc<GapResult>(METHODS.knowledgeGap, params)
  }

  /** JD 分析（M6.6.5 Contract 样板）：JD + Person Aggregate → options/unknowns/inputs */
  jdAnalyze(params: { jobId: string; personId: string }): Promise<JDIntelligenceResult> {
    return this.rpc<JDIntelligenceResult>(METHODS.jdAnalyze, params)
  }

  listCompanies(): Promise<(CompanyRecord & { validation?: Validation })[]> {
    return this.rpc<(CompanyRecord & { validation?: Validation })[]>(METHODS.listCompanies)
  }

  listPersons(): Promise<Person[]> {
    return this.rpc<Person[]>(METHODS.listPersons)
  }

  /** 创建 Person + Initialization Session（引擎写 manifest.md + intake/session-001.md） */
  createPersonSession(params: { name: string; sourceMode: 'resume' | 'interview' }): Promise<{ personId: string; sessionId: string }> {
    return this.rpc<{ personId: string; sessionId: string }>(METHODS.createPersonSession, params)
  }

  /** 追加对话轮次到 intake/session-001.md（原始对话记录） */
  appendSessionTurn(params: { personId: string; role: 'user' | 'assistant'; content: string; timestamp?: string }): Promise<unknown> {
    return this.rpc(METHODS.appendSessionTurn, params)
  }

  /** 追加候选批次到 extraction/candidates.md（Candidate ≠ Fact） */
  appendCandidates(params: { personId: string; candidates: { category: string; content: string; source: string }[] }): Promise<InitCandidate[]> {
    return this.rpc<InitCandidate[]>(METHODS.appendCandidates, params)
  }

  /** 候选列表（extraction/ 缺失 → 空） */
  listCandidates(personId: string): Promise<InitCandidate[]> {
    return this.rpc<InitCandidate[]>(METHODS.listCandidates, { personId })
  }

  /** 候选裁决（切片 2.3：更新 candidates.md 状态 + 写 resolution 事件） */
  resolveCandidate(params: {
    personId: string
    candidateId: string
    action: 'confirmed' | 'rejected' | 'modified'
    modifiedContent?: string
  }): Promise<{ candidateId: string; action: string; status: string }> {
    return this.rpc<{ candidateId: string; action: string; status: string }>(METHODS.resolveCandidate, params)
  }

  /** 重置初始化（Person 生命周期 v0.1：清 intake/extraction/events/snapshot，manifest 保留） */
  resetPerson(personId: string): Promise<{ personId: string }> {
    return this.rpc<{ personId: string }>(METHODS.resetPerson, { personId })
  }

  /** 完成初始化（用户声明基础信息达到可用状态，非封闭）：manifest init_state → completed */
  completePersonInit(personId: string): Promise<{ personId: string; initState: 'completed' }> {
    return this.rpc<{ personId: string; initState: 'completed' }>(METHODS.completePersonInit, { personId })
  }

  /** 物理删除 Person（dev/测试清理：persons/{id}/ 整目录移除，不可恢复） */
  deletePerson(personId: string): Promise<{ personId: string }> {
    return this.rpc<{ personId: string }>(METHODS.deletePerson, { personId })
  }

  /** PDF 提取（Document Ingestion：pdfBase64 → 本地文本层；pages → 逐页视觉；失败建模为状态不抛错）
   *  视觉通道逐页调用免费模型延迟高且带限流重试（3 次 × 每页约 15s + 退避），超时放宽到 180s */
  resumeExtract(params: { pdfBase64?: string; pages?: string[] }, timeoutMs = 180_000): Promise<ExtractionResult> {
    return this.rpc<ExtractionResult>(METHODS.resumeExtract, params, timeoutMs)
  }

  /** 简历 Artifact 落盘（documents/resumes/resume-00X + meta + extraction md，编号递增不覆盖） */
  saveResumeOriginal(params: {
    personId: string
    fileName?: string
    text?: string
    pdfBase64?: string
    extraction?: { method: 'text' | 'vision'; model?: string }
  }): Promise<{ artifactId: string; format: 'text' | 'pdf' }> {
    return this.rpc<{ artifactId: string; format: 'text' | 'pdf' }>(METHODS.saveResumeOriginal, params)
  }

  poolGraph(): Promise<GraphResult> {
    return this.rpc<GraphResult>(METHODS.poolGraph)
  }

  /** 健康投影（契约 v1；与 CLI --doctor 同一计算源） */
  health(): Promise<HealthReport> {
    return this.rpc<HealthReport>(METHODS.health)
  }

  /** 简历导出 PDF（引擎 spawn Edge headless --print-to-pdf） */
  exportResume(html: string): Promise<{ pdf: string; fileName: string }> {
    return this.rpc<{ pdf: string; fileName: string }>(METHODS.resumeExport, { html })
  }

  // ─── Agent 通道（真实 LLM 流；事件经 agent.event 订阅）───────────────────

  startAgent(params: {
    task: string
    context?: string
    resumeSessionId?: string
    /** 当前分析对象（person_003）——引擎注入任务上下文，决策产物继承此归属（ADR-014） */
    personId?: string
    permissionMode?: 'acceptEdits' | 'ask' | 'bypassPermissions'
    allowedTools?: string[]
    maxTurns?: number
    model?: string
    apiKey?: string
    baseUrl?: string
  }): Promise<{ taskId: string }> {
    return this.rpc<{ taskId: string }>(METHODS.agentStart, params)
  }

  /** Agent 设置（settings/get：来自 config.json） */
  getAgentSettings(): Promise<{
    model?: string
    apiKey?: string
    baseUrl?: string
    enabled?: boolean
    providers?: AgentProviderView[]
    permissionMode?: string
    allowedTools?: string[]
    maxTurns?: number
    map?: MapSettings
    document?: { vision?: { provider?: 'zhipu'; model?: string; apiKey?: string } }
  }> {
    return this.rpc(METHODS.settingsGet)
  }

  /** 更新 Agent 设置（settings/update：写回 config.json + 引擎内存，下次任务生效；undefined 字段不修改） */
  updateAgentSettings(patch: {
    model?: string
    apiKey?: string
    baseUrl?: string
    enabled?: boolean
    providers?: AgentProviderView[]
    permissionMode?: 'acceptEdits' | 'ask' | 'bypassPermissions'
    map?: { apiKey?: string; securityJsCode?: string }
    document?: { vision?: { provider?: 'zhipu'; model?: string; apiKey?: string } }
  }): Promise<unknown> {
    return this.rpc(METHODS.settingsUpdate, patch)
  }

  /** 可用模型列表（settings/models：有 apiKey 时引擎调 {baseUrl}/v1/models 拉真实模型；
   * 可选 params 传临时 apiKey/baseUrl——未保存也能提取（「提取模型」按钮），缺省用引擎配置 */
  getAvailableModels(params?: { apiKey?: string; baseUrl?: string }): Promise<{
    source: 'api' | 'cli' | 'api_error'
    models: string[]
    error?: 'auth' | 'no_endpoint' | 'network'
  }> {
    return this.rpc(METHODS.settingsModels, params)
  }

  answerAgent(taskId: string, text: string): Promise<unknown> {
    return this.rpc(METHODS.agentAnswer, { taskId, text })
  }

  cancelAgent(taskId: string): Promise<unknown> {
    return this.rpc(METHODS.agentCancel, { taskId })
  }

  /** 2B：rewrite 用户决策事件上报（只记录不学习，契约 Resume-Feedback-Contract-v1） */
  reportRewriteFeedback(params: {
    requestId: string
    action: 'apply' | 'reject'
    reason?: string
    selectedTextHash: string
  }): Promise<unknown> {
    return this.rpc(METHODS.rewriteFeedback, params)
  }

  permissionAgent(taskId: string, requestId: string, allow: boolean): Promise<unknown> {
    return this.rpc(METHODS.agentPermission, { taskId, requestId, allow })
  }

  /** 订阅 Agent 流式事件（帧 = { taskId, ...AgentRuntimeEvent }） */
  onAgentEvent(cb: (taskId: string, ev: AgentRuntimeEvent) => void): () => void {
    return this.on(EVENTS.agentEvent, (data) => {
      const frame = data as { taskId?: string } & Record<string, unknown>
      if (typeof frame.taskId !== 'string') return
      cb(frame.taskId, frame as unknown as AgentRuntimeEvent)
    })
  }
}

export { EVENTS }
export { METHODS }

export function createEngineClient(url = 'ws://127.0.0.1:5289'): EngineClient {
  return new EngineClient(url)
}
