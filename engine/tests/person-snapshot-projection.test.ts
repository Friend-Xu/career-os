import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { createPersonSession, resolveCandidate, scanPersons } from '../storage/person-watcher.ts'
import { projectPersonSnapshots, parseSkillPayload, parseConstraintPayload } from '../storage/person-snapshot-projection.ts'

let wsSeq = 0
function testWorkspace(): Workspace {
  wsSeq++
  return initWorkspace(`.local/ws-proj-test-${Date.now()}-${wsSeq}`)
}

/** 写候选（6 列带 payload；格式对齐 extraction/candidates.md） */
function seedCandidates(
  ws: Workspace,
  personId: string,
  rows: string[],
): void {
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

// ─── 投影：identity.md ← facts/education + facts/experience ─────────────

test('投影 identity.md：确认教育候选 → facts/education 登记 + identity.md 实时出现（确认一条归位一条）', () => {
  const { ws, pid } = PERSON()
  seedCandidates(ws, pid, ['| c-001 | pending | 教育 | 某大学机械本科 2019-2023 | user_reported | 学校=某大学；专业=机械工程；学历=本科；起=2019；止=2023 |'])
  const res = resolveCandidate(ws, { personId: pid, candidateId: 'c-001', action: 'confirmed' })
  assert.equal(res?.status, 'confirmed')
  // 事实层已登记
  assert.ok(ws.read(`persons/${pid}/facts/education.md`).includes('| c-001 |'))
  // 投影：确认后立即投影（RPC handler 触发；此处显式调用等价路径）
  const written = projectPersonSnapshots(ws, pid)
  assert.ok(written.includes('identity.md'))
  const identity = ws.read(`persons/${pid}/snapshot/current/identity.md`)
  assert.ok(identity.includes('| education | 本科 |'))
  assert.ok(identity.includes('| graduation_year | 2023 |'))
  // 无经历事实 → 无工作经历段
  assert.ok(!identity.includes('## 工作经历'))
})

test('投影 identity.md：确认经历候选 → 工作经历表实时出现', () => {
  const { ws, pid } = PERSON()
  seedCandidates(ws, pid, ['| c-002 | pending | 经历 | 某公司 机械工程师 2023.07-2025.03 | user_reported | 公司=某公司；岗位=机械工程师；起=2023.07；止=2025.03 |'])
  resolveCandidate(ws, { personId: pid, candidateId: 'c-002', action: 'confirmed' })
  const written = projectPersonSnapshots(ws, pid)
  assert.ok(written.includes('identity.md'))
  const identity = ws.read(`persons/${pid}/snapshot/current/identity.md`)
  assert.ok(identity.includes('## 工作经历'))
  assert.ok(identity.includes('| 某公司 | 机械工程师 | 2023.07 | 2025.03 |'))
})

// ─── 投影：preference_constraints.md ← confirmed 约束/兴趣 ─────────────────

test('投影 preference_constraints.md：约束候选（结构化载荷）→ 规范键 + 原文列表；无载荷 → 仅原文', () => {
  const { ws, pid } = PERSON()
  seedCandidates(ws, pid, [
    '| c-003 | pending | 约束 | 期望苏州/上海，薪资 10-12K | user_reported | 薪资=10-12K；城市=苏州、上海 |',
    '| c-004 | pending | 兴趣 | 继续机械方向 | user_reported |',
  ])
  resolveCandidate(ws, { personId: pid, candidateId: 'c-003', action: 'confirmed' })
  resolveCandidate(ws, { personId: pid, candidateId: 'c-004', action: 'confirmed' })
  const written = projectPersonSnapshots(ws, pid)
  assert.ok(written.includes('preference_constraints.md'))
  const pref = ws.read(`persons/${pid}/snapshot/current/preference_constraints.md`)
  assert.ok(pref.includes('| salary_range | 10-12K |'))
  assert.ok(pref.includes('| city | 苏州、上海 |'))
  // 原文列表（不拆解）
  assert.ok(pref.includes('- 继续机械方向（兴趣）'))
})

// ─── 投影：skill_inventory.md ← confirmed 技能候选 ────────────────────────

test('投影 skill_inventory.md：确认技能候选（结构化载荷）→ 技能清单表；级别词表映射', () => {
  const { ws, pid } = PERSON()
  seedCandidates(ws, pid, [
    '| c-005 | pending | 技能 | 尺寸链计算 | user_reported | 技能=尺寸链计算；级别=胜任；场景=医疗器械结构设计 |',
    '| c-006 | pending | 技能 | 有限元仿真 | user_reported | 技能=有限元仿真；级别=入门；场景=结构校核 |',
  ])
  resolveCandidate(ws, { personId: pid, candidateId: 'c-005', action: 'confirmed' })
  resolveCandidate(ws, { personId: pid, candidateId: 'c-006', action: 'confirmed' })
  const written = projectPersonSnapshots(ws, pid)
  assert.ok(written.includes('skill_inventory.md'))
  const inv = ws.read(`persons/${pid}/snapshot/current/skill_inventory.md`)
  assert.ok(inv.includes('| skill_count | 2 |'))
  assert.ok(inv.includes('| skill_001 | 尺寸链计算 | applied-intermediate | 医疗器械结构设计 |'))
  assert.ok(inv.includes('| skill_002 | 有限元仿真 | applied-basic | 结构校核 |'))
})

// ─── 幂等 + 无事实不生成 ─────────────────────────────────────────────────

test('投影幂等：重复投影重写一致；无已确认事实 → 零写入', () => {
  const { ws, pid } = PERSON()
  // 无事实：三件都不生成（缺件语义交给门禁判定，不生成空壳文件）
  assert.deepEqual(projectPersonSnapshots(ws, pid), [])
  // 有事实：两次投影产物一致
  seedCandidates(ws, pid, ['| c-007 | pending | 教育 | 某大学 本科 | user_reported | 学校=某大学；学历=本科；起=2019；止=2023 |'])
  resolveCandidate(ws, { personId: pid, candidateId: 'c-007', action: 'confirmed' })
  const first = projectPersonSnapshots(ws, pid)
  const firstMd = ws.read(`persons/${pid}/snapshot/current/identity.md`)
  const second = projectPersonSnapshots(ws, pid)
  assert.deepEqual(second, first)
  assert.equal(ws.read(`persons/${pid}/snapshot/current/identity.md`), firstMd)
})

test('rejected 候选不投影：拒绝 ≠ 事实（不进入快照）', () => {
  const { ws, pid } = PERSON()
  seedCandidates(ws, pid, ['| c-008 | pending | 技能 | 不会的技能 | user_reported | 技能=不会的技能；级别=入门；场景=无 |'])
  resolveCandidate(ws, { personId: pid, candidateId: 'c-008', action: 'rejected' })
  assert.deepEqual(projectPersonSnapshots(ws, pid), [])
})

// ─── payload 解析 ────────────────────────────────────────────────────────

test('parseSkillPayload：键值段解析 + 缺技能 → undefined', () => {
  assert.deepEqual(parseSkillPayload('技能=尺寸链计算；级别=胜任；场景=医疗器械结构设计'), { skill: '尺寸链计算', level: '胜任', context: '医疗器械结构设计' })
  assert.equal(parseSkillPayload('级别=胜任'), undefined)
  assert.equal(parseSkillPayload(undefined), undefined)
})

test('parseConstraintPayload：可选键（意向岗位/优先级）+ 空载荷 → 无键', () => {
  assert.deepEqual(parseConstraintPayload('意向岗位=机器人设计；优先级=high；薪资=10-12K；城市=苏州、上海'), {
    jobRole: '机器人设计',
    priority: 'high',
    salary: '10-12K',
    city: '苏州、上海',
    location: undefined,
  })
  // 优先级非法值（`高`）不落入结构化——投影用中性档 medium，不发明语义
  assert.equal(parseConstraintPayload('意向岗位=x；优先级=高').priority, undefined)
  const empty = parseConstraintPayload(undefined)
  assert.equal(empty.jobRole, undefined)
  assert.equal(empty.priority, undefined)
  assert.equal(empty.salary, undefined)
  assert.equal(empty.city, undefined)
  assert.equal(empty.location, undefined)
})

// ─── 投影：career_profile.md ← confirmed 约束/兴趣候选（意向岗位载荷）──────────────

test('投影 career_profile.md：意向岗位载荷 → User Career Intent 表 + scanPersons 读端闭环', () => {
  const { ws, pid } = PERSON()
  seedCandidates(ws, pid, [
    '| c-101 | pending | 约束 | 求职意向机械结构工程师 | user_reported | 意向岗位=机械结构工程师；优先级=high；薪资=11-13K；城市=苏州、成都、上海 |',
    '| c-102 | pending | 兴趣 | 继续机械方向 | user_reported | 意向岗位=机械结构工程师 |',
  ])
  resolveCandidate(ws, { personId: pid, candidateId: 'c-101', action: 'confirmed' })
  resolveCandidate(ws, { personId: pid, candidateId: 'c-102', action: 'confirmed' })
  const written = projectPersonSnapshots(ws, pid)
  assert.ok(written.includes('career_profile.md'))
  assert.ok(written.includes('preference_constraints.md'))
  const career = ws.read(`persons/${pid}/snapshot/current/career_profile.md`)
  assert.ok(career.includes('| target_role | priority | source |'))
  assert.ok(career.includes('| 机械结构工程师 | high | user |'))
  // 读端闭环：scanPersons → PersonSnapshot.careerProfile.targetRoles（只取 source=user 行）
  const snap = scanPersons(ws).find((s) => s.personId === pid)!
  assert.deepEqual(snap.careerProfile?.targetRoles, ['机械结构工程师'])
  // 同一确认候选：偏好规范键表同步有值（salary/city）
  const pref = ws.read(`persons/${pid}/snapshot/current/preference_constraints.md`)
  assert.ok(pref.includes('| salary_range | 11-13K |'))
  assert.ok(pref.includes('| city | 苏州、成都、上海 |'))
})

test('投影 career_profile.md：仅薪资/城市载荷（无意向岗位）→ 不生成（缺件语义，不假装）', () => {
  const { ws, pid } = PERSON()
  seedCandidates(ws, pid, ['| c-103 | pending | 约束 | 期望 10-12K | user_reported | 薪资=10-12K；城市=苏州 |'])
  resolveCandidate(ws, { personId: pid, candidateId: 'c-103', action: 'confirmed' })
  const written = projectPersonSnapshots(ws, pid)
  assert.ok(written.includes('preference_constraints.md'))
  assert.ok(!written.includes('career_profile.md'))
  assert.ok(!ws.exists(`persons/${pid}/snapshot/current/career_profile.md`))
})
