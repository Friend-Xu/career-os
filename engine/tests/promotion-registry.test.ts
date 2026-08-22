import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { createPersonSession, resolveCandidate } from '../storage/person-watcher.ts'
import { projectPersonSnapshots } from '../storage/person-snapshot-projection.ts'
import { cityCandidateId, cityCandidatesOf, createCityPromotion, parseCityCandidateId, revokePromotion, scanPromotions } from '../storage/promotion-registry.ts'
import { personHealth } from '../health/person-health.ts'

let wsSeq = 0
function testWorkspace(): Workspace {
  wsSeq++
  return initWorkspace(`.local/ws-promo-test-${Date.now()}-${wsSeq}`)
}

const PERSON = () => {
  const ws = testWorkspace()
  const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
  writeCityDecision(ws)
  return { ws, pid: personId }
}

/** 城市评估决策（skill=city-advisor + 城市评估明细 payload；苏州/上海 候选） */
function writeCityDecision(ws: Workspace): void {
  ws.write(
    'decisions/2026-08-22-城市评估.md',
    [
      '# 甲 — 城市评估：苏州/上海对比',
      '',
      '## 分析摘要',
      '',
      '| 字段 | 值 |',
      '|------|-----|',
      '| skill | city-advisor |',
      '| direction | 机器人 |',
      '| direction_match | 85% |',
      '| direction_confidence | 高 |',
      '| city | City-X |',
      '| city_score | 8.2/10 |',
      '| salary_feasible | true |',
      '| risk_level | 低 |',
      '| key_risk | 数据有限 |',
      '| status | complete |',
      '| protocol_version | 2.8 |',
      '| profile | 甲 |',
      '',
      '## 城市评估明细',
      '',
      '| 城市 | 得分 | 置信度 | 优势 | 风险 |',
      '|------|------|--------|------|------|',
      '| 苏州 | 8.5/10 | 高 | 产业/薪资 | 通勤/房价 |',
      '| 上海 | 7.8/10 | 中 | 机会多 | 竞争激烈 |',
      '',
    ].join('\n'),
  )
}

// ─── candidateId 派生/解析 ──────────────────────────────────────────────

test('candidateId：city:{城市名} 派生 + 解析防误判（仅 city: 前缀）+ 决策候选集合', () => {
  assert.equal(cityCandidateId('苏州'), 'city:苏州')
  assert.equal(parseCityCandidateId('city:苏州'), '苏州')
  assert.equal(parseCityCandidateId('role:机器人'), undefined)
  assert.equal(parseCityCandidateId('city:'), undefined)
  assert.deepEqual(
    cityCandidatesOf({ payload: { type: 'city', cities: [{ name: '苏州' }, { name: '上海' }] } }),
    ['苏州', '上海'],
  )
  assert.deepEqual(cityCandidatesOf({ city: '苏州' }), ['苏州']) // 旧协议：单 city 整串
  assert.deepEqual(cityCandidatesOf({ city: undefined }), [])
})

// ─── create / 幂等 / 拒绝 ──────────────────────────────────────────────

test('createCityPromotion：决策候选命中 → 登记 promo_001（actor=user/active/provenance）；同候选幂等', () => {
  const { ws, pid } = PERSON()
  const e = createCityPromotion(ws, { personId: pid, decisionId: '2026-08-22-城市评估', city: '苏州' })!
  assert.equal(e.id, 'promo_001')
  assert.equal(e.candidateId, 'city:苏州')
  assert.equal(e.actor, 'user')
  assert.equal(e.status, 'active')
  assert.ok(e.provenance.confirmedAt)
  assert.equal(scanPromotions(ws, pid).length, 1)
  // 幂等：同决策同候选 active → 返回现有（不重复登记）
  const again = createCityPromotion(ws, { personId: pid, decisionId: '2026-08-22-城市评估', city: '苏州' })!
  assert.equal(again.id, 'promo_001')
  assert.equal(scanPromotions(ws, pid).length, 1)
})

test('createCityPromotion：非法输入拒绝（城市不在候选/决策不存在）→ null', () => {
  const { ws, pid } = PERSON()
  assert.equal(createCityPromotion(ws, { personId: pid, decisionId: '2026-08-22-城市评估', city: '杭州' }), null)
  assert.equal(createCityPromotion(ws, { personId: pid, decisionId: '2026-08-22-不存在', city: '苏州' }), null)
  assert.equal(scanPromotions(ws, pid).length, 0)
})

// ─── revoke（状态翻转，不删除）────────────────────────────────────────

test('revokePromotion：active→revoked + revokedAt 保留文件；已 revoked 幂等', () => {
  const { ws, pid } = PERSON()
  const e = createCityPromotion(ws, { personId: pid, decisionId: '2026-08-22-城市评估', city: '苏州' })!
  const r = revokePromotion(ws, { personId: pid, promotionId: e.id })!
  assert.equal(r.status, 'revoked')
  assert.ok(r.revokedAt)
  assert.equal(scanPromotions(ws, pid).length, 1) // 文件保留（History immutable）
  const again = revokePromotion(ws, { personId: pid, promotionId: e.id })!
  assert.equal(again.status, 'revoked') // 幂等
})

// ─── 投影：Authority Resolution Order（active promotion > 候选载荷；revoke 回退）──

test('投影 city 权威顺序：无 promotion → 载荷；active promotion（上海）覆盖载荷（苏州）；revoke 回退', () => {
  const { ws, pid } = PERSON()
  // 候选：载荷 city=苏州（确认）
  ws.write(
    `persons/${pid}/extraction/candidates.md`,
    [
      '# Extraction Candidates',
      '',
      '| id | status | category | content | source | payload |',
      '|----|--------|----------|---------|--------|---------|',
      '| c-001 | pending | 约束 | 期望苏州 | user_reported | 城市=苏州；薪资=11-13K |',
      '',
    ].join('\n'),
  )
  resolveCandidate(ws, { personId: pid, candidateId: 'c-001', action: 'confirmed' })
  projectPersonSnapshots(ws, pid)
  const pref = () => ws.read(`persons/${pid}/snapshot/current/preference_constraints.md`)
  assert.ok(pref().includes('| city | 苏州 |'))

  // promotion 设上海（决策候选内）→ 覆盖（Authority Resolution Order）
  createCityPromotion(ws, { personId: pid, decisionId: '2026-08-22-城市评估', city: '上海' })
  projectPersonSnapshots(ws, pid)
  assert.ok(pref().includes('| city | 上海 |'), 'active promotion 应覆盖候选载荷')
  assert.ok(!pref().includes('| city | 苏州 |'))

  // revoke → 回退候选载荷
  const promo = scanPromotions(ws, pid)[0]!
  revokePromotion(ws, { personId: pid, promotionId: promo.id })
  projectPersonSnapshots(ws, pid)
  assert.ok(pref().includes('| city | 苏州 |'), 'revoke 后应回退下一权威层（候选载荷）')
})

// ─── Health 联动（H2 联合信息 + H4）────────────────────────────────────

test('health：active promotion 存在但投影缺失 → H2（refs 联合信息）；candidateId 非法 → H4', () => {
  const { ws, pid } = PERSON()
  // 无候选 → 投影 preference 缺失（projectPreference null）→ promotion 投影链断裂
  const e = createCityPromotion(ws, { personId: pid, decisionId: '2026-08-22-城市评估', city: '苏州' })!
  projectPersonSnapshots(ws, pid)
  let h = personHealth(ws, pid)!
  const h2 = h.checks.find((c) => c.id === 'H2-promo-promo_001')
  assert.ok(h2, 'active promotion 无投影应报 H2')
  assert.deepEqual(h2!.refs, ['promotion:promo_001', 'projection:preference.city'])

  // candidateId 非法（引擎派生形态被篡改）→ H4
  ws.write(`persons/${pid}/promotions/${e.id}.md`, ws.read(`persons/${pid}/promotions/${e.id}.md`).replace('candidate_id: city:苏州', 'candidate_id: role:机器人'))
  h = personHealth(ws, pid)!
  assert.ok(h.checks.some((c) => c.type === 'H4' && c.id === 'H4-promo-promo_001'))
})
