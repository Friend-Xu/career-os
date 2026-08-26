/**
 * Agent 运行时（第 4 步收尾）：任务注册表 + 事件循环 + 权限/提问/取消往返。
 * - 职责：Agent 是能力提供者——start() 创建任务（config 默认值合并），消费 AgentRunner
 *   事件流（直连 streamText，ADR-030）并转成可过 WS 的 AgentRuntimeEvent（permission_request
 *   换为 requestId，canUseTool promise 留在挂起表）；answer/cancel/permission 三个 RPC 入口驱动任务。
 * - 生命周期：done/error → 清理任务；cancel → AbortController.abort()。
 * - 权限：onPermissionRequest 返回挂起 promise，permission() 决策后 resolve（前端弹窗往返）。
 * - AskUserQuestion：runner 的 ask_user_question 工具直接放行（卡片不是危险操作），
 *   question_request 事件带结构化问题，answer() 回填提问 promise。
 * - resume：直连模式无会话恢复（上下文由引擎按 Artifact 全量重建，ADR-030）。
 * - 事件推送：构造时注入 emit(taskId, ev) 回调（websocket 广播 agent.event）。
 */
import { createAgentRunner } from '../agent/capability/agent-runner.ts'
import { resolveLanguageModel } from '../agent/providers/model.ts'
import type { WebSearchMode } from '../agent/providers/capabilities.ts'
import { buildFsTools, FS_TOOL_META } from '../agent/tools/fs-tools.ts'
import { createSubmitJdAnalysisTool } from '../agent/tools/jd-proposal-tool.ts'
import { buildWebSearchTool, createSearchSession, WEB_SEARCH_TOOL_META, type CacheEntry } from '../agent/tools/web-search.ts'
import {
  buildExaTools,
  buildIndustryEvidenceTool,
  createExaSession,
  EXA_CACHE_TTL_MINUTES,
  EXA_SESSION_BUDGET,
  EXA_TOOL_META,
  INDUSTRY_EVIDENCE_TOOL_META,
  ExaConnector,
  type ExaCacheEntry,
} from '../agent/tools/exa.ts'
import {
  buildNbsTools,
  buildNbsProfileTools,
  createNbsSession,
  createNbsProfileSession,
  NBS_CACHE_TTL_MINUTES,
  NBS_SESSION_BUDGET,
  NBS_PROFILE_SESSION_MAX_REQUESTS,
  NBS_TOOL_META,
  NBS_PROFILE_TOOL_META,
  NbsConnector,
  type NbsCacheEntry,
} from '../agent/tools/nbs/index.ts'
import type { ToolSourceDef } from '../agent/tools/tool-assembly.ts'
import type { SearchSession } from '../agent/tools/web-search.ts'
import type { ExaSession } from '../agent/tools/exa.ts'
import type { NbsProfileSession, NbsSession } from '../agent/tools/nbs/index.ts'
import { DEFAULT_SEARCH_BUDGET, DEFAULT_SEARCH_CACHE_TTL_MINUTES } from '../config.ts'
import type { AgentHandle, AgentEvent } from '../ir/agent-event.ts'
import type { AgentRuntimeEvent, SufficiencyValidationSummary } from '../ir/schema.ts'
import { validateEvidenceSufficiency } from './evidence-sufficiency-validator.ts'
import { SessionContextStore } from './session-context-store.ts'
import type { SessionFocusRef } from '../ir/session-context.ts'
import { buildSessionContextSection } from '../agent/context/session-context-compiler.ts'
import type { Logger } from '../logger.ts'
import type { Workspace } from '../storage/workspace.ts'
import { ExecutionRegistry, isTerminalExecutionStatus, type PendingInteraction } from './execution-registry.ts'
/** Agent Task & Context（ADR-020，ir 共享契约）——taskType/contextRefs/outputTarget/trigger */
import type {
  AgentTaskType,
  ContextReference,
  OutputTarget,
  TaskTrigger,
} from '../ir/agent-task.ts'

export type { AgentRuntimeEvent }

/** 工具来源组装入参（独立函数——websocket 接线层传参不在单测域，真机验收覆盖） */
export interface BuildSourcesOptions {
  workspace: Workspace
  defaults: AgentDefaults
  exaConnector?: ExaConnector
  nbsConnector?: NbsConnector
  searchCache: Map<string, CacheEntry>
  exaCache: Map<string, ExaCacheEntry>
  nbsCache: Map<string, NbsCacheEntry>
  logger: Logger
  baseUrl?: string
  /** start() fail fast 校验后必填（无凭证/无模型拒绝启动） */
  apiKey: string
  model: string
}

/**
 * 工具来源组装（Tool Assembly Layer 的 source 侧）：builtin 文件工具恒在；hosted WebSearch 按
 * 现有条件注入（无 provider/off 模式 → 不注册——装配层交集自然排除）；mcp 源（Exa）在连接
 * 已就绪时注入；data 源（NBS）在启用时注入（未启用 → 不注入，fail-safe）。
 * 返回同时带会话引用——ADR-035 完成语义：done 时读取 budget_exhausted 事实（预算拒绝计数）。
 */
export interface BuiltToolSources {
  sources: ToolSourceDef[]
  /** 已启用通道的治理会话（缺失 = 通道未启用） */
  sessions: {
    web_search?: SearchSession
    exa?: ExaSession
    nbs?: NbsSession
    nbsProfile?: NbsProfileSession
  }
}

export function buildToolSources(opts: BuildSourcesOptions): BuiltToolSources {
  const { defaults } = opts
  // 托管检索（hosted）：预算/缓存/证据会话（证据 = Tool Evidence Contract 生产方）
  const searchSession = createSearchSession({
    provider: { baseUrl: opts.baseUrl ?? '', apiKey: opts.apiKey, model: opts.model, mode: defaults.webSearchMode ?? 'responses' },
    budget: defaults.searchBudget ?? DEFAULT_SEARCH_BUDGET,
    cacheTtlMs: (defaults.searchCacheTtlMinutes ?? DEFAULT_SEARCH_CACHE_TTL_MINUTES) * 60_000,
    timeoutMs: defaults.searchTimeoutMs,
    hostedRetries: defaults.searchHostedRetries,
    cache: opts.searchCache,
    logger: opts.logger,
  })
  // Exa（mcp）：证据按认知层工具名分桶（WebResearch/WebFetch 各自归属）；
  // 行业证据模板（QueryIndustryEvidence）独立会话（预算/缓存互不挤占，证据独立标签）
  const exaBudget = defaults.exaBudget ?? EXA_SESSION_BUDGET
  const exaCacheTtlMs = (defaults.exaCacheTtlMinutes ?? EXA_CACHE_TTL_MINUTES) * 60_000
  const exaSession = opts.exaConnector?.ready === true
    ? createExaSession({ connector: opts.exaConnector, budget: exaBudget, cacheTtlMs: exaCacheTtlMs, cache: opts.exaCache, logger: opts.logger })
    : null
  const industrySession = opts.exaConnector?.ready === true
    ? createExaSession({
        connector: opts.exaConnector,
        budget: exaBudget,
        cacheTtlMs: exaCacheTtlMs,
        cache: opts.exaCache,
        logger: opts.logger,
        evidenceLabels: { web_search_exa: 'QueryIndustryEvidence', web_fetch_exa: 'WebFetch' },
      })
    : null
  // NBS（data）：两个治理会话（单查询/画像），共用连接器；证据各自归属
  const nbsTools = opts.nbsConnector === undefined ? null : {
    session: createNbsSession({
      connector: opts.nbsConnector,
      budget: defaults.nbsBudget ?? NBS_SESSION_BUDGET,
      cacheTtlMs: (defaults.nbsCacheTtlMinutes ?? NBS_CACHE_TTL_MINUTES) * 60_000,
      cache: opts.nbsCache,
      logger: opts.logger,
    }),
    profileSession: createNbsProfileSession({
      connector: opts.nbsConnector,
      budget: defaults.nbsProfileBudget ?? NBS_PROFILE_SESSION_MAX_REQUESTS,
      cacheTtlMs: (defaults.nbsCacheTtlMinutes ?? NBS_CACHE_TTL_MINUTES) * 60_000,
      cache: opts.nbsCache,
      logger: opts.logger,
    }),
    connector: opts.nbsConnector,
  }
  return {
    sources: [
      { tools: buildFsTools(opts.workspace), meta: FS_TOOL_META },
      ...(opts.baseUrl !== undefined && (defaults.webSearchMode ?? 'responses') !== 'off'
        ? [
            {
              tools: { WebSearch: buildWebSearchTool(searchSession) },
              meta: {
                WebSearch: {
                  ...WEB_SEARCH_TOOL_META,
                  budget: defaults.searchBudget ?? DEFAULT_SEARCH_BUDGET,
                },
              },
              evidence: { WebSearch: () => searchSession.takeEvidence() },
            },
          ]
        : []),
      ...(exaSession !== null
        ? [
            {
              tools: {
                ...buildExaTools(opts.exaConnector as ExaConnector, exaSession),
                ...buildIndustryEvidenceTool(industrySession as NonNullable<typeof industrySession>),
              },
              meta: { ...EXA_TOOL_META, ...INDUSTRY_EVIDENCE_TOOL_META },
              evidence: {
                WebResearch: () => exaSession.takeEvidence('WebResearch'),
                WebFetch: () => exaSession.takeEvidence('WebFetch'),
                QueryIndustryEvidence: () => (industrySession as NonNullable<typeof industrySession>).takeEvidence('QueryIndustryEvidence'),
              },
            },
          ]
        : []),
      ...(nbsTools !== null
        ? [
            {
              // data 源双工具：单查询（QueryMacroStats）+ 区域画像矩阵（CompareRegionProfiles）——
              // 共用同一 NbsConnector（指标索引/树缓存/解析器），治理会话各自独立（预算互不挤占）
              tools: {
                ...buildNbsTools(nbsTools.session),
                ...buildNbsProfileTools(nbsTools.profileSession),
              },
              meta: { ...NBS_TOOL_META, ...NBS_PROFILE_TOOL_META },
              evidence: {
                QueryMacroStats: () => nbsTools.session.takeEvidence(),
                CompareRegionProfiles: () => nbsTools.profileSession.takeEvidence(),
              },
            },
          ]
        : []),
    ],
    sessions: {
      ...(opts.baseUrl !== undefined && (defaults.webSearchMode ?? 'responses') !== 'off'
        ? { web_search: searchSession }
        : {}),
      ...(exaSession !== null ? { exa: exaSession } : {}),
      ...(nbsTools !== null ? { nbs: nbsTools.session, nbsProfile: nbsTools.profileSession } : {}),
    },
  }
}

export interface AgentStartParams {
  task: string
  /** 任务类型（ADR-020 Registry 9 型；缺省 = 旧调用无类型语义，v0.1 兼容） */
  taskType?: AgentTaskType
  /** 显式领域引用（Context Assembly 输入；缺省 = 空引用任务，开放探索） */
  contextRefs?: ContextReference[]
  /** 输出目标（Output Boundary：decision/artifact/none；缺省 none） */
  outputTarget?: OutputTarget
  /** v0.1 仅 'user_action' */
  trigger?: TaskTrigger
  context?: string
  /** 系统协议段（引擎单方组装：identity/Stage Envelope/任务协议——put into AI SDK system channel） */
  system?: string
  resumeSessionId?: string
  /** 当前分析对象——系统事实，注入任务上下文；决策产物继承此归属（ADR-014） */
  personId?: string
  /** Interaction provenance（ADR-034 §1.6）：UI 对话/会话触发才有；Workflow 触发可无 */
  sessionId?: string
  /** Workflow Stage Boundary Token（Agent Execution Boundary Repair P0-C）：与 stageId 成对，
   *  引擎校验 workflow active + stage == current + status == running 后编译 Stage Envelope 注入 */
  workflowId?: string
  stageId?: string
  permissionMode?: 'acceptEdits' | 'ask' | 'bypassPermissions'
  allowedTools?: string[]
  maxTurns?: number
  /** 单步输出预算（token；Control Plane 注入——Stage 任务按 StageSpec.task.outputBudget，
   *  普通过话缺省 = runner 8K 默认；客户端不可设，引擎单方决定） */
  outputBudget?: number
  /** Stage 级工具声明（StageSpec.task.tools；缺省 = 不收窄；客户端不可设，引擎单方决定） */
  stageTools?: string[]
  /** 模型覆盖（聊天界面切换器；缺省用引擎 config.agent.model） */
  model?: string
  /** API 密钥覆盖（设置页配置；缺省用引擎 config.agent.apiKey） */
  apiKey?: string
  /** API 端点根地址覆盖（缺省用引擎 config.agent.baseUrl；空 = 官方） */
  baseUrl?: string
  /** 本轮显式引用的解析投影（websocket 层 resolveContextRefs 后注入；ADR-036 Frame focus 更新源。
   *  Agent 不感知——仅 Context Compiler（引擎）消费，与 task 的引用装配正交） */
  resolvedFocus?: SessionFocusRef[]
}

/** config.agent 默认值（start 时合并；前端不传则用引擎配置） */
export interface AgentDefaults {
  permissionMode: 'acceptEdits' | 'ask' | 'bypassPermissions'
  allowedTools: string[]
  maxTurns?: number
  model?: string
  apiKey?: string
  baseUrl?: string
  /** WebSearch 任务级预算（引擎单方决定；缺省 = DEFAULT_SEARCH_BUDGET） */
  searchBudget?: number
  /** WebSearch 缓存 TTL 分钟（引擎单方决定；缺省 = DEFAULT_SEARCH_CACHE_TTL_MINUTES） */
  searchCacheTtlMinutes?: number
  /** WebSearch 执行模式（Provider Capability Registry 判定；'off' = 不注册工具；缺省 = responses，向后兼容） */
  webSearchMode?: WebSearchMode
  /** WebSearch 单次调用超时毫秒（Phase 4C 配置化；缺省 = WEBSEARCH_MODEL_TIMEOUT_MS） */
  searchTimeoutMs?: number
  /** WebSearch 守卫降级重试次数（0-3；缺省 = 0——降级即恢复语义） */
  searchHostedRetries?: number
  /** Exa 任务级预算（缺省 = EXA_SESSION_BUDGET） */
  exaBudget?: number
  /** Exa 缓存 TTL 分钟（缺省 = EXA_CACHE_TTL_MINUTES） */
  exaCacheTtlMinutes?: number
  /** NBS 单查询会话预算（缺省 = NBS_SESSION_BUDGET） */
  nbsBudget?: number
  /** NBS 画像会话预算（缺省 = NBS_PROFILE_SESSION_MAX_REQUESTS） */
  nbsProfileBudget?: number
  /** NBS 缓存 TTL 分钟（缺省 = NBS_CACHE_TTL_MINUTES） */
  nbsCacheTtlMinutes?: number
}

interface TaskState {
  handle: AgentHandle
  abort: AbortController
  sessionId?: string
  /** conversation 判定（ADR-036：workflow/stage 控制平面任务不参与 Frame——契约 §A） */
  workflowId?: string
  stageId?: string
  personId?: string
  /** 本轮显式引用投影（Focus 更新源；空 = 无显式引用 → focus 保留） */
  frameRefs?: SessionFocusRef[]
  /** 本轮用户输入（recentTurns 的 user 记录源） */
  userText?: string
  /** done 的最终回答（recentTurns 的 assistant 记录源；仅 done 有） */
  finalResult?: string
  /** 终点类型（先到先得——cancel 竞态下剩余事件不改写；契约 §D） */
  terminalKind?: 'done' | 'error' | 'cancelled'
  pendingPermissions: Map<string, (ok: boolean) => void>
  /** 本次任务已调用的工具名（tool_start 记录——完成钩子的合规检查证据面，如 BUG-4 市场检索） */
  usedTools: Set<string>
  /** Execution 关联（ADR-034 §2.2：executionId = public identity；taskId 仍是 tasks 索引） */
  executionId: string
  /** 等待外部输入的交互（waiting 状态的载荷——与 Registry.pendingInteraction 同步；答案/授权后清除） */
  pendingInteraction?: PendingInteraction
  /** ADR-020 任务类型（ADR-035 完成语义：company_research → 充分性校验） */
  taskType?: AgentTaskType
  /** 证据通道治理会话（ADR-035 done 时读预算事实） */
  sessions?: BuiltToolSources['sessions']
}

export class AgentRuntime {
  private tasks = new Map<string, TaskState>()
  private permissionSeq = 0
  private logger: Logger
  private emit: (taskId: string, ev: AgentRuntimeEvent) => void
  /** Execution Registry（ADR-034 §3.1：Runtime Execution SoT——AgentRuntime 是其唯一写入方） */
  private registry: ExecutionRegistry
  /** WebSearch 检索缓存（引擎级单例：跨任务共享，进程存续——引擎重启即失效，可接受） */
  private searchCache = new Map<string, CacheEntry>()
  /** Exa 检索缓存（引擎级单例：跨任务共享；与 WebSearch 缓存独立命名空间） */
  private exaCache = new Map<string, ExaCacheEntry>()
  /** NBS 统计缓存（引擎级单例：宏观数据低频，天级 TTL） */
  private nbsCache = new Map<string, NbsCacheEntry>()
  /** Exa MCP 连接器（Tool Runtime P2；缺省 = 不注册该源——未启用/连接失败均 fail-safe） */
  private exaConnector?: ExaConnector
  /** NBS 数据连接器（Tool Runtime P3；缺省 = 不注册该源——未启用即不注入） */
  private nbsConnector?: NbsConnector
  /** Session Context Store（ADR-036 Phase 2；缺省 = 不启用 Frame——测试/未接线实例零行为侵入） */
  private frames?: SessionContextStore

  constructor(
    logger: Logger,
    emit: (taskId: string, ev: AgentRuntimeEvent) => void,
    registry: ExecutionRegistry,
    exaConnector?: ExaConnector,
    nbsConnector?: NbsConnector,
    frames?: SessionContextStore,
  ) {
    this.logger = logger
    this.emit = emit
    this.registry = registry
    this.exaConnector = exaConnector
    this.nbsConnector = nbsConnector
    this.frames = frames
  }

  start(params: AgentStartParams, defaults: AgentDefaults, workspace: Workspace): { taskId: string; executionId: string } {
    const taskId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const abort = new AbortController()
    const task: TaskState = { handle: undefined as unknown as AgentHandle, abort, pendingPermissions: new Map(), usedTools: new Set(), executionId: '' }
    task.sessionId = params.sessionId
    task.workflowId = params.workflowId
    task.stageId = params.stageId
    task.personId = params.personId
    task.frameRefs = params.resolvedFocus
    task.userText = params.task
    const apiKey = params.apiKey ?? defaults.apiKey
    const baseUrl = params.baseUrl ?? defaults.baseUrl
    const model = params.model ?? defaults.model
    // 系统边界 fail fast（ADR-030 Step 6）：直连是唯一路径——无凭证/无模型直接拒绝启动
    if (!apiKey) throw new Error('未配置已启用的服务商（apiKey）——请在设置页添加并启用服务商后再试')
    if (!model) throw new Error('服务商未登记模型——请在设置页勾选模型后再试')

    // 工具来源组装（Tool Assembly Layer）：独立函数 buildToolSources（单测覆盖源组合；
    // websocket → AgentRuntime 的 connector 传参属接线层，真机验收覆盖）
    const built = buildToolSources({
      workspace,
      defaults,
      exaConnector: this.exaConnector,
      nbsConnector: this.nbsConnector,
      searchCache: this.searchCache,
      exaCache: this.exaCache,
      nbsCache: this.nbsCache,
      logger: this.logger,
      baseUrl,
      apiKey,
      model,
    })
    const sources = built.sources
    task.taskType = params.taskType
    task.sessions = built.sessions
    // ADR-036 Phase 3（契约 §C）：conversation 任务编译会话上下文——
    // 有显式引用 → 只注入 recentTurns（权威优先，focus 不继承）；无 → 继承 focus + recentTurns；
    // 无 Frame（/控制平面/无 sessionId）→ ''（零风险路径，行为与现状一致）
    const sessionSection =
      this.frames !== undefined &&
      params.sessionId !== undefined &&
      params.workflowId === undefined &&
      params.stageId === undefined
        ? buildSessionContextSection({
            frame: this.frames.get(params.sessionId),
            inheritFocus: (params.resolvedFocus?.length ?? 0) === 0,
          })
        : ''
    const handle = createAgentRunner({
      task: params.task,
      context: params.context,
      // 系统协议段（身份/Stage Envelope/任务协议/会话上下文）→ AI SDK system 通道
      system: [params.system, sessionSection].filter(Boolean).join('\n\n'),
      model: resolveLanguageModel({ apiKey, baseUrl, model, validModels: [model], credentialSource: 'config' }).model,
      sources,
      allowedTools: params.allowedTools ?? defaults.allowedTools,
      stageTools: params.stageTools,
      // 任务协议工具（按 taskType 引擎单方注入；submit_jd_analysis = job_analysis 的 Proposal 通道——
      // 契约 v0.1 方案 B：Agent 无 Artifact 写权限，提交经 Validator+Writer 写档）
      taskTools:
        params.taskType === 'job_analysis' ? { submit_jd_analysis: createSubmitJdAnalysisTool(workspace) } : undefined,
      permissionMode: params.permissionMode ?? defaults.permissionMode,
      maxTurns: params.maxTurns ?? defaults.maxTurns,
      outputBudget: params.outputBudget,
      abortController: abort,
      logger: this.logger,
      onPermissionRequest: (tool) =>
        new Promise<boolean>((resolve) => {
          const requestId = `p-${++this.permissionSeq}`
          task.pendingPermissions.set(requestId, resolve)
          // 权限挂起 = Runtime 暂停等待外部输入（waiting + 交互事实；ADR-034「waiting 不是普通 UI 态」）。
          // 在回调内同步迁移（permission_request 不依赖流内事件——向前兼容双通道）。问答（question）由
          // applyExecutionLifecycle 事件驱动迁移——两者最终状态语义一致（Question 卡片/权限弹窗）。
          const current = this.registry.get(task.executionId)
          if (current !== undefined && current.status === 'running') {
            task.pendingInteraction = { type: 'permission', tool }
            this.registry.setPendingInteraction(task.executionId, task.pendingInteraction)
            this.registry.transition(task.executionId, 'waiting')
          }
          this.emit(taskId, { type: 'permission_request', tool, requestId })
        }),
    })
    task.handle = handle
    // Execution Registry（ADR-034 §6.1 步 1）：start 即创建 Execution（status=running），
    // taskId → executionId 关联（taskId 保持内部实现 ID + 兼容层索引）。
    // 放在所有 fail-fast/构造之后：抛错路径不产生孤儿 Execution（任务未启动 = 无执行事实）。
    const execution = this.registry.create({
      taskId,
      sessionId: params.sessionId,
      workflowId: params.workflowId,
      stageId: params.stageId,
    })
    task.executionId = execution.id
    this.tasks.set(taskId, task)
    void this.runLoop(taskId)
    return { taskId, executionId: execution.id }
  }

  private async runLoop(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return
    try {
      for await (const ev of task.handle.events) {
        // 工具使用证据面（完成钩子合规检查）：tool_start 即记录（done emit 时 tasks 仍存活，可查询）
        if (ev.type === 'tool_start') task.usedTools.add(ev.name)
        this.forward(taskId, ev)
        this.applyExecutionLifecycle(task.executionId, ev)
      }
      this.logger.info(`agent/${taskId} 事件流结束（任务完成或放弃）`)
    } catch (err) {
      this.logger.error(`agent/${taskId} 事件循环异常：${err instanceof Error ? err.message : String(err)}`)
      // ADR-034：Execution 生命周期由 Registry 承载——异常 = 执行失败（终点态；cancel 竞态已终态则不改写）
      task.terminalKind ??= 'error'
      const execution = this.registry.get(task.executionId)
      if (execution !== undefined && !isTerminalExecutionStatus(execution.status)) {
        this.registry.transition(task.executionId, 'failed')
      }
    } finally {
      // ADR-036 Phase 2：conversation 任务（sessionId 归属且非控制平面）终点 → Frame 更新。
      // 契约 §F：焦点更新只认显式引用（refs 空 → 保留）；error/cancelled 只记 user turn。
      const isConversation =
        this.frames !== undefined &&
        task.sessionId !== undefined &&
        task.workflowId === undefined &&
        task.stageId === undefined &&
        task.terminalKind !== undefined
      if (isConversation) {
        try {
          this.frames!.updateOnExecutionTerminal({
            executionId: task.executionId,
            sessionId: task.sessionId!,
            personId: task.personId,
            refs: task.frameRefs,
            userText: task.userText,
            assistantText: task.terminalKind === 'done' ? task.finalResult : undefined,
          })
        } catch (err) {
          // Frame 是会话增强而非执行事实——更新失败不阻断任务收尾（记录，不重抛）
          this.logger.warn(`agent/${taskId} Session Frame 更新失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      this.tasks.delete(taskId)
    }
  }

  /** ADR-035 完成语义：company_research done → 契约 §I 全量机械校验（无 LLM 判断），
   *  环境输入 = 已启用通道（会话存在性）+ 预算拒绝事实（isBudgetExhausted） */
  private sufficiencyOf(taskId: string, result: string): SufficiencyValidationSummary | undefined {
    const task = this.tasks.get(taskId)
    if (task?.taskType !== 'company_research' || task.sessions === undefined) return undefined
    const s = task.sessions
    const enabled: string[] = []
    const exhausted: string[] = []
    if (s.web_search !== undefined) {
      enabled.push('web_search')
      if (s.web_search.isBudgetExhausted()) exhausted.push('web_search')
    }
    if (s.exa !== undefined) {
      enabled.push('exa')
      if (s.exa.isBudgetExhausted()) exhausted.push('exa')
    }
    if (s.nbs !== undefined || s.nbsProfile !== undefined) {
      enabled.push('nbs')
      if ((s.nbs?.isBudgetExhausted() ?? false) || (s.nbsProfile?.isBudgetExhausted() ?? false)) {
        exhausted.push('nbs')
      }
    }
    const r = validateEvidenceSufficiency({ text: result, enabledChannels: enabled, exhaustedChannels: exhausted })
    return {
      valid: r.valid,
      issues: r.issues,
      state: r.assessment?.state ?? '',
      nextAction: r.assessment?.nextAction ?? '',
    }
  }

  /**
   * Execution 生命周期（ADR-034 §1/§5.1）：运行时事件 → Registry 状态迁移。
   * question_request = 挂起等用户（waiting + 交互事实）；done = completed；error = failed。
   * permission_request 的挂起在 onPermissionRequest 回调内同步迁移（不依赖流内事件——向前兼容）。
   * 终点态守卫：cancel 后流仍可能到达剩余事件（abort 竞态）——不再迁移。
   */
  private applyExecutionLifecycle(executionId: string, ev: AgentEvent): void {
    const execution = this.registry.get(executionId)
    if (execution === undefined || isTerminalExecutionStatus(execution.status)) return
    switch (ev.type) {
      case 'question_request':
        // 交互载荷（问题文本+选项——UI 刷新后按此恢复提问卡片，模型与 permission 统一）
        this.registry.transition(executionId, 'waiting')
        this.registry.setPendingInteraction(executionId, {
          type: 'question',
          question: ev.question.question,
          options: ev.question.options.map((o) => o.label),
        })
        break
      case 'done':
        this.registry.transition(executionId, 'completed')
        break
      case 'error':
        this.registry.transition(executionId, 'failed')
        break
    }
  }

  /** adapter 事件 → WS 可传事件（permission_request 已由 onPermissionRequest 转发带 requestId 版本） */
  private forward(taskId: string, ev: AgentEvent): void {
    switch (ev.type) {
      // 不转发：start 的 onPermissionRequest 已 emit { tool, requestId } 给前端（adapter
      // yield 此事件后立即 await 该回调，一一对应；canUseTool promise 由挂起表持有）
      case 'permission_request':
        break
      case 'question_request':
        this.logger.info(`agent/${taskId} question_request：${ev.question.question}（等待用户回答，任务挂起）`)
        this.emit(taskId, { type: 'question_request', question: ev.question })
        break
      case 'done': {
        // ADR-035 完成语义：company_research → 契约 §I 全量机械校验 + 摘要载荷（done 事件 additive）
        const sufficiency = this.sufficiencyOf(taskId, ev.result)
        // ADR-036：终点事实（先到先得——cancel 竞态后到达的 done 不改写 terminalKind；契约 §D）
        const task = this.tasks.get(taskId)
        if (task !== undefined) {
          task.finalResult = ev.result
          task.terminalKind ??= 'done'
        }
        this.emit(taskId, { type: 'done', result: ev.result, ...(sufficiency !== undefined ? { sufficiency } : {}) })
        break
      }
      case 'error': {
        const task = this.tasks.get(taskId)
        if (task !== undefined) task.terminalKind ??= 'error'
        this.emit(taskId, { type: 'error', error: ev.error })
        break
      }
      case 'text_delta':
      case 'tool_start':
      case 'tool_done':
      case 'thinking_start':
      case 'thinking_delta':
      case 'thinking_stop':
        this.emit(taskId, ev)
        break
    }
  }

  answer(taskId: string, text: string): void {
    const task = this.tasks.get(taskId)
    if (!task) {
      this.logger.warn(`agent/answer 未命中任务：${taskId}（任务已结束/映射丢失——回答被丢弃）`)
      return
    }
    this.logger.info(`agent/answer：taskId=${taskId} 已送达（len=${text.length}）`)
    task.handle.answer(text)
    // 提问挂起（waiting）被回答 → 回到运行（ADR-034 状态机；answer 是 waiting→running 的驱动，
    // 与事件驱动（question_request/done/error）互补——否则回答后执行状态失真停在 waiting）
    task.pendingInteraction = undefined
    this.registry.setPendingInteraction(task.executionId, undefined)
    const execution = this.registry.get(task.executionId)
    if (execution !== undefined && execution.status === 'waiting') {
      this.registry.transition(task.executionId, 'running')
    }
  }

  /** 任务已调用工具清单（完成钩子合规检查；任务结束后返回空——done emit 时仍可查） */
  toolUsage(taskId: string): string[] {
    return [...(this.tasks.get(taskId)?.usedTools ?? [])]
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    // ADR-034 §5.1：cancel 是 Execution 语义（Registry → cancelled 终点态），AbortController 只是实现机制。
    // 幂等：任务已终态（done 竞态）→ Registry.cancel 直接返回现状，不产生新事件。
    // ADR-036 §D：cancel 终点只记 user turn（focus 不变）；先到先得，后续流事件不改写。
    task.terminalKind ??= 'cancelled'
    this.registry.cancel(task.executionId)
    task.abort.abort()
    // 挂起中的权限决策视为拒绝（解挂 SDK 回调）
    for (const resolve of task.pendingPermissions.values()) resolve(false)
    task.pendingPermissions.clear()
  }

  permission(taskId: string, requestId: string, allow: boolean): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    const resolve = task.pendingPermissions.get(requestId)
    if (resolve === undefined) return // 未知 requestId（已决策/任务结束）→ 忽略
    task.pendingPermissions.delete(requestId)
    resolve(allow)
    // 授权/拒绝完成 → 清除交互并回运行（waiting→running；与 answer 语义对称）
    task.pendingInteraction = undefined
    this.registry.setPendingInteraction(task.executionId, undefined)
    const execution = this.registry.get(task.executionId)
    if (execution !== undefined && execution.status === 'waiting') {
      this.registry.transition(task.executionId, 'running')
    }
  }

  /** ADR-034 §6.1：executionId 授权通道（刷新恢复——requestId 是引擎内存表键，刷新即丢）。
   *  一个执行同时至多一个挂起授权（流式串行）；无/多挂起 → 拒绝（不猜测，避免误授权）。 */
  permissionByExecution(executionId: string, allow: boolean): void {
    for (const [taskId, task] of this.tasks) {
      if (task.executionId !== executionId) continue
      const keys = [...task.pendingPermissions.keys()]
      if (keys.length !== 1) {
        this.logger.warn(`agent/permission 唯一挂起校验失败：execution=${executionId} 挂起数=${keys.length}——授权被拒绝`)
        return
      }
      this.permission(taskId, keys[0]!, allow)
      return
    }
    this.logger.warn(`agent/permission 未命中执行：${executionId}（任务已结束/映射丢失——授权被忽略）`)
  }

  /** 优雅关闭：中止所有活跃任务（abort → SDK close → CLI 子进程终止）+ 关闭外部 MCP 连接 */
  shutdown(): void {
    for (const taskId of [...this.tasks.keys()]) this.cancel(taskId)
    void this.exaConnector?.close()
  }
}
