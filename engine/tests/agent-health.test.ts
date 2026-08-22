import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultConfig, type EngineConfig } from '../config.ts'
import { checkAgentHealth } from '../runtime/agent-health.ts'
import { startFakeAnthropicServer, textTurn } from './agent/fake-anthropic-server.ts'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} }

function configWith(serverUrl: string): EngineConfig {
  const c = defaultConfig()
  c.agent.providers = [{ id: 'deepseek', apiKey: 'sk-test', baseUrl: `${serverUrl}/anthropic`, enabled: true, models: ['deepseek-v4-flash'] }]
  return c
}

test('agent/health：无服务商 → not_configured（状态可见，非错误）', async () => {
  const h = await checkAgentHealth(defaultConfig(), silentLogger)
  assert.equal(h.status, 'not_configured')
  assert.match(h.error ?? '', /未配置/)
})

test('agent/health：假端点可调用 → ready + latencyMs', async () => {
  const server = await startFakeAnthropicServer([textTurn('ok')])
  const h = await checkAgentHealth(configWith(server.url), silentLogger)
  await server.close()
  assert.equal(h.status, 'ready')
  assert.equal(h.model, 'deepseek-v4-flash')
  assert.ok(h.latencyMs !== undefined && h.latencyMs >= 0)
})

test('agent/health：端点不可达 → error（10s 内 fail fast，不挂 75s）', async () => {
  const h = await checkAgentHealth(configWith('http://127.0.0.1:1'), silentLogger)
  assert.equal(h.status, 'error')
  assert.ok(h.latencyMs !== undefined && h.latencyMs < 10_000)
})
