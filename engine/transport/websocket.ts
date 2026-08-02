/**
 * WebSocket 桥（第 3 步）：RPC 分派 + 事件广播。
 * - 契约：protocol.ts 定稿（RpcRequest/RpcResponse/ServerEvent + METHODS/EVENTS），严格按此实现
 * - 权限：仅本机回环（个人使用；监听地址 = config.server.host，另拒绝非回环远端）
 * - 分派失败：未注册方法 → method_not_found；非 RPC 帧 → invalid_request；处理器异常 → internal_error
 * - 广播：ServerEvent 单帧发给所有连接客户端（事件是通知，状态走 RPC 拉取）
 */
import { WebSocketServer, type WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { EngineConfig } from '../config.ts'
import type { Workspace } from '../storage/workspace.ts'
import type { Logger } from '../logger.ts'
import { METHODS, type RpcRequest, type RpcResponse, type ServerEvent } from './protocol.ts'

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

export async function startServer(opts: {
  config: EngineConfig
  workspace: Workspace
  logger: Logger
  store: BridgeStore
}): Promise<ServerHandle> {
  const { config, logger, store } = opts
  const wss = new WebSocketServer({ host: config.server.host, port: config.server.port })

  const handlers: Record<string, () => unknown> = {
    [METHODS.init]: () => store.init(),
    [METHODS.listDecisions]: () => store.listDecisions(),
    [METHODS.rescan]: () => store.rescan(),
    [METHODS.listCompanies]: () => store.listCompanies(),
    [METHODS.listPersons]: () => store.listPersons(),
    [METHODS.poolGraph]: () => store.graph(),
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

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve())
    wss.once('error', (err) => reject(err))
  })

  const port = (wss.address() as { port: number }).port
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
