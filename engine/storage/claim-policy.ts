/**
 * claim-policy：Claim 消费策略——Claim 没有可信度，只有可消费性（M3-0 冻结 #6）。
 * canUseClaim 从证据继承推导：provenance 全部 evidence 满足 canConsumeEvidence 才可消费。
 * - 证据 archived / 删除 → Claim 自动不可用（无孤儿维护、无迁移）
 * - provenance 为空 → 恒 false（Claim 不脱离证据；即使 every 对空数组为 true 也强制拦截）
 * - 消费者统一走此函数，禁止自行过滤（规则进代码，不靠消费者自律）
 */
import type { CareerClaim, EvidenceItem } from '../ir/schema.ts'
import { canConsumeEvidence } from './evidence-policy.ts'

export function canUseClaim(claim: CareerClaim, evidenceById: ReadonlyMap<string, EvidenceItem>): boolean {
  if (claim.provenance.length === 0) return false
  return claim.provenance.every((p) => {
    const item = evidenceById.get(p.evidenceId)
    return item ? canConsumeEvidence(item, 'resume') : false
  })
}

/** 构建 evidenceId → item 索引（扫描结果 → Map；canUseClaim 每次实时推导，不缓存） */
export function indexEvidence(items: EvidenceItem[]): ReadonlyMap<string, EvidenceItem> {
  return new Map(items.map((e) => [e.id, e]))
}
