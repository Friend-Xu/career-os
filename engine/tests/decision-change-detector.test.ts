import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionProjection } from '../ir/decision-projection.ts'
import { parseSelectedChange, projectDecision } from '../ir/decision-projection.ts'
import { detectDecisionChange } from '../runtime/decision-change-detector.ts'

function proj(partial: Partial<DecisionProjection> = {}): DecisionProjection {
  return { id: partial.id ?? 'decision_001', updatedAt: partial.updatedAt ?? '', ...partial }
}

test('方向变化 → direction_target 候选（Level A）', () => {
  const cands = detectDecisionChange(
    proj({ direction: '机械结构工程师' }),
    proj({ direction: '工业软件工程师' }),
  )
  assert.equal(cands.length, 1)
  assert.deepEqual(cands[0], {
    changeUnit: 'direction_target',
    changeType: 'decision',
    before: '机械结构工程师',
    after: '工业软件工程师',
    confidence: 'medium',
  })
})

test('城市/薪资可行性变化 → city_constraint / salary_constraint 候选', () => {
  const cands = detectDecisionChange(
    proj({ city: 'City-W', salaryFeasible: true }),
    proj({ city: 'City-Circle', salaryFeasible: false }),
  )
  assert.equal(cands.length, 2)
  const city = cands.find((c) => c.changeUnit === 'city_constraint')!
  assert.deepEqual(city, {
    changeUnit: 'city_constraint',
    changeType: 'preference',
    before: 'City-W',
    after: 'City-Circle',
    confidence: 'medium',
  })
  const salary = cands.find((c) => c.changeUnit === 'salary_constraint')!
  assert.equal(salary.changeType, 'constraint')
  assert.equal(salary.before, 'true')
  assert.equal(salary.after, 'false')
})

test('分析变化不产生候选：投影不含分析字段（结构保证），相同投影 → 空', () => {
  // DecisionProjection 类型无 confidence/score/risk/match/analysis 字段——
  // Detector 结构上无从检测分析变化
  const base = proj({ direction: '机器人', city: 'City-X' })
  assert.deepEqual(detectDecisionChange(base, base), [])
})

test('selected 字段变化不产生候选：Detector 不推导 old ≠ new → selected_change', () => {
  // selected 是 snapshot 不是事件源——投影无 selected 字段；无显式 selectedChange → 空
  assert.deepEqual(
    detectDecisionChange(proj({ direction: 'A' }), proj({ direction: 'A' })),
    [],
  )
})

test('显式 selected_change → 候选（source=user_decision，confidence=high）', () => {
  const cands = detectDecisionChange(
    proj({ selectedChange: { unit: 'direction_target', from: '医疗器械结构工程师', to: '工业软件工程师' } }),
    proj({ selectedChange: { unit: 'direction_target', from: '医疗器械结构工程师', to: '工业AI工程师' } }),
  )
  assert.equal(cands.length, 1)
  assert.deepEqual(cands[0], {
    changeUnit: 'direction_target',
    changeType: 'decision',
    before: '医疗器械结构工程师',
    after: '工业AI工程师',
    source: 'user_decision',
    confidence: 'high',
  })
  // city 落点 → preference 类型
  const cityCands = detectDecisionChange(
    proj({ selectedChange: { unit: 'city_constraint', from: 'City-W', to: 'City-X' } }),
    proj({ selectedChange: { unit: 'city_constraint', from: 'City-W', to: 'City-Y' } }),
  )
  assert.equal(cityCands[0]!.changeType, 'preference')
})

test('决策问题变化 → jd_strategy 候选（Level B，medium）', () => {
  const cands = detectDecisionChange(
    proj({ contextQuestion: '机械结构工程师岗位可行性' }),
    proj({ contextQuestion: '工业软件工程师岗位可行性' }),
  )
  assert.equal(cands.length, 1)
  assert.deepEqual(cands[0], {
    changeUnit: 'jd_strategy',
    changeType: 'decision',
    before: '机械结构工程师岗位可行性',
    after: '工业软件工程师岗位可行性',
    confidence: 'medium',
  })
})

test('projectDecision：摘要表 → 投影（direction/city/salary/selected_change；非法格式降级）', () => {
  const md = `# 测试

## 分析摘要

| 字段 | 值 |
|------|-----|
| direction | 机器人结构设计 |
| city | City-X |
| salary_feasible | true |
| selected_change | direction_target:机器人结构设计 → 机械+AI 交叉 |
| direction_match | 82% |
| risk_level | 低 |
`
  const p = projectDecision(md, 'decision_001', '2026-08-06')
  assert.equal(p.direction, '机器人结构设计')
  assert.equal(p.city, 'City-X')
  assert.equal(p.salaryFeasible, true)
  assert.deepEqual(p.selectedChange, { unit: 'direction_target', from: '机器人结构设计', to: '机械+AI 交叉' })
  // 分析字段不进入投影（结构保证）
  assert.equal('directionMatch' in p, false)
  assert.equal('riskLevel' in p, false)
  // 非法格式 selected_change → 不产出
  const bad = projectDecision(md.replace('direction_target:机器人结构设计 → 机械+AI 交叉', '坏格式'), 'decision_001', '')
  assert.equal(bad.selectedChange, undefined)
  // 无摘要表 → 空投影
  assert.deepEqual(projectDecision('# 无摘要表', 'x', ''), { id: 'x', updatedAt: '' })
})

test('parseSelectedChange：格式解析（含首选择 from 可空 + 非法单位拒绝）', () => {
  assert.deepEqual(parseSelectedChange('direction_target:机器人 → 工业'), { unit: 'direction_target', from: '机器人', to: '工业' })
  assert.deepEqual(parseSelectedChange('city_constraint:→ City-X'), { unit: 'city_constraint', to: 'City-X' }) // 首选择
  assert.equal(parseSelectedChange('bad_unit:A → B'), undefined) // 非法单位
  assert.equal(parseSelectedChange('无箭头格式'), undefined)
})
