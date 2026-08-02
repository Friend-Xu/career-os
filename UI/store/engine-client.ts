/**
 * 引擎客户端（WS 桥）：RPC + 事件订阅 + 离线降级。
 * - 契约：engine/transport/protocol.ts（RPC 请求/响应 + ServerEvent）
 * - 事件是通知，状态是可拉的资源：data.* 事件只作信号，数据一律 RPC 拉取
 * - 离线：连接失败/断开 → status 'offline' + 指数退避重连；UI 在 offline 时保持
 *   mock 数据行为（渐进替换，不假死）
 */
import type {
  CompanyRecord,
  DecisionAggregate,
  DecisionChain,
  DecisionRecord,
  GapResult,
  Person,
  PoolEdge,
  PoolNode,
  Role,
  Skill,
  Validation,
} from '../../engine/ir/schema.ts'
import { EVENTS, METHODS } from '../../engine/transport/protocol.ts'

export type EngineStatus = 'connecting' | 'connected' | 'offline'

export interface InitResult {
  protocol: string
  version: string
  workspace: string
  serverTime: string
}

export type DecisionView = DecisionRecord & { validation?: Validation }

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
        this.emit(msg.event, msg.data)
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

  listChains(): Promise<DecisionChain[]> {
    return this.rpc<DecisionChain[]>(METHODS.chain)
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

  listCompanies(): Promise<(CompanyRecord & { validation?: Validation })[]> {
    return this.rpc<(CompanyRecord & { validation?: Validation })[]>(METHODS.listCompanies)
  }

  listPersons(): Promise<Person[]> {
    return this.rpc<Person[]>(METHODS.listPersons)
  }

  poolGraph(): Promise<GraphResult> {
    return this.rpc<GraphResult>(METHODS.poolGraph)
  }
}

export { EVENTS }
export { METHODS }

export function createEngineClient(url = 'ws://127.0.0.1:5289'): EngineClient {
  return new EngineClient(url)
}
