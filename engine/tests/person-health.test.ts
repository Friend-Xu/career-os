import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { createPersonSession, resolveCandidate } from '../storage/person-watcher.ts'
import { projectPersonSnapshots } from '../storage/person-snapshot-projection.ts'
import { listPersonHealths, personHealth } from '../health/person-health.ts'

let wsSeq = 0
function testWorkspace(): Workspace {
  wsSeq++
  return initWorkspace(`.local/ws-health-test-${Date.now()}-${wsSeq}`)
}

/** 写候选（6 列带 payload；格式对齐 extraction/candidates.md） */
function seedCandidates(ws: Workspace, personId: string, rows: string[]): void {
  ws.write(`persons/${personId}/extraction/candidates.md`, [
    '# Extraction Candidates',
    '',
    '| id | status | category | content | source | payload |',
    '|----|--------|----------|---------|--------|---------|',
    ...rows,
    '',
  ].join('\n'))
}

const PERSON = () => {
  const ws = testWorkspace()
  const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
  return { ws, pid: personId }
}

/** 健康 person：教育/经历/技能/约束 全带载荷确认 + 投影 */
function seedHealthy(ws: Workspace, pid: string): void {
  seedCandidates(ws, pid, [
    '| c-001 | pending | 教育 | 某大学机械本科 2019-2023 | user_reported | 学校=某大学；专业=机械工程；学历=本科；起=2019；止=2023 |',
    '| c-002 | pending | 经历 | 某公司 结构工程师 2020-2023 | user_reported | 公司=某公司；岗位=结构工程师；起=2020；止=2023 |',
    '| c-003 | pending | 技能 | 结构设计 | user_reported | 技能=结构设计；级别=胜任；场景=整机设计 |',
    '| c-004 | pending | 约束 | 期望苏州，11-13K | user_reported | 意向岗位=结构工程师；薪资=11-13K；城市=苏州 |',
  ])
  for (const c of ['c-001', 'c-002', 'c-003', 'c-004']) {
    resolveCandidate(ws, { personId: pid, candidateId: c, action: 'confirmed' })
  }
  projectPersonSnapshots(ws, pid)
}

// ─── healthy：链路自洽 ──────────────────────────────────────────────────

test('personHealth：完整带载荷确认 + 投影 → healthy（四件一致，零检查）', () => {
  const { ws, pid } = PERSON()
  seedHealthy(ws, pid)
  const h = personHealth(ws, pid)!
  assert.equal(h.verdict, 'healthy')
  assert.deepEqual(h.checks, [])
})

// ─── H2 缺关键投影（事故现场形态）──────────────────────────────────────

test('personHealth：confirmed 约束候选无载荷 → H2 规范键缺失（warning）', () => {
  const { ws, pid } = PERSON()
  seedCandidates(ws, pid, ['| c-001 | pending | 约束 | 期望苏州，11-13K | user_reported |'])
  resolveCandidate(ws, { personId: pid, candidateId: 'c-001', action: 'confirmed' })
  projectPersonSnapshots(ws, pid)
  const h = personHealth(ws, pid)!
  assert.equal(h.verdict, 'warning')
  const h2 = h.checks.find((c) => c.id === 'H2-pref-nokeys')
  assert.ok(h2, '应报 H2 规范键缺失')
  assert.equal(h2!.type, 'H2')
})

// ─── H3 双写不一致 ─────────────────────────────────────────────────────

test('personHealth：投影文件被改动 → H3 同源重投影不一致（warning）', () => {
  const { ws, pid } = PERSON()
  seedHealthy(ws, pid)
  const rel = `persons/${pid}/snapshot/current/preference_constraints.md`
  ws.write(rel, ws.read(rel).replace('11-13K', '99-100K'))
  const h = personHealth(ws, pid)!
  assert.equal(h.verdict, 'warning')
  const h3 = h.checks.find((c) => c.id === 'H3-preference_constraints.md')
  assert.ok(h3, '应报 H3 内容不一致')
})

// ─── H1 孤儿/断裂 ──────────────────────────────────────────────────────

test('personHealth：确认事实但快照缺失 → H1 无投影消费者（warning）', () => {
  const { ws, pid } = PERSON()
  seedCandidates(ws, pid, ['| c-001 | pending | 技能 | 结构设计 | user_reported | 技能=结构设计；级别=胜任；场景=整机设计 |'])
  resolveCandidate(ws, { personId: pid, candidateId: 'c-001', action: 'confirmed' })
  // 不调用投影器：快照缺失
  const h = personHealth(ws, pid)!
  assert.equal(h.verdict, 'warning')
  assert.ok(h.checks.some((c) => c.id === 'H1-skill_inventory.md-missing'))
})

test('personHealth：快照残留但事实源已无 → H1 stale（warning）', () => {
  const { ws, pid } = PERSON()
  ws.write(`persons/${pid}/snapshot/current/identity.md`, '# 残留\n')
  const h = personHealth(ws, pid)!
  assert.equal(h.verdict, 'warning')
  assert.ok(h.checks.some((c) => c.id === 'H1-identity.md-stale'))
})

// ─── H4 生命周期非法态 ─────────────────────────────────────────────────

test('personHealth：career_profile source=user 无事实源 → H4 幽灵事实（error）', () => {
  const { ws, pid } = PERSON()
  ws.write(`persons/${pid}/snapshot/current/career_profile.md`, [
    '# 职业目标',
    '',
    '## User Career Intent',
    '',
    '| target_role | priority | source |',
    '|-------------|----------|--------|',
    '| 机器人设计 | medium | user |',
    '',
  ].join('\n'))
  const h = personHealth(ws, pid)!
  assert.equal(h.verdict, 'error')
  assert.ok(h.checks.some((c) => c.type === 'H4' && c.id === 'H4-role-机器人设计'))
})

// ─── 全量 ──────────────────────────────────────────────────────────────

test('listPersonHealths：多 person → 按 id 排序全量清单', () => {
  const { ws, pid } = PERSON()
  const second = createPersonSession(ws, { name: '乙', sourceMode: 'interview' })
  seedHealthy(ws, pid)
  const list = listPersonHealths(ws)
  assert.equal(list.length, 2)
  assert.ok(list.some((h) => h.personId === second.personId))
  assert.equal(list.find((h) => h.personId === pid)!.verdict, 'healthy')
})
