import type { Company } from '../types'

/**
 * 公司引用解析：canonical exact → alias exact → undefined。
 * 禁止 substring/fuzzy——错误关联比无关联危险（模糊匹配会把「待尽调」伪装成「已尽调」）。
 * 与引擎侧 resolveCompany 同一语义（engine/storage/projection.ts）——消费端统一走登记解析，
 * 不自行发明匹配逻辑（Producer Ownership：关联靠 Agent 提议 + 引擎登记的 alias，不靠 UI 猜）。
 */
export function resolveCompanyReference<T extends Company>(companies: T[], ref: string): T | undefined {
  return companies.find((c) => c.name === ref) ?? companies.find((c) => c.aliases?.includes(ref))
}
