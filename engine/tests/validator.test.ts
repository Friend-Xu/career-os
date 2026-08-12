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
  city: 'City-W',
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

test('协议必填字段缺失：invalid + error', () => {
  const { validation } = validateDecisionRecord({ ...validRecord, skill: undefined })
  assert.equal(validation?.status, 'invalid')
  assert.ok(validation?.issues.some((i) => i.path === 'skill' && i.severity === 'error'))
})

test('语义字段缺失（direction）：协议可选 → 合法（无 validation）', () => {
  const { validation } = validateDecisionRecord({ ...validRecord, direction: undefined })
  assert.equal(validation, undefined)
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
  const v28 = validateByProtocol({ ...validRecord, protocolVersion: '2.8' })
  assert.equal(v28.validation, undefined)
  const bad = validateByProtocol({ ...validRecord, protocolVersion: '1.0' })
  assert.equal(bad.validation?.status, 'invalid')
})

// ─── v2.8 Decision Payload 校验 ───

const validPayloadRecord = {
  ...validRecord,
  protocolVersion: '2.8',
  payload: {
    type: 'city',
    direction: '机器人结构设计',
    cities: [
      { name: 'City-X', score: 76, confidence: 'medium', strengths: ['薪酬性价比'], risks: [] },
      { name: 'City-W', score: 69.5, strengths: [], risks: ['租金高'] },
    ],
  },
}

test('合法 payload（city）：不带 validation', () => {
  const { validation } = validateDecisionRecord(validPayloadRecord)
  assert.equal(validation, undefined)
})

test('payload.type 非法：degraded + warn', () => {
  const { validation } = validateDecisionRecord({
    ...validRecord,
    protocolVersion: '2.8',
    payload: { type: 'company', cities: [{ name: 'City-X', score: 76 }] },
  })
  assert.equal(validation?.status, 'degraded')
  assert.ok(validation?.issues.some((i) => i.path === 'payload' && i.severity === 'warn'))
})

test('payload 行数组为空：degraded + warn', () => {
  const { validation } = validateDecisionRecord({
    ...validRecord,
    protocolVersion: '2.8',
    payload: { type: 'city', cities: [] },
  })
  assert.equal(validation?.status, 'degraded')
  assert.ok(validation?.issues.some((i) => i.path === 'payload.cities' && i.severity === 'warn'))
})

test('payload 行 score 越界：degraded + warn（行级不整体 invalid）', () => {
  const { validation } = validateDecisionRecord({
    ...validRecord,
    protocolVersion: '2.8',
    payload: {
      type: 'direction',
      directions: [
        { name: '热管理', match: 59 },
        { name: '工业软件开发', match: 150 }, // 越界
      ],
    },
  })
  assert.equal(validation?.status, 'degraded')
  assert.ok(validation?.issues.some((i) => i.path === 'payload.directions[1].match' && i.severity === 'warn'))
})

test('payload 行 confidence 非法枚举：degraded + warn', () => {
  const { validation } = validateDecisionRecord({
    ...validRecord,
    protocolVersion: '2.8',
    payload: { type: 'direction', directions: [{ name: '热管理', match: 59, confidence: '极高' }] },
  })
  assert.equal(validation?.status, 'degraded')
  assert.ok(validation?.issues.some((i) => i.path.includes('confidence') && i.severity === 'warn'))
})

test('无 payload：合法（存量决策无 payload 属常态）', () => {
  const { validation } = validateDecisionRecord({ ...validRecord, protocolVersion: '2.8' })
  assert.equal(validation, undefined)
})

test('cityConfidence 非法枚举：degraded + warn', () => {
  const { validation } = validateDecisionRecord({ ...validRecord, protocolVersion: '2.8', cityConfidence: '极高' })
  assert.equal(validation?.status, 'degraded')
  assert.ok(validation?.issues.some((i) => i.path === 'cityConfidence' && i.severity === 'warn'))
})

test('版本分派：2.1 缺 profile → invalid；2.0 缺 profile → ok', () => {
  const noProfile = { ...validRecord, profile: undefined }
  const v21 = validateByProtocol({ ...noProfile, protocolVersion: '2.1' })
  assert.equal(v21.validation?.status, 'invalid')
  assert.ok(v21.validation?.issues.some((i) => i.path === 'profile'))
  const v20 = validateByProtocol({ ...noProfile, protocolVersion: '2.0' })
  assert.equal(v20.validation, undefined)
})

test('PoolNode type 非法：degraded', () => {
  const { validation } = validatePoolNode({ id: 'n-1', label: 'x', type: '外星人' })
  assert.equal(validation?.status, 'degraded')
  assert.ok(validation?.issues.some((i) => i.path === 'type'))
})
