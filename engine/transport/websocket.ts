/**
 * WebSocket 桥（第 3 步）：RPC 分派 + 事件广播。
 * - 契约：protocol.ts 定稿（RpcRequest/RpcResponse/ServerEvent + METHODS/EVENTS），严格按此实现
 * - 权限：仅本机回环（个人使用；监听地址 = config.server.host，另拒绝非回环远端）
 * - 分派失败：未注册方法 → method_not_found；非 RPC 帧 → invalid_request；处理器异常 → internal_error
 * - 端口：EADDRINUSE 时日志警告后 +1 递增重试（最多 5 次），仍失败抛 ServerError fail fast
 * - 广播：ServerEvent 单帧发给所有连接客户端（事件是通知，状态走 RPC 拉取）
 */
import { WebSocketServer, type WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG_PATH, type AgentProvider, type EngineConfig, type PermissionMode } from '../config.ts'
import type { Workspace } from '../storage/workspace.ts'
import type { Logger } from '../logger.ts'
import type { DecisionAggregate, DecisionChain, DecisionRecord, GapResult } from '../ir/schema.ts'
import { DecisionRuntime } from '../runtime/decision-runtime.ts'
import { AgentRuntime, type AgentStartParams } from '../runtime/agent-runtime.ts'
import { buildAggregates } from '../runtime/decision-aggregate.ts'
import { computeGap } from '../runtime/gap-calculator.ts'
import { generateHealthReport } from '../health/checker.ts'
import { exportPdf } from '../export/pdf.ts'
import { recordRewriteFeedback } from '../feedback/writer.ts'
import { scanContexts } from '../storage/context-watcher.ts'
import { scanKnowledge } from '../storage/knowledge-watcher.ts'
import { scanProfiles } from '../storage/projection.ts'
import { updateDecisionFile } from '../storage/decision-editor.ts'
import { createJobFile, deleteJobFile, scanJobs, type CreateJobParams } from '../storage/job-watcher.ts'
import { scanEvidence } from '../storage/evidence-watcher.ts'
import { scanClaims } from '../storage/claim-watcher.ts'
import { scanResumes, transitionResumeStatusFile, cloneResumeFile, diffResumes, markResumeExported } from '../storage/resume-watcher.ts'
import { indexEvidence, canUseClaim } from '../storage/claim-policy.ts'
import { computeClaimCoverage } from '../runtime/claim-coverage.ts'
import { selectExpressionCandidates } from '../runtime/claim-selector.ts'
import { exportResumePdf, serializeExportRecord } from '../export/resume-export.ts'
import { buildCareerContext } from '../context/career-context.ts'
import { computeEvidenceCoverage } from '../runtime/evidence-coverage.ts'
import { acceptProposalFile, rejectProposalFile, scanProposals } from '../storage/proposal-watcher.ts'
import {
  acceptPortfolioProposal,
  rejectPortfolioProposal,
  scanPortfolioProjects,
  scanPortfolioProposals,
  transitionPortfolioProject,
} from '../storage/portfolio-watcher.ts'
import type { PortfolioStatus } from '../ir/portfolio.ts'
import {
  acceptInterviewProposal,
  rejectInterviewProposal,
  scanInterviewProposals,
  scanInterviewQas,
  transitionInterviewQa,
} from '../storage/interview-watcher.ts'
import type { InterviewStatus } from '../ir/interview.ts'
import {
  acceptCoverLetterProposal,
  rejectCoverLetterProposal,
  scanCoverLetterProposals,
  scanCoverLetters,
  transitionCoverLetter,
} from '../storage/cover-letter-watcher.ts'
import type { CoverLetterStatus } from '../ir/cover-letter.ts'
import { deleteCompanyFile, readCompanyFile, type ProjectionStore } from '../storage/projection.ts'
import { extractJdFields } from '../runtime/jd-extract.ts'
import { METHODS, EVENTS, type RpcRequest, type RpcResponse, type ServerEvent } from './protocol.ts'

/** 端口占用递增兜底次数（config.server.port 起最多 +5） */
const MAX_PORT_RETRIES = 5

/** 端口监听失败（递增耗尽）→ main.ts 以 ❌ 风格输出 */
export class ServerError extends Error {
  constructor(message: string) {
    super(`❌ server：${message}`)
    this.name = 'ServerError'
  }
}

/** 桥的查询入口（main 注入；投影服务实现，RPC 处理器从 store 取数） */
export interface BridgeStore {
  init(): unknown
  listDecisions(): unknown
  rescan(): unknown
  listCompanies(): unknown
  listPersons(): unknown
  graph(): unknown
}

export interface ServerHandle {
  port: number
  broadcast(event: ServerEvent): void
  /** 优雅关闭：中止全部活跃 Agent 任务（SDK close → CLI 子进程终止） */
  shutdown(): void
}

function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function isRpcRequest(v: unknown): v is RpcRequest {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as RpcRequest).id === 'string' &&
    typeof (v as RpcRequest).method === 'string'
  )
}

/**
 * decisions/chain 处理器派生：listDecisions() 按 profile 分组 → 每人对该人决策调 computeChain。
 * 空链过滤：computeChain 内部已排除 invalid 决策（Validation.status === 'invalid'），
 * 链上无 completed 阶段即该人无合法决策（无进展）→ 不返回。
 */
export function computeChains(decisions: DecisionRecord[], runtime: DecisionRuntime): DecisionChain[] {
  const byPerson = new Map<string, DecisionRecord[]>()
  for (const d of decisions) {
    if (!d.profile) continue // v2.0 旧记录无 profile，无法归属人
    const list = byPerson.get(d.profile)
    if (list) list.push(d)
    else byPerson.set(d.profile, [d])
  }
  const chains: DecisionChain[] = []
  for (const person of [...byPerson.keys()].sort()) {
    const chain = runtime.computeChain(byPerson.get(person)!, person)
    if (chain.stages.some((s) => s.status === 'completed')) chains.push(chain)
  }
  return chains
}

/** contexts/list 处理器派生：context 目录扫描 + 决策投影 → 按 context 组装聚合（纯函数，不落盘） */
export function listContexts(workspace: Workspace, store: BridgeStore): DecisionAggregate[] {
  return buildAggregates(scanContexts(workspace), store.listDecisions() as DecisionRecord[])
}

/** knowledge/gap 处理器派生：roleId 找 Role + person 找画像技能声明 → computeGap（纯派生，不落盘） */
export function computeKnowledgeGap(workspace: Workspace, params: { person: string; roleId: string }): GapResult {
  const { skills, roles } = scanKnowledge(workspace)
  const role = roles.find((r) => r.id === params.roleId)
  if (!role) throw new Error(`角色不存在：${params.roleId}`)
  const personSkills = scanProfiles(workspace).find((p) => p.name === params.person)?.skills ?? []
  return computeGap({ role, person: params.person, personSkills, skills })
}

/** knowledge/gap 入参校验（RPC 边界：用户输入校验，fail fast） */
function gapParams(v: unknown): { person: string; roleId: string } {
  if (typeof v !== 'object' || v === null) throw new Error('knowledge/gap 需要 params { person, roleId }')
  const p = v as Record<string, unknown>
  if (typeof p.person !== 'string' || p.person.length === 0) throw new Error('params.person 缺失（画像名）')
  if (typeof p.roleId !== 'string' || p.roleId.length === 0) throw new Error('params.roleId 缺失（岗位 id）')
  return { person: p.person, roleId: p.roleId }
}

/** decisions/update 入参校验（RPC 边界：用户输入校验，fail fast） */
function updateDecisionParams(v: unknown): { id: string; fields: Record<string, string> } {
  if (typeof v !== 'object' || v === null) throw new Error('decisions/update 需要 params { id, fields }')
  const p = v as Record<string, unknown>
  if (typeof p.id !== 'string' || p.id.length === 0) throw new Error('params.id 缺失（决策文件名）')
  if (typeof p.fields !== 'object' || p.fields === null || Array.isArray(p.fields)) {
    throw new Error('params.fields 应为对象 { 字段: 值 }')
  }
  const fields: Record<string, string> = {}
  for (const [k, val] of Object.entries(p.fields)) {
    if (typeof val !== 'string') throw new Error(`params.fields.${k} 应为字符串`)
    fields[k] = val
  }
  return { id: p.id, fields }
}

/** jobs/create 入参校验（RPC 边界：用户输入校验，fail fast） */
function createJobParams(v: unknown): CreateJobParams {
  if (typeof v !== 'object' || v === null) throw new Error('jobs/create 需要 params { company, title, ... }')
  const p = v as Record<string, unknown>
  if (typeof p.company !== 'string' || p.company.length === 0) throw new Error('params.company 缺失（公司名）')
  if (typeof p.title !== 'string' || p.title.length === 0) throw new Error('params.title 缺失（岗位名）')
  const out: CreateJobParams = { company: p.company, title: p.title }
  for (const k of ['location', 'salary', 'jdSource', 'requirements', 'jdText'] as const) {
    if (p[k] !== undefined) {
      if (typeof p[k] !== 'string') throw new Error(`params.${k} 应为字符串`)
      out[k] = p[k] as string
    }
  }
  return out
}

/** jobs/get / jobs/match / jobs/delete / companies/get / companies/delete 的 id 提取（RPC 边界） */
function jobIdParams(v: unknown): string {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>).id !== 'string') {
    throw new Error('params.id 缺失')
  }
  return (v as Record<string, unknown>).id as string
}

/** jobs/extract 入参校验（RPC 边界：用户输入校验，fail fast） */
function extractJdParams(v: unknown): { jdText: string } {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>).jdText !== 'string') {
    throw new Error('jobs/extract 需要 params { jdText }')
  }
  const text = (v as Record<string, unknown>).jdText as string
  if (text.trim().length === 0) throw new Error('params.jdText 缺失（JD 原文）')
  return { jdText: text }
}

/** jobs/match：Job.responsibilities（capabilities 对齐源）→ computeGap → GapResult（Signal Layer：可解释匹配，不做百分比） */
export function computeJobMatch(workspace: Workspace, jobId: string, person: string): GapResult {
  const job = scanJobs(workspace).find((j) => j.record.id === jobId)
  if (!job) throw new Error(`岗位不存在：${jobId}`)
  const { skills } = scanKnowledge(workspace)
  const role = {
    id: job.record.id,
    name: job.record.title,
    company: job.record.company,
    // capabilities 为对齐源；迁移数据（capabilities 空）回退 statement——旧技能词等价旧行为；
    // 去重：ai capabilities 可能与 user statement 重叠（computeGap 的 missing 不去重）
    skills: (() => {
      const seen = new Set<string>()
      return job.record.responsibilities.flatMap((r) =>
        (r.capabilities.length > 0 ? r.capabilities : [r.statement]).map((name) => ({
          name,
          essential: r.priority === 'must',
          source: 'JD',
        })),
      ).filter((s) => {
        if (seen.has(s.name)) return false
        seen.add(s.name)
        return true
      })
    })(),
  }
  const personSkills = scanProfiles(workspace).find((p) => p.name === person)?.skills ?? []
  return computeGap({ role, person, personSkills, skills })
}

/** resume/export 入参校验（RPC 边界） */
function resumeHtmlParams(v: unknown): string {
  if (typeof v !== 'object' || v === null) throw new Error('resume/export 需要 params { html }')
  const p = v as Record<string, unknown>
  if (typeof p.html !== 'string' || p.html.length === 0) throw new Error('params.html 缺失（打印 HTML）')
  if (p.html.length > 500_000) throw new Error('params.html 过大（>500KB）')
  return p.html
}

/** 端口监听：EADDRINUSE → logger.warn + 端口 +1 重试，最多递增 MAX_PORT_RETRIES 次；其余错误立即抛 */
async function listenWithRetry(opts: { host: string; port: number; logger: Logger }): Promise<{ wss: WebSocketServer; port: number }> {
  const { host, port, logger } = opts
  for (let i = 0; i <= MAX_PORT_RETRIES; i++) {
    const target = port + i
    const wss = new WebSocketServer({ host, port: target })
    try {
      await new Promise<void>((resolve, reject) => {
        wss.once('listening', () => resolve())
        wss.once('error', reject)
      })
      return { wss, port: target }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE') throw err // 权限/地址等其他绑定错误 fail fast
      if (i === MAX_PORT_RETRIES) break
      logger.warn(`端口 ${target} 被占用（EADDRINUSE），递增重试 ${target + 1}`)
    }
  }
  throw new ServerError(`端口 ${port}-${port + MAX_PORT_RETRIES} 全部被占用，已递增重试 ${MAX_PORT_RETRIES} 次`)
}

/** agent/start 入参校验（RPC 边界：用户输入校验，fail fast） */
function agentStartParams(v: unknown): AgentStartParams {
  if (typeof v !== 'object' || v === null) throw new Error('agent/start 需要 params { task, ... }')
  const p = v as Record<string, unknown>
  if (typeof p.task !== 'string' || p.task.length === 0) throw new Error('params.task 缺失（任务指令）')
  const out: AgentStartParams = { task: p.task }
  if (p.context !== undefined) {
    if (typeof p.context !== 'string') throw new Error('params.context 应为字符串')
    out.context = p.context
  }
  if (p.resumeSessionId !== undefined) {
    if (typeof p.resumeSessionId !== 'string') throw new Error('params.resumeSessionId 应为字符串')
    out.resumeSessionId = p.resumeSessionId
  }
  if (p.permissionMode !== undefined) {
    if (!['acceptEdits', 'ask', 'bypassPermissions'].includes(p.permissionMode as string)) {
      throw new Error('params.permissionMode 应为 acceptEdits/ask/bypassPermissions')
    }
    out.permissionMode = p.permissionMode as AgentStartParams['permissionMode']
  }
  if (p.allowedTools !== undefined) {
    if (!Array.isArray(p.allowedTools) || p.allowedTools.some((t) => typeof t !== 'string')) {
      throw new Error('params.allowedTools 应为 string[]')
    }
    out.allowedTools = p.allowedTools as string[]
  }
  if (p.maxTurns !== undefined) {
    if (typeof p.maxTurns !== 'number' || p.maxTurns < 1) throw new Error('params.maxTurns 应为正整数')
    out.maxTurns = p.maxTurns
  }
  if (p.model !== undefined) {
    if (typeof p.model !== 'string') throw new Error('params.model 应为字符串')
    out.model = p.model
  }
  if (p.apiKey !== undefined) {
    if (typeof p.apiKey !== 'string') throw new Error('params.apiKey 应为字符串')
    out.apiKey = p.apiKey
  }
  if (p.baseUrl !== undefined) {
    if (typeof p.baseUrl !== 'string') throw new Error('params.baseUrl 应为字符串')
    try {
      new URL(p.baseUrl)
    } catch {
      throw new Error('params.baseUrl 应为合法 URL（如 https://api.anthropic.com）')
    }
    out.baseUrl = p.baseUrl
  }
  return out
}

/** settings/update 入参校验（RPC 边界：undefined = 不修改该字段） */
function settingsUpdateParams(v: unknown): {
  model?: string
  apiKey?: string
  baseUrl?: string
  enabled?: boolean
  providers?: AgentProvider[]
  permissionMode?: PermissionMode
  allowedTools?: string[]
  maxTurns?: number
  map?: { apiKey?: string; securityJsCode?: string }
} {
  if (typeof v !== 'object' || v === null) throw new Error('settings/update 需要 params 对象')
  const p = v as Record<string, unknown>
  const out: NonNullable<ReturnType<typeof settingsUpdateParams>> = {}
  if (p.model !== undefined) {
    if (typeof p.model !== 'string') throw new Error('params.model 应为字符串')
    out.model = p.model
  }
  if (p.apiKey !== undefined) {
    if (typeof p.apiKey !== 'string') throw new Error('params.apiKey 应为字符串')
    out.apiKey = p.apiKey
  }
  if (p.baseUrl !== undefined) {
    if (typeof p.baseUrl !== 'string') throw new Error('params.baseUrl 应为字符串')
    try {
      new URL(p.baseUrl)
    } catch {
      throw new Error('params.baseUrl 应为合法 URL（如 https://api.anthropic.com）')
    }
    out.baseUrl = p.baseUrl
  }
  if (p.enabled !== undefined) {
    if (typeof p.enabled !== 'boolean') throw new Error('params.enabled 应为布尔')
    out.enabled = p.enabled
  }
  if (p.providers !== undefined) {
    if (!Array.isArray(p.providers)) throw new Error('params.providers 应为数组')
    for (const item of p.providers) {
      if (typeof item !== 'object' || item === null) throw new Error('params.providers 每项应为对象')
      const pr = item as Record<string, unknown>
      if (typeof pr.id !== 'string' || pr.id.length === 0) throw new Error('params.providers[].id 应为非空字符串')
      if (pr.enabled !== undefined && typeof pr.enabled !== 'boolean') throw new Error('params.providers[].enabled 应为布尔')
      if (pr.models !== undefined && (!Array.isArray(pr.models) || pr.models.some((m) => typeof m !== 'string'))) {
        throw new Error('params.providers[].models 应为 string[]')
      }
    }
    out.providers = p.providers as AgentProvider[]
  }
  if (p.permissionMode !== undefined) {
    if (!['acceptEdits', 'ask', 'bypassPermissions'].includes(p.permissionMode as string)) {
      throw new Error('params.permissionMode 应为 acceptEdits/ask/bypassPermissions')
    }
    out.permissionMode = p.permissionMode as PermissionMode
  }
  if (p.allowedTools !== undefined) {
    if (!Array.isArray(p.allowedTools) || p.allowedTools.length === 0 || p.allowedTools.some((t) => typeof t !== 'string')) {
      throw new Error('params.allowedTools 应为非空 string[]')
    }
    out.allowedTools = p.allowedTools as string[]
  }
  if (p.maxTurns !== undefined) {
    if (typeof p.maxTurns !== 'number' || p.maxTurns < 1) throw new Error('params.maxTurns 应为正整数')
    out.maxTurns = p.maxTurns
  }
  if (p.map !== undefined) {
    if (typeof p.map !== 'object' || p.map === null || Array.isArray(p.map)) {
      throw new Error('params.map 应为对象 { apiKey?, securityJsCode? }')
    }
    const m = p.map as Record<string, unknown>
    if (m.apiKey !== undefined && typeof m.apiKey !== 'string') throw new Error('params.map.apiKey 应为字符串')
    if (m.securityJsCode !== undefined && typeof m.securityJsCode !== 'string') {
      throw new Error('params.map.securityJsCode 应为字符串')
    }
    out.map = {
      ...(m.apiKey !== undefined ? { apiKey: m.apiKey as string } : {}),
      ...(m.securityJsCode !== undefined ? { securityJsCode: m.securityJsCode as string } : {}),
    }
  }
  return out
}

/** settings/models 入参（可选）：临时 apiKey/baseUrl——未保存也能提取模型（「提取模型」按钮）；
 * 缺省用引擎配置 config.agent.apiKey/baseUrl */
function settingsModelsParams(v: unknown): { apiKey?: string; baseUrl?: string } {
  if (v === undefined || v === null) return {}
  const p = v as Record<string, unknown>
  const out: { apiKey?: string; baseUrl?: string } = {}
  if (p.apiKey !== undefined) {
    if (typeof p.apiKey !== 'string') throw new Error('params.apiKey 应为字符串')
    out.apiKey = p.apiKey
  }
  if (p.baseUrl !== undefined) {
    if (typeof p.baseUrl !== 'string') throw new Error('params.baseUrl 应为字符串')
    try {
      new URL(p.baseUrl)
    } catch {
      throw new Error('params.baseUrl 应为合法 URL（如 https://api.anthropic.com）')
    }
    out.baseUrl = p.baseUrl
  }
  return out
}

/** 可用模型列表：只从 API 提取（不预制）——有 apiKey 时探测端点拉真实可用模型；
 * 无 key（CLI 模式）→ 空列表（模型由 claude CLI 决定，UI 仅自由输入）。
 * 探测链（第三方兼容网关差异适配，外部 API 边界）：Anthropic 标准 /v1/models →
 * OpenAI 风格 /models → baseUrl 以 /anthropic 结尾时去掉后缀探测根 /models（DeepSeek 类网关：
 * 兼容端点无模型列表，原生端点有）。401/403 直接判定 Key 无效（其余路径必同结果），
 * 404/405 视为该路径不存在继续探测。 */
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com'

async function listAvailableModels(
  apiKey?: string,
  baseUrl?: string,
): Promise<{ source: 'api' | 'cli' | 'api_error'; models: string[]; error?: 'auth' | 'no_endpoint' | 'network' }> {
  if (apiKey === undefined || apiKey === '') return { source: 'cli', models: [] }
  const base = (baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const candidates = [
    `${base}/v1/models`,
    `${base}/models`,
    ...(base.endsWith('/anthropic') ? [`${base.slice(0, -'/anthropic'.length)}/models`] : []),
  ]
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers })
      if (res.ok) {
        const json = (await res.json()) as { data: { id: string }[] }
        if (Array.isArray(json.data)) return { source: 'api', models: json.data.map((m) => m.id) }
        return { source: 'api_error', models: [], error: 'no_endpoint' }
      }
      if (res.status === 401 || res.status === 403) return { source: 'api_error', models: [], error: 'auth' }
      if (res.status !== 404 && res.status !== 405) {
        return { source: 'api_error', models: [], error: 'no_endpoint' }
      }
    } catch {
      return { source: 'api_error', models: [], error: 'network' }
    }
  }
  return { source: 'api_error', models: [], error: 'no_endpoint' }
}

/** agent/answer|cancel|permission 的 taskId 提取（RPC 边界） */
function taskIdParams(v: unknown): string {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>).taskId !== 'string') {
    throw new Error('params.taskId 缺失')
  }
  return (v as Record<string, unknown>).taskId as string
}

/** agent/permission 的 requestId + allow 提取（RPC 边界） */
function permissionParams(v: unknown): { taskId: string; requestId: string; allow: boolean } {
  const taskId = taskIdParams(v)
  const p = v as Record<string, unknown>
  if (typeof p.requestId !== 'string' || p.requestId.length === 0) throw new Error('params.requestId 缺失')
  if (typeof p.allow !== 'boolean') throw new Error('params.allow 应为 boolean')
  return { taskId, requestId: p.requestId, allow: p.allow }
}

/**
 * Agent 技能身份注入：任务启动前引导 Agent 阅读技能文件（人设 + 协议来源）。
 * 不注入时模型仅凭 cwd 猜身份（曾出现把自己当成"公司分析助手"的开场白）。
 * 同时注入工作区初始化状态：SKILL.md 的首次检查依赖 CLAUDE_PROJECT_DIR 环境变量，
 * 引擎 spawn 的 CLI 进程未设置该变量 → Agent 会把已初始化工作区误判为"首次使用"，
 * 此处用真实文件状态直接覆盖该检查。
 */
function buildSkillIdentity(skillsDir: string, workspaceRoot: string): string {
  const indexExists = existsSync(join(workspaceRoot, 'INDEX.md'))
  const initState = indexExists
    ? `当前工作区已初始化（${join(workspaceRoot, 'INDEX.md')} 存在），直接跳过 SKILL.md 中的"首次运行检查"步骤。`
    : `当前工作区尚未初始化（缺 ${join(workspaceRoot, 'INDEX.md')}），按 SKILL.md 的"首次运行检查"执行初始化。`
  try {
    const skill = readFileSync(join(skillsDir, 'SKILL.md'), 'utf8')
    return [
      '你是 Career OS 的职业决策助手（技能：career-advisor）。',
      `你的完整协议与工作流程定义在技能文件 ${join(skillsDir, 'SKILL.md')}（本任务工作目录下可访问），开始处理任务前请先阅读它。`,
      initState,
      '技能概述（节选）：',
      skill.slice(0, 1500),
    ].join('\n')
  } catch {
    return `你是 Career OS 的职业决策助手，请依据工作区中的 profiles/、decisions/ 等数据为用户提供职业决策建议。${initState}`
  }
}

export async function startServer(opts: {
  config: EngineConfig
  workspace: Workspace
  logger: Logger
  store: BridgeStore
  runtime: DecisionRuntime
}): Promise<ServerHandle> {
  const { config, workspace, logger, store, runtime } = opts
  const { wss, port } = await listenWithRetry({ host: config.server.host, port: config.server.port, logger })

  // 事件广播（先定义：Agent 事件推送与监听器共用）
  const broadcast = (event: ServerEvent): void => {
    const payload = JSON.stringify(event)
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload)
    }
  }
  // Agent 事件推送：广播（个人工具单客户端；与 data.* 事件同语义）
  const agentRuntime = new AgentRuntime(logger, (taskId, ev) => {
    broadcast({ event: EVENTS.agentEvent, taskId, data: ev })
  })

  const handlers: Record<string, (params?: unknown) => unknown> = {
    [METHODS.init]: () => store.init(),
    [METHODS.listDecisions]: () => store.listDecisions(),
    [METHODS.rescan]: () => store.rescan(),
    [METHODS.updateDecision]: (params) => {
      const { id, fields } = updateDecisionParams(params)
      return updateDecisionFile(workspace, id, fields)
    },
    [METHODS.listCompanies]: () => store.listCompanies(),
    [METHODS.companyGet]: (params) => readCompanyFile(workspace, jobIdParams(params)),
    [METHODS.listPersons]: () => store.listPersons(),
    [METHODS.poolGraph]: () => store.graph(),
    [METHODS.chain]: () => computeChains(store.listDecisions() as DecisionRecord[], runtime),
    [METHODS.contexts]: () => listContexts(workspace, store),
    [METHODS.knowledgeGraph]: () => scanKnowledge(workspace),
    [METHODS.knowledgeGap]: (params) => computeKnowledgeGap(workspace, gapParams(params)),
    [METHODS.health]: () => generateHealthReport(workspace, store as ProjectionStore),
    [METHODS.resumeExport]: (params) => exportPdf(resumeHtmlParams(params)),
    [METHODS.agentStart]: (params) => {
      const p = agentStartParams(params)
      // 技能身份注入：人设 + 协议引导拼在任务前（不注入会因缺上下文导致身份漂移）
      const identity = buildSkillIdentity(config.paths.skills, workspace.paths.root)
      return {
        taskId: agentRuntime.start(
          { ...p, context: [identity, p.context].filter(Boolean).join('\n\n') },
          {
            permissionMode: config.agent.permissionMode,
            allowedTools: config.agent.allowedTools,
            maxTurns: config.agent.maxTurns,
            model: config.agent.enabled === false ? undefined : config.agent.model,
            apiKey: config.agent.enabled === false ? undefined : config.agent.apiKey,
            baseUrl: config.agent.enabled === false ? undefined : config.agent.baseUrl,
          },
          workspace.paths.root,
        ),
      }
    },
    [METHODS.settingsGet]: () => ({
      model: config.agent.model,
      apiKey: config.agent.apiKey,
      baseUrl: config.agent.baseUrl,
      enabled: config.agent.enabled !== false,
      providers: config.agent.providers,
      permissionMode: config.agent.permissionMode,
      allowedTools: config.agent.allowedTools,
      maxTurns: config.agent.maxTurns,
      map: config.map,
    }),
    [METHODS.settingsUpdate]: (params) => {
      const patch = settingsUpdateParams(params)
      // 更新内存（下次任务立即生效）
      if (patch.model !== undefined) config.agent.model = patch.model || undefined
      if (patch.apiKey !== undefined) config.agent.apiKey = patch.apiKey || undefined
      if (patch.baseUrl !== undefined) config.agent.baseUrl = patch.baseUrl || undefined
      if (patch.enabled !== undefined) config.agent.enabled = patch.enabled
      if (patch.providers !== undefined) config.agent.providers = patch.providers
      if (patch.permissionMode !== undefined) config.agent.permissionMode = patch.permissionMode
      if (patch.allowedTools !== undefined) config.agent.allowedTools = patch.allowedTools
      if (patch.maxTurns !== undefined) config.agent.maxTurns = patch.maxTurns
      if (patch.map !== undefined) config.map = { provider: config.map.provider, ...patch.map }
      // 写回 config.json（保持其他字段不动；空串 → 删除该字段）
      const full = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8')) as Record<string, unknown>
      const agent = (full.agent ?? {}) as Record<string, unknown>
      const { map: mapPatch, ...agentPatch } = patch
      for (const [k, v] of Object.entries(agentPatch)) {
        if (v === '') delete agent[k]
        else agent[k] = v
      }
      full.agent = agent
      // map 段独立写回（provider 保持不动，只更新 apiKey / securityJsCode）
      if (mapPatch) {
        const map = (full.map ?? { provider: 'amap' }) as Record<string, unknown>
        if (mapPatch.apiKey === '') delete map.apiKey
        else map.apiKey = mapPatch.apiKey
        if (mapPatch.securityJsCode === '') delete map.securityJsCode
        else map.securityJsCode = mapPatch.securityJsCode
        full.map = map
      }
      writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(full, null, 2) + '\n', 'utf8')
      return { ok: true }
    },
    [METHODS.settingsModels]: (params) => {
      const p = settingsModelsParams(params)
      return listAvailableModels(p.apiKey ?? config.agent.apiKey, p.baseUrl ?? config.agent.baseUrl)
    },
    [METHODS.agentAnswer]: (params) => {
      const taskId = taskIdParams(params) // 返回字符串，不可解构
      const p = params as Record<string, unknown>
      if (typeof p.text !== 'string' || p.text.length === 0) throw new Error('params.text 缺失（回答内容）')
      agentRuntime.answer(taskId, p.text)
      return {}
    },
    [METHODS.agentCancel]: (params) => {
      agentRuntime.cancel(taskIdParams(params))
      return {}
    },
    [METHODS.agentPermission]: (params) => {
      const { taskId, requestId, allow } = permissionParams(params)
      agentRuntime.permission(taskId, requestId, allow)
      return {}
    },
    [METHODS.rewriteFeedback]: (params) => {
      recordRewriteFeedback(join(config.paths.logs, 'feedback'), params)
      return {}
    },
    [METHODS.createJob]: (params) => {
      const job = createJobFile(workspace, createJobParams(params))
      // 建档联带占位公司（companies/ 无 watcher，显式广播；jobs 由 watchJobs 广播）
      broadcast({ event: EVENTS.companiesChanged })
      return job
    },
    [METHODS.deleteJob]: (params) => {
      deleteJobFile(workspace, jobIdParams(params))
      return {}
    },
    [METHODS.jobCoverage]: (params) => {
      const id = jobIdParams(params)
      const job = scanJobs(workspace).find((j) => j.record.id === id)
      if (!job) throw new Error(`岗位不存在：${id}`)
      return computeEvidenceCoverage(job.record, scanEvidence(workspace).map((e) => e.record))
    },
    [METHODS.listEvidence]: () => scanEvidence(workspace).map((e) => ({
      ...e.record,
      ...(e.validation ? { validation: e.validation } : {}),
    })),
    [METHODS.listClaims]: () => {
      const evidenceById = indexEvidence(scanEvidence(workspace).map((e) => e.record))
      return scanClaims(workspace).map((c) => ({
        ...c.record,
        usable: canUseClaim(c.record, evidenceById),
        ...(c.validation ? { validation: c.validation } : {}),
      }))
    },
    [METHODS.claimCoverage]: (params) => {
      const id = jobIdParams(params)
      const job = scanJobs(workspace).find((j) => j.record.id === id)
      if (!job) throw new Error(`岗位不存在：${id}`)
      return computeClaimCoverage(job.record, scanEvidence(workspace).map((e) => e.record), scanClaims(workspace).map((c) => c.record))
    },
    [METHODS.claimSelect]: (params) => {
      const id = jobIdParams(params)
      const job = scanJobs(workspace).find((j) => j.record.id === id)
      if (!job) throw new Error(`岗位不存在：${id}`)
      return selectExpressionCandidates(job.record, scanEvidence(workspace).map((e) => e.record), scanClaims(workspace).map((c) => c.record))
    },
    [METHODS.listResumes]: () => scanResumes(workspace).map((r) => ({
      ...r.record,
      ...(r.validation ? { validation: r.validation } : {}),
    })),
    [METHODS.getResume]: (params) => {
      const id = jobIdParams(params)
      const r = scanResumes(workspace).find((x) => x.record.id === id)
      if (!r) throw new Error(`简历版本不存在：${id}`)
      return r.record
    },
    [METHODS.cloneResume]: (params) => {
      const id = jobIdParams(params)
      const r = scanResumes(workspace).find((x) => x.record.id === id)
      if (!r) throw new Error(`简历版本不存在：${id}`)
      const clone = cloneResumeFile(workspace, r.record)
      broadcast({ event: EVENTS.resumesChanged })
      return clone
    },
    [METHODS.transitionResume]: (params) => {
      const p = params as Record<string, unknown>
      const id = jobIdParams(params)
      const target = p?.targetStatus
      if (typeof target !== 'string' || !['draft', 'review', 'exported', 'archived'].includes(target)) {
        throw new Error('params.targetStatus 缺失/非法（draft/review/exported/archived）')
      }
      const file = scanResumes(workspace).find((x) => x.record.id === id)?.sourceFile
      if (!file) throw new Error(`简历版本不存在：${id}`)
      const next = transitionResumeStatusFile(workspace, file, target as 'draft' | 'review' | 'exported' | 'archived', 'user')
      broadcast({ event: EVENTS.resumesChanged })
      return next
    },
    [METHODS.diffResumes]: (params) => {
      const p = params as Record<string, unknown>
      const a = typeof p?.a === 'string' ? p.a : ''
      const b = typeof p?.b === 'string' ? p.b : ''
      const ra = scanResumes(workspace).find((x) => x.record.id === a)?.record
      const rb = scanResumes(workspace).find((x) => x.record.id === b)?.record
      if (!ra || !rb) throw new Error('params.a/params.b 简历版本不存在')
      return diffResumes(ra, rb)
    },
    [METHODS.exportResume]: async (params) => {
      const id = jobIdParams(params)
      const r = scanResumes(workspace).find((x) => x.record.id === id)
      if (!r) throw new Error(`简历版本不存在：${id}`)
      const { result, record } = await exportResumePdf(r.record) // 失败抛错——不产生 exported 状态
      workspace.write(`resumes/exports/${record.id}.md`, serializeExportRecord(record))
      markResumeExported(workspace, r.sourceFile) // 绑定 ExportRecord 后系统流转 exported
      broadcast({ event: EVENTS.resumesChanged })
      return { result, record }
    },
    [METHODS.listProposals]: () => scanProposals(workspace).map((p) => ({
      ...p.record,
      ...(p.validation ? { validation: p.validation } : {}),
    })),
    [METHODS.acceptProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const { document } = acceptProposalFile(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.resumesChanged })
      broadcast({ event: EVENTS.proposalsChanged })
      return document
    },
    [METHODS.rejectProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const updated = rejectProposalFile(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.proposalsChanged })
      return updated
    },
    [METHODS.listPortfolioProjects]: () => scanPortfolioProjects(workspace).map((p) => ({
      ...p.record,
      ...(p.issues.length > 0 ? { issues: p.issues } : {}),
    })),
    [METHODS.listPortfolioProposals]: () => scanPortfolioProposals(workspace).map((p) => ({
      ...p.record,
      ...(p.issues.length > 0 ? { issues: p.issues } : {}),
    })),
    [METHODS.transitionPortfolio]: (params) => {
      const p = params as Record<string, unknown>
      const target = p?.targetStatus
      if (typeof target !== 'string' || !['draft', 'reviewed', 'published'].includes(target)) {
        throw new Error('params.targetStatus 缺失/非法（draft/reviewed/published）')
      }
      const updated = transitionPortfolioProject(workspace, jobIdParams(params), target as PortfolioStatus)
      broadcast({ event: EVENTS.portfolioChanged })
      return updated
    },
    [METHODS.acceptPortfolioProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const { project } = acceptPortfolioProposal(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.portfolioChanged })
      return project
    },
    [METHODS.rejectPortfolioProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const updated = rejectPortfolioProposal(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.portfolioChanged })
      return updated
    },
    [METHODS.listInterviewQas]: () => scanInterviewQas(workspace).map((q) => ({
      ...q.record,
      ...(q.issues.length > 0 ? { issues: q.issues } : {}),
    })),
    [METHODS.listInterviewProposals]: () => scanInterviewProposals(workspace).map((p) => ({
      ...p.record,
      ...(p.issues.length > 0 ? { issues: p.issues } : {}),
    })),
    [METHODS.transitionInterview]: (params) => {
      const p = params as Record<string, unknown>
      const target = p?.targetStatus
      if (typeof target !== 'string' || !['draft', 'reviewed', 'ready'].includes(target)) {
        throw new Error('params.targetStatus 缺失/非法（draft/reviewed/ready）')
      }
      const updated = transitionInterviewQa(workspace, jobIdParams(params), target as InterviewStatus)
      broadcast({ event: EVENTS.interviewChanged })
      return updated
    },
    [METHODS.acceptInterviewProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const { qa } = acceptInterviewProposal(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.interviewChanged })
      return qa
    },
    [METHODS.rejectInterviewProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const updated = rejectInterviewProposal(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.interviewChanged })
      return updated
    },
    [METHODS.listCoverLetters]: () => scanCoverLetters(workspace).map((c) => ({
      ...c.record,
      ...(c.issues.length > 0 ? { issues: c.issues } : {}),
    })),
    [METHODS.listCoverLetterProposals]: () => scanCoverLetterProposals(workspace).map((p) => ({
      ...p.record,
      ...(p.issues.length > 0 ? { issues: p.issues } : {}),
    })),
    [METHODS.transitionCoverLetter]: (params) => {
      const p = params as Record<string, unknown>
      const target = p?.targetStatus
      if (typeof target !== 'string' || !['draft', 'reviewed', 'ready'].includes(target)) {
        throw new Error('params.targetStatus 缺失/非法（draft/reviewed/ready）')
      }
      const updated = transitionCoverLetter(workspace, jobIdParams(params), target as CoverLetterStatus)
      broadcast({ event: EVENTS.coverLetterChanged })
      return updated
    },
    [METHODS.acceptCoverLetterProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const { coverLetter } = acceptCoverLetterProposal(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.coverLetterChanged })
      return coverLetter
    },
    [METHODS.rejectCoverLetterProposal]: (params) => {
      const p = params as Record<string, unknown>
      const reason = typeof p?.reason === 'string' && p.reason.trim().length > 0 ? p.reason : undefined
      const updated = rejectCoverLetterProposal(workspace, jobIdParams(params), reason)
      broadcast({ event: EVENTS.coverLetterChanged })
      return updated
    },
    [METHODS.aiContext]: (params) => {
      const p = params as Record<string, unknown> | undefined
      const jobId = typeof p?.jobId === 'string' ? p.jobId : undefined
      return buildCareerContext(workspace, jobId ? { jobId } : {})
    },
    [METHODS.deleteCompany]: (params) => {
      deleteCompanyFile(workspace, jobIdParams(params))
      broadcast({ event: EVENTS.companiesChanged })
      return {}
    },
    [METHODS.listJobs]: () => scanJobs(workspace).map((j) => ({
      ...j.record,
      ...(j.validation ? { validation: j.validation } : {}),
    })),
    [METHODS.getJob]: (params) => {
      const id = jobIdParams(params)
      const job = scanJobs(workspace).find((j) => j.record.id === id)
      if (!job) throw new Error(`岗位不存在：${id}`)
      return job.record
    },
    [METHODS.matchJob]: (params) => {
      const p = params as Record<string, unknown>
      if (typeof p?.person !== 'string' || p.person.length === 0) throw new Error('params.person 缺失（画像名）')
      return computeJobMatch(workspace, jobIdParams(params), p.person)
    },
    [METHODS.extractJd]: async (params) => ({
      result: await extractJdFields(extractJdParams(params).jdText, {
        cwd: workspace.paths.root,
        model: config.agent.model,
        logger,
      }),
    }),
  }

  function respond(ws: WebSocket, resp: RpcResponse): void {
    ws.send(JSON.stringify(resp))
  }

  wss.on('connection', (ws, req: IncomingMessage) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      logger.warn(`拒绝非本机连接：${req.socket.remoteAddress}`)
      ws.close(1008, '仅允许本机回环连接')
      return
    }

    ws.on('message', (raw) => {
      let msg: unknown
      try {
        msg = JSON.parse(String(raw))
      } catch {
        respond(ws, { id: '', error: { code: 'invalid_request', message: '非 JSON 帧' } })
        return
      }
      if (!isRpcRequest(msg)) {
        respond(ws, { id: '', error: { code: 'invalid_request', message: '缺少 id/method' } })
        return
      }
      const handler = handlers[msg.method]
      if (!handler) {
        respond(ws, { id: msg.id, error: { code: 'method_not_found', message: `未知方法 ${msg.method}` } })
        return
      }
      void (async () => {
        try {
          respond(ws, { id: msg.id, result: await handler(msg.params) })
        } catch (err) {
          logger.error(`RPC ${msg.method} 失败：${err instanceof Error ? err.message : String(err)}`)
          respond(ws, { id: msg.id, error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) } })
        }
      })()
    })
  })

  logger.info(`WebSocket 桥监听 ws://${config.server.host}:${port}`)

  return {
    port,
    broadcast,
    shutdown: () => agentRuntime.shutdown(),
  }
}
