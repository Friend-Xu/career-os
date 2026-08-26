/**
 * Session Context Store 契约测试（ADR-036 Phase 2 / 契约 §B–§D + 回归矩阵）。
 * 覆盖：首次登记 / focus 替换与保留 / turns 有界 FIFO / 单条截断 / error 路径 /
 * 无 Frame 零风险路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { SessionContextStore, truncateTurnText } from '../runtime/session-context-store.ts'
import { SESSION_FRAME_MAX_FOCUS, SESSION_FRAME_MAX_TURNS, SESSION_FRAME_MAX_TURN_TEXT } from '../ir/session-context.ts'
import type { SessionFocusRef } from '../ir/session-context.ts'

function tmpStore(): { ws: ReturnType<typeof initWorkspace>; store: SessionContextStore } {
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), 'cos-frame-')))
  return { ws, store: new SessionContextStore(ws) }
}

function refs(...items: [SessionFocusRef['type'], string, string][]): SessionFocusRef[] {
  return items.map(([type, id, label]) => ({ type, id, label }))
}

test('首次执行终止 → Frame 登记（focus 写入 + user/assistant 轮次）', () => {
  const { store } = tmpStore()
  const frame = store.updateOnExecutionTerminal({
    executionId: 'exec-1',
    sessionId: 'session-001',
    personId: 'person_001',
    refs: refs(['company', 'company_A', 'Company-A 机械工程师']),
    userText: '请分析这个 JD',
    assistantText: '已完成分析',
  })
  assert.equal(frame.sessionId, 'session-001')
  assert.equal(frame.personId, 'person_001')
  assert.equal(frame.focus.length, 1)
  assert.equal(frame.focus[0]!.id, 'company_A')
  assert.equal(frame.lastExecutionId, 'exec-1')
  assert.deepEqual(
    frame.recentTurns.map((t) => [t.role, t.text]),
    [
      ['user', '请分析这个 JD'],
      ['assistant', '已完成分析'],
    ],
  )
  // 落盘可读回（workspace 用户数据域）
  const reread = store.get('session-001')
  assert.ok(reread)
  assert.equal(reread.recentTurns.length, 2)
})

test('同话题追问（无显式引用）→ focus 保留 + 轮次追加', () => {
  const { store } = tmpStore()
  store.updateOnExecutionTerminal({
    executionId: 'exec-1',
    sessionId: 's1',
    refs: refs(['company', 'c_A', 'Company-A']),
    userText: '帮我看看这家公司',
    assistantText: '好的',
  })
  const frame = store.updateOnExecutionTerminal({
    executionId: 'exec-2',
    sessionId: 's1',
    userText: '那怎么回复 HR？',
    assistantText: '可以这样回复……',
  })
  assert.equal(frame.focus.length, 1)
  assert.equal(frame.focus[0]!.id, 'c_A')
  assert.deepEqual(
    frame.recentTurns.map((t) => [t.role, t.text]),
    [
      ['user', '帮我看看这家公司'],
      ['assistant', '好的'],
      ['user', '那怎么回复 HR？'],
      ['assistant', '可以这样回复……'],
    ],
  )
})

test('显式换对象 → focus 替换（旧对象不进 Frame）', () => {
  const { store } = tmpStore()
  store.updateOnExecutionTerminal({
    executionId: 'exec-1',
    sessionId: 's1',
    refs: refs(['company', 'c_A', 'Company-A']),
  })
  const frame = store.updateOnExecutionTerminal({
    executionId: 'exec-2',
    sessionId: 's1',
    refs: refs(['company', 'c_B', 'Company-B'], ['job', 'j_1', 'Company-B 机械工程师']),
    userText: '看看这家新公司',
  })
  assert.deepEqual(
    frame.focus.map((f) => f.id),
    ['c_B', 'j_1'],
  )
})

test('error / cancelled → focus 不变 + 仅记 user 轮次', () => {
  const { store } = tmpStore()
  store.updateOnExecutionTerminal({
    executionId: 'exec-1',
    sessionId: 's1',
    refs: refs(['job', 'j_1', 'JD-1']),
    userText: '第一轮',
  })
  const frame = store.updateOnExecutionTerminal({
    executionId: 'exec-2',
    sessionId: 's1',
    userText: '第二轮（未完成）',
  })
  assert.deepEqual(
    frame.focus.map((f) => f.id),
    ['j_1'],
  )
  assert.deepEqual(
    frame.recentTurns.map((t) => [t.role, t.text]),
    [
      ['user', '第一轮'],
      ['user', '第二轮（未完成）'],
    ],
  )
})

test('FIFO 有界：超过 MAX_TURNS 丢最旧', () => {
  const { store } = tmpStore()
  for (let i = 1; i <= SESSION_FRAME_MAX_TURNS + 2; i++) {
    store.updateOnExecutionTerminal({
      executionId: `e${i}`,
      sessionId: 's1',
      userText: `第 ${i} 轮`,
    })
  }
  const frame = store.get('s1')!
  assert.equal(frame.recentTurns.length, SESSION_FRAME_MAX_TURNS)
  assert.equal(frame.recentTurns[0]!.text, '第 3 轮')
  assert.equal(frame.recentTurns.at(-1)!.text, `第 ${SESSION_FRAME_MAX_TURNS + 2} 轮`)
})

test('focus 有界：超过 MAX_FOCUS 保留前 N 项', () => {
  const { store } = tmpStore()
  const frame = store.updateOnExecutionTerminal({
    executionId: 'e1',
    sessionId: 's1',
    refs: refs(
      ['company', 'c1', 'C1'],
      ['job', 'j1', 'J1'],
      ['resume', 'r1', 'R1'],
      ['decision', 'd1', 'D1'],
    ),
  })
  assert.equal(frame.focus.length, SESSION_FRAME_MAX_FOCUS)
  assert.deepEqual(
    frame.focus.map((f) => f.id),
    ['c1', 'j1', 'r1'],
  )
})

test('单条文本截断：保留首尾，总长 = 上限', () => {
  const long = '甲'.repeat(SESSION_FRAME_MAX_TURN_TEXT + 200)
  const out = truncateTurnText(long)
  assert.equal(out.length, SESSION_FRAME_MAX_TURN_TEXT)
  assert.ok(out.startsWith('甲'.repeat(240)))
  assert.ok(out.endsWith('甲'.repeat(258)))
  assert.ok(out.includes('……'))
})

test('空文本不写入轮次；无 Frame get → undefined（零风险路径）', () => {
  const { store } = tmpStore()
  assert.equal(store.get('never-created'), undefined)
  const frame = store.updateOnExecutionTerminal({
    executionId: 'e1',
    sessionId: 's1',
    userText: '',
    assistantText: '',
  })
  assert.equal(frame.recentTurns.length, 0)
  assert.equal(frame.focus.length, 0)
})

test('personId 更新：传入则覆盖，缺省保留', () => {
  const { store } = tmpStore()
  store.updateOnExecutionTerminal({ executionId: 'e1', sessionId: 's1', personId: 'person_001' })
  const frame = store.updateOnExecutionTerminal({ executionId: 'e2', sessionId: 's1' })
  assert.equal(frame.personId, 'person_001')
  const frame2 = store.updateOnExecutionTerminal({ executionId: 'e3', sessionId: 's1', personId: 'person_002' })
  assert.equal(frame2.personId, 'person_002')
})
