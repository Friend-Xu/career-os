import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionRecord } from '../ir/schema.ts'
import {
  DecisionRuntime,
  stageOfSkill,
  stageProgressed,
  STAGE_ORDER,
  type StageId,
} from '../runtime/decision-runtime.ts'

const ALL_STAGES: readonly StageId[] = ['方向探索', '转行评估', '城市评估', '公司筛选', 'JD分析', '简历定制']
const CANONICAL_SKILLS = [
  'career-path',
  'career-transition',
  'city-advisor',
  'company-screener',
  'jd-analysis',
  'resume-writing',
]

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

test('空决策：6 阶段全 pending、方向探索 current、progressedAt 空', () => {
  const chain = runtime.computeChain([], '我')
  assert.deepEqual(chain.stages.map((s) => s.status), ['current', 'pending', 'pending', 'pending', 'pending', 'pending'])
  assert.equal(chain.currentStage, '方向探索')
  assert.equal(chain.progressedAt, '')
  assert.equal(chain.person, '我')
})

test('方向探索决策：方向探索 completed、转行评估 current', () => {
  const chain = runtime.computeChain(
    [record({ id: 'd-1', skill: 'career-path', createdAt: '2026-08-01' })],
    '我',
  )
  assert.deepEqual(chain.stages.map((s) => s.status), ['completed', 'current', 'pending', 'pending', 'pending', 'pending'])
  assert.equal(chain.currentStage, '转行评估')
  assert.equal(chain.progressedAt, '2026-08-01')
})

test('顺序写入 6 阶段决策：全部 completed、终态 currentStage 停在简历定制', () => {
  const decisions = CANONICAL_SKILLS.map((skill, i) =>
    record({ id: `d-${i}`, skill, createdAt: `2026-08-0${i + 1}` }),
  )
  const chain = runtime.computeChain(decisions, '我')
  assert.deepEqual(chain.stages.map((s) => s.status), ALL_STAGES.map(() => 'completed'))
  assert.equal(chain.currentStage, '简历定制')
  assert.equal(chain.progressedAt, '2026-08-06')
})

test('跳阶段（先写城市评估）：城市评估 backfill completed，链不推进（方向探索仍 current）', () => {
  const chain = runtime.computeChain(
    [record({ id: 'd-1', skill: 'city-advisor', createdAt: '2026-08-01' })],
    '我',
  )
  assert.deepEqual(chain.stages.map((s) => s.status), ['current', 'pending', 'completed', 'pending', 'pending', 'pending'])
  assert.equal(chain.currentStage, '方向探索')
})

test('跳阶段后的线性推进：补齐方向/转行后 current 依次越过已 backfill 阶段', () => {
  const chain = runtime.computeChain(
    [
      record({ id: 'd-1', skill: 'city-advisor', createdAt: '2026-08-01' }),
      record({ id: 'd-2', skill: 'career-path', createdAt: '2026-08-02' }),
      record({ id: 'd-3', skill: 'career-transition', createdAt: '2026-08-03' }),
    ],
    '我',
  )
  assert.deepEqual(chain.stages.map((s) => s.status), ['completed', 'completed', 'completed', 'current', 'pending', 'pending'])
  assert.equal(chain.currentStage, '公司筛选')
  assert.equal(chain.progressedAt, '2026-08-03')
})

test('多阶段决策混合（方向 + 城市，原型变体 skill）：链正确 + 参数挂当前阶段', () => {
  const chain = runtime.computeChain(
    [
      record({ id: 'd-1', skill: 'direction-explore', direction: '机器人', city: '深圳', createdAt: '2026-08-01' }),
      record({ id: 'd-2', skill: 'city-eval', direction: '机器人', city: '苏州', createdAt: '2026-08-02' }),
    ],
    '我',
  )
  assert.deepEqual(chain.stages.map((s) => s.status), ['completed', 'current', 'completed', 'pending', 'pending', 'pending'])
  assert.equal(chain.currentStage, '转行评估')
  const current = chain.stages.find((s) => s.stage === chain.currentStage)!
  assert.equal(current.direction, '机器人')
  assert.equal(current.city, '苏州')
  assert.equal(chain.progressedAt, '2026-08-02')
})

test('direction/city 随最新决策更新：非空值合并，部分更新不覆盖', () => {
  const chain = runtime.computeChain(
    [
      record({ id: 'd-1', skill: 'career-path', direction: '机器人', city: '深圳', createdAt: '2026-08-01' }),
      record({ id: 'd-2', skill: 'career-transition', direction: '机器人研发', createdAt: '2026-08-02' }),
    ],
    '我',
  )
  const current = chain.stages.find((s) => s.stage === chain.currentStage)!
  assert.equal(chain.currentStage, '城市评估')
  assert.equal(current.direction, '机器人研发') // 最新决策更新 direction
  assert.equal(current.city, '深圳') // 最新决策无 city，保留前值
})

test('invalid 决策不推进链：全 pending、progressedAt 空；不影响同链合法决策', () => {
  const onlyInvalid = runtime.computeChain(
    [invalidRecord({ id: 'd-bad', skill: 'career-path', createdAt: '2026-08-01' })],
    '我',
  )
  assert.deepEqual(onlyInvalid.stages.map((s) => s.status), ['current', 'pending', 'pending', 'pending', 'pending', 'pending'])
  assert.equal(onlyInvalid.progressedAt, '')

  const mixed = runtime.computeChain(
    [
      invalidRecord({ id: 'd-bad', skill: 'career-path', createdAt: '2026-08-01' }),
      record({ id: 'd-ok', skill: 'career-path', createdAt: '2026-08-02' }),
    ],
    '我',
  )
  assert.deepEqual(mixed.stages.map((s) => s.status), ['completed', 'current', 'pending', 'pending', 'pending', 'pending'])
  assert.equal(mixed.progressedAt, '2026-08-02')
})

test('degraded 决策参与推进（仅 invalid 排除）', () => {
  const chain = runtime.computeChain(
    [degradedRecord({ id: 'd-1', skill: 'career-path', createdAt: '2026-08-01' })],
    '我',
  )
  assert.deepEqual(chain.stages.map((s) => s.status), ['completed', 'current', 'pending', 'pending', 'pending', 'pending'])
})

test('按人隔离：两人各自链互不影响', () => {
  const decisions = [
    record({ id: 'd-1', skill: 'career-path', profile: '我', createdAt: '2026-08-01' }),
    record({ id: 'd-2', skill: 'city-advisor', profile: '家人 A', createdAt: '2026-08-02' }),
  ]
  const a = runtime.computeChain(decisions, '我')
  const b = runtime.computeChain(decisions, '家人 A')
  assert.deepEqual(a.stages.map((s) => s.status), ['completed', 'current', 'pending', 'pending', 'pending', 'pending'])
  assert.deepEqual(b.stages.map((s) => s.status), ['current', 'pending', 'completed', 'pending', 'pending', 'pending'])
  assert.equal(a.currentStage, '转行评估')
  assert.equal(b.currentStage, '方向探索')
})

test('stageOfSkill：规范名精确映射', () => {
  const expected: [string, StageId][] = [
    ['career-path', '方向探索'],
    ['career-transition', '转行评估'],
    ['city-advisor', '城市评估'],
    ['company-screener', '公司筛选'],
    ['jd-analysis', 'JD分析'],
    ['resume-writing', '简历定制'],
  ]
  for (const [skill, stage] of expected) assert.equal(stageOfSkill(skill), stage)
})

test('stageOfSkill：原型变体关键词推断 + 未命中归入方向探索', () => {
  assert.equal(stageOfSkill('direction-explore'), '方向探索')
  assert.equal(stageOfSkill('transfer-eval'), '转行评估')
  assert.equal(stageOfSkill('city-eval'), '城市评估')
  assert.equal(stageOfSkill('city-compare'), '城市评估')
  assert.equal(stageOfSkill('resume'), '简历定制')
  assert.equal(stageOfSkill('城市对比'), '城市评估')
  assert.equal(stageOfSkill('unknown-skill'), '方向探索')
  assert.equal(stageOfSkill(undefined), '方向探索')
  assert.equal(stageOfSkill(''), '方向探索')
})

test('stageProgressed：currentStage 变化 → 推进事件；不变 → 不推进', () => {
  const prev = runtime.computeChain([], '我')
  const next = runtime.computeChain(
    [record({ id: 'd-1', skill: 'career-path', createdAt: '2026-08-01' })],
    '我',
  )
  assert.deepEqual(stageProgressed(prev, next), { progressed: true, from: '方向探索', to: '转行评估' })

  // 同阶段再写一条：链不推进
  const again = runtime.computeChain(
    [
      record({ id: 'd-1', skill: 'career-path', createdAt: '2026-08-01' }),
      record({ id: 'd-2', skill: 'career-path', createdAt: '2026-08-02' }),
    ],
    '我',
  )
  assert.deepEqual(stageProgressed(next, again), { progressed: false, from: null, to: null })
})

test('决策链阶段数恒为 6，顺序固定', () => {
  const chain = runtime.computeChain(
    [record({ id: 'd-1', skill: 'city-eval', createdAt: '2026-08-01' })],
    '我',
  )
  assert.deepEqual(
    chain.stages.map((s) => s.stage),
    [...STAGE_ORDER],
  )
})
