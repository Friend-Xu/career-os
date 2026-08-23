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
  /** 能力声明（Provider Capability Registry P2）：显式覆盖 Registry 推断（'auto' 缺省 = 按 id/域名推断）。
   *  webSearch: 'responses'（OpenAI Responses + provider 侧搜索）/ 'google'（Gemini grounding）/
   *  'off'（不注册 WebSearch 工具）。配置文件字段，设置页不管理（透传保字段）。 */
  capabilities?: { webSearch?: 'auto' | 'responses' | 'google' | 'off' }
}

/**
 * Provider Credential Contract（ADR-030 Step 0.6）：
 * 凭据来源优先级 = 环境变量（COS_LLM_API_KEY / COS_LLM_BASE_URL / COS_LLM_MODEL）> config.json providers。
 * **禁止本机 Claude CLI 运行时参与**（settings.json env / ANTHROPIC_BASE_URL / CLI 登录态）——
 * 引擎拥有凭据控制权，CLI 时代继承的认证风险（PROXY_MANAGED 式隐藏授权）不得进入新链路。
 * credentialSource 随连接上报（health-check/设置页可见：凭据到底来自哪一层）。
 */
export interface AgentConnection {
  /** 服务商 id（providers[].id；health 上报 provider 身份用） */
  providerId?: string
  apiKey: string
  baseUrl?: string
  model?: string
  /** 服务商登记的合法模型列表（外部模型名经 resolveModel 校验回落） */
  validModels: string[]
  /** 凭据来源（env = 运行环境覆盖；config = config.json providers 登记） */
  credentialSource: 'env' | 'config'
  /** 能力声明（P2 Registry 输入：显式覆盖优先于 id/域名推断） */
  capabilities?: { webSearch?: 'auto' | 'responses' | 'google' | 'off' }
}

/**
 * 解析 API 直连连接：agent.providers 中第一个 enabled 且带 apiKey 的服务商。
 * - agent.enabled === false → undefined（用户显式要求走本机 CLI 登录态）
 * - 无匹配服务商 → undefined（沿用旧行为：CLI 登录态）
 * - 环境变量覆盖 apiKey/baseUrl/model（Step 0.6：env > config，无 env 时回落 config）
 * - 模型名只在服务商 models 列表内合法：config.agent.model 命中则沿用，否则回落 models[0]
 *   （旧 config.agent.model 可能是代理映射名如 claude-sonnet-4-6，直连端点不识别）
 */
export function resolveAgentConnection(config: EngineConfig): AgentConnection | undefined {
  if (config.agent.enabled === false) return undefined
  const provider = (config.agent.providers ?? []).find((p) => p.enabled && p.apiKey)
  if (!provider || !provider.apiKey) return undefined
  const envKey = process.env.COS_LLM_API_KEY
  const envBase = process.env.COS_LLM_BASE_URL
  const envModel = process.env.COS_LLM_MODEL
  const validModels = provider.models ?? []
  const model = envModel ?? (validModels.includes(config.agent.model ?? '') ? config.agent.model : validModels[0])
  const baseUrl = (envBase ?? provider.baseUrl) ?? ''
  return {
    providerId: provider.id,
    apiKey: envKey ?? provider.apiKey,
    ...(baseUrl !== '' ? { baseUrl } : {}),
    ...(model !== undefined ? { model } : {}),
    validModels,
    credentialSource: envKey !== undefined && envKey !== '' ? 'env' : 'config',
    ...(provider.capabilities !== undefined ? { capabilities: provider.capabilities } : {}),
  }
}

/** 请求模型名校验：直连模式下只许服务商登记模型，未命中回落连接默认模型 */
export function resolveModel(conn: AgentConnection | undefined, requested?: string): string | undefined {
  if (!conn) return requested
  if (requested && conn.validModels.includes(requested)) return requested
  return conn.model
}

export type TaskModelKey = 'jd_extract' | 'career_analysis' | 'resume_extract'

/** 任务级模型解析：taskModels[task] 登记 → 用之；未登记 → 服务商默认模型。
 *  已登记但不在当前服务商模型列表（设置页运行时改动导致）→ 抛 ConfigError（fail fast，不静默换模型） */
export function resolveTaskModel(conn: AgentConnection, config: EngineConfig, task: TaskModelKey): string | undefined {
  const requested = config.agent.taskModels?.[task]
  if (requested === undefined) return conn.model
  if (!conn.validModels.includes(requested)) {
    throw new ConfigError(
      `agent.taskModels.${task}`,
      requested,
      `当前服务商登记模型（${conn.validModels.join(' / ')}）`,
      'config.json',
    )
  }
  return requested
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
    /** 任务级模型绑定（ADR-030 Step 4）：jd_extract=结构化提取 / career_analysis=工作流推理 /
     *  resume_extract=简历事实提取（P0-1 确定性通道）；未绑定 → 服务商默认模型。
     *  配置文件字段（设置页不管理） */
    taskModels?: { jd_extract?: string; career_analysis?: string; resume_extract?: string }
    /** WebSearch 治理旋钮（Search Capability Layer P1a）：任务级搜索预算（外部调用次数上限，
     *  缓存命中不消耗）+ 检索结果缓存 TTL（分钟；引擎内存缓存，重启失效）。引擎单方决定，客户端不可设。 */
    search?: { budgetPerTask?: number; cacheTtlMinutes?: number }
    /**
     * 外部工具源（Tool Runtime 第二阶段 P2）：MCP/数据源开关——外部工具默认关闭（Phase 0 冻结：
     *  无管理后台，配置文件字段）。enabled=true 才连接/注册；工具进白名单（allowedTools）才装配。
     *  exa：Exa hosted MCP（https://mcp.exa.ai/mcp，匿名限速可用；apiKey 可选，Authorization Bearer 提升额度）。
     */
    toolSources?: { exa?: { apiKey?: string; enabled: boolean } }
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
// WebSearch = DeepSeek Responses 托管搜索（引擎薄封装；无 provider 时不注册——白名单交集自然排除）
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebSearch']
// Search Capability Layer P1a 默认旋钮（config.json 可覆盖；runtime 无配置时也以此为缺省）
export const DEFAULT_SEARCH_BUDGET = 8
export const DEFAULT_SEARCH_CACHE_TTL_MINUTES = 30
// P2 Provider Capability Registry：webSearch 能力声明合法值
const WEB_SEARCH_VALUES = ['auto', 'responses', 'google', 'off']

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
    // capabilities（P2 Registry 输入）：webSearch 枚举校验（'auto' 归一为不声明——推断语义）
    const cap = p.capabilities
    const isCapObject = cap !== undefined && typeof cap === 'object' && cap !== null && !Array.isArray(cap)
    const declaredWebSearch = isCapObject ? (cap as Record<string, unknown>).webSearch : undefined
    if (cap !== undefined && !isCapObject) {
      throw new ConfigError(`agent.providers[${i}].capabilities`, cap, '{ webSearch? }', source)
    }
    if (declaredWebSearch !== undefined && !WEB_SEARCH_VALUES.includes(declaredWebSearch as never)) {
      throw new ConfigError(
        `agent.providers[${i}].capabilities.webSearch`,
        declaredWebSearch,
        WEB_SEARCH_VALUES.join('/'),
        source,
      )
    }
    return {
      id: p.id,
      ...(p.label !== undefined ? { label: p.label } : {}),
      ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
      ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}),
      enabled: p.enabled,
      ...(p.models !== undefined ? { models: p.models } : {}),
      ...(typeof declaredWebSearch === 'string' && declaredWebSearch !== 'auto'
        ? { capabilities: { webSearch: declaredWebSearch } }
        : {}),
    } as AgentProvider
  })
}

function assertTaskModels(v: unknown, source: ConfigSource): { jd_extract?: string; career_analysis?: string; resume_extract?: string } | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) throw new ConfigError('agent.taskModels', v, '{ jd_extract?, career_analysis?, resume_extract? }', source)
  const m = v as Record<string, unknown>
  const out: { jd_extract?: string; career_analysis?: string; resume_extract?: string } = {}
  for (const key of ['jd_extract', 'career_analysis', 'resume_extract'] as const) {
    if (m[key] === undefined || m[key] === '') continue
    if (typeof m[key] !== 'string') throw new ConfigError(`agent.taskModels.${key}`, m[key], '字符串（服务商 models 之一）', source)
    out[key] = m[key]
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function assertMaxTurns(v: unknown, source: ConfigSource): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ConfigError('agent.maxTurns', v, '正整数', source)
  }
  return v
}

/** WebSearch 治理旋钮校验：两个字段均为正整数（缺失 = 引擎默认，不报错） */
function assertSearch(v: unknown, source: ConfigSource): { budgetPerTask?: number; cacheTtlMinutes?: number } | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new ConfigError('agent.search', v, '{ budgetPerTask?, cacheTtlMinutes? }', source)
  }
  const s = v as Record<string, unknown>
  const out: { budgetPerTask?: number; cacheTtlMinutes?: number } = {}
  for (const key of ['budgetPerTask', 'cacheTtlMinutes'] as const) {
    if (s[key] === undefined) continue
    if (typeof s[key] !== 'number' || !Number.isInteger(s[key]) || (s[key] as number) <= 0) {
      throw new ConfigError(`agent.search.${key}`, s[key], '正整数', source)
    }
    out[key] = s[key] as number
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 外部工具源校验（Tool Runtime 第二阶段 P2）：exa 段形状校验；enabled 缺省 = false（外部工具默认关闭） */
function assertToolSources(v: unknown, source: ConfigSource): { exa?: { apiKey?: string; enabled: boolean } } | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new ConfigError('agent.toolSources', v, '{ exa?: { apiKey?, enabled } }', source)
  }
  const s = v as Record<string, unknown>
  const out: { exa?: { apiKey?: string; enabled: boolean } } = {}
  if (s.exa !== undefined) {
    if (typeof s.exa !== 'object' || s.exa === null || Array.isArray(s.exa)) {
      throw new ConfigError('agent.toolSources.exa', s.exa, '{ apiKey?, enabled }', source)
    }
    const e = s.exa as Record<string, unknown>
    if (e.apiKey !== undefined && typeof e.apiKey !== 'string') {
      throw new ConfigError('agent.toolSources.exa.apiKey', e.apiKey, '字符串或空（匿名限速可用）', source)
    }
    if (e.enabled !== undefined && typeof e.enabled !== 'boolean') {
      throw new ConfigError('agent.toolSources.exa.enabled', e.enabled, '布尔（缺省 false = 外部工具默认关闭）', source)
    }
    out.exa = {
      ...(e.apiKey !== undefined ? { apiKey: e.apiKey } : {}),
      enabled: e.enabled === true,
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
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
  if (workspace !== undefined) {
    config.paths.workspace = resolvePath(workspace, 'env')
    // 隔离联动（2026-08-22 修复，真机前端验收发现）：workspace 覆盖后 db 必须跟随——
    // config.json 的 paths.db 指向原 workspace 的投影库，不联动会导致 COS_WORKSPACE 隔离实例
    // 仍读写真实 DB（前端从投影读到真实画像数据，误判为"非空白测试"）
    config.paths.db = resolve(config.paths.workspace, '.career-os.db')
  }
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
      if (file.agent.taskModels !== undefined) config.agent.taskModels = assertTaskModels(file.agent.taskModels, 'config.json')
      if (file.agent.search !== undefined) config.agent.search = assertSearch(file.agent.search, 'config.json')
      if (file.agent.toolSources !== undefined) config.agent.toolSources = assertToolSources(file.agent.toolSources, 'config.json')
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

  // taskModels 成员校验（fail fast）：任务模型必须登记在某个服务商 models 列表内
  if (config.agent.taskModels) {
    const allModels = new Set((config.agent.providers ?? []).flatMap((p) => p.models ?? []))
    for (const task of ['jd_extract', 'career_analysis', 'resume_extract'] as const) {
      const m = config.agent.taskModels[task]
      if (m !== undefined && !allModels.has(m)) {
        throw new ConfigError(
          `agent.taskModels.${task}`,
          m,
          `providers[].models 之一（${[...allModels].join(' / ') || '无已登记模型'}）`,
          'config.json',
        )
      }
    }
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
    `agent.search = budgetPerTask ${config.agent.search?.budgetPerTask ?? DEFAULT_SEARCH_BUDGET} 次 / cacheTtl ${config.agent.search?.cacheTtlMinutes ?? DEFAULT_SEARCH_CACHE_TTL_MINUTES} 分钟（WebSearch 治理旋钮）`,
    `paths.workspace = ${config.paths.workspace}（信息池真相源）`,
    `paths.skills = ${config.paths.skills}（skill 加载目录）`,
    `paths.logs = ${config.paths.logs}（应用日志 + Agent 轨迹）`,
    `paths.db = ${config.paths.db}（SQLite Projection，第 4 步引入）`,
    `watcher.enabled = ${config.watcher.enabled}（decisions/ 监听，第 3 步引入）`,
    `document.vision = ${config.document.vision?.model ?? '未配置'}${config.document.vision?.apiKey ? '（已配置 key）' : '（未配置 key：图片型 PDF 提取不可用）'}`,
  ]
}
