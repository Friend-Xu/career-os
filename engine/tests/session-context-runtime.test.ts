/**
 * AgentRuntime × Session Context Store 接线测试（ADR-036 Phase 2——契约 §D 更新时机 +
 * §A 适用边界 + 回归矩阵「workflow_stage 不碰 Frame」「无 Frame = 现有行为」）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { AgentRuntime } from '../runtime/agent-runtime.ts'
import { ExecutionRegistry } from '../runtime/execution-registry.ts'
import { SessionContextStore } from '../runtime/session-context-store.ts'
import type { AgentRuntimeEvent } from '../ir/schema.ts'
import type { Logger } from '../logger.ts'
import { startFakeAnthropicServer, textTurn } from './agent/fake-anthropic-server.ts'

function makeLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {}, trace() {} } as unknown as Logger
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (pred()) return
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const DEFAULTS = { permissionMode: 'acceptEdits' as const, allowedTools: [] as string[] }

function harness(ws: ReturnType<typeof initWorkspace>) {
  const events: AgentRuntimeEvent[] = []
  const registry = new ExecutionRegistry(makeLogger())
  const store = new SessionContextStore(ws)
  const rt = new AgentRuntime(makeLogger(), (_taskId, ev) => { events.push(ev) }, registry, undefined, undefined, store)
  return { events, registry, store, rt }
}

test('conversation 任务 done → Frame 落盘（显式引用 → focus；user/assistant → recentTurns）', async () => {
  const server = await startFakeAnthropicServer([textTurn('这是回答')])
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), 'cos-rt-')))
  const { rt, store, events } = harness(ws)
  rt.start(
    {
      task: '分析 Company-A',
      sessionId: 'sess-1',
      personId: 'person_001',
      resolvedFocus: [{ type: 'company', id: 'c1', label: 'Company-A' }],
      apiKey: 'fake-key',
      model: 'fake-model',
      baseUrl: `${server.url}/anthropic`,
    },
    DEFAULTS,
    ws,
  )
  await waitFor(() => events.some((e) => e.type === 'done'))
  await waitFor(() => store.get('sess-1') !== undefined)
  await server.close()
  const frame = store.get('sess-1')!
  assert.deepEqual(
    frame.focus.map((f) => f.id),
    ['c1'],
  )
  assert.deepEqual(
    frame.recentTurns.map((t) => [t.role, t.text]),
    [
      ['user', '分析 Company-A'],
      ['assistant', '这是回答'],
    ],
  )
  assert.equal(frame.personId, 'person_001')
})

test('无 sessionId（Workflow 触发）→ 不写 Frame（零侵入）', async () => {
  const server = await startFakeAnthropicServer([textTurn('ok')])
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), 'cos-rt-')))
  const { rt, store, events } = harness(ws)
  const { executionId } = rt.start(
    {
      task: '控制平面任务',
      apiKey: 'fake-key',
      model: 'fake-model',
      baseUrl: `${server.url}/anthropic`,
    },
    DEFAULTS,
    ws,
  )
  await waitFor(() => events.some((e) => e.type === 'done'))
  await waitFor(() => store.get('sess-x') === undefined && events.length > 0)
  await server.close()
  // 任务真实完成（Registry 终态），但 Frame 未创建
  assert.ok(executionId.length > 0)
  assert.equal(store.get('sess-x'), undefined)
})

test('控制平面（sessionId + workflowId/stageId）→ 不读不写 Frame（契约 §A）', async () => {
  const server = await startFakeAnthropicServer([textTurn('stage 完成')])
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), 'cos-rt-')))
  const { rt, store, events } = harness(ws)
  rt.start(
    {
      task: 'Stage 任务',
      sessionId: 'sess-2',
      workflowId: 'workflow-001',
      stageId: 'direction_exploration',
      resolvedFocus: [{ type: 'company', id: 'c1', label: 'Company-A' }],
      apiKey: 'fake-key',
      model: 'fake-model',
      baseUrl: `${server.url}/anthropic`,
    },
    DEFAULTS,
    ws,
  )
  await waitFor(() => events.some((e) => e.type === 'done'))
  // 流结束后再给 finally 留出窗口
  await new Promise((r) => setTimeout(r, 100))
  await server.close()
  assert.equal(store.get('sess-2'), undefined)
})

test('编译注入：预置 Frame + 无显式引用 → system 含焦点继承 + 原始对话（契约 §C.1）', async () => {
  // 第一轮：写入 Frame（显式引用 → focus；对话 → recentTurns）
  const server = await startFakeAnthropicServer([textTurn('第一轮完成')])
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), 'cos-rt-')))
  const { rt, store, events } = harness(ws)
  rt.start(
    {
      task: '帮我看看这家公司',
      sessionId: 'sess-3',
      resolvedFocus: [{ type: 'company', id: 'c1', label: 'Company-A' }],
      apiKey: 'fake-key',
      model: 'fake-model',
      baseUrl: `${server.url}/anthropic`,
    },
    DEFAULTS,
    ws,
  )
  await waitFor(() => store.get('sess-3') !== undefined)
  const server2 = await startFakeAnthropicServer([textTurn('第二轮完成')])
  rt.start(
    {
      task: '那怎么回复 HR？',
      sessionId: 'sess-3',
      apiKey: 'fake-key',
      model: 'fake-model',
      baseUrl: `${server2.url}/anthropic`,
    },
    DEFAULTS,
    ws,
  )
  await waitFor(() => events.filter((e) => e.type === 'done').length >= 2)
  await server.close()
  await server2.close()
  const body = JSON.stringify(server2.requests[0])
  assert.ok(body.includes('会话上下文（引擎装配）'), 'system 应含会话上下文段')
  assert.ok(body.includes('继承自会话'), '无显式引用时应继承 focus')
  assert.ok(body.includes('Company-A'), 'focus 继承应带对象名')
  assert.ok(body.includes('User: 帮我看看这家公司'), '原始对话应注入')
})

test('编译注入：有显式引用 → 不继承 focus（权威优先），原始对话仍注入（契约 §C.1）', async () => {
  const server = await startFakeAnthropicServer([textTurn('第一轮完成')])
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), 'cos-rt-')))
  const { rt, store, events } = harness(ws)
  rt.start(
    {
      task: '分析 Company-A',
      sessionId: 'sess-4',
      resolvedFocus: [{ type: 'company', id: 'c1', label: 'Company-A' }],
      apiKey: 'fake-key',
      model: 'fake-model',
      baseUrl: `${server.url}/anthropic`,
    },
    DEFAULTS,
    ws,
  )
  await waitFor(() => store.get('sess-4') !== undefined)
  const server2 = await startFakeAnthropicServer([textTurn('完成')])
  rt.start(
    {
      task: '换成 Company-B 再来一次',
      sessionId: 'sess-4',
      resolvedFocus: [{ type: 'company', id: 'c2', label: 'Company-B' }],
      apiKey: 'fake-key',
      model: 'fake-model',
      baseUrl: `${server2.url}/anthropic`,
    },
    DEFAULTS,
    ws,
  )
  await waitFor(() => events.filter((e) => e.type === 'done').length >= 2)
  await server.close()
  await server2.close()
  const body = JSON.stringify(server2.requests[0])
  assert.ok(body.includes('会话上下文（引擎装配）'))
  assert.ok(!body.includes('继承自会话'), '有显式引用时不得继承 focus')
  assert.ok(body.includes('User: 分析 Company-A'), '原始对话仍注入')
})

test('编译注入：无 Frame → 不注入会话段（零风险路径）', async () => {
  const server = await startFakeAnthropicServer([textTurn('你好')])
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), 'cos-rt-')))
  const { rt, events } = harness(ws)
  rt.start(
    {
      task: '全新的会话',
      sessionId: 'sess-5',
      apiKey: 'fake-key',
      model: 'fake-model',
      baseUrl: `${server.url}/anthropic`,
    },
    DEFAULTS,
    ws,
  )
  await waitFor(() => events.some((e) => e.type === 'done'))
  await server.close()
  assert.ok(!JSON.stringify(server.requests[0]).includes('会话上下文（引擎装配）'))
})
