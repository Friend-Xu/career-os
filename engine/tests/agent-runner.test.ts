import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnthropic } from '@ai-sdk/anthropic'
import { tool } from 'ai'
import { z } from 'zod'
import { createAgentRunner } from '../agent/capability/agent-runner.ts'
import { buildFsTools, FS_TOOL_META } from '../agent/tools/fs-tools.ts'
import { initWorkspace } from '../storage/workspace.ts'
import type { AgentEvent } from '../ir/agent-event.ts'
import { startFakeAnthropicServer, textTurn, toolUseTurn } from './agent/fake-anthropic-server.ts'

function tmpWorkspace() {
  return initWorkspace(mkdtempSync(join(tmpdir(), 'cos-runner-')))
}

async function collect(handle: { events: AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of handle.events) out.push(ev)
  return out
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (pred()) return
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function runnerOpts(server: { url: string }, workspace: ReturnType<typeof initWorkspace>, extra?: Record<string, unknown>) {
  return {
    task: '测试任务',
    model: createAnthropic({ apiKey: 'fake-key', baseURL: `${server.url}/anthropic` })('fake-model'),
    // Tool Assembly Layer：builtin 文件工具源（治理元数据与工具同源）
    sources: [{ tools: buildFsTools(workspace), meta: FS_TOOL_META }],
    allowedTools: ['Read', 'Write', 'Edit', 'Grep', 'Glob'],
    permissionMode: 'bypassPermissions' as const,
    ...extra,
  }
}

test('文本补全：text_delta 流 + done 全文', async () => {
  const server = await startFakeAnthropicServer([textTurn('方向探索完成')])
  const ws = tmpWorkspace()
  const handle = createAgentRunner(runnerOpts(server, ws))
  const events = await collect(handle)
  await server.close()
  const deltas = events.filter((e) => e.type === 'text_delta')
  assert.ok(deltas.length >= 1)
  assert.equal(deltas.map((e) => (e.type === 'text_delta' ? e.text : '')).join(''), '方向探索完成')
  const done = events.find((e) => e.type === 'done')
  assert.ok(done && done.type === 'done' && done.result === '方向探索完成')
})

test('工具循环：Write 落盘 + tool_start/tool_done 事件 + done', async () => {
  const server = await startFakeAnthropicServer([
    toolUseTurn('Write', { file_path: 'probe.md', content: '你好' }),
    textTurn('已写入'),
  ])
  const ws = tmpWorkspace()
  const handle = createAgentRunner(runnerOpts(server, ws))
  const events = await collect(handle)
  await server.close()
  assert.ok(events.some((e) => e.type === 'tool_start' && e.name === 'Write'), '应有 tool_start Write')
  assert.ok(events.some((e) => e.type === 'tool_done' && e.name === 'Write'), '应有 tool_done Write')
  // Tool Source 透传（T1 审计面）：事件带 source，认知面（工具名）无供应商标识
  assert.ok(events.some((e) => e.type === 'tool_start' && e.name === 'Write' && e.source === 'builtin'), 'tool_start 带 source=builtin')
  assert.ok(events.some((e) => e.type === 'tool_done' && e.name === 'Write' && e.source === 'builtin'), 'tool_done 带 source=builtin')
  assert.equal(readFileSync(join(ws.paths.root, 'probe.md'), 'utf8'), '你好')
  const done = events.find((e) => e.type === 'done')
  assert.ok(done && done.type === 'done' && done.result === '已写入')
  // 工具结果回合：第二请求应携带 tool_result
  assert.equal(server.requests.length, 2)
})

test('提问卡片：question_request 事件 + answer() 回填 + 续答 done', async () => {
  const server = await startFakeAnthropicServer([
    toolUseTurn('ask_user_question', {
      question: '选哪个方向？',
      header: '方向确认',
      options: [{ label: '机器人' }, { label: '医疗' }],
      multiSelect: false,
    }),
    textTurn('收到你的选择'),
  ])
  const ws = tmpWorkspace()
  const handle = createAgentRunner(runnerOpts(server, ws))
  const events: AgentEvent[] = []
  // 边收边入共享数组：question_request 到达时即可应答（不等流结束）
  const doneCollecting = (async () => {
    for await (const ev of handle.events) events.push(ev)
  })()
  await waitFor(() => events.some((e) => e.type === 'question_request'), 5000)
  const q = events.find((e) => e.type === 'question_request')
  assert.ok(q && q.type === 'question_request')
  assert.equal(q.question.question, '选哪个方向？')
  assert.equal(q.question.header, '方向确认')
  assert.equal(q.question.options.length, 2)
  assert.equal(q.question.multiSelect, false)
  handle.answer('机器人')
  await doneCollecting
  await server.close()
  const done = events.find((e) => e.type === 'done')
  assert.ok(done && done.type === 'done' && done.result === '收到你的选择')
})

test('ask 权限拒绝：工具不执行（文件不落盘）+ 流程继续 done', async () => {
  const server = await startFakeAnthropicServer([
    toolUseTurn('Write', { file_path: 'denied.md', content: 'x' }),
    textTurn('继续'),
  ])
  const ws = tmpWorkspace()
  const handle = createAgentRunner(
    runnerOpts(server, ws, { permissionMode: 'ask', onPermissionRequest: () => Promise.resolve(false) }),
  )
  const events = await collect(handle)
  await server.close()
  assert.equal(ws.exists('denied.md'), false)
  const done = events.find((e) => e.type === 'done')
  assert.ok(done && done.type === 'done')
})

test('取消：abort → error cancelled（fail fast，无挂死）', async () => {
  const server = await startFakeAnthropicServer([textTurn('慢回复', 3000)])
  const ws = tmpWorkspace()
  const abort = new AbortController()
  const handle = createAgentRunner(runnerOpts(server, ws, { abortController: abort }))
  setTimeout(() => abort.abort(), 50)
  const events = await collect(handle)
  await server.close()
  const err = events.find((e) => e.type === 'error')
  assert.ok(err && err.type === 'error')
  assert.equal(err.error.code, 'cancelled')
})

test('allowedTools 白名单：未列出的工具不注册（Write 不出现）', async () => {
  const server = await startFakeAnthropicServer([
    toolUseTurn('Write', { file_path: 'no.md', content: 'x' }),
    textTurn('结束'),
  ])
  const ws = tmpWorkspace()
  const handle = createAgentRunner(runnerOpts(server, ws, { allowedTools: ['Read'] }))
  const events = await collect(handle)
  await server.close()
  assert.equal(ws.exists('no.md'), false)
  assert.ok(events.every((e) => e.type !== 'tool_start' || e.name !== 'Write'))
})

test('outputBudget：预算下发 provider 请求体（max_tokens）；缺省 = 8000', async () => {
  // 显式预算：4096 → 请求体 max_tokens = 4096
  const server = await startFakeAnthropicServer([textTurn('完成')])
  const ws = tmpWorkspace()
  const handle = createAgentRunner(runnerOpts(server, ws, { outputBudget: 4096 }))
  await collect(handle)
  await server.close()
  const body = server.requests[0] as Record<string, unknown>
  assert.equal(body.max_tokens, 4096)
  // 缺省（普通过话/Stage 未挂预算）：runner 8K 默认——兼容模式 4096 截断事故的显式防线
  const server2 = await startFakeAnthropicServer([textTurn('完成')])
  const ws2 = tmpWorkspace()
  const handle2 = createAgentRunner(runnerOpts(server2, ws2))
  await collect(handle2)
  await server2.close()
  const body2 = server2.requests[0] as Record<string, unknown>
  assert.equal(body2.max_tokens, 8000)
})

test('Tool Evidence Contract：tool_done 携带装配层生产方证据（evidence 访问器 → 取即清）', async () => {
  const server = await startFakeAnthropicServer([
    toolUseTurn('Write', { file_path: 'ev.md', content: 'x' }),
    textTurn('完成'),
  ])
  const ws = tmpWorkspace()
  const sources = [
    {
      tools: buildFsTools(ws),
      meta: FS_TOOL_META,
      evidence: {
        Write: () => [{ source: 'builtin' as const, citation: 'ev://write-1', fetchedAt: '2026-01-01T00:00:00.000Z' }],
      },
    },
  ]
  const handle = createAgentRunner(runnerOpts(server, ws, { sources }))
  const events = await collect(handle)
  await server.close()
  const done = events.find((e) => e.type === 'tool_done' && e.name === 'Write')
  assert.ok(done !== undefined && done.type === 'tool_done', 'tool_done 事件存在')
  if (done !== undefined && done.type === 'tool_done') {
    assert.equal(done.source, 'builtin', 'source 透传不受 evidence 影响')
    assert.ok(done.evidence !== undefined, 'tool_done 携带 evidence')
    assert.equal(done.evidence[0].citation, 'ev://write-1')
    assert.equal(done.evidence[0].source, 'builtin')
  }
})

test('system 协议段：走 AI SDK system 通道（请求体 system 字段）', async () => {
  const server = await startFakeAnthropicServer([textTurn('OK')])
  const ws = tmpWorkspace()
  const handle = createAgentRunner(runnerOpts(server, ws, { system: '你是系统协议' }))
  await collect(handle)
  await server.close()
  const body = server.requests[0] as Record<string, unknown>
  // Anthropic 协议：system 为数组格式 [{ type: 'text', text }]
  assert.deepEqual(body.system, [{ type: 'text', text: '你是系统协议' }])
})

test('任务协议工具：taskTools 注入（白名单外亦可调用）+ 审计透传', async () => {
  const server = await startFakeAnthropicServer([
    toolUseTurn('report_done', { text: 'ok' }),
    textTurn('完成'),
  ])
  const ws = tmpWorkspace()
  const handle = createAgentRunner(
    runnerOpts(server, ws, {
      taskTools: {
        report_done: tool({
          description: '报告完成（任务协议工具）',
          inputSchema: z.object({ text: z.string() }),
          execute: async (i) => `received:${i.text}`,
        }),
      },
    }),
  )
  const events = await collect(handle)
  await server.close()
  const start = events.find((e) => e.type === 'tool_start' && e.name === 'report_done')
  assert.ok(start !== undefined, '白名单外任务工具应可调用')
  // 审计面：任务协议工具挂 builtin 源 + task 命名空间
  assert.equal(start !== undefined && start.type === 'tool_start' ? start.source : 'x', 'builtin')
  assert.equal(server.requests.length, 2, '工具结果回合已回传')
})
