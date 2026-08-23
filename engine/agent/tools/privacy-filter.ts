/**
 * 外发查询隐私红线（共享正则，Tool Runtime 第二阶段）：手机号/邮箱/身份证。
 * - 所有 egress='external' 的工具（hosted 搜索 / MCP / data）执行前必须过此检查——
 *   用户事实不出境是统一治理规则，不在各工具内各自发明。
 * - 拒绝语义由各工具的 PolicyError 呈现（web_search → SearchPolicyError、exa → ExaPolicyError），
 *   本模块只提供唯一正则事实源。
 */
export const PRIVACY_PATTERN =
  /(1[3-9]\d{9})|(\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]?)|([\w.+-]+@[\w-]+\.[\w.]+)/
