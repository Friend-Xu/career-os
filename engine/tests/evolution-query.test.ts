import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { archiveCurrentSnapshot } from '../storage/snapshot-archive.ts'
import { commitDecisionLedgerEvent, commitLedgerEvent } from '../storage/ledger-writer.ts'
import { replayDecision, whyChanged, whyChangedRecently } from '../runtime/evolution-query.ts'

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

## A. Mechanical Engineering

| skill_id | 技能 | level | usage_context |
|----------|------|-------|---------------|
${rows.map(([id, name, level]) => `| ${id} | ${name} | ${level} | 结构设计 |`).join('\n')}
`
}

function pref(status: string): string {
  return `---
id: person_001
status: ${status}
---

## 分析摘要

| 字段 | 值 |
|------|-----|
| salary | 11-13K/月 |
| city | City-Circle |
| preference_count | 1 |
| constraint_count | 1 |

## Preference（喜欢）

| # | 维度 | 内容 | 来源 |
|---|------|------|------|
| pf-01 | 工作方式 | 双休 | 访谈 |

## Constraint（不能接受）

| # | 维度 | 内容 | 来源 |
|---|------|------|------|
| ct-01 | 班制 | 夜班 | 访谈 |
`
}

function makeBase(): { root: string; ws: ReturnType<typeof initWorkspace>; v2: string; v3: string } {
  const root = mkdtempSync(join(tmpdir(), 'cos-evo-'))
  const ws = initWorkspace(root)
  ws.write('persons/person_001/manifest.md', manifestMd)
  ws.write('persons/person_001/snapshot/current/skill_inventory.md', skillInv('v2', [['skill_a', '机械设计', 'applied-basic']]))
  ws.write('persons/person_001/snapshot/current/preference_constraints.md', pref('v2'))
  const v2 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'bootstrap' })!.id
  ws.write('persons/person_001/snapshot/current/skill_inventory.md', skillInv('v3', [['skill_a', '机械设计', 'applied-professional']]))
  const v3 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'skill_update' })!.id
  return { root, ws, v2, v3 }
}

test('whyChanged：变化单位 → 完整事件链（before/after/why/证据/触发）', () => {
  const { root, ws, v2, v3 } = makeBase()
  try {
    commitLedgerEvent(ws, 'person_001', {
      fromId: v2, toId: v3, unit: 'skill_a',
      trigger: { type: 'snapshot_change', source: 'user_skill_confirmation', refs: ['session_001'] },
      attribution: { why: '用户确认独立项目开发能力', sourceRefs: ['evidence_001'] },
      confirmation: { type: 'user_confirmation', ref: 'session_001' },
    })
    const chain = whyChanged(ws, 'person_001', 'skill_a')
    assert.equal(chain.length, 1)
    const c = chain[0]!
    assert.equal(c.changeType, 'skill')
    assert.equal(c.before, 'applied-basic')
    assert.equal(c.after, 'applied-professional')
    assert.equal(c.why, '用户确认独立项目开发能力')
    assert.deepEqual(c.sourceRefs, ['evidence_001'])
    assert.equal(c.trigger.source, 'user_skill_confirmation')
    assert.equal(c.beforeRef, v2)
    assert.equal(c.afterRef, v3)
    assert.ok(c.timestamp.length > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('whyChanged：无事件单位 → 空；事件无变化单位覆盖 → 无（查询不编造）', () => {
  const { root, ws, v2, v3 } = makeBase()
  try {
    commitLedgerEvent(ws, 'person_001', {
      fromId: v2, toId: v3, unit: 'skill_a',
      trigger: { type: 'snapshot_change' },
      attribution: { why: '用户确认', sourceRefs: [] },
      confirmation: { type: 'user_confirmation', ref: 's1' },
    })
    assert.deepEqual(whyChanged(ws, 'person_001', 'skill_ghost'), [])
    assert.equal(whyChanged(ws, 'person_001', 'skill_a').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('replayDecision：decision 来源事件 → 回放（decisionId + 当时输入 + 当时未知）', () => {
  const { root, ws } = makeBase()
  try {
    ws.write('decisions/decision_001.md', `# 方向决策

## 分析摘要

| 字段 | 值 |
|------|-----|
| direction | 机械结构工程师 |
| status | exploring |
| protocol_version | 2.3 |
| profile | 我 |

## 输入引用

- skill: skill_a@v2
- constraint: preference_constraints
- knowledge: jd_robotics_001
`)
    ws.write('decision-contexts/方向选择.md', `# 方向选择

## 分析摘要

| 字段 | 值 |
|------|-----|
| person | 我 |
| question | 未来三年职业方向 |
| related_decisions | decision_001 |

## 未知

- 高级 CAE 经验不足
- 机器人行业薪资不确定
`)
    // 更新决策方向并提交认知变化事件
    ws.write('decisions/decision_001.md', ws.read('decisions/decision_001.md').replace('机械结构工程师', '机械+AI 交叉'))
    commitDecisionLedgerEvent(ws, 'person_001', {
      decisionId: 'decision_001',
      changeUnit: 'direction_target',
      changeType: 'decision',
      before: '机械结构工程师',
      after: '机械+AI 交叉',
      trigger: { type: 'decision_changed', source: 'user_decision', refs: ['session_002'] },
      attribution: { why: '用户确认方向调整', sourceRefs: ['evidence_002'] },
      confirmation: { type: 'user_confirmation', ref: 'session_002' },
    })

    const replays = replayDecision(ws, 'person_001')
    assert.equal(replays.length, 1)
    const r = replays[0]!
    assert.equal(r.decisionId, 'decision_001')
    assert.equal(r.changeUnit, 'direction_target')
    assert.equal(r.before, '机械结构工程师')
    assert.equal(r.after, '机械+AI 交叉')
    assert.equal(r.why, '用户确认方向调整')
    // 当时输入（decision 文件引用段）
    assert.deepEqual(r.decisionInputs?.skillRefs, [{ id: 'skill_a', version: 'v2' }])
    assert.deepEqual(r.decisionInputs?.constraintRefs, [{ id: 'preference_constraints' }])
    // 当时未知（关联 context 段落）
    assert.deepEqual(r.unknowns, ['高级 CAE 经验不足', '机器人行业薪资不确定'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('whyChangedRecently：近 N 天变化 + 无变化单位（当前单位无事件覆盖）', () => {
  const { root, ws, v2, v3 } = makeBase()
  try {
    commitLedgerEvent(ws, 'person_001', {
      fromId: v2, toId: v3, unit: 'skill_a',
      trigger: { type: 'snapshot_change', source: 'user_skill_confirmation' },
      attribution: { why: '用户确认独立项目开发能力', sourceRefs: ['evidence_001'] },
      confirmation: { type: 'user_confirmation', ref: 's1' },
    })
    const recent = whyChangedRecently(ws, 'person_001', 30)
    assert.equal(recent.changes.length, 1)
    assert.equal(recent.changes[0]!.changeUnit, 'skill_a')
    // 当前快照单位中无事件覆盖的（preference/constraint/salary/city）
    assert.ok(recent.unchanged.includes('pf-01'))
    assert.ok(recent.unchanged.includes('ct-01'))
    assert.ok(recent.unchanged.includes('salary'))
    assert.ok(recent.unchanged.includes('city'))
    assert.ok(!recent.unchanged.includes('skill_a')) // 有事件 → 不在无变化
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
