import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { ConfigError, defaultConfig, loadConfig, parseCliArgs, REPO_ROOT, resolveAgentConnection, resolveModel, resolveTaskModel, type EngineConfig } from '../config.ts'

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
  assert.equal(config.agent.permissionMode, 'bypassPermissions')
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

test('config.json 相对 paths → 解析为相对 REPO_ROOT（项目迁移不失效）', () => {
  const path = tempConfigFile({
    paths: { workspace: 'workspace/career-advisor', skills: 'skills/career-advisor', logs: 'logs', db: 'workspace/career-advisor/.career-os.db' },
  })
  const { config } = loadConfig(['--config', path])
  assert.equal(config.paths.workspace, resolve(REPO_ROOT, 'workspace/career-advisor'))
  assert.equal(config.paths.skills, resolve(REPO_ROOT, 'skills/career-advisor'))
  assert.equal(config.paths.logs, resolve(REPO_ROOT, 'logs'))
  assert.equal(config.paths.db, resolve(REPO_ROOT, 'workspace/career-advisor/.career-os.db'))
  rmSync(join(path, '..'), { recursive: true, force: true })
})

test('config.json 绝对 paths → 原样保留（数据放任意盘）', () => {
  const path = tempConfigFile({ paths: { workspace: 'D:/elsewhere/ws' } })
  const { config } = loadConfig(['--config', path])
  assert.equal(config.paths.workspace, 'D:/elsewhere/ws')
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

// ─── resolveAgentConnection（ADR-030：providers 直连解析）───────────────────

function agentConfigWith(providers: unknown, extra?: { model?: string; enabled?: boolean }): EngineConfig {
  const config = defaultConfig()
  config.agent.model = extra?.model
  config.agent.enabled = extra?.enabled
  if (providers !== undefined) config.agent.providers = providers as EngineConfig['agent']['providers']
  return config
}

test('resolveAgentConnection：enabled 且带 apiKey 的服务商 → 直连三元组', () => {
  const config = agentConfigWith(
    [{ id: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-1', enabled: true, models: ['deepseek-v4-flash', 'deepseek-v4-pro'] }],
    { model: 'claude-sonnet-4-6' },
  )
  const conn = resolveAgentConnection(config)
  assert.ok(conn)
  assert.equal(conn.apiKey, 'sk-1')
  assert.equal(conn.baseUrl, 'https://api.deepseek.com/anthropic')
  assert.equal(conn.model, 'deepseek-v4-flash')
  assert.deepEqual(conn.validModels, ['deepseek-v4-flash', 'deepseek-v4-pro'])
  assert.equal(conn.credentialSource, 'config')
})

test('resolveAgentConnection：config.agent.model 命中服务商模型列表 → 沿用', () => {
  const config = agentConfigWith(
    [{ id: 'deepseek', apiKey: 'sk-1', enabled: true, models: ['deepseek-v4-flash', 'deepseek-v4-pro'] }],
    { model: 'deepseek-v4-pro' },
  )
  assert.equal(resolveAgentConnection(config)?.model, 'deepseek-v4-pro')
})

test('resolveAgentConnection：enabled=false → undefined（走 CLI 登录态）', () => {
  const config = agentConfigWith(
    [{ id: 'deepseek', apiKey: 'sk-1', enabled: true, models: ['deepseek-v4-flash'] }],
    { enabled: false },
  )
  assert.equal(resolveAgentConnection(config), undefined)
})

test('resolveAgentConnection：无 enabled 服务商/无 apiKey → undefined', () => {
  assert.equal(
    resolveAgentConnection(agentConfigWith([{ id: 'deepseek', apiKey: 'sk-1', enabled: false, models: [] }])),
    undefined,
  )
  assert.equal(resolveAgentConnection(agentConfigWith([{ id: 'deepseek', enabled: true, models: ['m'] }])), undefined)
  assert.equal(resolveAgentConnection(agentConfigWith(undefined)), undefined)
})

// ─── Provider Credential Contract（Step 0.6：env > config）──────────────────

function clearLlmEnv(): void {
  delete process.env.COS_LLM_API_KEY
  delete process.env.COS_LLM_BASE_URL
  delete process.env.COS_LLM_MODEL
}

test('Credential Contract：COS_LLM_API_KEY 覆盖 config key + credentialSource=env', () => {
  clearLlmEnv()
  const config = agentConfigWith([{ id: 'deepseek', apiKey: 'sk-config', enabled: true, models: ['deepseek-v4-flash'] }])
  process.env.COS_LLM_API_KEY = 'sk-env'
  const conn = resolveAgentConnection(config)
  assert.equal(conn?.apiKey, 'sk-env')
  assert.equal(conn?.credentialSource, 'env')
  clearLlmEnv()
})

test('Credential Contract：COS_LLM_MODEL 覆盖模型（env 模型不需在 providers.models 内）', () => {
  clearLlmEnv()
  const config = agentConfigWith([{ id: 'deepseek', apiKey: 'sk-1', enabled: true, models: ['deepseek-v4-flash'] }])
  process.env.COS_LLM_MODEL = 'another-model'
  assert.equal(resolveAgentConnection(config)?.model, 'another-model')
  clearLlmEnv()
})

test('Credential Contract：无 env 回落 config（credentialSource=config）', () => {
  clearLlmEnv()
  const config = agentConfigWith([{ id: 'deepseek', apiKey: 'sk-1', enabled: true, models: ['deepseek-v4-flash'] }])
  const conn = resolveAgentConnection(config)
  assert.equal(conn?.apiKey, 'sk-1')
  assert.equal(conn?.credentialSource, 'config')
})

// ─── resolveModel / resolveTaskModel（ADR-030 Step 4：模型校验与任务绑定）────

test('resolveModel：无连接透传请求名；有连接未命中回落默认模型', () => {
  assert.equal(resolveModel(undefined, 'any-model'), 'any-model')
  assert.equal(resolveModel(undefined, undefined), undefined)
  const conn = { apiKey: 'sk-1', model: 'deepseek-v4-flash', validModels: ['deepseek-v4-flash', 'deepseek-v4-pro'], credentialSource: 'config' as const }
  assert.equal(resolveModel(conn, 'deepseek-v4-pro'), 'deepseek-v4-pro')
  assert.equal(resolveModel(conn, 'claude-sonnet-4-6'), 'deepseek-v4-flash')
  assert.equal(resolveModel(conn, undefined), 'deepseek-v4-flash')
})

test('resolveTaskModel：未绑定 → 服务商默认模型；已绑定合法 → 用之', () => {
  const conn = { apiKey: 'sk-1', model: 'deepseek-v4-flash', validModels: ['deepseek-v4-flash', 'deepseek-v4-pro'], credentialSource: 'config' as const }
  const plain = defaultConfig()
  assert.equal(resolveTaskModel(conn, plain, 'jd_extract'), 'deepseek-v4-flash')
  const bound = defaultConfig()
  bound.agent.taskModels = { jd_extract: 'deepseek-v4-pro' }
  assert.equal(resolveTaskModel(conn, bound, 'jd_extract'), 'deepseek-v4-pro')
  assert.equal(resolveTaskModel(conn, bound, 'career_analysis'), 'deepseek-v4-flash')
})

test('resolveTaskModel：已绑定但不在服务商模型列表 → ConfigError（fail fast，不静默换模型）', () => {
  const conn = { apiKey: 'sk-1', model: 'deepseek-v4-flash', validModels: ['deepseek-v4-flash'], credentialSource: 'config' as const }
  const bound = defaultConfig()
  bound.agent.taskModels = { jd_extract: 'ghost-model' }
  assert.throws(() => resolveTaskModel(conn, bound, 'jd_extract'), ConfigError)
})

test('loadConfig：taskModels 成员不在任何服务商 models → ConfigError（加载期 fail fast）', () => {
  clearEnv()
  const path = tempConfigFile({
    agent: {
      providers: [{ id: 'deepseek', apiKey: 'sk-1', enabled: true, models: ['deepseek-v4-flash'] }],
      taskModels: { jd_extract: 'not-a-model' },
    },
  })
  assert.throws(() => loadConfig(['--config', path]), ConfigError)
  rmSync(join(path, '..'), { recursive: true, force: true })
})

test('loadConfig：taskModels 形状非法（非字符串）→ ConfigError', () => {
  clearEnv()
  const path = tempConfigFile({ agent: { taskModels: { jd_extract: 42 } } })
  assert.throws(() => loadConfig(['--config', path]), ConfigError)
  rmSync(join(path, '..'), { recursive: true, force: true })
})
