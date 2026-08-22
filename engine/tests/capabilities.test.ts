import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webSearchModeOf } from '../agent/providers/capabilities.ts'
import type { AgentConnection } from '../config.ts'

function conn(patch: Partial<AgentConnection>): AgentConnection {
  return { apiKey: 'sk-test', validModels: ['m'], credentialSource: 'config', ...patch }
}

test('registry：provider.id 别名命中（deepseek/openai→responses，google→google）', () => {
  assert.equal(webSearchModeOf(conn({ providerId: 'deepseek', baseUrl: 'https://custom.gateway.com/anthropic' })), 'responses')
  assert.equal(webSearchModeOf(conn({ providerId: 'openai' })), 'responses')
  assert.equal(webSearchModeOf(conn({ providerId: 'google', baseUrl: 'https://custom.gateway.com' })), 'google')
})

test('registry：baseUrl 域名规则命中（自定义服务商 id 不可控，域名是稳定事实源）', () => {
  assert.equal(webSearchModeOf(conn({ providerId: 'custom-123', baseUrl: 'https://api.deepseek.com/anthropic' })), 'responses')
  assert.equal(webSearchModeOf(conn({ providerId: 'custom-456', baseUrl: 'https://api.openai.com/v1' })), 'responses')
  assert.equal(webSearchModeOf(conn({ providerId: 'custom-789', baseUrl: 'https://generativelanguage.googleapis.com' })), 'google')
})

test('registry：显式声明覆盖推断（未知网关可声明能走的实现；off 显式关闭）', () => {
  assert.equal(
    webSearchModeOf(conn({ providerId: 'custom-x', baseUrl: 'https://ollama.local/v1', capabilities: { webSearch: 'responses' } })),
    'responses',
  )
  assert.equal(
    webSearchModeOf(conn({ providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', capabilities: { webSearch: 'off' } })),
    'off',
  )
})

test('registry：未知 → off（不假装有搜索能力；WebSearch 工具不注册）', () => {
  assert.equal(webSearchModeOf(conn({ providerId: 'custom-x', baseUrl: 'https://ollama.local/v1' })), 'off')
  assert.equal(webSearchModeOf(conn({ providerId: 'anthropic', baseUrl: 'https://api.anthropic.com' })), 'off')
})
