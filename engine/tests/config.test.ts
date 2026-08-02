import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, defaultConfig, loadConfig, parseCliArgs } from '../config.ts'

function tempConfigFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-config-'))
  const path = join(dir, 'career-os.config.json')
  writeFileSync(path, JSON.stringify(content), 'utf8')
  return path
}

function clearEnv(): void {
  delete process.env.COS_PORT
  delete process.env.COS_WORKSPACE
  delete process.env.COS_MODEL
}

test('默认值：无 config.json 时生成 + firstRun', () => {
  clearEnv()
  const dir = mkdtempSync(join(tmpdir(), 'cos-config-'))
  const path = join(dir, 'career-os.config.json')
  const { config, firstRun, configPath } = loadConfig(['--config', path])
  assert.equal(firstRun, true)
  assert.equal(configPath, path)
  assert.equal(config.server.host, '127.0.0.1')
  assert.equal(config.server.port, 5289)
  assert.equal(config.agent.permissionMode, 'acceptEdits')
  assert.deepEqual(config.agent.allowedTools, ['Read', 'Write', 'Edit', 'Grep', 'Glob'])
  assert.equal(config.watcher.enabled, true)
  assert.ok(existsSync(path), '首次运行应生成 config.json')
  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(written.server.port, 5289)
  rmSync(dir, { recursive: true, force: true })
})

test('config.json 合并：覆盖部分字段，其余保持默认', () => {
  clearEnv()
  const path = tempConfigFile({ server: { port: 6000 } })
  const { config, firstRun } = loadConfig(['--config', path])
  assert.equal(firstRun, false)
  assert.equal(config.server.port, 6000)
  assert.equal(config.server.host, '127.0.0.1')
  assert.equal(config.paths.workspace, defaultConfig().paths.workspace)
  rmSync(join(path, '..'), { recursive: true, force: true })
})

test('env 覆盖：COS_PORT / COS_WORKSPACE / COS_MODEL', () => {
  const path = tempConfigFile({})
  process.env.COS_PORT = '6001'
  process.env.COS_WORKSPACE = 'D:/tmp-ws'
  process.env.COS_MODEL = 'claude-sonnet-4-6'
  const { config } = loadConfig(['--config', path])
  assert.equal(config.server.port, 6001)
  assert.equal(config.paths.workspace, 'D:/tmp-ws')
  assert.equal(config.agent.model, 'claude-sonnet-4-6')
  clearEnv()
  rmSync(join(path, '..'), { recursive: true, force: true })
})

test('CLI 覆盖最高：--port 压过 env', () => {
  const path = tempConfigFile({})
  process.env.COS_PORT = '6001'
  const { config } = loadConfig(['--config', path, '--port', '7000'])
  assert.equal(config.server.port, 7000)
  clearEnv()
  rmSync(join(path, '..'), { recursive: true, force: true })
})

test('fail fast：config.json 非法 port → ConfigError', () => {
  const path = tempConfigFile({ server: { port: 70000 } })
  assert.throws(
    () => loadConfig(['--config', path]),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      const e = err as ConfigError
      assert.equal(e.field, 'server.port')
      assert.equal(e.source, 'config.json')
      assert.match(e.message, /合法值：1-65535/)
      return true
    },
  )
  rmSync(join(path, '..'), { recursive: true, force: true })
})

test('fail fast：env 非法 port → ConfigError（来源 env）', () => {
  const path = tempConfigFile({})
  process.env.COS_PORT = 'abc'
  assert.throws(
    () => loadConfig(['--config', path]),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.equal((err as ConfigError).source, 'env')
      return true
    },
  )
  clearEnv()
  rmSync(join(path, '..'), { recursive: true, force: true })
})

test('fail fast：非法 permissionMode → ConfigError', () => {
  const path = tempConfigFile({ agent: { permissionMode: 'sudo' } })
  assert.throws(() => loadConfig(['--config', path]), ConfigError)
  rmSync(join(path, '..'), { recursive: true, force: true })
})

test('fail fast：config.json 非法 JSON → ConfigError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-config-'))
  const path = join(dir, 'bad.json')
  writeFileSync(path, '{ not json', 'utf8')
  assert.throws(() => loadConfig(['--config', path]), ConfigError)
  rmSync(dir, { recursive: true, force: true })
})

test('parseCliArgs：--config 后跟值、--port 校验', () => {
  assert.deepEqual(parseCliArgs(['--config', 'x.json']), { configPath: 'x.json' })
  assert.deepEqual(parseCliArgs(['--port', '5290']), { port: 5290 })
  assert.throws(() => parseCliArgs(['--port', 'nan']), ConfigError)
})
