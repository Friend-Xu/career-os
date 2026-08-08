/**
 * application-registry：投递行动记录登记（ADR-019 + Application Contract v0.1）。
 * - 存储：applications/{id}.json——Application 是用户事件状态资产（Engine 单方读写，
 *   Agent 禁止创建/推进），非 Agent 协作文档，故不用 md 摘要表协议
 * - 能力：create / get / list / updateStatus / linkDecision / delete（用户撤销）
 * - 明确不做：自动生成（JD 建档不产生 Application）、watcher、followup、interview
 * - 引用规则：只持 jobId（岗位唯一事实源），不复制岗位信息；SUBMITTED 时从 Job 登记
 *   displayFallback（仅 Job 删除后历史展示用）
 */
import type { ApplicationRecord, ApplicationStatus, ApplicationView, CreateApplicationRequest } from '../ir/schema.ts'
import { APPLICATION_STATUSES } from '../ir/validator.ts'
import { scanJobs } from './job-watcher.ts'
import type { Workspace } from './workspace.ts'

const STATUS_SET = new Set<string>(APPLICATION_STATUSES)

/**
 * 状态跃迁表（Step 3.3 边界：禁止跳变——PREPARING→OFFERED 等跳转会破坏行动事实）。
 * - 前向相邻推进（PREPARING 可直接 → SUBMITTED：READY 是可选中间态）
 * - REJECTED 仅从投出后（SUBMITTED 起）进入（公司拒绝对内部准备态无意义）
 * - WITHDRAWN 任何状态可入（主动停止，历史保留）；REJECTED/WITHDRAWN 为终态
 */
export const APPLICATION_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  PREPARING: ['READY', 'SUBMITTED', 'WITHDRAWN'],
  READY: ['SUBMITTED', 'WITHDRAWN'],
  SUBMITTED: ['COMMUNICATING', 'INTERVIEWING', 'REJECTED', 'WITHDRAWN'],
  COMMUNICATING: ['INTERVIEWING', 'REJECTED', 'WITHDRAWN'],
  INTERVIEWING: ['OFFERED', 'REJECTED', 'WITHDRAWN'],
  OFFERED: ['REJECTED', 'WITHDRAWN'],
  REJECTED: [],
  WITHDRAWN: [],
}

/** 状态跃迁校验（确定性：current → next 必须 ∈ 迁移表；非法迁移抛错，UI 无法破坏事实） */
export function transitionApplicationStatus(current: ApplicationStatus, next: ApplicationStatus): void {
  if (current === next) return
  if (!STATUS_SET.has(current) || !STATUS_SET.has(next)) throw new Error(`非法投递状态：${JSON.stringify(next)}`)
  if (!APPLICATION_TRANSITIONS[current].includes(next)) {
    throw new Error(`非法状态跃迁：${current} → ${next}`)
  }
}

/** 记录 → RPC 视图（allowedTransitions = 状态机合法推进选项——UI 只展示合法跃迁，不复制状态机） */
export function applicationView(record: ApplicationRecord): ApplicationView {
  return { ...record, allowedTransitions: APPLICATION_TRANSITIONS[record.status] }
}

/** 系统 ID 生成：application_{YYYYMMDD}_{NNNNN}（当日最大序号 +1——按序号非数量，
 *  防删除空洞导致 ID 复用覆盖旧文件；跨日归零；单进程个人工具无需锁） */
export function nextApplicationId(ws: Workspace, now: Date): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `application_${day}_`
  let max = 0
  for (const f of ws.listJson('applications')) {
    if (!f.startsWith(prefix)) continue
    const n = parseInt(f.slice(prefix.length, -5), 10)
    if (!Number.isNaN(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(5, '0')}`
}

function readApplication(ws: Workspace, id: string): ApplicationRecord {
  const rel = `applications/${id}.json`
  if (!ws.exists(rel)) throw new Error(`投递记录不存在：${id}`)
  return JSON.parse(ws.read(rel)) as ApplicationRecord
}

function writeApplication(ws: Workspace, record: ApplicationRecord): void {
  ws.write(`applications/${record.id}.json`, JSON.stringify(record, null, 2) + '\n')
}

/** 投递记录 id 合法性（RPC 边界：路径安全校验，同 deleteJobFile 模式） */
function assertSafeId(id: string): void {
  if (!/^application_\d{8}_\d{5}$/.test(id)) throw new Error(`非法投递记录 id：${JSON.stringify(id)}`)
}

/**
 * 创建投递记录（用户「开始投递流程」事件——createdBy 恒为 'user'，Agent 禁止创建）。
 * - jobId 必须指向存在的 Job（引用有效 = 系统边界校验；Job 是岗位唯一事实源）
 * - status 初始 = PREPARING（进入投递准备流程，不自动 SUBMITTED）
 */
export function createApplication(ws: Workspace, params: CreateApplicationRequest, now: Date = new Date()): ApplicationRecord {
  const job = scanJobs(ws).find((j) => j.record.id === params.jobId)
  if (!job) throw new Error(`岗位不存在：${params.jobId}`)
  const record: ApplicationRecord = {
    id: nextApplicationId(ws, now),
    personId: params.personId,
    jobId: params.jobId,
    status: 'PREPARING',
    createdAt: now.toISOString(),
    ...(params.decisionId ? { decisionId: params.decisionId } : {}),
  }
  writeApplication(ws, record)
  return record
}

export function getApplication(ws: Workspace, id: string): ApplicationRecord {
  assertSafeId(id)
  return readApplication(ws, id)
}

export function listApplications(ws: Workspace): ApplicationRecord[] {
  if (!ws.exists('applications')) return []
  return ws
    .listJson('applications')
    .sort()
    .map((f) => JSON.parse(ws.read(`applications/${f}`)) as ApplicationRecord)
}

/**
 * 推进投递状态（用户确认——Agent 不得调用；SUBMITTED = 用户「我已提交」）。
 * - 状态跃迁校验（Step 3.3）：current → next 必须 ∈ 迁移表，禁止跳变/倒退/终态再动
 * - SUBMITTED 时登记 submittedAt + displayFallback（从当前 Job 快照公司/岗位名，
 *   仅 Job 删除后历史展示用；已登记则保留首次值）
 */
export function updateApplicationStatus(
  ws: Workspace,
  id: string,
  status: ApplicationStatus,
  now: Date = new Date(),
): ApplicationRecord {
  assertSafeId(id)
  const record = readApplication(ws, id)
  transitionApplicationStatus(record.status, status)
  const updated: ApplicationRecord = { ...record, status }
  if (status === 'SUBMITTED') {
    const job = scanJobs(ws).find((j) => j.record.id === record.jobId)
    if (!job) throw new Error(`岗位不存在：${record.jobId}（Job 已删除则不能推进到 SUBMITTED——displayFallback 需当时快照）`)
    updated.submittedAt = record.submittedAt ?? now.toISOString()
    updated.displayFallback = record.displayFallback ?? { company: job.record.company, position: job.record.title }
  }
  writeApplication(ws, updated)
  return updated
}

/** 关联决策（Decision → Application 创建时的引用登记；decisionId 可选，不编造关联） */
export function linkApplicationDecision(ws: Workspace, id: string, decisionId: string): ApplicationRecord {
  assertSafeId(id)
  if (!/^decision_\d{8}_\d{5}$/.test(decisionId)) throw new Error(`非法决策 id：${JSON.stringify(decisionId)}`)
  const record = readApplication(ws, id)
  const updated: ApplicationRecord = { ...record, decisionId }
  writeApplication(ws, updated)
  return updated
}

/**
 * 删除投递记录（Step 3.5：Application 是用户行动历史，非物理删除优先）。
 * - 仅 PREPARING（无任何事件）允许物理删除——撤销误操作
 * - 其他状态 → 拒绝：历史事实不可消失，用户应推进 WITHDRAWN（历史保留）
 */
export function deleteApplication(ws: Workspace, id: string): void {
  assertSafeId(id)
  const record = readApplication(ws, id)
  if (record.status !== 'PREPARING') {
    throw new Error(`投递记录「${id}」已处于 ${record.status}——行动历史不可删除，请推进 WITHDRAWN（撤回，历史保留）`)
  }
  ws.delete(`applications/${id}.json`)
}
