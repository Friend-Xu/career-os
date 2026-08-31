import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeJDMatchScore, capabilityScore, cityConflictOf, verdictOf, JD_MATCH_RULE_VERSION } from '../runtime/jd-match-score.ts'
import type { ConstraintMatchRow, GapResult } from '../ir/schema.ts'

/**
 * JD Match Score 回归（契约 references/jd-match-score-contract-v0.1.md）。
 * 规则表 total 性：能力三元组每个状态恰命中一行；门槛四态映射 + 一票否决 + NOT_DECLARED 剔行。
 */

function gap(partial: Partial<GapResult>): GapResult {
  return {
    role: { id: 'job-1', name: '流体机械工程师', company: '示例流体', skills: [] },
    person: '我',
    satisfied: [],
    transferable: [],
    missing: [],
    personSkillCount: 0,
    ...partial,
  } as GapResult
}

function sat(n: number): { name: string; level: number }[] {
  return Array.from({ length: n }, (_, i) => ({ name: `s${i}`, level: 3 }))
}

function tra(n: number): { name: string; level: number }[] {
  return Array.from({ length: n }, (_, i) => ({ name: `t${i}`, level: 2 }))
}

function miss(n: number, essentialFrom = 0): { name: string; essential: boolean; source: string; action: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `m${i}`,
    essential: i < essentialFrom,
    source: 'JD',
    action: '学习',
  }))
}

function row(dim: ConstraintMatchRow['dim'], status: ConstraintMatchRow['status'], requirement = '本科'): ConstraintMatchRow {
  return { id: `c-${dim}`, dim, requirement, person: '本科', personEvidence: [], status } as ConstraintMatchRow
}

test('能力维度分：规则行 total（v2 加权口径——核心缺口 must×2；全覆盖 5 / 核心全声明 4 / 全基础 3 / 核心覆盖 3 / 核心缺口 2 / 大面积缺失 1 / 无数据 null）', () => {
  assert.equal(capabilityScore(gap({ satisfied: sat(3) })), 5)
  assert.equal(capabilityScore(gap({ satisfied: sat(3), transferable: tra(1) })), 4)
  assert.equal(capabilityScore(gap({ transferable: tra(3) })), 3)
  assert.equal(capabilityScore(gap({ satisfied: sat(2), missing: miss(4) })), 3) // 缺的全是加分项——核心全覆盖
  assert.equal(capabilityScore(gap({ satisfied: sat(2), missing: miss(3, 1) })), 2) // 1 核心 + 2 加分 = 4 重量
  assert.equal(capabilityScore(gap({ missing: miss(4, 2) })), 2) // 2 核心 + 2 加分 = 6 重量（恰在边界）
  assert.equal(capabilityScore(gap({ missing: miss(4, 3) })), 1) // 3 核心 + 1 加分 = 7 重量（越过边界）
  assert.equal(capabilityScore(gap({})), null) // 岗位未分析
})

test('v2 加权语义：核心缺口比加分缺口致命一倍（B 场景从 2 分降到 1 分）', () => {
  // 场景 A：核心全覆盖、缺 3 个加分 → 3 分（不变）
  assert.equal(capabilityScore(gap({ satisfied: sat(2), missing: miss(3) })), 3)
  // 场景 B：加分全覆盖、缺 3 个核心 → 重量 6 ≤6 → 2 分（v1 也是 2）；缺 4 个核心 → 重量 8 → 1 分
  assert.equal(capabilityScore(gap({ satisfied: sat(2), missing: miss(3, 3) })), 2)
  assert.equal(capabilityScore(gap({ satisfied: sat(2), missing: miss(4, 4) })), 1)
})

test('EVALUATED 全覆盖：能力 5 + 门槛三行 MATCHED → 85 / 85', () => {
  const r = computeJDMatchScore({
    jobId: 'job-1',
    personId: 'person_001',
    gap: gap({ satisfied: sat(3) }),
    constraints: [row('education', 'MATCHED'), row('major', 'MATCHED'), row('experience', 'MATCHED')],
  })
  assert.equal(r.status, 'EVALUATED')
  assert.equal(r.score, 85)
  assert.equal(r.maxScore, 85)
  assert.equal(r.dimensions.capability.score, 5)
  assert.equal(r.dimensions.gate.score, 5)
  assert.equal(r.ruleVersion, JD_MATCH_RULE_VERSION)
})

test('EVALUATED 部分满足：能力 2（must 缺口）+ 门槛 MATCHED/NEEDS_CONFIRMATION → 分数可解释', () => {
  const r = computeJDMatchScore({
    jobId: 'job-1',
    personId: 'person_001',
    gap: gap({ satisfied: sat(2), missing: miss(3, 1) }),
    constraints: [row('education', 'MATCHED'), row('major', 'NEEDS_CONFIRMATION'), row('experience', 'MATCHED')],
  })
  // cap: 2/5×55=22；gate: 5/5×10 + 3/5×10 + 5/5×10 = 26 → 48
  assert.equal(r.status, 'EVALUATED')
  assert.equal(r.score, 48)
  assert.equal(r.dimensions.capability.score, 2)
  assert.equal(r.dimensions.gate.score, 4)
  assert.ok(r.dimensions.capability.detail.mustMissing.length === 1)
})

test('HARD_GATE_FAILED：学历 NOT_MATCHED → 一票否决，score null（能力分保留供展示）', () => {
  const r = computeJDMatchScore({
    jobId: 'job-1',
    personId: 'person_001',
    gap: gap({ satisfied: sat(3) }),
    constraints: [row('education', 'NOT_MATCHED'), row('major', 'MATCHED'), row('experience', 'MATCHED')],
  })
  assert.equal(r.status, 'HARD_GATE_FAILED')
  assert.equal(r.score, null)
  assert.equal(r.maxScore, 0)
  assert.equal(r.dimensions.capability.score, 5)
})

test('PARTIAL：能力无数据（岗位未分析）→ 分数不计算（未知 ≠ 中等）', () => {
  const r = computeJDMatchScore({
    jobId: 'job-1',
    personId: 'person_001',
    gap: gap({}),
    constraints: [],
  })
  assert.equal(r.status, 'PARTIAL')
  assert.equal(r.score, null)
  assert.equal(r.dimensions.capability.score, null)
})

test('NOT_DECLARED 剔行：岗位未要求门槛 → 分母收缩（maxScore 55），不扣分不减分', () => {
  const r = computeJDMatchScore({
    jobId: 'job-1',
    personId: 'person_001',
    gap: gap({ satisfied: sat(2), missing: miss(4) }), // cap 3
    constraints: [row('education', 'NOT_DECLARED'), row('major', 'NOT_DECLARED'), row('experience', 'NOT_DECLARED')],
  })
  assert.equal(r.status, 'EVALUATED')
  assert.equal(r.maxScore, 55)
  assert.equal(r.score, 33) // 3/5×55
  assert.equal(r.dimensions.gate.score, null)
  assert.deepEqual(r.dimensions.gate.detail.excludedRows, ['education', 'major', 'experience'])
})

test('NOT_DECLARED 部分剔行：单行参与 → maxScore 65，行权重不变', () => {
  const r = computeJDMatchScore({
    jobId: 'job-1',
    personId: 'person_001',
    gap: gap({ satisfied: sat(3) }), // cap 5 → 55
    constraints: [row('education', 'MATCHED'), row('major', 'NOT_DECLARED'), row('experience', 'NOT_DECLARED')],
  })
  assert.equal(r.maxScore, 65)
  assert.equal(r.score, 65) // 55 + 5/5×10
  assert.equal(r.dimensions.gate.score, 5)
})

test('excluded 披露：差异化优势 15 恒定披露（未纳入 ≠ 默认满分）', () => {
  const r = computeJDMatchScore({
    jobId: 'job-1',
    personId: 'person_001',
    gap: gap({ satisfied: sat(1) }),
    constraints: [row('education', 'MATCHED')],
  })
  assert.deepEqual(r.excluded, [{ label: '差异化优势', weight: 15 }])
})

test('城市冲突 FLAG：意向苏州 vs 岗位杭州 → conflict=true（提示不否决，分数照常）', () => {
  const r = computeJDMatchScore({
    jobId: 'job-1',
    personId: 'person_001',
    gap: gap({ satisfied: sat(3) }),
    constraints: [row('education', 'MATCHED')],
    preferredCity: '苏州',
    jobLocation: '杭州',
  })
  assert.equal(r.status, 'EVALUATED')
  assert.equal(r.score, 65)
  assert.deepEqual(r.city, { preferred: '苏州', jobLocation: '杭州', conflict: true })
})

test('城市互含：意向苏州 vs 岗位苏州工业园区 → conflict=false（子串双向）', () => {
  assert.deepEqual(cityConflictOf('苏州', '苏州工业园区'), { preferred: '苏州', jobLocation: '苏州工业园区', conflict: false })
  assert.deepEqual(cityConflictOf('上海市', '上海'), { preferred: '上海市', jobLocation: '上海', conflict: false })
})

test('城市数据缺失：无偏好（不知道去哪）或无岗位城市 → null（不提示）', () => {
  assert.equal(cityConflictOf(undefined, '杭州'), null)
  assert.equal(cityConflictOf('苏州', undefined), null)
  assert.equal(cityConflictOf('', '杭州'), null)
  const r = computeJDMatchScore({
    jobId: 'job-1',
    personId: 'person_001',
    gap: gap({ satisfied: sat(1) }),
    constraints: [],
  })
  assert.equal(r.city, null)
})

test('判定档位（provisional 借档）：比率 → 高度匹配/推荐投递/备选/观望', () => {
  assert.equal(verdictOf(85, 85), '高度匹配')
  assert.equal(verdictOf(55, 65), '高度匹配') // 85%
  assert.equal(verdictOf(52, 65), '推荐投递') // 80%
  assert.equal(verdictOf(39, 65), '备选') // 60%
  assert.equal(verdictOf(33, 65), '备选') // 50.8→51
  assert.equal(verdictOf(32, 65), '观望') // 49%
  assert.equal(verdictOf(17, 65), '观望') // 26%
  assert.equal(verdictOf(10, 0), '') // 无有效分母
})
