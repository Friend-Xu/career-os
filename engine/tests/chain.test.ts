import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionRecord } from '../ir/schema.ts'
import { DecisionRuntime } from '../runtime/decision-runtime.ts'
import { computeChains } from '../transport/websocket.ts'

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

test('按 profile 分组：两人各自一条决策 → 两条链，按人名排序', () => {
  const chains = computeChains(
    [
      record({ id: 'd-2', skill: 'city-advisor', profile: '家人 A', createdAt: '2026-08-02' }),
      record({ id: 'd-1', skill: 'career-path', profile: '我', createdAt: '2026-08-01' }),
    ],
    runtime,
  )
  assert.deepEqual(chains.map((c) => c.person), ['家人 A', '我'])
  assert.equal(chains[0].currentStage, '方向探索') // 家人 A：城市评估 backfill，链不推进
  assert.equal(chains[1].currentStage, '转行评估')
  assert.equal(chains[1].progressedAt, '2026-08-01')
})

test('无 profile 的决策（v2.0 旧记录）不计入任何链', () => {
  const old = Object.assign(record({ id: 'd-old', skill: 'career-path', createdAt: '2026-08-01' }), { profile: undefined })
  const chains = computeChains([old], runtime)
  assert.equal(chains.length, 0)
})

test('该人全部决策 invalid → 空链被过滤（不返回）', () => {
  const chains = computeChains(
    [invalidRecord({ id: 'd-bad', skill: 'career-path', createdAt: '2026-08-01' })],
    runtime,
  )
  assert.equal(chains.length, 0)
})

test('混合合法 + invalid：返回该人链，invalid 不推进', () => {
  const chains = computeChains(
    [
      invalidRecord({ id: 'd-bad', skill: 'career-path', createdAt: '2026-08-01' }),
      record({ id: 'd-ok', skill: 'career-path', createdAt: '2026-08-02' }),
    ],
    runtime,
  )
  assert.equal(chains.length, 1)
  assert.equal(chains[0].person, '我')
  assert.equal(chains[0].currentStage, '转行评估')
  assert.equal(chains[0].progressedAt, '2026-08-02')
})

test('空集合 → 无链', () => {
  assert.deepEqual(computeChains([], runtime), [])
})
