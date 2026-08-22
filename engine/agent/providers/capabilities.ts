/**
 * Provider Capability Registry（P2）：某连接具备什么 WebSearch 能力——注册表判定，不散落判断。
 *
 * 判定优先级（自上而下）：
 *  1. services 显式声明（capabilities.webSearch：'responses' | 'google' | 'off'——用户对本连接照实声明，
 *     未知网关也可显式指定走哪条实现；'auto'/缺省 = 继续推断）
 *  2. provider.id 别名（deepseek/openai/google；用于自定义 baseUrl 或 env 覆盖 baseUrl 后仍识别）
 *  3. baseUrl 域名规则（自定义服务商 id 是 custom-{ts}，不可靠——域名是稳定事实源）
 *  4. 未知 → 'off'（不假装有搜索能力：工具不注册，其余功能不受影响）
 *
 * 边界声明（不做假承诺）：
 * - anthropic：官方 Messages 线格式有服务端 web_search 工具（@ai-sdk/anthropic webSearch_2025x），
 *   但 DeepSeek /anthropic 端点不实现该工具、Anthropic 官方场景无真机验证——P2 不注册 anthropic 模式，
 *   待真机验证（有 key 环境）后补。DeepSeek 的联网搜索走其 Responses 兼容端点（'responses' 模式）。
 */
import type { AgentConnection } from '../../config.ts'

export type WebSearchMode = 'responses' | 'google' | 'off'

/** id 别名（覆盖 env 覆盖 baseUrl / 自定义端点仍命中的场景） */
const ID_ALIASES: Record<string, WebSearchMode> = {
  deepseek: 'responses',
  openai: 'responses',
  google: 'google',
}

/** baseUrl 域名规则（自定义服务商 id 不可控，域名是稳定事实源） */
const DOMAIN_RULES: Array<[RegExp, WebSearchMode]> = [
  [/api\.deepseek\.com/i, 'responses'],
  [/api\.openai\.com/i, 'responses'],
  [/generativelanguage\.googleapis\.com/i, 'google'],
]

/** 连接 → WebSearch 执行模式（Registry 唯一入口；'off' = 不注册 WebSearch 工具） */
export function webSearchModeOf(conn: AgentConnection): WebSearchMode {
  const declared = conn.capabilities?.webSearch
  if (declared !== undefined && declared !== 'auto') return declared
  const byId = conn.providerId !== undefined ? ID_ALIASES[conn.providerId] : undefined
  if (byId !== undefined) return byId
  if (conn.baseUrl !== undefined) {
    for (const [re, mode] of DOMAIN_RULES) {
      if (re.test(conn.baseUrl)) return mode
    }
  }
  return 'off'
}
