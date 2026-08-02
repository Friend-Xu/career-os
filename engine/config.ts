/**
 * 引擎配置（文件化）：career-os.config.json（仓库根，gitignored）。
 * 来源优先级：CLI 参数 > 环境变量 > config.json > 内置默认值。
 * fail fast：非法值抛 ConfigError（字段名/当前值/合法值枚举/来源层级），不静默降级。
 * 首次启动生成完整 config.json + 逐字段打印说明（JSON 标准不支持注释，说明走启动日志）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINE_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(ENGINE_DIR, '..')

export const DEFAULT_CONFIG_PATH = resolve(REPO_ROOT, 'career-os.config.json')

export type PermissionMode = 'acceptEdits' | 'ask' | 'bypassPermissions'
export type ConfigSource = 'CLI' | 'env' | 'config.json' | '默认值'

export interface EngineConfig {
  server: {
    host: string
    port: number
  }
  agent: {
    model?: string
    permissionMode: PermissionMode
    allowedTools: string[]
    maxTurns?: number
  }
  paths: {
    workspace: string
    skills: string
    logs: string
    db: string
  }
  watcher: {
    enabled: boolean
  }
}

export class ConfigError extends Error {
  readonly field: string
  readonly value: unknown
  readonly legal: string
  readonly source: ConfigSource

  constructor(field: string, value: unknown, legal: string, source: ConfigSource) {
    super(`❌ config：${field} = ${JSON.stringify(value)}（合法值：${legal}）[来源：${source}]`)
    this.name = 'ConfigError'
    this.field = field
    this.value = value
    this.legal = legal
    this.source = source
  }
}

const PERMISSION_MODES: PermissionMode[] = ['acceptEdits', 'ask', 'bypassPermissions']
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Grep', 'Glob']

export function defaultConfig(): EngineConfig {
  const workspace = resolve(REPO_ROOT, 'workspace', 'career-advisor')
  return {
    server: { host: '127.0.0.1', port: 5289 },
    agent: { permissionMode: 'acceptEdits', allowedTools: [...DEFAULT_ALLOWED_TOOLS] },
    paths: {
      workspace,
      skills: resolve(REPO_ROOT, 'skills', 'career-advisor'),
      logs: resolve(REPO_ROOT, 'logs'),
      db: resolve(workspace, '.career-os.db'),
    },
    watcher: { enabled: true },
  }
}

// ─── 字段校验（fail fast）─────────────────────────────────────────────────

function assertPort(v: unknown, source: ConfigSource): number {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError('server.port', v, '1-65535 整数', source)
  }
  return n
}

function assertHost(v: unknown, source: ConfigSource): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ConfigError('server.host', v, '非空字符串', source)
  }
  return v
}

function assertPermissionMode(v: unknown, source: ConfigSource): PermissionMode {
  if (typeof v !== 'string' || !PERMISSION_MODES.includes(v as PermissionMode)) {
    throw new ConfigError('agent.permissionMode', v, PERMISSION_MODES.join('/'), source)
  }
  return v as PermissionMode
}

function assertTools(v: unknown, source: ConfigSource): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.some((t) => typeof t !== 'string')) {
    throw new ConfigError('agent.allowedTools', v, '非空 string[]', source)
  }
  return v
}

function assertModel(v: unknown, source: ConfigSource): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new ConfigError('agent.model', v, '字符串或空（用 CLI 默认模型）', source)
  return v
}

function assertMaxTurns(v: unknown, source: ConfigSource): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ConfigError('agent.maxTurns', v, '正整数', source)
  }
  return v
}

function assertPath(v: unknown, source: ConfigSource): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ConfigError('paths.*', v, '非空字符串（绝对或相对路径）', source)
  }
  return v
}

function assertEnabled(v: unknown, source: ConfigSource): boolean {
  if (typeof v !== 'boolean') throw new ConfigError('watcher.enabled', v, 'true/false', source)
  return v
}

// ─── 来源解析 ─────────────────────────────────────────────────────────────

export interface CliArgs {
  configPath?: string
  port?: number
}

export function parseCliArgs(args: string[]): CliArgs {
  const cli: CliArgs = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--config') {
      cli.configPath = args[++i]
      if (!cli.configPath) throw new ConfigError('--config', undefined, '配置文件路径', 'CLI')
    } else if (arg === '--port') {
      const raw = args[++i]
      cli.port = assertPort(raw, 'CLI')
    }
  }
  return cli
}

type PartialConfig = { [K in keyof EngineConfig]?: Partial<EngineConfig[K]> }

function readConfigFile(path: string): PartialConfig | undefined {
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ConfigError('config.json', String(err instanceof Error ? err.message : err), '合法 JSON', 'config.json')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('config.json', raw, 'JSON 对象', 'config.json')
  }
  return raw as PartialConfig
}

function applyEnv(config: EngineConfig): void {
  const port = process.env.COS_PORT
  if (port !== undefined) config.server.port = assertPort(port, 'env')
  const workspace = process.env.COS_WORKSPACE
  if (workspace !== undefined) config.paths.workspace = assertPath(workspace, 'env')
  const model = process.env.COS_MODEL
  if (model !== undefined) config.agent.model = assertModel(model, 'env')
}

function applyCli(config: EngineConfig, cli: CliArgs): void {
  if (cli.port !== undefined) config.server.port = cli.port
}

/** 配置加载：默认值 ← config.json ← env ← CLI（后覆盖前），全程 fail fast */
export function loadConfig(args: string[] = []): { config: EngineConfig; firstRun: boolean; configPath: string } {
  const cli = parseCliArgs(args)
  const configPath = cli.configPath ?? DEFAULT_CONFIG_PATH
  const config = defaultConfig()
  const file = readConfigFile(configPath)

  if (file) {
    if (file.server) {
      if (file.server.host !== undefined) config.server.host = assertHost(file.server.host, 'config.json')
      if (file.server.port !== undefined) config.server.port = assertPort(file.server.port, 'config.json')
    }
    if (file.agent) {
      if (file.agent.model !== undefined) config.agent.model = assertModel(file.agent.model, 'config.json')
      if (file.agent.permissionMode !== undefined) config.agent.permissionMode = assertPermissionMode(file.agent.permissionMode, 'config.json')
      if (file.agent.allowedTools !== undefined) config.agent.allowedTools = assertTools(file.agent.allowedTools, 'config.json')
      if (file.agent.maxTurns !== undefined) config.agent.maxTurns = assertMaxTurns(file.agent.maxTurns, 'config.json')
    }
    if (file.paths) {
      if (file.paths.workspace !== undefined) config.paths.workspace = assertPath(file.paths.workspace, 'config.json')
      if (file.paths.skills !== undefined) config.paths.skills = assertPath(file.paths.skills, 'config.json')
      if (file.paths.logs !== undefined) config.paths.logs = assertPath(file.paths.logs, 'config.json')
      if (file.paths.db !== undefined) config.paths.db = assertPath(file.paths.db, 'config.json')
    }
    if (file.watcher && file.watcher.enabled !== undefined) {
      config.watcher.enabled = assertEnabled(file.watcher.enabled, 'config.json')
    }
  } else {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  }

  applyEnv(config)
  applyCli(config, cli)

  return { config, firstRun: !file, configPath }
}

/** 逐字段启动说明（config.json 无注释，说明走启动日志） */
export function describeConfig(config: EngineConfig): string[] {
  return [
    `server.host = ${config.server.host}（监听地址，个人使用默认仅回环）`,
    `server.port = ${config.server.port}（与前端 5288 相邻；占用时 +1 递增兜底）`,
    `agent.model = ${config.agent.model ?? '（空）用 claude CLI 默认模型'}`,
    `agent.permissionMode = ${config.agent.permissionMode}（权限模式：acceptEdits 自动放行 Read/Write/Edit/Grep/Glob）`,
    `agent.allowedTools = [${config.agent.allowedTools.join(', ')}]`,
    `agent.maxTurns = ${config.agent.maxTurns ?? '（空）不限制'}`,
    `paths.workspace = ${config.paths.workspace}（信息池真相源）`,
    `paths.skills = ${config.paths.skills}（skill 加载目录）`,
    `paths.logs = ${config.paths.logs}（应用日志 + Agent 轨迹）`,
    `paths.db = ${config.paths.db}（SQLite Projection，第 4 步引入）`,
    `watcher.enabled = ${config.watcher.enabled}（decisions/ 监听，第 3 步引入）`,
  ]
}
