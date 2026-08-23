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
import { DEFAULT_SEARCH_BUDGET, DEFAULT_SEARCH_CACHE_TTL_MINUTES } from '../config.ts'
import type { AgentHandle, AgentEvent } from '../ir/agent-event.ts'
import type { AgentRuntimeEvent } from '../ir/schema.ts'
import type { Logger } from '../logger.ts'
import type { Workspace } from '../storage/workspace.ts'
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
 */
export function buildToolSources(opts: BuildSourcesOptions): ToolSourceDef[] {
  const { defaults } = opts
  // 托管检索（hosted）：预算/缓存/证据会话（证据 = Tool Evidence Contract 生产方）
  const searchSession = createSearchSession({
    provider: { baseUrl: opts.baseUrl ?? '', apiKey: opts.apiKey, model: opts.model, mode: defaults.webSearchMode ?? 'responses' },
    budget: defaults.searchBudget ?? DEFAULT_SEARCH_BUDGET,
    cacheTtlMs: (defaults.searchCacheTtlMinutes ?? DEFAULT_SEARCH_CACHE_TTL_MINUTES) * 60_000,
    cache: opts.searchCache,
    logger: opts.logger,
  })
  // Exa（mcp）：证据按认知层工具名分桶（WebResearch/WebFetch 各自归属）；
  // 行业证据模板（QueryIndustryEvidence）独立会话（预算/缓存互不挤占，证据独立标签）
  const exaSession = opts.exaConnector?.ready === true
    ? createExaSession({ connector: opts.exaConnector, budget: EXA_SESSION_BUDGET, cacheTtlMs: EXA_CACHE_TTL_MINUTES * 60_000, cache: opts.exaCache, logger: opts.logger })
    : null
  const industrySession = opts.exaConnector?.ready === true
    ? createExaSession({
        connector: opts.exaConnector,
        budget: EXA_SESSION_BUDGET,
        cacheTtlMs: EXA_CACHE_TTL_MINUTES * 60_000,
        cache: opts.exaCache,
        logger: opts.logger,
        evidenceLabels: { web_search_exa: 'QueryIndustryEvidence', web_fetch_exa: 'WebFetch' },
      })
    : null
  // NBS（data）：两个治理会话（单查询/画像），共用连接器；证据各自归属
  const nbsTools = opts.nbsConnector === undefined ? null : {
    session: createNbsSession({
      connector: opts.nbsConnector,
      budget: NBS_SESSION_BUDGET,
      cacheTtlMs: NBS_CACHE_TTL_MINUTES * 60_000,
      cache: opts.nbsCache,
      logger: opts.logger,
    }),
    profileSession: createNbsProfileSession({
      connector: opts.nbsConnector,
      budget: NBS_PROFILE_SESSION_MAX_REQUESTS,
      cacheTtlMs: NBS_CACHE_TTL_MINUTES * 60_000,
      cache: opts.nbsCache,
      logger: opts.logger,
    }),
    connector: opts.nbsConnector,
  }
  return [
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
  ]
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
  resumeSessionId?: string
  /** 当前分析对象——系统事实，注入任务上下文；决策产物继承此归属（ADR-014） */
  personId?: string
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
}

interface TaskState {
  handle: AgentHandle
  abort: AbortController
  sessionId?: string
  pendingPermissions: Map<string, (ok: boolean) => void>
}

export class AgentRuntime {
  private tasks = new Map<string, TaskState>()
  private permissionSeq = 0
  private logger: Logger
  private emit: (taskId: string, ev: AgentRuntimeEvent) => void
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

  constructor(
    logger: Logger,
    emit: (taskId: string, ev: AgentRuntimeEvent) => void,
    exaConnector?: ExaConnector,
    nbsConnector?: NbsConnector,
  ) {
    this.logger = logger
    this.emit = emit
    this.exaConnector = exaConnector
    this.nbsConnector = nbsConnector
  }

  start(params: AgentStartParams, defaults: AgentDefaults, workspace: Workspace): string {
    const taskId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const abort = new AbortController()
    const task: TaskState = { handle: undefined as unknown as AgentHandle, abort, pendingPermissions: new Map() }
    const apiKey = params.apiKey ?? defaults.apiKey
    const baseUrl = params.baseUrl ?? defaults.baseUrl
    const model = params.model ?? defaults.model
    // 系统边界 fail fast（ADR-030 Step 6）：直连是唯一路径——无凭证/无模型直接拒绝启动
    if (!apiKey) throw new Error('未配置已启用的服务商（apiKey）——请在设置页添加并启用服务商后再试')
    if (!model) throw new Error('服务商未登记模型——请在设置页勾选模型后再试')

    // 工具来源组装（Tool Assembly Layer）：独立函数 buildToolSources（单测覆盖源组合；
    // websocket → AgentRuntime 的 connector 传参属接线层，真机验收覆盖）
    const sources = buildToolSources({
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
    const handle = createAgentRunner({
      task: params.task,
      context: params.context,
      model: resolveLanguageModel({ apiKey, baseUrl, model, validModels: [model], credentialSource: 'config' }).model,
      sources,
      allowedTools: params.allowedTools ?? defaults.allowedTools,
      stageTools: params.stageTools,
      permissionMode: params.permissionMode ?? defaults.permissionMode,
      maxTurns: params.maxTurns ?? defaults.maxTurns,
      outputBudget: params.outputBudget,
      abortController: abort,
      logger: this.logger,
      onPermissionRequest: (tool) =>
        new Promise<boolean>((resolve) => {
          const requestId = `p-${++this.permissionSeq}`
          task.pendingPermissions.set(requestId, resolve)
          this.emit(taskId, { type: 'permission_request', tool, requestId })
        }),
    })
    task.handle = handle
    this.tasks.set(taskId, task)
    void this.runLoop(taskId)
    return taskId
  }

  private async runLoop(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return
    try {
      for await (const ev of task.handle.events) {
        this.forward(taskId, ev)
      }
    } catch (err) {
      this.logger.error(`agent/${taskId} 事件循环异常：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.tasks.delete(taskId)
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
        this.emit(taskId, { type: 'question_request', question: ev.question })
        break
      case 'done':
        this.emit(taskId, { type: 'done', result: ev.result })
        break
      case 'error':
        this.emit(taskId, { type: 'error', error: ev.error })
        break
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
    this.tasks.get(taskId)?.handle.answer(text)
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
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
  }

  /** 优雅关闭：中止所有活跃任务（abort → SDK close → CLI 子进程终止）+ 关闭外部 MCP 连接 */
  shutdown(): void {
    for (const taskId of [...this.tasks.keys()]) this.cancel(taskId)
    void this.exaConnector?.close()
  }
}
