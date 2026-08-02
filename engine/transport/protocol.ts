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

/** 服务端 → 客户端：单向事件（数据变更信号） */
export interface ServerEvent {
  event: string
  data?: unknown
}

export const METHODS = {
  /** 握手：返回协议/版本/工作区路径 */
  init: 'system/init',
  /** 全量决策记录（含 validation 标记） */
  listDecisions: 'decisions/list',
  /** 触发一次全量重扫描（md → IR） */
  rescan: 'decisions/rescan',
  /** 决策链投影（按人分组的 computeChain 派生视图，6 阶段状态机） */
  chain: 'decisions/chain',
  /** 公司档案列表（完整 CompanyRecord，含 validation 标记） */
  listCompanies: 'companies/list',
  /** 人列表（投影） */
  listPersons: 'persons/list',
  /** 信息池图谱（PoolNode[] + PoolEdge[]，由 decisions/companies/profiles 派生） */
  poolGraph: 'pool/graph',
} as const

export const EVENTS = {
  /** decisions/ 目录变更后推送（不含数据，客户端用 decisions/list 拉快照） */
  decisionsChanged: 'data.decisions.changed',
  poolChanged: 'data.pool.changed',
  engineError: 'error.engine',
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
