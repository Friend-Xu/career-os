/**
 * evidence-policy：消费者策略——trusted 过滤进公共 Guard（M2 裁决 #15）。
 * 简历定制/面试准备等消费者统一走此函数，禁止自行过滤（规则进代码，不靠消费者自律）。
 */
import type { EvidenceItem } from '../ir/schema.ts'

export type EvidenceConsumer = 'resume' | 'interview'

/** 条目是否可被消费者读取：MVP 仅 trusted（可表达授权——raw/candidate 不得提级）。
 *  consumer 参数预留：未来简历/面试策略可差异化（如面试可读 trusted+部分 candidate 作故事线素材）。 */
export function canConsumeEvidence(item: EvidenceItem, _consumer: EvidenceConsumer): boolean {
  return item.status === 'trusted'
}
