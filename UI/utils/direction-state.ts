/**
 * 方向状态派生（单一事实源）——城市视图/导航/Next Action/Today KPI/顶栏/画像视图统一消费。
 *
 * 背景：career-path 多方向评估按 v2.8 业务协议，摘要表 direction 填 `-`
 * （多方向明细进 `## 方向评估明细` 段落 → payload.type='direction'），引擎解析后
 * record.direction = undefined。因此「方向是否已确定」不能只看某条决策的 direction：
 * 后续决策（公司筛选/JD 分析等）direction 为空是常态，会错误覆盖方向已探索的事实。
 * 判定必须聚合两种证据：
 *   1. 任一决策 direction 非空且 ≠ '方向待定'（如城市评估携带的方向口径）
 *   2. 任一决策 payload.type === 'direction'（方向探索评估明细）
 */
import type { DecisionView } from '../store/engine-client'
import { belongsToPerson } from './ownership'

/** 单条决策是否携带方向证据（摘要 direction 或 v2.8 方向评估明细） */
export function hasDirectionEvidence(d: DecisionView): boolean {
  return Boolean((d.direction && d.direction !== '方向待定') || d.payload?.type === 'direction')
}

/** 某人方向是否已确定：任一决策携带方向证据（方向探索完成后不因后续决策回退） */
export function hasPersonDirection(
  decisions: DecisionView[],
  person: { personId?: string; name: string },
): boolean {
  return decisions.some((d) => belongsToPerson(d, person) && hasDirectionEvidence(d))
}

/** 最新方向值：优先最新方向探索明细（主方向 = 匹配度最高），回退最新非空 direction（跨决策） */
export function latestPersonDirection(
  decisions: DecisionView[],
  person: { personId?: string; name: string },
): string | undefined {
  const mine = decisions.filter((d) => belongsToPerson(d, person))
  if (mine.length === 0) return undefined
  const sorted = [...mine].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  const explore = sorted.find((d) => d.payload?.type === 'direction' && d.payload.directions.length > 0)
  if (explore?.payload?.type === 'direction') {
    return [...explore.payload.directions].sort((a, b) => b.match - a.match)[0].name
  }
  return sorted.find((d) => d.direction && d.direction !== '方向待定')?.direction
}
