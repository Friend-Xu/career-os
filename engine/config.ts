/**
 * 引擎配置（文件化）：career-os.config.json（仓库根，gitignored）。
 * 来源优先级：CLI 参数 > 环境变量 > config.json > 内置默认值。
 * fail fast：非法值抛 ConfigError（字段名/当前值/合法值枚举/来源层级），不静默降级。
 * 首次启动生成完整 config.json + 逐字段打印说明（JSON 标准不支持注释，说明走启动日志）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINE_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(ENGINE_DIR, '..')

export const DEFAULT_CONFIG_PATH = resolve(REPO_ROOT, 'career-os.config.json')

export type PermissionMode = 'acceptEdits' | 'ask' | 'bypassPermissions'
export type ConfigSource = 'CLI' | 'env' | 'config.json' | '默认值'

/** 模型服务商连接（设置页服务商卡片；id 稳定标识，models = 用户勾选的模型） */
export interface AgentProvider {
  id: string
  label?: string
  baseUrl?: string
  apiKey?: string
  enabled: boolean
  models?: string[]
}

export interface EngineConfig {
  server: {
    host: string
    port: number
  }
  agent: {
    model?: string
    /** API 密钥（可选）：传则走 API 模式；留空复用本机 claude CLI 登录态 */
    apiKey?: string
    /** API 端点根地址（可选）：默认官方 https://api.anthropic.com；留空 = 官方 */
    baseUrl?: string
    /** 启用 API 模型配置（设置页大胶囊勾选）；false = 忽略 apiKey/baseUrl/model，Agent 走 CLI 登录态 */
    enabled?: boolean
    /** 服务商连接数组（设置页卡片式管理的唯一事实源；旧 model/apiKey/baseUrl 字段仅迁移兼容） */
    providers?: AgentProvider[]
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
  map: {
    /** 地图服务商（当前仅高德 Web JS API） */
    provider: string
    /** 高德 JS API key（纯前端消费；与 agent.apiKey 同存 config.json，受同一 gitignore 保护） */
    apiKey?: string
    /** 高德 JS API 安全密钥（2021-12 后申请的 key 必须；明文方式 _AMapSecurityConfig，同存 config.json 保护） */
    securityJsCode?: string
  }
  /**
   * 通勤圈城市（用户偏好数据：真实值只写本地 career-os.config.json，gitignored，不入库）。
   * 空数组 = 未配置，圈约束不启用（JD 地点不因通勤圈产生 risk）。
   */
  prefCities?: string[]
  /** 文档智能（Document Runtime：PDF 简历提取等）——与 agent 平行，不共享 Provider 语义 */
  document: {
    /** 视觉模型连接（图片型 PDF 提取；未配置 → 仅文本型 PDF 可用） */
    vision?: {
      /** 视觉服务商（当前仅 zhipu，OpenAI 兼容 /chat/completions） */
      provider: 'zhipu'
      /** 视觉模型（默认 glm-4.6v-flash 免费） */
      model?: string
      /** 视觉 API key（与 agent.apiKey 同保护：career-os.config.json gitignored） */
      apiKey?: string
    }
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
    agent: { permissionMode: 'bypassPermissions', allowedTools: [...DEFAULT_ALLOWED_TOOLS] },
    paths: {
      workspace,
      skills: resolve(REPO_ROOT, 'skills', 'career-advisor'),
      logs: resolve(REPO_ROOT, 'logs'),
      db: resolve(workspace, '.career-os.db'),
    },
    watcher: { enabled: true },
    map: { provider: 'amap' },
    prefCities: [],
    document: { vision: { provider: 'zhipu', model: 'glm-4.6v-flash' } },
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

function assertApiKey(v: unknown, source: ConfigSource): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new ConfigError('agent.apiKey', v, '字符串或空（复用本机 CLI 登录态）', source)
  return v
}

function assertBaseUrl(v: unknown, source: ConfigSource): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new ConfigError('agent.baseUrl', v, '字符串或空（默认官方 API）', source)
  try {
    new URL(v)
  } catch {
    throw new ConfigError('agent.baseUrl', v, '合法 URL（如 https://api.anthropic.com）', source)
  }
  return v
}

function assertAgentEnabled(v: unknown, source: ConfigSource): boolean | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new ConfigError('agent.enabled', v, '布尔或空（默认启用）', source)
  return v
}

function assertProviders(v: unknown, source: ConfigSource): AgentProvider[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new ConfigError('agent.providers', v, '服务商数组', source)
  return v.map((item, i) => {
    if (typeof item !== 'object' || item === null) {
      throw new ConfigError(`agent.providers[${i}]`, item, '对象', source)
    }
    const p = item as Record<string, unknown>
    if (typeof p.id !== 'string' || p.id.length === 0) {
      throw new ConfigError(`agent.providers[${i}].id`, p.id, '非空字符串', source)
    }
    if (p.label !== undefined && typeof p.label !== 'string') {
      throw new ConfigError(`agent.providers[${i}].label`, p.label, '字符串', source)
    }
    if (p.baseUrl !== undefined && typeof p.baseUrl !== 'string') {
      throw new ConfigError(`agent.providers[${i}].baseUrl`, p.baseUrl, '字符串', source)
    }
    if (p.apiKey !== undefined && typeof p.apiKey !== 'string') {
      throw new ConfigError(`agent.providers[${i}].apiKey`, p.apiKey, '字符串', source)
    }
    if (typeof p.enabled !== 'boolean') {
      throw new ConfigError(`agent.providers[${i}].enabled`, p.enabled, '布尔', source)
    }
    if (p.models !== undefined && (!Array.isArray(p.models) || p.models.some((m) => typeof m !== 'string'))) {
      throw new ConfigError(`agent.providers[${i}].models`, p.models, 'string[]', source)
    }
    return {
      id: p.id,
      ...(p.label !== undefined ? { label: p.label } : {}),
      ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
      ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}),
      enabled: p.enabled,
      ...(p.models !== undefined ? { models: p.models } : {}),
    } as AgentProvider
  })
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

/** 相对路径按项目根解析（项目整体迁移后不失效）；绝对路径原样（数据可放任意盘） */
function resolvePath(v: unknown, source: ConfigSource): string {
  const p = assertPath(v, source)
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p)
}

function assertEnabled(v: unknown, source: ConfigSource): boolean {
  if (typeof v !== 'boolean') throw new ConfigError('watcher.enabled', v, 'true/false', source)
  return v
}

function assertMap(v: unknown, source: ConfigSource): { provider: string; apiKey?: string; securityJsCode?: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ConfigError('map', v, '对象 { provider, apiKey?, securityJsCode? }', source)
  }
  const m = v as Record<string, unknown>
  if (typeof m.provider !== 'string' || m.provider.length === 0) {
    throw new ConfigError('map.provider', m.provider, '非空字符串', source)
  }
  if (m.apiKey !== undefined && typeof m.apiKey !== 'string') {
    throw new ConfigError('map.apiKey', m.apiKey, '字符串或空', source)
  }
  if (m.securityJsCode !== undefined && typeof m.securityJsCode !== 'string') {
    throw new ConfigError('map.securityJsCode', m.securityJsCode, '字符串或空', source)
  }
  return {
    provider: m.provider,
    ...(m.apiKey !== undefined ? { apiKey: m.apiKey } : {}),
    ...(m.securityJsCode !== undefined ? { securityJsCode: m.securityJsCode } : {}),
  }
}

/** 通勤圈城市校验：string[]（真实值仅存在于本地 gitignored config.json） */
function assertPrefCities(v: unknown, source: ConfigSource): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.some((c) => typeof c !== 'string' || c.length === 0)) {
    throw new ConfigError('prefCities', v, 'string[]（通勤圈城市，如 ["苏州","上海"]）', source)
  }
  return v
}

/** document 段校验（config.json 边界：直接编辑也可）；vision 可选，缺失字段回退默认 */
function assertDocument(v: unknown, source: ConfigSource): { vision?: { provider: 'zhipu'; model?: string; apiKey?: string } } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ConfigError('document', v, '对象 { vision? }', source)
  }
  const d = v as Record<string, unknown>
  if (d.vision === undefined) return {}
  if (typeof d.vision !== 'object' || d.vision === null || Array.isArray(d.vision)) {
    throw new ConfigError('document.vision', d.vision, '对象 { provider?, model?, apiKey? }', source)
  }
  const v2 = d.vision as Record<string, unknown>
  if (v2.provider !== undefined && v2.provider !== 'zhipu') {
    throw new ConfigError('document.vision.provider', v2.provider, "'zhipu'", source)
  }
  if (v2.model !== undefined && typeof v2.model !== 'string') {
    throw new ConfigError('document.vision.model', v2.model, '字符串', source)
  }
  if (v2.apiKey !== undefined && typeof v2.apiKey !== 'string') {
    throw new ConfigError('document.vision.apiKey', v2.apiKey, '字符串', source)
  }
  return {
    vision: {
      provider: 'zhipu',
      ...(v2.model ? { model: v2.model } : {}),
      ...(v2.apiKey ? { apiKey: v2.apiKey } : {}),
    },
  }
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
  if (workspace !== undefined) config.paths.workspace = resolvePath(workspace, 'env')
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
      if (file.agent.apiKey !== undefined) config.agent.apiKey = assertApiKey(file.agent.apiKey, 'config.json')
      if (file.agent.baseUrl !== undefined) config.agent.baseUrl = assertBaseUrl(file.agent.baseUrl, 'config.json')
      if (file.agent.enabled !== undefined) config.agent.enabled = assertAgentEnabled(file.agent.enabled, 'config.json')
      if (file.agent.providers !== undefined) config.agent.providers = assertProviders(file.agent.providers, 'config.json')
      if (file.agent.permissionMode !== undefined) config.agent.permissionMode = assertPermissionMode(file.agent.permissionMode, 'config.json')
      if (file.agent.allowedTools !== undefined) config.agent.allowedTools = assertTools(file.agent.allowedTools, 'config.json')
      if (file.agent.maxTurns !== undefined) config.agent.maxTurns = assertMaxTurns(file.agent.maxTurns, 'config.json')
    }
    if (file.paths) {
      if (file.paths.workspace !== undefined) config.paths.workspace = resolvePath(file.paths.workspace, 'config.json')
      if (file.paths.skills !== undefined) config.paths.skills = resolvePath(file.paths.skills, 'config.json')
      if (file.paths.logs !== undefined) config.paths.logs = resolvePath(file.paths.logs, 'config.json')
      if (file.paths.db !== undefined) config.paths.db = resolvePath(file.paths.db, 'config.json')
    }
    if (file.watcher && file.watcher.enabled !== undefined) {
      config.watcher.enabled = assertEnabled(file.watcher.enabled, 'config.json')
    }
    if (file.map) {
      config.map = assertMap(file.map, 'config.json')
    }
    if (file.prefCities !== undefined) {
      config.prefCities = assertPrefCities(file.prefCities, 'config.json')
    }
    if (file.document) {
      const doc = assertDocument(file.document, 'config.json')
      config.document = { vision: { provider: 'zhipu', ...config.document.vision, ...(doc.vision ?? {}) } }
    }
  } else {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  }

  applyEnv(config)
  applyCli(config, cli)

  // 旧字段迁移：providers 是唯一事实源；无 providers 但配了 apiKey → 迁移为自定义服务商
  if (!config.agent.providers && config.agent.apiKey) {
    config.agent.providers = [
      {
        id: 'custom',
        label: '自定义',
        baseUrl: config.agent.baseUrl,
        apiKey: config.agent.apiKey,
        enabled: config.agent.enabled !== false,
        models: config.agent.model ? [config.agent.model] : [],
      },
    ]
  }

  return { config, firstRun: !file, configPath }
}

/** 逐字段启动说明（config.json 无注释，说明走启动日志） */
export function describeConfig(config: EngineConfig): string[] {
  return [
    `server.host = ${config.server.host}（监听地址，个人使用默认仅回环）`,
    `server.port = ${config.server.port}（与前端 5288 相邻；占用时 +1 递增兜底）`,
    `agent.model = ${config.agent.model ?? '（空）用 claude CLI 默认模型'}`,
    `agent.apiKey = ${config.agent.apiKey ? '已配置（API 模式）' : '（空）复用本机 claude CLI 登录态'}`,
    `agent.baseUrl = ${config.agent.baseUrl ?? '（空）官方 API https://api.anthropic.com'}`,
    `agent.enabled = ${config.agent.enabled === false ? 'false（未启用：Agent 走本机 CLI 登录态）' : 'true（启用 API 模型配置）'}`,
    `agent.permissionMode = ${config.agent.permissionMode}（权限模式：acceptEdits 自动放行 Read/Write/Edit/Grep/Glob）`,
    `agent.allowedTools = [${config.agent.allowedTools.join(', ')}]`,
    `agent.maxTurns = ${config.agent.maxTurns ?? '（空）不限制'}`,
    `paths.workspace = ${config.paths.workspace}（信息池真相源）`,
    `paths.skills = ${config.paths.skills}（skill 加载目录）`,
    `paths.logs = ${config.paths.logs}（应用日志 + Agent 轨迹）`,
    `paths.db = ${config.paths.db}（SQLite Projection，第 4 步引入）`,
    `watcher.enabled = ${config.watcher.enabled}（decisions/ 监听，第 3 步引入）`,
    `document.vision = ${config.document.vision?.model ?? '未配置'}${config.document.vision?.apiKey ? '（已配置 key）' : '（未配置 key：图片型 PDF 提取不可用）'}`,
  ]
}
