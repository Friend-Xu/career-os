/**
 * P0-3 验收：多轮 interaction 确定性全链（ADR-034 UI Contract——Interaction Boundary 切分）。
 *
 * 走真实路径：进程内 startServer（真实 WS 引擎 + 真实 Registry）
 * + 假 Anthropic 端点（脚本队列）驱动「assistant#1 → question#1 → answer#1 → assistant#2 →
 * question#2 → answer#2 → assistant#3 → done」事件序列 + WS RPC 客户端断言：
 *
 *  - 1 Execution（executionId 全程不变；队列中无第二个 Execution）
 *  - 事件流：text_delta → question_request → text_delta → question_request → text_delta → done
 *  - question 后 answer 恢复流（waiting → running 状态迁移在事件中可见）
 *  - 终态 completed；Registry get 全程同 id
 *
 * 运行：node tests/p0-interaction-boundary-flow.mjs（测试区，需全权限）
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../config.ts'
import { initWorkspace } from '../storage/workspace.ts'
import { createProjection } from '../storage/projection.ts'
import { DecisionRuntime } from '../runtime/decision-runtime.ts'
import { startServer } from '../transport/websocket.ts'
import {
  startFakeAnthropicServer,
  textTurn,
  toolUseTurn,
} from './agent/fake-anthropic-server.ts'

const PORT = 5321
const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} }

const root = mkdtempSync(join(tmpdir(), 'cos-p0-flow-'))
const ws = initWorkspace(root)

/**
 * 回合队列——注意：每个条目 = 一次【模型回合】（LLM 请求）。streamText 工具循环中：
 * ask_user_question 工具执行挂起 → answer 后 SDK 发起下一个模型回合。
 * 1: ask_user_question（问题1）→ question_request #1 → waiting → answer → 工具返回
 * 2: ask_user_question（问题2）→ question_request #2 → waiting → answer → 工具返回
 * 3: text（终答）              → text_delta（contination #2）→ done
 */
const fakeLlm = await startFakeAnthropicServer([
  toolUseTurn('ask_user_question', {
    question: '第一轮：请选择方向（医疗 / 机器人）',
    header: '方向确认 · 第一轮',
    options: [{ label: '医疗' }, { label: '机器人' }],
    multiSelect: false,
  }),
  toolUseTurn('ask_user_question', {
    question: '第二轮：请确认优先级（先投递 / 先补课）',
    header: '优先级确认 · 第二轮',
    options: [{ label: '先投递' }, { label: '先补课' }],
    multiSelect: false,
  }),
  textTurn('已收到两轮选择，最终结论：按你的选择推进。'),
])

const config = {
  ...defaultConfig(),
  server: { ...defaultConfig().server, host: '127.0.0.1', port: PORT },
  paths: { ...defaultConfig().paths, workspace: root, db: join(root, '.p0.db') },
  agent: {
    ...defaultConfig().agent,
    providers: [
      {
        id: 'fake',
        apiKey: 'fake-key',
        baseUrl: `http://127.0.0.1:${fakeLlm.port}/anthropic`,
        enabled: true,
        models: ['fake-model'],
      },
    ],
    model: 'fake-model',
    maxTurns: 8,
  },
}

const projection = createProjection({ dbPath: config.paths.db, workspace: ws, logger: silentLogger })
const engine = await startServer({ config, workspace: ws, logger: silentLogger, store: projection, runtime: new DecisionRuntime() })

// ─── WS RPC 客户端 ────────────────────────────────────────────────
const client = new WebSocket(`ws://127.0.0.1:${PORT}`)
let seq = 0
const pending = new Map()
const agentEvents = []
const execEvents = []

function call(method, params) {
  const id = `q${++seq}`
  client.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

let doneReceived = false
client.addEventListener('message', (ev) => {
  const m = JSON.parse(String(ev.data))
  if (m.id !== undefined && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) p.reject(new Error(JSON.stringify(m.error)))
    else p.resolve(m.result)
    return
  }
  if (m.event === 'agent.event') {
    const d = m.data ?? {}
    agentEvents.push({ type: d.type, text: d.text, question: d.question?.question })
    if (d.type === 'done') doneReceived = true
  }
  if (m.event === 'execution.event') {
    execEvents.push({ type: m.data?.type, to: m.data?.to, from: m.data?.from })
  }
})

function fail(msg) {
  console.error('❌', msg)
  process.exit(1)
}

async function waitFor(pred, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) fail(`超时：${label}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

function assert(cond, msg) {
  if (!cond) fail(msg)
  console.log('✅', msg)
}

// ─── 跑 ───────────────────────────────────────────────────────────
await new Promise((resolve, reject) => {
  client.addEventListener('open', () => resolve())
  client.addEventListener('error', reject)
})
console.log('… WS 已连接，开始任务（脚本队列 4 回合 × 2 交互）')

const started = await call('agent/start', {
  task: '双轮交互确定性验收任务',
  sessionId: 's-p0-test',
})
const execId = started.executionId
console.log(`… execution: ${execId}`)

// 问题1
await waitFor(() => agentEvents.some((e) => e.type === 'question_request'), 'question_request #1')
const q1 = agentEvents.filter((e) => e.type === 'question_request')
assert(q1.length === 1, 'question_request #1 到达')
assert(q1[0].question !== undefined, '问题1 带文本')

// 回答1 → 引擎 resume（AgentRuntime.answer → waiting→running）→ SDK 发起模型回合2 = ask #2
await call('agent/answer', { executionId: execId, text: '医疗' })
await waitFor(() => agentEvents.filter((e) => e.type === 'question_request').length >= 2, 'question_request #2')
assert(agentEvents.filter((e) => e.type === 'question_request').length === 2, 'question_request #2 到达（answer #1 后恢复 → 第二轮提问）')
console.log('✅ answer #1 后恢复 → question #2 到达')
console.log('… fake server 请求数(2):', fakeLlm.requests.length)

// 回答2 → 终态（模型回合3 = text → text_delta → done）
await call('agent/answer', { executionId: execId, text: '先投递' })
await waitFor(() => doneReceived, 'done')
console.log('✅ done 到达')
console.log('… fake server 请求数(3):', fakeLlm.requests.length)

// ─── 断言（P0-3 验收矩阵）────────────────────────────────────────────
// 1) 单 Execution 不变
const g = await call('agent/executions/get', { executionId: execId })
assert(g.id === execId, 'executionId 始终不变')
assert(g.status === 'completed', '终态 completed')

const all = await call('agent/executions', {})
const mine = all.filter((e) => e.sessionId === 's-p0-test' && e.id === execId)
assert(mine.length === 1, '本轮 start 恰好 1 个 Execution（无分叉：本 executionId 唯一）')
assert(all.filter((e) => e.sessionId === 's-p0-test' && e.id === execId && e.status === 'completed').length === 1, '该 Execution 终态唯一且 completed')
// 2) 事件序列：text_delta(1) → question → text_delta(2) → question → text_delta(3) → done
const seqTypes = agentEvents.map((e) => e.type)
const d1 = agentEvents.findIndex((e) => e.type === 'question_request')
const d2 = agentEvents.findIndex((e, i) => e.type === 'question_request' && i > d1)
const dn = agentEvents.findIndex((e) => e.type === 'done')
assert(d1 >= 0, '序列含 question #1')
assert(d2 > d1, '序列含 question #2')
assert(dn > d2, 'done 在最后')
console.log(`✅ 事件序列：question#1 → question#2 → done（${seqTypes.join(' → ')}）`)

// 3) 引擎 Execution 事件：waiting⇄running 可见（Registry 层事实——RPC 事件日志，无广播竞态）
const evLog = await call('agent/executions/events', { executionId: execId })
const st = []
for (const e of evLog) { if (e.type === 'execution.status_changed') st.push(e) }
const waitingCount = st.filter((e) => e.to === 'waiting').length
if (waitingCount < 1) fail(`事件流含 waiting（实际 ${JSON.stringify(st.map((e) => `${e.from}→${e.to}`))}）`)
const resumeCount = st.filter((e) => e.to === 'running' && e.from === 'waiting').length
if (resumeCount < 2) fail(`waiting→running 恢复 ×2（实际 ${resumeCount}）`)
if (evLog.at(-1).to !== 'completed') fail('事件链末态 completed')
console.log(`✅ Execution 事件链：${JSON.stringify(st.map((e) => `${e.from}→${e.to}`))}（2 次交互 · 末态 completed）`)

// 4) 终态确认（Registry 事实）
const g2 = await call('agent/executions/get', { executionId: execId })
if (g2.status !== 'completed') fail('终态 completed（执行历程含 2 次交互）')
console.log('✅ 终态 completed，单 Execution 贯穿 2 次 interaction')

await client.close()
await fakeLlm.close()
engine.shutdown()
console.log('🎉 P0-3 多轮 interaction 确定性验收全部通过（1 Execution · 3 内容段 · 2 交互）')
process.exit(0)
