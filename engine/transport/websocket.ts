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
import type { DecisionChain, DecisionRecord } from '../ir/schema.ts'
import { DecisionRuntime } from '../runtime/decision-runtime.ts'
import { METHODS, type RpcRequest, type RpcResponse, type ServerEvent } from './protocol.ts'

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

export async function startServer(opts: {
  config: EngineConfig
  workspace: Workspace
  logger: Logger
  store: BridgeStore
  runtime: DecisionRuntime
}): Promise<ServerHandle> {
  const { config, logger, store, runtime } = opts
  const { wss, port } = await listenWithRetry({ host: config.server.host, port: config.server.port, logger })

  const handlers: Record<string, () => unknown> = {
    [METHODS.init]: () => store.init(),
    [METHODS.listDecisions]: () => store.listDecisions(),
    [METHODS.rescan]: () => store.rescan(),
    [METHODS.listCompanies]: () => store.listCompanies(),
    [METHODS.listPersons]: () => store.listPersons(),
    [METHODS.poolGraph]: () => store.graph(),
    [METHODS.chain]: () => computeChains(store.listDecisions() as DecisionRecord[], runtime),
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
        respond(ws, { id: msg.id, result: handler() })
      } catch (err) {
        logger.error(`RPC ${msg.method} 失败：${err instanceof Error ? err.message : String(err)}`)
        respond(ws, { id: msg.id, error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) } })
      }
    })
  })

  logger.info(`WebSocket 桥监听 ws://${config.server.host}:${port}`)

  return {
    port,
    broadcast(event) {
      const payload = JSON.stringify(event)
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(payload)
      }
    },
  }
}
