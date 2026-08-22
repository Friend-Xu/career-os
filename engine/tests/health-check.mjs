/**
 * 一键 Provider 健康检查（ADR-030 Phase 0.5 真机版）：
 * node tests/health-check.mjs → 打印 AgentHealth（provider/model/status/latency）
 * 用途：验收 A 步（Provider Smoke Test）——不需要开 UI 就能验证 DeepSeek 链路。
 */
import { loadConfig, REPO_ROOT } from '../config.ts'
import { checkAgentHealth } from '../runtime/agent-health.ts'
import { createLogger } from '../logger.ts'
import { join } from 'node:path'

const { config, configPath } = loadConfig([])
const logger = createLogger({ logsDir: join(REPO_ROOT, 'logs') }) // 复用引擎日志目录
const health = await checkAgentHealth(config, logger)
console.log('┌──────────────────────────────┐')
console.log('│ Agent LLM 链路健康检查（真机） │')
console.log('└──────────────────────────────┘')
console.log(`配置文件：${configPath}`)
console.log(`服务商   ：${health.provider}`)
console.log(`模型     ：${health.model}`)
if (health.baseUrl) console.log(`端点     ：${health.baseUrl}`)
console.log(`凭据来源 ：${health.credentialSource ?? '-'}（env = 环境变量覆盖；config = config.json 登记）`)
console.log(`状态     ：${health.status}${health.latencyMs !== undefined ? `（${health.latencyMs}ms）` : ''}`)
if (health.error) console.log(`错误     ：${health.error}`)
// 用 exitCode 让 Node 自然退出（Windows 上 process.exit + undici keep-alive 有 teardown 断言毛刺）
process.exitCode = health.status === 'ready' ? 0 : 1
