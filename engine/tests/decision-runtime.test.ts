import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionRecord } from '../ir/schema.ts'
import {
  DECISION_TYPE_ORDER,
  DecisionRuntime,
  decisionTypeOf,
  type DecisionType,
} from '../runtime/decision-runtime.ts'

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
    validation: { status: 'invalid' as const, issues: [{ path: 'skill', reason: '缺表', severity: 'error' as const }] },
  })
}

function degradedRecord(partial: Pick<DecisionRecord, 'id' | 'skill' | 'createdAt'> & Partial<DecisionRecord>): DecisionRecord {
  return Object.assign(record(partial), {
    validation: { status: 'degraded' as const, issues: [{ path: 'cityScore', reason: '越界', severity: 'warn' as const }] },
  })
}

const runtime = new DecisionRuntime()

test('空决策：groups 为空（无任何类型输出）', () => {
  const history = runtime.computeHistory([], '我')
  assert.deepEqual(history.groups, [])
  assert.equal(history.person, '我')
})

test('方向探索决策：direction 组（label/decisionIds/updatedAt）', () => {
  const history = runtime.computeHistory(
    [record({ id: 'd-1', skill: 'career-path', createdAt: '2026-08-01' })],
    '我',
  )
  assert.equal(history.groups.length, 1)
  const g = history.groups[0]!
  assert.equal(g.type, 'direction')
  assert.equal(g.label, '方向探索')
  assert.deepEqual(g.decisionIds, ['d-1'])
  assert.equal(g.updatedAt, '2026-08-01')
})

test('多种类型决策：按固定顺序输出已有类型，无决策类型不输出', () => {
  const decisions = [
    record({ id: 'd-1', skill: 'jd-analysis', createdAt: '2026-08-01' }),
    record({ id: 'd-2', skill: 'city-advisor', createdAt: '2026-08-02' }),
    record({ id: 'd-3', skill: 'career-path', createdAt: '2026-08-03' }),
  ]
  const history = runtime.computeHistory(decisions, '我')
  assert.deepEqual(
    history.groups.map((g) => g.type),
    ['direction', 'city', 'jd'],
  )
  // 固定顺序 = DECISION_TYPE_ORDER 过滤
  assert.deepEqual(
    history.groups.map((g) => g.type),
    DECISION_TYPE_ORDER.filter((t) => t !== 'company' && t !== 'resume'),
  )
})

test('同类型多条决策：decisionIds 收集 + updatedAt 取最近', () => {
  const history = runtime.computeHistory(
    [
      record({ id: 'd-1', skill: 'career-path', createdAt: '2026-08-01' }),
      record({ id: 'd-2', skill: 'direction-explore', createdAt: '2026-08-02' }),
    ],
    '我',
  )
  const g = history.groups[0]!
  assert.deepEqual(g.decisionIds, ['d-1', 'd-2'])
  assert.equal(g.updatedAt, '2026-08-02')
})

test('direction/city 随最新决策更新：非空值合并，部分更新不覆盖', () => {
  const history = runtime.computeHistory(
    [
      record({ id: 'd-1', skill: 'career-path', direction: '机器人', city: '深圳', createdAt: '2026-08-01' }),
      record({ id: 'd-2', skill: 'direction-explore', direction: '机器人研发', createdAt: '2026-08-02' }),
    ],
    '我',
  )
  const g = history.groups[0]!
  assert.equal(g.direction, '机器人研发') // 最新决策更新 direction
  assert.equal(g.city, '深圳') // 最新决策无 city，保留前值
})

test('invalid 决策不进入历史；不影响同类型合法决策', () => {
  const onlyInvalid = runtime.computeHistory(
    [invalidRecord({ id: 'd-bad', skill: 'career-path', createdAt: '2026-08-01' })],
    '我',
  )
  assert.deepEqual(onlyInvalid.groups, [])

  const mixed = runtime.computeHistory(
    [
      invalidRecord({ id: 'd-bad', skill: 'career-path', createdAt: '2026-08-01' }),
      record({ id: 'd-ok', skill: 'career-path', createdAt: '2026-08-02' }),
    ],
    '我',
  )
  assert.deepEqual(mixed.groups[0]!.decisionIds, ['d-ok'])
  assert.equal(mixed.groups[0]!.updatedAt, '2026-08-02')
})

test('degraded 决策参与历史（仅 invalid 排除）', () => {
  const history = runtime.computeHistory(
    [degradedRecord({ id: 'd-1', skill: 'career-path', createdAt: '2026-08-01' })],
    '我',
  )
  assert.deepEqual(history.groups[0]!.decisionIds, ['d-1'])
})

test('按人隔离：两人各自历史互不影响', () => {
  const decisions = [
    record({ id: 'd-1', skill: 'career-path', profile: '我', createdAt: '2026-08-01' }),
    record({ id: 'd-2', skill: 'city-advisor', profile: '家人 A', createdAt: '2026-08-02' }),
  ]
  const a = runtime.computeHistory(decisions, '我')
  const b = runtime.computeHistory(decisions, '家人 A')
  assert.deepEqual(a.groups.map((g) => g.type), ['direction'])
  assert.deepEqual(b.groups.map((g) => g.type), ['city'])
})

test('decisionTypeOf：规范名精确映射（career-transition 并入 direction）', () => {
  const expected: [string, DecisionType][] = [
    ['career-path', 'direction'],
    ['career-transition', 'direction'],
    ['city-advisor', 'city'],
    ['company-screener', 'company'],
    ['jd-analysis', 'jd'],
    ['resume-writing', 'resume'],
  ]
  for (const [skill, type] of expected) assert.equal(decisionTypeOf(skill), type)
})

test('decisionTypeOf：原型变体关键词推断 + 未命中归入 direction', () => {
  assert.equal(decisionTypeOf('direction-explore'), 'direction')
  assert.equal(decisionTypeOf('transfer-eval'), 'direction')
  assert.equal(decisionTypeOf('city-eval'), 'city')
  assert.equal(decisionTypeOf('city-compare'), 'city')
  assert.equal(decisionTypeOf('resume'), 'resume')
  assert.equal(decisionTypeOf('城市对比'), 'city')
  assert.equal(decisionTypeOf('unknown-skill'), 'direction')
  assert.equal(decisionTypeOf(undefined), 'direction')
  assert.equal(decisionTypeOf(''), 'direction')
})
