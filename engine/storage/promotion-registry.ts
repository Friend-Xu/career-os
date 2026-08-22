/**
 * Promotion Registry（ADR-032 Decision Promotion Flow——Accepted 冻结，v0.4.2）
 *
 * Promotion = 「用户从 Decision Artifact 选定候选」的领域事件：
 *   Decision Artifact（AI 建议）→ User Confirm（唯一触发者）→ Promotion Event → Domain Projection
 *
 * - **candidateId Authority**：候选 id 由引擎从 Decision 派生（`city:{城市名}`），客户端不可输入
 *   （create 仅收 decisionId+candidateId，引擎校验候选命中决策集合——防伪造：{苏州,上海} 与 {杭州} → 拒绝）
 * - **actor 恒 user**（引擎硬编码；Promotion RPC 不在 Agent 协议白名单——Agent Tool Call 禁止创建）
 * - **revoke = 状态翻转**（active→revoked），不删除历史（History immutable；投影只消费 active）
 * - 存储：persons/{personId}/promotions/promo_XXX.md（引擎登记，append-only）
 */
import type { Workspace } from './workspace.ts'
import type { PromotionEvent } from '../ir/schema.ts'
import { scanDecisions } from './report-watcher.ts'
import { splitFrontmatter } from './artifact-registry.ts'

export const CITY_PREFIX = 'city:'

/** 城市候选稳定 id（引擎派生；客户端不可输入） */
export function cityCandidateId(city: string): string {
  return CITY_PREFIX + city.trim()
}

/** candidateId → 城市名（前缀不符/空 → undefined——H4 判定输入） */
export function parseCityCandidateId(id: string): string | undefined {
  return id.startsWith(CITY_PREFIX) && id.length > CITY_PREFIX.length ? id.slice(CITY_PREFIX.length) : undefined
}

/** 决策的城市候选集合（与 cities-view 派生保持一致：payload.cities 优先；旧协议单 city 整串） */
export function cityCandidatesOf(record: { city?: string; payload?: { type?: string; cities?: { name?: string }[] } }): string[] {
  const cities = record.payload?.cities
  if (record.payload?.type === 'city' && cities && cities.length > 0) {
    return cities.map((c) => (c.name ?? '').trim()).filter(Boolean)
  }
  return record.city?.trim() ? [record.city.trim()] : []
}

/** 按 id 查决策（record.id 稳定标识；personId 归属校验由调用层） */
function findDecision(ws: Workspace, decisionId: string): { id: string; personId?: string; skill?: string; city?: string; payload?: { type?: string; cities?: { name?: string }[] } } | undefined {
  return scanDecisions(ws).map((p) => p.record).find((r) => r.id === decisionId)
}

/** promotions/{personId}/promo_XXX.md → PromotionEvent（非法文件 → null） */
function parsePromotionFile(md: string): PromotionEvent | null {
  const { meta } = splitFrontmatter(md)
  const id = meta['id']
  const decisionId = meta['decision_id']
  const candidateId = meta['candidate_id']
  const type = meta['type']
  const actor = meta['actor']
  const personId = meta['person_id']
  const domain = meta['domain']
  const status = meta['status']
  const confirmedAt = meta['confirmed_at']
  const revokedAt = meta['revoked_at']
  if (!id || !decisionId || !candidateId || !personId || !confirmedAt) return null
  if (type !== 'city_choice' || actor !== 'user' || domain !== 'preference.city') return null
  if (status !== 'active' && status !== 'revoked') return null
  return {
    id,
    decisionId,
    candidateId,
    type,
    actor,
    target: { personId, domain },
    status,
    provenance: { confirmedAt },
    ...(revokedAt ? { revokedAt } : {}),
  }
}

/** persons/{personId}/promotions/ 扫描（目录缺 → 空；非法文件跳过） */
export function scanPromotions(ws: Workspace, personId: string): PromotionEvent[] {
  const rel = `persons/${personId}/promotions`
  if (!ws.exists(rel)) return []
  const out: PromotionEvent[] = []
  for (const f of ws.listMarkdown(rel).sort()) {
    try {
      const p = parsePromotionFile(ws.read(`${rel}/${f}`))
      if (p) out.push(p)
    } catch {
      /* 非法文件跳过 */
    }
  }
  return out
}

function promotionFile(p: PromotionEvent): string {
  const meta: string[] = ['---']
  meta.push(`id: ${p.id}`)
  meta.push(`decision_id: ${p.decisionId}`)
  meta.push(`candidate_id: ${p.candidateId}`)
  meta.push(`type: ${p.type}`)
  meta.push(`actor: ${p.actor}`)
  meta.push(`person_id: ${p.target.personId}`)
  meta.push(`domain: ${p.target.domain}`)
  meta.push(`status: ${p.status}`)
  meta.push(`confirmed_at: ${p.provenance.confirmedAt}`)
  if (p.revokedAt) meta.push(`revoked_at: ${p.revokedAt}`)
  meta.push('---', '', `# Promotion ${p.id}`, '', `- 决策：${p.decisionId}`, `- 候选：${p.candidateId}`, `- 类型：${p.type === 'city_choice' ? '城市选定（city_choice）' : p.type}`, '')
  return meta.join('\n')
}

/** 下一 promo 序号（promo_001 起；无目录 → 001） */
function nextPromoSeq(ws: Workspace, personId: string): number {
  const rel = `persons/${personId}/promotions`
  if (!ws.exists(rel)) return 1
  let max = 0
  for (const f of ws.listMarkdown(rel)) {
    const m = f.match(/^promo_(\d+)\.md$/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/**
 * 创建城市选定 Promotion（用户动作；决策驱动 + candidateId 校验；同决策同候选 active → 幂等返回现有）。
 * decisionId+city 经 cityCandidateId 校验必须命中决策候选集合——不信任客户端（candidateId Authority）。
 * 返回 null = 非法输入（决策不存在/非城市决策/城市不在候选集/人员不匹配）。
 */
export function createCityPromotion(
  ws: Workspace,
  params: { personId: string; decisionId: string; city: string; timestamp?: string },
): PromotionEvent | null {
  const { personId, decisionId, city } = params
  const decision = findDecision(ws, decisionId)
  if (!decision || decision.skill !== 'city-advisor' && !(decision.payload?.type === 'city')) return null
  const candidates = cityCandidatesOf(decision)
  const name = city.trim()
  if (!name || !candidates.includes(name)) return null
  // 归属校验（ADR-013：决策 person_id 与目标 person 一致）
  if (decision.personId && decision.personId !== personId) return null

  const existing = scanPromotions(ws, personId).find((p) => p.status === 'active' && p.decisionId === decisionId && p.candidateId === cityCandidateId(name))
  if (existing) return existing

  const seq = nextPromoSeq(ws, personId)
  const id = `promo_${String(seq).padStart(3, '0')}`
  const event: PromotionEvent = {
    id,
    decisionId,
    candidateId: cityCandidateId(name),
    type: 'city_choice',
    actor: 'user',
    target: { personId, domain: 'preference.city' },
    status: 'active',
    provenance: { confirmedAt: params.timestamp ?? new Date().toISOString() },
  }
  const rel = `persons/${personId}/promotions`
  if (!ws.exists(rel)) ws.write(`${rel}/.keep`, '')
  ws.write(`${rel}/${id}.md`, promotionFile(event))
  return event
}

/** 撤销（active→revoked；幂等：已 revoked → 返回现有；不存在 → null） */
export function revokePromotion(ws: Workspace, params: { personId: string; promotionId: string; timestamp?: string }): PromotionEvent | null {
  const existing = scanPromotions(ws, params.personId).find((p) => p.id === params.promotionId)
  if (!existing) return null
  if (existing.status === 'revoked') return existing
  const revoked: PromotionEvent = {
    ...existing,
    status: 'revoked',
    revokedAt: params.timestamp ?? new Date().toISOString(),
  }
  const rel = `persons/${params.personId}/promotions`
  // 不删除文件（History immutable）——写回状态翻转
  ws.write(`${rel}/${existing.id}.md`, promotionFile(revoked))
  return revoked
}
