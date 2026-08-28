/**
 * 推理等级 → providerOptions 映射白盒（agent/providers/reasoning.ts——2026-08-28 探针实测：
 * DeepSeek 原生线 reasoning_effort 语义单调（思考 tokens 0/419/685/1358）；
 * Anthropic 线 thinking budget 语义（Anthropic 官方协议）。）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reasoningProviderOptions } from '../agent/providers/reasoning.ts'

test('openai-compatible 线（DeepSeek 原生）：off = thinking disabled；low/high/max = reasoningEffort', () => {
  assert.deepEqual(reasoningProviderOptions('openai-compatible', 'off', 16_384), {
    deepseek: { thinking: { type: 'disabled' } },
  })
  assert.deepEqual(reasoningProviderOptions('openai-compatible', 'low', 16_384), {
    deepseek: { reasoningEffort: 'low' },
  })
  assert.deepEqual(reasoningProviderOptions('openai-compatible', 'high', 16_384), {
    deepseek: { reasoningEffort: 'high' },
  })
  assert.deepEqual(reasoningProviderOptions('openai-compatible', 'max', 16_384), {
    deepseek: { reasoningEffort: 'max' },
  })
})

test('anthropic 线：off = disabled；low/high = budget 档；max = max_tokens−1024（clamp 下限 1024）', () => {
  assert.deepEqual(reasoningProviderOptions('anthropic', 'off', 16_384), {
    anthropic: { thinking: { type: 'disabled' } },
  })
  assert.deepEqual(reasoningProviderOptions('anthropic', 'low', 16_384), {
    anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } },
  })
  assert.deepEqual(reasoningProviderOptions('anthropic', 'high', 16_384), {
    anthropic: { thinking: { type: 'enabled', budgetTokens: 8192 } },
  })
  assert.deepEqual(reasoningProviderOptions('anthropic', 'max', 16_384), {
    anthropic: { thinking: { type: 'enabled', budgetTokens: 15_360 } },
  })
  // max 小预算 clamp：max_tokens 4096 → budget 3072；不低于 1024
  assert.deepEqual(reasoningProviderOptions('anthropic', 'max', 4096), {
    anthropic: { thinking: { type: 'enabled', budgetTokens: 3072 } },
  })
  // low 档小预算：min(2048, max−1024)
  assert.deepEqual(reasoningProviderOptions('anthropic', 'low', 2048), {
    anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 } },
  })
})
