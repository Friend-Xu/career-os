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
import type { EngineConfig } from '../config.ts'
import type { Workspace } from '../storage/workspace.ts'
import type { Logger } from '../logger.ts'
import type { DecisionAggregate, DecisionChain, DecisionRecord, GapResult } from '../ir/schema.ts'
import { DecisionRuntime } from '../runtime/decision-runtime.ts'
import { AgentRuntime, type AgentStartParams } from '../runtime/agent-runtime.ts'
import { buildAggregates } from '../runtime/decision-aggregate.ts'
import { computeGap } from '../runtime/gap-calculator.ts'
import { scanContexts } from '../storage/context-watcher.ts'
import { scanKnowledge } from '../storage/knowledge-watcher.ts'
import { scanProfiles } from '../storage/projection.ts'
import { METHODS, EVENTS, type RpcRequest, type RpcResponse, type ServerEvent } from './protocol.ts'

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
 * decisions/chain 处理器派生：listDecisions() 按 profile 分组 → 每人对该人决策调 computeChain。
 * 空链过滤：computeChain 内部已排除 invalid 决策（Validation.status === 'invalid'），
 * 链上无 completed 阶段即该人无合法决策（无进展）→ 不返回。
 */
export function computeChains(decisions: DecisionRecord[], runtime: DecisionRuntime): DecisionChain[] {
  const byPerson = new Map<string, DecisionRecord[]>()
  for (const d of decisions) {
    if (!d.profile) continue // v2.0 旧记录无 profile，无法归属人
    const list = byPerson.get(d.profile)
    if (list) list.push(d)
    else byPerson.set(d.profile, [d])
  }
  const chains: DecisionChain[] = []
  for (const person of [...byPerson.keys()].sort()) {
    const chain = runtime.computeChain(byPerson.get(person)!, person)
    if (chain.stages.some((s) => s.status === 'completed')) chains.push(chain)
  }
  return chains
}

/** contexts/list 处理器派生：context 目录扫描 + 决策投影 → 按 context 组装聚合（纯函数，不落盘） */
export function listContexts(workspace: Workspace, store: BridgeStore): DecisionAggregate[] {
  return buildAggregates(scanContexts(workspace), store.listDecisions() as DecisionRecord[])
}

/** knowledge/gap 处理器派生：roleId 找 Role + person 找画像技能声明 → computeGap（纯派生，不落盘） */
export function computeKnowledgeGap(workspace: Workspace, params: { person: string; roleId: string }): GapResult {
  const { skills, roles } = scanKnowledge(workspace)
  const role = roles.find((r) => r.id === params.roleId)
  if (!role) throw new Error(`角色不存在：${params.roleId}`)
  const personSkills = scanProfiles(workspace).find((p) => p.name === params.person)?.skills ?? []
  return computeGap({ role, person: params.person, personSkills, skills })
}

/** knowledge/gap 入参校验（RPC 边界：用户输入校验，fail fast） */
function gapParams(v: unknown): { person: string; roleId: string } {
  if (typeof v !== 'object' || v === null) throw new Error('knowledge/gap 需要 params { person, roleId }')
  const p = v as Record<string, unknown>
  if (typeof p.person !== 'string' || p.person.length === 0) throw new Error('params.person 缺失（画像名）')
  if (typeof p.roleId !== 'string' || p.roleId.length === 0) throw new Error('params.roleId 缺失（岗位 id）')
  return { person: p.person, roleId: p.roleId }
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
  if (p.context !== undefined) {
    if (typeof p.context !== 'string') throw new Error('params.context 应为字符串')
    out.context = p.context
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
  return out
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
  const agentRuntime = new AgentRuntime(logger, (taskId, ev) => {
    broadcast({ event: EVENTS.agentEvent, taskId, data: ev })
  })

  const handlers: Record<string, (params?: unknown) => unknown> = {
    [METHODS.init]: () => store.init(),
    [METHODS.listDecisions]: () => store.listDecisions(),
    [METHODS.rescan]: () => store.rescan(),
    [METHODS.listCompanies]: () => store.listCompanies(),
    [METHODS.listPersons]: () => store.listPersons(),
    [METHODS.poolGraph]: () => store.graph(),
    [METHODS.chain]: () => computeChains(store.listDecisions() as DecisionRecord[], runtime),
    [METHODS.contexts]: () => listContexts(workspace, store),
    [METHODS.knowledgeGraph]: () => scanKnowledge(workspace),
    [METHODS.knowledgeGap]: (params) => computeKnowledgeGap(workspace, gapParams(params)),
    [METHODS.agentStart]: (params) => ({
      taskId: agentRuntime.start(agentStartParams(params), {
        permissionMode: config.agent.permissionMode,
        allowedTools: config.agent.allowedTools,
        maxTurns: config.agent.maxTurns,
        model: config.agent.model,
      }, workspace.paths.root),
    }),
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
      try {
        respond(ws, { id: msg.id, result: handler(msg.params) })
      } catch (err) {
        logger.error(`RPC ${msg.method} 失败：${err instanceof Error ? err.message : String(err)}`)
        respond(ws, { id: msg.id, error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) } })
      }
    })
  })

  logger.info(`WebSocket 桥监听 ws://${config.server.host}:${port}`)

  return { port, broadcast }
}
