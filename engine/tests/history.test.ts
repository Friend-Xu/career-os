import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionRecord } from '../ir/schema.ts'
import { DecisionRuntime } from '../runtime/decision-runtime.ts'
import { computeHistories } from '../transport/websocket.ts'

const runtime = new DecisionRuntime()

function record(partial: Pick<DecisionRecord, 'id' | 'skill' | 'createdAt'> & Partial<DecisionRecord>): DecisionRecord {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    skill: partial.skill,
    direction: partial.direction ?? '',
    directionMatch: 80,
    directionConfidence: 'medium',
    city: partial.city ?? '',
    cityScore: 80,
    salaryFeasible: true,
    riskLevel: 'low',
    keyRisk: '',
    status: 'completed',
    profile: partial.profile ?? '我',
    summary: '',
    createdAt: partial.createdAt,
    protocolVersion: '2.1',
  }
}

function invalidRecord(partial: Pick<DecisionRecord, 'id' | 'skill' | 'createdAt'> & Partial<DecisionRecord>): DecisionRecord {
  return Object.assign(record(partial), {
    validation: { status: 'invalid' as const, issues: [{ path: 'profile', reason: '缺失', severity: 'error' as const }] },
  })
}

test('按 profile 分组：两人各自一条决策 → 两条历史，按人名排序', () => {
  const histories = computeHistories(
    [
      record({ id: 'd-2', skill: 'city-advisor', profile: '家人 A', createdAt: '2026-08-02' }),
      record({ id: 'd-1', skill: 'career-path', profile: '我', createdAt: '2026-08-01' }),
    ],
    runtime,
  )
  assert.deepEqual(histories.map((h) => h.person), ['家人 A', '我'])
  assert.deepEqual(histories[0].groups.map((g) => g.type), ['city'])
  assert.deepEqual(histories[1].groups.map((g) => g.type), ['direction'])
  assert.equal(histories[1].groups[0].updatedAt, '2026-08-01')
})

test('无 profile 的决策（v2.0 旧记录）不计入任何历史', () => {
  const old = Object.assign(record({ id: 'd-old', skill: 'career-path', createdAt: '2026-08-01' }), { profile: undefined })
  const histories = computeHistories([old], runtime)
  assert.equal(histories.length, 0)
})

test('该人全部决策 invalid → 空历史被过滤（不返回）', () => {
  const histories = computeHistories(
    [invalidRecord({ id: 'd-bad', skill: 'career-path', createdAt: '2026-08-01' })],
    runtime,
  )
  assert.equal(histories.length, 0)
})

test('混合合法 + invalid：返回该人历史，invalid 不进入', () => {
  const histories = computeHistories(
    [
      invalidRecord({ id: 'd-bad', skill: 'career-path', createdAt: '2026-08-01' }),
      record({ id: 'd-ok', skill: 'career-path', createdAt: '2026-08-02' }),
    ],
    runtime,
  )
  assert.equal(histories.length, 1)
  assert.equal(histories[0].person, '我')
  assert.deepEqual(histories[0].groups[0].decisionIds, ['d-ok'])
  assert.equal(histories[0].groups[0].updatedAt, '2026-08-02')
})

test('空集合 → 无历史', () => {
  assert.deepEqual(computeHistories([], runtime), [])
})
