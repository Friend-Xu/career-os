import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEventLog } from '../runtime/execution-event-log.ts'
import { ExecutionRegistry } from '../runtime/execution-registry.ts'
import type { ExecutionEvent } from '../ir/execution.ts'
import type { Logger } from '../logger.ts'

function makeLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {}, trace() {} }
}

function makeLogPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-exec-log-'))
  return join(dir, name)
}

test('execute event log：append + replay 往返（eventId 自洽）', () => {
  const path = makeLogPath('a.jsonl')
  const log = new ExecutionEventLog({ filePath: path, logger: makeLogger() })
  const ev1: ExecutionEvent = {
    type: 'execution.created',
    eventId: 'evt-1',
    executionId: 'execution_1',
    taskId: 't-1',
    status: 'running',
    at: '2026-08-24T00:00:00.000Z',
  }
  const ev2: ExecutionEvent = {
    type: 'execution.status_changed',
    eventId: 'evt-2',
    executionId: 'execution_1',
    from: 'running',
    to: 'completed',
    at: '2026-08-24T00:00:01.000Z',
    resultRefs: ['DIR-20260824_00001'],
  }
  log.append(ev1)
  log.append(ev2)

  // 文件内容 = 两行 JSON
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '')
  assert.equal(lines.length, 2)
  // 重新打开（模拟重启）→ replay 自洽还原
  const log2 = new ExecutionEventLog({ filePath: path, logger: makeLogger() })
  const all = log2.all()
  assert.equal(all.length, 2)
  assert.deepEqual(all[0], ev1)
  assert.deepEqual(all[1], ev2)
  rmSync(path, { force: true })
})

test('event log：非末行损坏 → 跳过 + 显式警告；末行截断 → 丢弃（不静默吞历史）', () => {
  const path = makeLogPath('b.jsonl')
  // 构造：行1 合法 created；行2 损坏（非法 JSON）；行3 截断（无 \n 的半个 JSON）
  const valid = JSON.stringify({
    type: 'execution.created',
    eventId: 'evt-1',
    executionId: 'execution_2',
    taskId: 't-2',
    status: 'running',
    at: '2026-08-24T00:00:00.000Z',
  })
  writeFileSync(path, `${valid}\n{broken json\n{"type":"execution.`, 'utf8')
  const warnings: string[] = []
  const logger: Logger = { debug() {}, info() {}, warn(m: string) { warnings.push(m) }, error() {}, trace() {} }
  const log = new ExecutionEventLog({ filePath: path, logger })
  assert.equal(log.all().length, 1) // 只留下合法行
  assert.ok(warnings.length >= 2, '损坏行与截断行都应显式警告') // 非末行损坏 + 末行截断
  rmSync(path, { force: true })
})

test('registry × event log：mutation 双写 → 重启 replay 重建 → 非终态 reconcile → failed(process_restart)', () => {
  const path = makeLogPath('c.jsonl')
  const logger = makeLogger()

  // 第一进程：注入 adapter 的 Registry——create/transition/cancel 全部落 JSONL
  const reg1 = new ExecutionRegistry(logger, new ExecutionEventLog({ filePath: path, logger }))
  const done = reg1.create({ taskId: 't-a', workflowId: 'workflow_20260824_00001', stageId: 'direction_exploration' })
  reg1.setResultRefs(done.id, ['DIR-20260824_00009'])
  reg1.transition(done.id, 'completed')
  const running = reg1.create({ taskId: 't-b', sessionId: 's-b' }) // 未完成（模拟崩溃时的活跃执行）

  // 模拟进程重启：同文件新 Registry → replay
  const reg2 = new ExecutionRegistry(logger, new ExecutionEventLog({ filePath: path, logger }))
  const g1 = reg2.get(done.id)
  assert.equal(g1?.status, 'completed')
  assert.deepEqual(g1?.resultRefs, ['DIR-20260824_00009']) // resultRefs 随事件快照恢复
  assert.equal(reg2.get(running.id)?.status, 'running') // 重建而非复活（TaskState 不存在）

  // 重启调和：非终态 → failed（note=process_restart）
  const reconciled = reg2.reconcileAfterStartup()
  assert.equal(reconciled.length, 1)
  assert.equal(reg2.get(running.id)?.status, 'failed')
  // reconcile 也落 JSONL（事件连续——第三次打开仍可见完整链）
  const reg3 = new ExecutionRegistry(logger, new ExecutionEventLog({ filePath: path, logger }))
  const events = reg3.events({ executionId: running.id })
  assert.deepEqual(
    events.map((e) => (e.type === 'execution.status_changed' ? `${e.from}->${e.to}${e.note ?? ''}` : e.type)),
    ['execution.created', 'running->failedprocess_restart'],
  )
  assert.equal(reg3.get(done.id)?.status, 'completed') // 历史保留不串
  rmSync(path, { force: true })
})

test('registry × event log：非法迁移事件 replay 跳过（容错不静默）', () => {
  const path = makeLogPath('d.jsonl')
  const logger = makeLogger()
  const reg1 = new ExecutionRegistry(logger, new ExecutionEventLog({ filePath: path, logger }))
  const e = reg1.create({ taskId: 't-c' })
  reg1.transition(e.id, 'completed')
  // 手工追加一条非法事件（completed → running——状态机不允许）
  const filePath = path
  const raw = readFileSync(filePath, 'utf8')
  writeFileSync(
    filePath,
    raw + JSON.stringify({
      type: 'execution.status_changed',
      eventId: 'evt-bad',
      executionId: e.id,
      from: 'completed',
      to: 'running',
      at: '2026-08-24T00:00:02.000Z',
    }) + '\n',
    'utf8',
  )
  const reg2 = new ExecutionRegistry(logger, new ExecutionEventLog({ filePath: path, logger }))
  assert.equal(reg2.get(e.id)?.status, 'completed') // 非法事件未生效
  rmSync(filePath, { force: true })
})
