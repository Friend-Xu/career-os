import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateByProtocol, validateDecisionRecord, validatePoolNode } from '../ir/validator.ts'

const validRecord = {
  id: 'd-001',
  title: '机器人方向可行性分析',
  skill: 'career-transition',
  direction: '机器人研发',
  directionMatch: 82,
  directionConfidence: 'high',
  city: '深圳',
  cityScore: 86,
  salaryFeasible: true,
  riskLevel: 'medium',
  keyRisk: '竞争激烈',
  status: 'completed',
  profile: '我',
  summary: '可行',
  createdAt: '2026-08-01',
  protocolVersion: '2.1',
}

test('合法 DecisionRecord：不带 validation', () => {
  const { value, validation } = validateDecisionRecord(validRecord)
  assert.equal(value.id, 'd-001')
  assert.equal(validation, undefined)
})

test('必填字段缺失：invalid + error', () => {
  const { validation } = validateDecisionRecord({ ...validRecord, direction: undefined })
  assert.equal(validation?.status, 'invalid')
  assert.ok(validation?.issues.some((i) => i.path === 'direction' && i.severity === 'error'))
})

test('枚举值非法：degraded + warn，值保留', () => {
  const input = { ...validRecord, directionConfidence: '超神' }
  const { value, validation } = validateDecisionRecord(input)
  assert.equal(validation?.status, 'degraded')
  assert.ok(validation?.issues.some((i) => i.path === 'directionConfidence' && i.severity === 'warn'))
  assert.equal(value.directionConfidence, '超神')
})

test('数值越界：degraded + warn', () => {
  const { validation } = validateDecisionRecord({ ...validRecord, cityScore: 150 })
  assert.equal(validation?.status, 'degraded')
  assert.ok(validation?.issues.some((i) => i.path === 'cityScore'))
})

test('非对象输入：全部必填缺失 → invalid', () => {
  const { validation } = validateDecisionRecord('garbage')
  assert.equal(validation?.status, 'invalid')
})

test('不支持的协议版本：invalid + error', () => {
  const { validation } = validateDecisionRecord({ ...validRecord, protocolVersion: '9.9' })
  assert.equal(validation?.status, 'invalid')
  assert.ok(validation?.issues.some((i) => i.path === 'protocolVersion' && i.severity === 'error'))
})

test('validateByProtocol：按版本分派', () => {
  const ok = validateByProtocol(validRecord)
  assert.equal(ok.validation, undefined)
  const bad = validateByProtocol({ ...validRecord, protocolVersion: '1.0' })
  assert.equal(bad.validation?.status, 'invalid')
})

test('PoolNode type 非法：degraded', () => {
  const { validation } = validatePoolNode({ id: 'n-1', label: 'x', type: '外星人' })
  assert.equal(validation?.status, 'degraded')
  assert.ok(validation?.issues.some((i) => i.path === 'type'))
})
