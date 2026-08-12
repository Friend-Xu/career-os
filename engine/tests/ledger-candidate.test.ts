import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { archiveCurrentSnapshot, listSnapshotVersions } from '../storage/snapshot-archive.ts'
import { buildCandidates, diffSnapshotVersions } from '../runtime/ledger-candidate.ts'

const manifestMd = `---
id: person_001
name: 我
status: active
created_at: 2026-08-06
---

# Person 001 — 我
`

function skillInv(status: string, rows: [string, string, string][]): string {
  return `---
id: person_001
status: ${status}
---

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill_count | ${rows.length} |
| status | ${status} resolved |

## A. Mechanical Engineering

| skill_id | 技能 | level | usage_context | confidence |
|----------|------|-------|---------------|------------|
${rows.map(([id, name, level]) => `| ${id} | ${name} | ${level} | 结构设计 | high |`).join('\n')}
`
}

function pref(status: string, prefs: [string, string, string][], cons: [string, string, string][], salary = '11-13K/月'): string {
  return `---
id: person_001
status: ${status}
---

## 分析摘要

| 字段 | 值 |
|------|-----|
| salary | ${salary} |
| city | City-Circle |
| preference_count | ${prefs.length} |
| constraint_count | ${cons.length} |

## Preference（喜欢）

| # | 维度 | 内容 | 来源 |
|---|------|------|------|
${prefs.map(([id, dim, v]) => `| ${id} | ${dim} | ${v} | 访谈 |`).join('\n')}

## Constraint（不能接受）

| # | 维度 | 内容 | 来源 |
|---|------|------|------|
${cons.map(([id, dim, v]) => `| ${id} | ${dim} | ${v} | 访谈 |`).join('\n')}
`
}

function career(status: string, targets?: [string, string][], currentRole = '机械结构工程师（2023.07-2025.03）'): string {
  const rows = targets
    ? targets.map(([name, pos]) => `| ${name} | ${pos} | Interest |`).join('\n')
    : ''
  return `---
id: person_001
status: ${status}
---

## 分析摘要

| 字段 | 值 |
|------|-----|
| current_role | ${currentRole} |
| target_roles | ${targets ? 'confirmed' : '（待采集）'} |

${targets ? `## 目标方向（确认）

| 方向 | 定位 | 能力基础 |
|------|------|---------|
${rows}
` : '## 目标方向（待采集）\n'}
`
}

function identity(status: string, extra = ''): string {
  return `---
id: person_001
status: ${status}
---

## 分析摘要

| 字段 | 值 |
|------|-----|
| education | 机械工程本科 |
| age | 26 |
${extra}
`
}

function makeWorkspace(): { root: string; ws: ReturnType<typeof initWorkspace> } {
  const root = mkdtempSync(join(tmpdir(), 'cos-ledger-'))
  const ws = initWorkspace(root)
  ws.write('persons/person_001/manifest.md', manifestMd)
  return { root, ws }
}

test('diffSnapshotVersions：skill 变化单位（level 变/新增/删除）——粒度是单位不是文件', () => {
  const { root, ws } = makeWorkspace()
  try {
    ws.write('persons/person_001/snapshot/current/skill_inventory.md', skillInv('v2', [
      ['skill_a', '机械设计', 'applied-basic'],
      ['skill_b', '减速器设计', 'applied'],
    ]))
    const v2 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'bootstrap' })!.id
    ws.write('persons/person_001/snapshot/current/skill_inventory.md', skillInv('v3', [
      ['skill_a', '机械设计', 'applied-professional'],
      ['skill_c', 'CAE 仿真', 'applied-basic'],
    ]))
    const v3 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'skill_update' })!.id

    const diffs = diffSnapshotVersions(ws, 'person_001', v2, v3)
    assert.equal(diffs.length, 3) // 一个文件 3 个变化单位
    const a = diffs.find((d) => d.unit === 'skill_a')!
    assert.equal(a.changeType, 'skill')
    assert.equal(a.before, 'applied-basic')
    assert.equal(a.after, 'applied-professional')
    assert.equal(a.file, 'skill_inventory.md')
    const added = diffs.find((d) => d.unit === 'skill_c')!
    assert.equal(added.before, undefined) // 新增：before 空
    assert.equal(added.after, 'applied-basic')
    const removed = diffs.find((d) => d.unit === 'skill_b')!
    assert.equal(removed.after, undefined) // 删除：after 空
    assert.equal(removed.before, 'applied')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('diffSnapshotVersions：pf/ct 条目分型（preference vs constraint）+ salary/city 字段 + 无变化跳过', () => {
  const { root, ws } = makeWorkspace()
  try {
    ws.write('persons/person_001/snapshot/current/preference_constraints.md', pref('v2', [
      ['pf-01', '工作方式', '双休'],
    ], [
      ['ct-01', '班制', '夜班'],
    ]))
    const v2 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'bootstrap' })!.id
    ws.write('persons/person_001/snapshot/current/preference_constraints.md', pref('v3', [
      ['pf-01', '工作方式', '双休（可协商）'],
    ], [
      ['ct-01', '班制', '夜班'],
      ['ct-02', '工作时长', '长期 996'],
    ]))
    archiveCurrentSnapshot(ws, 'person_001', { reason: 'preference_update' })
    const v3pref = ws.read('persons/person_001/snapshot/current/preference_constraints.md')
    ws.write('persons/person_001/snapshot/current/preference_constraints.md', v3pref.replace('11-13K/月', '13-15K/月'))
    const v4 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'salary_update' })!.id

    const diffs = diffSnapshotVersions(ws, 'person_001', v2, v4)
    assert.equal(diffs.length, 3) // pf-01 变 + ct-02 增 + salary 变
    assert.equal(diffs.find((d) => d.unit === 'pf-01')!.changeType, 'preference')
    assert.equal(diffs.find((d) => d.unit === 'ct-02')!.changeType, 'constraint')
    assert.equal(diffs.find((d) => d.unit === 'ct-01'), undefined) // 未变不产生 diff
    assert.equal(diffs.find((d) => d.unit === 'salary')!.changeType, 'preference')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('diffSnapshotVersions：方向行 → decision；current_role → identity；identity 字段 → identity', () => {
  const { root, ws } = makeWorkspace()
  try {
    ws.write('persons/person_001/snapshot/current/career_profile.md', career('v2'))
    ws.write('persons/person_001/snapshot/current/identity.md', identity('v2'))
    const v2 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'bootstrap' })!.id
    ws.write('persons/person_001/snapshot/current/career_profile.md', career('v3', [
      ['Robotics', '求职目标'],
      ['Mechanical+AI 交叉', '求职目标'],
    ], '机械工程师（某公司 2025.04-）'))
    ws.write('persons/person_001/snapshot/current/identity.md', identity('v3', '| gender | 男 |\n'))
    const v3 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'direction_update' })!.id

    const diffs = diffSnapshotVersions(ws, 'person_001', v2, v3)
    assert.equal(diffs.find((d) => d.unit === 'Robotics')!.changeType, 'decision')
    assert.equal(diffs.find((d) => d.unit === 'Mechanical+AI 交叉')!.changeType, 'decision')
    assert.equal(diffs.find((d) => d.unit === 'current_role')!.changeType, 'identity')
    assert.equal(diffs.find((d) => d.unit === 'gender')!.changeType, 'identity')
    assert.equal(diffs.find((d) => d.unit === 'education'), undefined) // 未变
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildCandidates：无归因 → proposed + low；ref 防漂移引用（版本 id + 单位）', () => {
  const { root, ws } = makeWorkspace()
  try {
    ws.write('persons/person_001/snapshot/current/skill_inventory.md', skillInv('v2', [['skill_a', '机械设计', 'applied-basic']]))
    const v2 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'bootstrap' })!.id
    ws.write('persons/person_001/snapshot/current/skill_inventory.md', skillInv('v3', [['skill_a', '机械设计', 'applied-intermediate']]))
    const v3 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'skill_update' })!.id

    const cands = buildCandidates(ws, 'person_001', {
      fromId: v2,
      toId: v3,
      trigger: { type: 'snapshot_change', source: 'self_assessment', refs: ['session_20260806_001'] },
    })
    assert.equal(cands.length, 1)
    const c = cands[0]!
    assert.equal(c.status, 'proposed') // 无 confirmation → 不 committed
    assert.equal(c.confidence, 'low') // 无 why 无 confirmation
    assert.equal(c.attribution, undefined)
    assert.deepEqual(c.trigger, { type: 'snapshot_change', source: 'self_assessment', refs: ['session_20260806_001'] })
    assert.equal(c.diffEvidence.beforeRef, `${v2}#skill_a`)
    assert.equal(c.diffEvidence.afterRef, `${v3}#skill_a`)
    assert.equal(c.id, `person_001:${v3}#skill_a`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildCandidates：confirmed 无 why → fail fast；confirmed + why → high + confirmation 组装', () => {
  const { root, ws } = makeWorkspace()
  try {
    ws.write('persons/person_001/snapshot/current/skill_inventory.md', skillInv('v2', [['skill_a', '机械设计', 'applied-basic']]))
    const v2 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'bootstrap' })!.id
    ws.write('persons/person_001/snapshot/current/skill_inventory.md', skillInv('v3', [['skill_a', '机械设计', 'applied-professional']]))
    const v3 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'skill_update' })!.id

    // confirmed 但无 why → 抛（confirmed + committed 必须 why 非空）
    assert.throws(
      () => buildCandidates(ws, 'person_001', {
        fromId: v2,
        toId: v3,
        trigger: { type: 'snapshot_change' },
        confirmation: { type: 'user_confirmation', ref: 'session_001' },
      }),
      /confirmed 必须 why 非空/,
    )

    const cands = buildCandidates(ws, 'person_001', {
      fromId: v2,
      toId: v3,
      trigger: { type: 'snapshot_change', source: 'user_skill_confirmation', refs: ['session_001'] },
      attribution: { why: '用户确认独立项目开发能力', sourceRefs: ['evidence_001'] },
      confirmation: { type: 'user_confirmation', ref: 'session_001' },
    })
    assert.equal(cands.length, 1)
    const c = cands[0]!
    assert.equal(c.status, 'confirmed')
    assert.equal(c.confidence, 'high')
    assert.deepEqual(c.attribution, { why: '用户确认独立项目开发能力', sourceRefs: ['evidence_001'] })
    assert.deepEqual(c.confirmation, { type: 'user_confirmation', ref: 'session_001' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildCandidates：无差异 → 空数组（版本无变化不产生 candidate）', () => {
  const { root, ws } = makeWorkspace()
  try {
    ws.write('persons/person_001/snapshot/current/skill_inventory.md', skillInv('v2', [['skill_a', '机械设计', 'applied-basic']]))
    const v2 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'bootstrap' })!.id
    assert.deepEqual(
      buildCandidates(ws, 'person_001', { fromId: v2, toId: v2, trigger: { type: 'snapshot_change' } }),
      [],
    )
    assert.equal(listSnapshotVersions(ws, 'person_001').length, 1) // 无归档发生
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
