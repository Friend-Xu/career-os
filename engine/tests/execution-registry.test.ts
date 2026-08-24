import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ExecutionRegistry } from '../runtime/execution-registry.ts'
import { isTerminalExecutionStatus, type Execution, type ExecutionEvent } from '../ir/execution.ts'
import type { Logger } from '../logger.ts'

function makeLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {}, trace() {} }
}

/** union 缩窄：status_changed 事件（事件序列断言用） */
function statusChanged(ev: ExecutionEvent): ev is Extract<ExecutionEvent, { type: 'execution.status_changed' }> {
  return ev.type === 'execution.status_changed'
}

/** ADR-034 §2.1 红线守卫：Execution 身份字段清单（冻结版——不得扩展业务字段） */
const ADR034_IDENTITY_FIELDS = ['createdAt', 'id', 'startedAt', 'status', 'taskId']

test('create：身份生成 + 状态 running + startedAt=createdAt（ADR-034 §2.1/§2.2）', () => {
  const registry = new ExecutionRegistry(makeLogger())
  const execution = registry.create({ taskId: 't-100' })

  assert.match(execution.id, /^execution_\d+_[a-z0-9]+$/)
  assert.equal(execution.status, 'running')
  assert.equal(execution.startedAt, execution.createdAt)
  assert.equal(execution.finishedAt, undefined)
  // 红线守卫：无 sessionId/workflowId/stageId 时对象不含业务/多余字段（ADR §2.1 冻结字段集）
  assert.deepEqual(Object.keys(execution).sort(), [...ADR034_IDENTITY_FIELDS].sort())
  // taskId 仍是内部实现 ID（兼容索引），executionId 才是 public identity
  assert.equal(registry.get(execution.id), execution)
  assert.equal(registry.getByTaskId('t-100'), execution)
  assert.equal(registry.getByTaskId('t-404'), undefined)
})

test('create：Interaction/Domain provenance 可选归属（ADR-034 §1.6）', () => {
  const registry = new ExecutionRegistry(makeLogger())
  const execution = registry.create({
    taskId: 't-101',
    sessionId: 's-1',
    workflowId: 'workflow_20260824_00001',
    stageId: 'fact_collection',
  })
  assert.equal(execution.sessionId, 's-1')
  assert.equal(execution.workflowId, 'workflow_20260824_00001')
  assert.equal(execution.stageId, 'fact_collection')
  // 不传 provenance = 字段缺省（Workflow 触发可无 sessionId——ADR §1.6）
  const bare = registry.create({ taskId: 't-102' })
  assert.equal(bare.sessionId, undefined)
  assert.equal(bare.workflowId, undefined)
  assert.equal(bare.stageId, undefined)
})

test('query：过滤维度 = Runtime 事实（status/sessionId/workflowId）+ 最新在前', async () => {
  const registry = new ExecutionRegistry(makeLogger())
  const a = registry.create({ taskId: 't-1', sessionId: 's-a' })
  await new Promise((r) => setTimeout(r, 2))
  const b = registry.create({ taskId: 't-2', sessionId: 's-b', workflowId: 'workflow_20260824_00001' })
  await new Promise((r) => setTimeout(r, 2))
  const c = registry.create({ taskId: 't-3', sessionId: 's-a', workflowId: 'workflow_20260824_00001' })
  registry.cancel(c.id) // 制造一个终态

  const all = registry.query()
  assert.equal(all.length, 3)
  // 降序（createdAt 非增；同 ms 允许相等——stable）
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].createdAt >= all[i].createdAt)

  assert.deepEqual(registry.query({ status: 'running' }).map((e) => e.id).sort(), [a.id, b.id].sort())
  assert.deepEqual(registry.query({ status: 'cancelled' }).map((e) => e.id), [c.id])
  assert.deepEqual(registry.query({ sessionId: 's-a' }).map((e) => e.id).sort(), [a.id, c.id].sort())
  assert.deepEqual(
    registry.query({ workflowId: 'workflow_20260824_00001' }).map((e) => e.id).sort(),
    [b.id, c.id].sort(),
  )
  assert.deepEqual(registry.query({ sessionId: 's-b', status: 'running' }).map((e) => e.id), [b.id])
})

test('transition：running → waiting → running → completed 全链路 + finishedAt + 事件序列', () => {
  const registry = new ExecutionRegistry(makeLogger())
  const execution = registry.create({ taskId: 't-20' })

  const waiting = registry.transition(execution.id, 'waiting')
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.finishedAt, undefined)

  const resumed = registry.transition(execution.id, 'running')
  assert.equal(resumed.status, 'running')

  const done = registry.transition(execution.id, 'completed')
  assert.equal(done.status, 'completed')
  assert.ok(done.finishedAt !== undefined)

  const events = registry.events({ executionId: execution.id })
  assert.deepEqual(
    events.map((e) => e.type === 'execution.status_changed' ? `${e.from}->${e.to}` : e.type),
    ['execution.created', 'running->waiting', 'waiting->running', 'running->completed'],
  )
  // 全局事件日志 = 同一序列（本用例只此一个 execution）
  assert.equal(registry.events().length, events.length)
})

test('transition：非法迁移拒绝（终点态不可逆/同态迁移/未知 id）', () => {
  const registry = new ExecutionRegistry(makeLogger())
  const execution = registry.create({ taskId: 't-21' })
  registry.transition(execution.id, 'completed')

  assert.throws(() => registry.transition(execution.id, 'running'), /非法状态迁移.*completed → running/)
  assert.throws(() => registry.transition(execution.id, 'cancelled'), /非法状态迁移.*completed → cancelled/)
  // 同态迁移非法（running → running 不存在于迁移表）
  const fresh = registry.create({ taskId: 't-22' })
  assert.throws(() => registry.transition(fresh.id, 'running'), /非法状态迁移.*running → running/)
  assert.throws(() => registry.transition('execution_nonexistent', 'failed'), /不存在/)
})

test('cancel：running/waiting → cancelled 终点态；幂等（重试安全）；未知抛错', () => {
  const registry = new ExecutionRegistry(makeLogger())
  const running = registry.create({ taskId: 't-30' })
  const waiting = registry.create({ taskId: 't-31' })
  registry.transition(waiting.id, 'waiting')

  assert.equal(registry.cancel(running.id).status, 'cancelled')
  assert.equal(registry.cancel(waiting.id).status, 'cancelled')
  assert.ok(running.finishedAt !== undefined)

  // 幂等：已终态再 cancel → 现状返回、无新事件
  const before = registry.events().length
  const again = registry.cancel(running.id)
  assert.equal(again.status, 'cancelled')
  assert.equal(registry.events().length, before)

  assert.throws(() => registry.cancel('execution_nonexistent'), /不存在/)
})

test('events：append-only 且按 executionId 过滤（Phase 2 events RPC 来源）', () => {
  const registry = new ExecutionRegistry(makeLogger())
  const a = registry.create({ taskId: 't-40', sessionId: 's-a' })
  registry.transition(a.id, 'completed')
  const b = registry.create({ taskId: 't-41' })
  registry.cancel(b.id)

  const aEvents = registry.events({ executionId: a.id })
  const bEvents = registry.events({ executionId: b.id })
  assert.equal(aEvents.length, 2) // created + status_changed
  assert.equal(bEvents.length, 2)
  assert.deepEqual(aEvents.map((e) => e.type), ['execution.created', 'execution.status_changed'])
  const aLast = aEvents[1]
  const bLast = bEvents[1]
  assert.ok(statusChanged(aLast))
  assert.ok(statusChanged(bLast))
  assert.equal(aLast.to, 'completed')
  assert.equal(bLast.to, 'cancelled')
  assert.equal(registry.events().length, 4) // 全局 append-only 无覆盖
})

test('subscribe：事件增量通知 + unsubscribe 生效', () => {
  const registry = new ExecutionRegistry(makeLogger())
  const seen: string[] = []
  const unsubscribe = registry.subscribe((ev) => seen.push(ev.type))
  const execution = registry.create({ taskId: 't-50' })
  registry.transition(execution.id, 'waiting')
  registry.transition(execution.id, 'running')
  assert.deepEqual(seen, ['execution.created', 'execution.status_changed', 'execution.status_changed'])

  unsubscribe()
  registry.transition(execution.id, 'completed')
  assert.equal(seen.length, 3) // unsubscribe 后不再收
})

test('多会话并行（ADR-034 §1.1 核心场景）：平级独立 Executions，取消互不影响', () => {
  const registry = new ExecutionRegistry(makeLogger())
  const a = registry.create({ taskId: 't-a', sessionId: 's-a' })
  const b = registry.create({ taskId: 't-b', sessionId: 's-b' })
  const c = registry.create({ taskId: 't-c', sessionId: 's-c' })

  registry.cancel(b.id) // cancel(B)，A/C 不受影响
  const aAfter = registry.get(a.id)
  const cAfter = registry.get(c.id)
  assert.equal(aAfter?.status, 'running')
  assert.equal(cAfter?.status, 'running')
  assert.equal(registry.get(b.id)?.status, 'cancelled')

  // 各自状态可独立查询（UI 重连投影重建的 Query 面）
  assert.deepEqual(registry.query({ sessionId: 's-a' }).map((e) => e.status), ['running'])
  assert.deepEqual(registry.query({ sessionId: 's-b' }).map((e) => e.status), ['cancelled'])
})

test('isTerminalExecutionStatus：终点态判定', () => {
  assert.equal(isTerminalExecutionStatus('running'), false)
  assert.equal(isTerminalExecutionStatus('waiting'), false)
  assert.equal(isTerminalExecutionStatus('completed'), true)
  assert.equal(isTerminalExecutionStatus('failed'), true)
  assert.equal(isTerminalExecutionStatus('cancelled'), true)
})

test('红线：Execution 不携带业务字段（personId/companyId/score/recommendation/artifactContent）', () => {
  const registry = new ExecutionRegistry(makeLogger())
  const execution: Execution = registry.create({
    taskId: 't-90',
    sessionId: 's-x',
    workflowId: 'workflow_20260824_00001',
    stageId: 'direction_exploration',
  })
  const forbidden = ['personId', 'companyId', 'assessment', 'score', 'recommendation', 'artifactContent']
  for (const key of forbidden) {
    assert.equal(key in execution, false, `Execution 不得携带业务字段 ${key}（ADR-034 红线）`)
  }
})
