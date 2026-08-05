import type { DecisionStatus } from './schema.ts'

const LEGACY_MAP: Record<string, DecisionStatus> = {
  evaluating: 'exploring', // 分析中 = 尚未形成用户裁决
  decided: 'accepted',
  reviewing: 'revisiting',
}

/**
 * Decision Status 归一化（Contract v1）：
 * 4 值直通；legacy 值（evaluating/decided/reviewing）映射到 4 值；
 * 未知值 → exploring（默认探索态）。原始记录不修改——只影响解析/消费层。
 */
export function normalizeDecisionStatus(s: string | undefined): DecisionStatus {
  if (s === 'exploring' || s === 'accepted' || s === 'rejected' || s === 'revisiting') return s
  return (s !== undefined && LEGACY_MAP[s]) || 'exploring'
}
