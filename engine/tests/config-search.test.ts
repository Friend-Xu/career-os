import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, loadConfig } from '../config.ts'

/** 临时 config.json → loadConfig（fail fast 边界校验；合成配置不含真实实体） */
function loadFrom(obj: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'cos-config-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify(obj))
  return loadConfig(['--config', path])
}

test('agent.search：合法旋钮加载（budgetPerTask/cacheTtlMinutes）', () => {
  const { config } = loadFrom({ agent: { search: { budgetPerTask: 5, cacheTtlMinutes: 15 } } })
  assert.deepEqual(config.agent.search, { budgetPerTask: 5, cacheTtlMinutes: 15 })
})

test('agent.search：缺失 → undefined（引擎默认 8 次 / 30 分钟）', () => {
  const { config } = loadFrom({})
  assert.equal(config.agent.search, undefined)
})

test('agent.search：非法值 → ConfigError 带字段名（fail fast，不静默降级）', () => {
  for (const bad of [{ budgetPerTask: 0 }, { budgetPerTask: -1 }, { budgetPerTask: '8' }, { cacheTtlMinutes: 1.5 }, { cacheTtlMinutes: '30' }]) {
    assert.throws(
      () => loadFrom({ agent: { search: bad } }),
      (err: unknown) => err instanceof ConfigError && err.message.includes('agent.search.'),
      `应拒绝 ${JSON.stringify(bad)}`,
    )
  }
})
