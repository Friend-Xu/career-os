/**
 * Rewrite Feedback writer 单测（Phase 2B）：落盘格式 + 边界校验 fail fast。
 * 契约：docs/contracts/Resume-Feedback-Contract-v1.md
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { recordRewriteFeedback } from '../feedback/writer.ts'

test('rewrite feedback writer 落盘（apply/reject + 可选字段）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-fb-test-'))
  try {
    recordRewriteFeedback(dir, { requestId: 't1', action: 'apply', selectedTextHash: 'abcd1234' })
    recordRewriteFeedback(dir, { requestId: 't2', action: 'reject', reason: 'inaccurate_claim', standardUsed: 'mechanical.design', selectedTextHash: 'ef567890' })
    const lines = readFileSync(join(dir, 'rewrite-feedback.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.ok(lines[0].includes('"action":"apply"'))
    assert.ok(lines[0].includes('"selectedTextHash":"abcd1234"'))
    assert.ok(lines[1].includes('"reason":"inaccurate_claim"'))
    assert.ok(lines[1].includes('"standardUsed":"mechanical.design"'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rewrite feedback writer 边界校验 fail fast', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-fb-test-'))
  try {
    assert.throws(() => recordRewriteFeedback(dir, { requestId: 't', action: 'maybe', selectedTextHash: 'x' }))
    assert.throws(() => recordRewriteFeedback(dir, { requestId: 't', action: 'apply', reason: 'nonsense', selectedTextHash: 'x' }))
    assert.throws(() => recordRewriteFeedback(dir, { requestId: 't', action: 'apply' }))
    assert.throws(() => recordRewriteFeedback(dir, { action: 'apply', selectedTextHash: 'x' }))
    assert.throws(() => recordRewriteFeedback(dir, 'not-an-object'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
