import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace, WorkspaceError } from '../storage/workspace.ts'
import { archiveCurrentSnapshot } from '../storage/snapshot-archive.ts'
import { commitDecisionLedgerEvent, commitLedgerEvent, parseLedgerEvent, readLedgerEvents } from '../storage/ledger-writer.ts'

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

function makeVersions(): { root: string; ws: ReturnType<typeof initWorkspace>; v2: string; v3: string } {
  const root = mkdtempSync(join(tmpdir(), 'cos-ledgerw-'))
  const ws = initWorkspace(root)
  ws.write('persons/person_001/manifest.md', manifestMd)
  ws.write('persons/person_001/snapshot/current/skill_inventory.md', skillInv('v2', [['skill_a', '机械设计', 'applied-basic']]))
  const v2 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'bootstrap' })!.id
  ws.write('persons/person_001/snapshot/current/skill_inventory.md', skillInv('v3', [['skill_a', '机械设计', 'applied-professional']]))
  const v3 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'skill_update' })!.id
  return { root, ws, v2, v3 }
}

const commitInput = (fromId: string, toId: string, unit = 'skill_a') => ({
  fromId,
  toId,
  unit,
  trigger: { type: 'snapshot_change' as const, source: 'user_skill_confirmation', refs: ['session_001'] },
  attribution: { why: '用户确认独立项目开发能力', sourceRefs: ['evidence_001'] },
  confirmation: { type: 'user_confirmation' as const, ref: 'session_001' },
})

test('commitLedgerEvent：confirmed 候选 → ledger/events/ 落盘（frontmatter + Change/Why/Evidence）+ manifest 维护', () => {
  const { root, ws, v2, v3 } = makeVersions()
  try {
    const rec = commitLedgerEvent(ws, 'person_001', commitInput(v2, v3))
    assert.match(rec.id, /^ledger_\d{8}_\d{5}$/) // 系统登记制 id
    assert.equal(rec.personId, 'person_001')
    assert.equal(rec.type, 'skill')
    assert.equal(rec.status, 'committed')
    assert.equal(rec.changeUnit, 'skill_a')
    assert.equal(rec.beforeRef, v2)
    assert.equal(rec.afterRef, v3)
    assert.equal(rec.why, '用户确认独立项目开发能力')
    assert.deepEqual(rec.sourceRefs, ['evidence_001'])
    assert.equal(rec.confidence, 'high')

    // 文件内容（人可读可审计）
    const md = ws.read(`persons/person_001/ledger/events/${rec.id}.md`)
    assert.ok(md.includes('status: committed'))
    assert.ok(md.includes('trigger_type: snapshot_change'))
    assert.ok(md.includes('trigger_source: user_skill_confirmation'))
    assert.ok(md.includes(`before_ref: ${v2}`))
    assert.ok(md.includes('## Change'))
    assert.ok(md.includes('applied-basic'))
    assert.ok(md.includes('applied-professional'))
    assert.ok(md.includes('## Why'))
    assert.ok(md.includes('用户确认独立项目开发能力'))
    assert.ok(md.includes('- evidence_001'))

    // manifest
    const manifest = ws.read('persons/person_001/ledger/manifest.md')
    assert.ok(manifest.includes('event_count: 1'))
    assert.ok(manifest.includes(`latest_event_id: ${rec.id}`))
    assert.ok(manifest.includes(`latest_timestamp: ${rec.timestamp}`))
    assert.ok(manifest.includes('person_001'))

    // 解析 roundtrip
    const parsed = parseLedgerEvent(md)!
    assert.deepEqual(parsed, rec)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('commitLedgerEvent：连续提交 → id 当日序号递增（000001 → 000002）', () => {
  const { root, ws, v2, v3 } = makeVersions()
  try {
    const r1 = commitLedgerEvent(ws, 'person_001', commitInput(v2, v3))
    const r2 = commitLedgerEvent(ws, 'person_001', commitInput(v2, v3, 'skill_a'))
    assert.equal(r1.id.endsWith('00001'), true)
    assert.equal(r2.id.endsWith('00002'), true)
    assert.equal(readLedgerEvents(ws, 'person_001').length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('commitLedgerEvent：不变量——版本不可读 / unit 无变化 / why 空 → 不写入（fail fast）', () => {
  const { root, ws, v2, v3 } = makeVersions()
  try {
    // 版本不存在（before_ref 不可读）
    assert.throws(
      () => commitLedgerEvent(ws, 'person_001', commitInput('snapshot_20990101_v99', v3)),
      WorkspaceError,
    )
    // 相同版本对（unit 无变化——diff 为空）
    assert.throws(
      () => commitLedgerEvent(ws, 'person_001', commitInput(v2, v2)),
      /不存在变化单位/,
    )
    // 不存在的 unit（候选过期/漂移）
    assert.throws(
      () => commitLedgerEvent(ws, 'person_001', commitInput(v2, v3, 'skill_ghost')),
      /不存在变化单位 skill_ghost/,
    )
    // why 空（confirmed + committed 不变式）
    assert.throws(
      () => commitLedgerEvent(ws, 'person_001', { ...commitInput(v2, v3), attribution: { why: '   ' } }),
      /why 非空/,
    )
    // 全部失败 → 无任何事件写入
    assert.deepEqual(readLedgerEvents(ws, 'person_001'), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readLedgerEvents：目录缺失 → 空；解析后正序', () => {
  const { root, ws, v2, v3 } = makeVersions()
  try {
    assert.deepEqual(readLedgerEvents(ws, 'person_001'), []) // 未 commit → 空
    commitLedgerEvent(ws, 'person_001', commitInput(v2, v3))
    const events = readLedgerEvents(ws, 'person_001')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.trigger.type, 'snapshot_change')
    assert.equal(events[0]!.trigger.source, 'user_skill_confirmation')
    assert.deepEqual(events[0]!.trigger.refs, ['session_001'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const decisionMd = `# 我 — 方向探索

## 分析摘要

| 字段 | 值 |
|------|-----|
| direction | 机械结构工程师 |
| city | City-X |
| salary_feasible | true |
| status | exploring |
| protocol_version | 2.3 |
| profile | 我 |
`

function makeDecisionWorkspace(): { root: string; ws: ReturnType<typeof initWorkspace> } {
  const root = mkdtempSync(join(tmpdir(), 'cos-ledgerd-'))
  const ws = initWorkspace(root)
  ws.write('persons/person_001/manifest.md', manifestMd)
  ws.write('decisions/decision_001.md', decisionMd)
  return { root, ws }
}

const decisionCommit = (after: string) => ({
  decisionId: 'decision_001',
  changeUnit: 'direction_target',
  changeType: 'decision' as const,
  before: '机械结构工程师',
  after,
  trigger: { type: 'decision_changed' as const, source: 'user_decision', refs: ['session_002'] },
  attribution: { why: '用户确认方向调整：从机械结构转向机械+AI', sourceRefs: ['evidence_002'] },
  confirmation: { type: 'user_confirmation' as const, ref: 'session_002' },
})

test('commitDecisionLedgerEvent：decision 候选 → 落盘（decision_ref 引用 + 与 snapshot 事件共用目录/id 登记）', () => {
  const { root, ws } = makeDecisionWorkspace()
  try {
    ws.write('decisions/decision_001.md', decisionMd.replace('机械结构工程师', '机械+AI 交叉'))
    const rec = commitDecisionLedgerEvent(ws, 'person_001', decisionCommit('机械+AI 交叉'))
    assert.match(rec.id, /^ledger_\d{8}_\d{5}$/)
    assert.equal(rec.type, 'decision')
    assert.equal(rec.changeUnit, 'direction_target')
    assert.equal(rec.beforeRef, 'decision:decision_001')
    assert.equal(rec.why, '用户确认方向调整：从机械结构转向机械+AI')
    const md = ws.read(`persons/person_001/ledger/events/${rec.id}.md`)
    assert.ok(md.includes('trigger_type: decision_changed'))
    assert.ok(md.includes('trigger_source: user_decision'))
    assert.ok(md.includes('before_ref: decision:decision_001'))
    assert.ok(md.includes('机械+AI 交叉'))
    // 与 snapshot 事件共用 id 登记（同日连续 +1）
    assert.deepEqual(parseLedgerEvent(md), rec)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('commitDecisionLedgerEvent：防漂移——决策文件当前值与候选 after 不一致 → 拒绝写入', () => {
  const { root, ws } = makeDecisionWorkspace()
  try {
    ws.write('decisions/decision_001.md', decisionMd.replace('机械结构工程师', '工业软件工程师')) // 已再次变化
    assert.throws(
      () => commitDecisionLedgerEvent(ws, 'person_001', decisionCommit('机械+AI 交叉')),
      /commit 漂移/,
    )
    assert.deepEqual(readLedgerEvents(ws, 'person_001'), []) // 无事件写入
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('commitDecisionLedgerEvent：决策不存在 / why 空 → 拒绝（不变量）', () => {
  const { root, ws } = makeDecisionWorkspace()
  try {
    assert.throws(
      () => commitDecisionLedgerEvent(ws, 'person_001', { ...decisionCommit('机械+AI 交叉'), decisionId: 'decision_ghost' }),
      /决策不存在/,
    )
    assert.throws(
      () => commitDecisionLedgerEvent(ws, 'person_001', { ...decisionCommit('机械+AI 交叉'), attribution: { why: ' ' } }),
      /why 非空/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
