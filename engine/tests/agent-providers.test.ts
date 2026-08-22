import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLanguageModel, wireFormatOf } from '../agent/providers/model.ts'
import { JdSchema } from '../runtime/jd-extract.ts'

// ─── provider 线格式判别（ADR-030 Provider 层）─────────────────────────────

const connAnthropic = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-v4-flash',
  validModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  credentialSource: 'config' as const,
}
const connOpenAi = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  validModels: ['deepseek-v4-flash'],
  credentialSource: 'config' as const,
}

test('wireFormatOf：/anthropic 后缀 → anthropic；否则 openai-compatible', () => {
  assert.equal(wireFormatOf(connAnthropic), 'anthropic')
  assert.equal(wireFormatOf(connOpenAi), 'openai-compatible')
  assert.equal(wireFormatOf({ apiKey: 'sk', model: 'm', validModels: ['m'], credentialSource: 'config' }), 'openai-compatible')
})

test('resolveLanguageModel：anthropic 线格式 → anthropic provider', () => {
  const { model, modelId } = resolveLanguageModel(connAnthropic)
  assert.equal(modelId, 'deepseek-v4-flash')
  assert.equal(typeof model, 'object')
  if (typeof model === 'object') {
    assert.equal(model.provider, 'anthropic.messages')
    assert.equal(model.modelId, 'deepseek-v4-flash')
  }
})

test('resolveLanguageModel：openai 兼容线格式 → deepseek provider', () => {
  const { model, modelId } = resolveLanguageModel(connOpenAi)
  assert.equal(modelId, 'deepseek-v4-flash')
  assert.equal(typeof model, 'object')
  if (typeof model === 'object') {
    assert.equal(model.provider, 'deepseek.chat')
    assert.equal(model.modelId, 'deepseek-v4-flash')
  }
})

test('resolveLanguageModel：provider 未登记模型 → 抛错（fail fast，不静默）', () => {
  assert.throws(
    () => resolveLanguageModel({ apiKey: 'sk', model: undefined, validModels: [], credentialSource: 'config' }),
    /provider 未登记模型/,
  )
})

// ─── JD 结构化契约（JdSchema = generateObject schema = 类型同源）────────────

test('JdSchema：完整 JD 字段合法', () => {
  const parsed = JdSchema.safeParse({
    company: 'Company-A',
    title: '机械工程师',
    location: 'City-X',
    salary: '10-15K',
    requirements: ['CAD', 'BOM'],
  })
  assert.equal(parsed.success, true)
})

test('JdSchema：company/requirements 缺省降级；location/salary 可选省略', () => {
  const parsed = JdSchema.safeParse({ title: '机械工程师' })
  assert.equal(parsed.success, true)
  if (parsed.success) {
    assert.equal(parsed.data.company, '')
    assert.deepEqual(parsed.data.requirements, [])
    assert.equal(parsed.data.location, undefined)
    assert.equal(parsed.data.salary, undefined)
  }
})

test('JdSchema：title 缺失 → 不合法（generateObject 校验重试的拦截点）', () => {
  assert.equal(JdSchema.safeParse({ company: 'Company-A' }).success, false)
})

test('JdSchema：requirements 非字符串元素 → 不合法', () => {
  assert.equal(JdSchema.safeParse({ title: 'x', requirements: [1] }).success, false)
})
