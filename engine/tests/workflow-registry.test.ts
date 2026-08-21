import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import {
  startWorkflow,
  advanceWorkflow,
  abortWorkflow,
  getWorkflow,
  scanWorkflows,
  onFactCollectionReady,
  isPersonInitComplete,
} from '../storage/workflow-registry.ts'
import { createPersonSession } from '../storage/person-watcher.ts'

let wsSeq = 0
function testWorkspace(): Workspace {
  wsSeq++
  return initWorkspace(`.local/ws-workflow-test-${Date.now()}-${wsSeq}`)
}

function makePerson(ws: Workspace): string {
  const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
  return personId
}

/** 补齐 person-init 三件快照（复用 completePersonInit 门禁判定） */
function seedCompleteSnapshots(ws: Workspace, personId: string): void {
  ws.write(`persons/${personId}/snapshot/current/identity.md`, '# 身份\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| location | 苏州 |\n')
  ws.write(`persons/${personId}/snapshot/current/skill_inventory.md`, '# 技能\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| skill_count | 1 |\n\n## A. 技能清单\n\n| skill_id | 技能 | level | usage_context |\n|----------|------|-------|---------------|\n| skill_001 | 机械设计 | applied-professional | 结构设计 |\n')
  ws.write(`persons/${personId}/snapshot/current/preference_constraints.md`, '# 偏好\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| city | 苏州 |\n')
}

/** 写 pending candidates（Path B 判定输入；格式对齐 extraction/candidates.md） */
function seedPendingCandidates(ws: Workspace, personId: string): void {
  ws.write(`persons/${personId}/extraction/candidates.md`, [
    '# Extraction Candidates',
    '',
    '| id | status | category | content | source |',
    '|----|--------|----------|---------|--------|',
    '| c-001 | pending | 约束 | 期望城市苏州 | user_reported |',
    '| c-002 | pending | 兴趣 | 继续机械方向 | user_reported |',
    '',
  ].join('\n'))
}

const GOAL = '帮我确定职业方向'

// ─── Path A：全新 Person（无 pending candidates）──────────────────────────

test('startWorkflow Path A：无 pending candidates → Stage 1 running（等待 Agent 收集）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow, path } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL }, new Date('2026-08-21T00:00:00Z'))
  assert.equal(path, 'A')
  assert.equal(workflow.status, 'active')
  assert.equal(workflow.currentStage, 'fact_collection')
  assert.equal(workflow.stages[0]!.status, 'running')
  assert.equal(workflow.stages[0]!.gate, undefined) // Path A：gate 在收集产出后挂
  // 落盘可回读
  const reloaded = getWorkflow(ws, workflow.id)!
  assert.equal(reloaded.id, workflow.id)
  assert.equal(reloaded.stages[0]!.status, 'running')
})

test('Path A：Agent 产出候选（onFactCollectionReady）→ waiting_gate + gate 挂载', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  seedPendingCandidates(ws, pid)
  const next = onFactCollectionReady(ws, workflow.id)!
  assert.equal(next.stages[0]!.status, 'waiting_gate')
  assert.deepEqual(next.stages[0]!.gate, { id: 'confirm_person_facts', status: 'waiting' })
})

test('Path A：Agent 未产出候选（onFactCollectionReady 但无 pending）→ failed（不信任自报）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  const next = onFactCollectionReady(ws, workflow.id)!
  assert.equal(next.stages[0]!.status, 'failed')
})

// ─── Path B：已有 pending candidates ──────────────────────────────────────

test('startWorkflow Path B：有 pending candidates → 直接 waiting_gate，不启动 Agent（不重新收集）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedPendingCandidates(ws, pid)
  const { workflow, path } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  assert.equal(path, 'B')
  assert.equal(workflow.stages[0]!.status, 'waiting_gate')
  assert.deepEqual(workflow.stages[0]!.gate, { id: 'confirm_person_facts', status: 'waiting' })
})

// ─── advance 四步校验（契约 §四.2）────────────────────────────────────────

test('advance：Stage 1 waiting_gate 但 person-init 未完成 → STAGE_INCOMPLETE 拒绝（缺件清单）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedPendingCandidates(ws, pid)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  assert.equal(workflow.stages[0]!.status, 'waiting_gate')
  const res = advanceWorkflow(ws, workflow.id)
  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.equal(res.code, 'STAGE_INCOMPLETE')
    assert.ok(res.missing.some((m) => m.includes('person-init')))
  }
  // 状态未被推进（Stage 2 不存在——验收核心）
  const reloaded = getWorkflow(ws, workflow.id)!
  assert.equal(reloaded.currentStage, 'fact_collection')
  assert.equal(reloaded.stages.length, 1)
})

test('advance：person-init 完成 → 推进 Stage 2 running（Golden Flow 确认路径）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedPendingCandidates(ws, pid)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  // 用户确认候选 → 登记 → 三件快照齐备（模拟真实链路：resolveCandidate 后由 Agent 写快照）
  seedCompleteSnapshots(ws, pid)
  assert.equal(isPersonInitComplete(ws, pid), true)
  const res = advanceWorkflow(ws, workflow.id)
  assert.equal(res.ok, true)
  if (res.ok) {
    assert.equal(res.nextStage, 'direction_exploration')
    const reloaded = getWorkflow(ws, workflow.id)!
    assert.equal(reloaded.stages[0]!.status, 'completed')
    assert.deepEqual(reloaded.stages[0]!.gate, { id: 'confirm_person_facts', status: 'passed', confirmedAt: reloaded.stages[0]!.gate!.confirmedAt })
    assert.equal(reloaded.stages[1]!.id, 'direction_exploration')
    assert.equal(reloaded.stages[1]!.status, 'running')
    assert.equal(reloaded.currentStage, 'direction_exploration')
  }
})

test('advance：running 状态推进 → ILLEGAL_STATE 拒绝（用户不能决定完成）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  assert.equal(workflow.stages[0]!.status, 'running')
  const res = advanceWorkflow(ws, workflow.id)
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.code, 'ILLEGAL_STATE')
})

test('advance：gateId 不匹配 → ILLEGAL_STATE 拒绝', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedPendingCandidates(ws, pid)
  seedCompleteSnapshots(ws, pid)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  const res = advanceWorkflow(ws, workflow.id, 'review_recommendation')
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.code, 'ILLEGAL_STATE')
})

// ─── 探索分支（契约 §4.3）─────────────────────────────────────────────────

test('探索分支语义：未登记 → Stage 1 不 completed，正常 advance 被拒（不得伪装成 Person Aggregate）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedPendingCandidates(ws, pid)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  // 用户点「暂不登记，继续探索」：不 resolve、不写快照——person-init 不满足
  assert.equal(isPersonInitComplete(ws, pid), false)
  const res = advanceWorkflow(ws, workflow.id)
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.code, 'STAGE_INCOMPLETE')
  // Stage 2 不存在
  const reloaded = getWorkflow(ws, workflow.id)!
  assert.equal(reloaded.stages.length, 1)
  assert.equal(reloaded.currentStage, 'fact_collection')
})

// ─── abort / list ─────────────────────────────────────────────────────────

test('abort：active → aborted（append-only 审计）；已完成后 abort 拒绝', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  const aborted = abortWorkflow(ws, workflow.id)
  assert.equal(aborted.status, 'aborted')
  assert.ok(aborted.abortedAt)
  assert.throws(() => abortWorkflow(ws, workflow.id), /不可 abort/)
})

test('scanWorkflows：按 personId 过滤；getWorkflow 非法 id → null', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  assert.equal(scanWorkflows(ws, pid).length, 1)
  assert.equal(scanWorkflows(ws, 'person_999').length, 0)
  assert.equal(getWorkflow(ws, 'workflow_bad'), null)
})

// ─── 输入校验 ─────────────────────────────────────────────────────────────

test('startWorkflow 边界：type/personId/statement/person 存在性 fail fast', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  assert.throws(() => startWorkflow(ws, { type: 'unknown' as never, personId: pid, statement: GOAL }), /type 非法/)
  assert.throws(() => startWorkflow(ws, { type: 'career_direction', personId: 'bad', statement: GOAL }), /personId 非法/)
  assert.throws(() => startWorkflow(ws, { type: 'career_direction', personId: pid, statement: '  ' }), /statement 必填/)
  assert.throws(() => startWorkflow(ws, { type: 'career_direction', personId: 'person_999', statement: GOAL }), /person 不存在/)
})
