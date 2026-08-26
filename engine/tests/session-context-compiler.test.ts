/**
 * Session Context Compiler 契约测试（ADR-036 Phase 3 / 契约 §C——编译顺序与零风险路径）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionContextSection } from '../agent/context/session-context-compiler.ts'
import type { SessionContextFrame } from '../ir/session-context.ts'

function frame(partial: Partial<SessionContextFrame>): SessionContextFrame {
  return {
    sessionId: 's1',
    focus: [{ type: 'company', id: 'c1', label: 'Company-A' }],
    recentTurns: [{ role: 'user', text: '帮我看看这家公司', at: '2026-08-26T00:00:00.000Z' }],
    updatedAt: '2026-08-26T00:00:00.000Z',
    ...partial,
  }
}

test('无 Frame → 空字符串（零风险路径：行为与现状一致）', () => {
  assert.equal(buildSessionContextSection({ inheritFocus: true }), '')
})

test('空 Frame（无 focus 无轮次）→ 空字符串', () => {
  assert.equal(buildSessionContextSection({ frame: frame({ focus: [], recentTurns: [] }), inheritFocus: true }), '')
})

test('无显式引用 → 继承 focus + recentTurns 双段（focus 标注非权威）', () => {
  const out = buildSessionContextSection({ frame: frame({}), inheritFocus: true })
  assert.ok(out.includes('## 会话上下文（引擎装配）'))
  assert.ok(out.includes('【会话焦点（继承自会话——非本轮确认依据，提示性语境）】'))
  assert.ok(out.includes('- Company-A（company c1）'))
  assert.ok(out.includes('【最近对话（原始摘录）】'))
  assert.ok(out.includes('User: 帮我看看这家公司'))
})

test('有显式引用 → focus 不继承（权威优先），recentTurns 仍注入', () => {
  const out = buildSessionContextSection({ frame: frame({}), inheritFocus: false })
  assert.ok(!out.includes('继承自会话'))
  assert.ok(!out.includes('Company-A'))
  assert.ok(out.includes('User: 帮我看看这家公司'))
})

test('多轮次按序呈现（原始文本，非摘要）', () => {
  const f = frame({
    recentTurns: [
      { role: 'user', text: '这个公司团队很小', at: 't1' },
      { role: 'assistant', text: '是的，规模会影响保障', at: 't2' },
      { role: 'user', text: '那怎么回复 HR？', at: 't3' },
    ],
  })
  const out = buildSessionContextSection({ frame: f, inheritFocus: true })
  const userIdx = out.indexOf('User: 这个公司团队很小')
  const asstIdx = out.indexOf('Assistant: 是的，规模会影响保障')
  const user2Idx = out.indexOf('User: 那怎么回复 HR？')
  assert.ok(userIdx >= 0 && asstIdx > userIdx && user2Idx > asstIdx)
})
