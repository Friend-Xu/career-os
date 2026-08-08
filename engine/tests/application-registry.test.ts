import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { createJobFile } from '../storage/job-watcher.ts'
import {
  createApplication,
  deleteApplication,
  getApplication,
  linkApplicationDecision,
  listApplications,
  nextApplicationId,
  updateApplicationStatus,
} from '../storage/application-registry.ts'

/**
 * Application Registry 闭环（ADR-019 Step 2：Decision → create application → Registry → list）。
 * 断言：创建（PREPARING，不自动 SUBMITTED）/ 状态推进（SUBMITTED 登记 submittedAt +
 * displayFallback，其余状态只改 status）/ linkDecision / 删除 / 边界（jobId 非法拒绝、
 * status 非法拒绝、id 非法拒绝、Job 删除后不能 SUBMITTED）。
 */

const FIXED_NOW = new Date('2026-08-08T12:00:00Z')

function setup(): ReturnType<typeof initWorkspace> {
  const root = mkdtempSync(join(tmpdir(), 'cos-app-'))
  const ws = initWorkspace(root)
  createJobFile(ws, { company: '示例智造', title: '机械设计工程师', location: '杭州' }, FIXED_NOW)
  return ws
}

function teardown(ws: ReturnType<typeof initWorkspace>): void {
  rmSync(ws.paths.root, { recursive: true, force: true })
}

const JOB_ID = '2026-08-08-示例智造-机械设计工程师'

test('Case A：完整闭环——create → list → updateStatus(SUBMITTED) → linkDecision → get', () => {
  const ws = setup()
  try {
    // Decision 发起投递 → 用户「开始投递流程」→ create（PREPARING，不自动 SUBMITTED）
    const app = createApplication(ws, { jobId: JOB_ID, decisionId: 'decision_20260808_00001', personId: 'person_001' }, FIXED_NOW)
    assert.equal(app.status, 'PREPARING')
    assert.equal(app.jobId, JOB_ID)
    assert.equal(app.decisionId, 'decision_20260808_00001')
    assert.equal(app.personId, 'person_001')
    assert.equal(app.createdAt, FIXED_NOW.toISOString())
    assert.equal(app.submittedAt, undefined)

    // Registry → list 闭环成立
    const listed = listApplications(ws)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, app.id)

    // 用户「我已提交」→ SUBMITTED：登记 submittedAt + displayFallback（Job 快照）
    const submitted = updateApplicationStatus(ws, app.id, 'SUBMITTED', new Date('2026-08-09T09:00:00Z'))
    assert.equal(submitted.status, 'SUBMITTED')
    assert.equal(submitted.submittedAt, '2026-08-09T09:00:00.000Z')
    assert.deepEqual(submitted.displayFallback, { company: '示例智造', position: '机械设计工程师' })

    // get 读回一致性
    const reread = getApplication(ws, app.id)
    assert.deepEqual(reread, submitted)

    // 其余状态推进只改 status，不重复登记 submittedAt/displayFallback
    const comm = updateApplicationStatus(ws, app.id, 'COMMUNICATING')
    assert.equal(comm.status, 'COMMUNICATING')
    assert.equal(comm.submittedAt, submitted.submittedAt)
    assert.deepEqual(comm.displayFallback, submitted.displayFallback)
  } finally {
    teardown(ws)
  }
})

test('Case B：ID 序号递增（按序号非数量——删除后不复用旧序号）', () => {
  const ws = setup()
  try {
    const a = createApplication(ws, { jobId: JOB_ID, personId: 'person_001' }, FIXED_NOW)
    const b = createApplication(ws, { jobId: JOB_ID, personId: 'person_001' }, FIXED_NOW)
    assert.equal(a.id, 'application_20260808_00001')
    assert.equal(b.id, 'application_20260808_00002')
    // 删除中间记录后新 ID 不复用（空洞）
    deleteApplication(ws, a.id)
    const c = createApplication(ws, { jobId: JOB_ID, personId: 'person_001' }, FIXED_NOW)
    assert.equal(c.id, 'application_20260808_00003')
    assert.equal(nextApplicationId(ws, FIXED_NOW), 'application_20260808_00004')
  } finally {
    teardown(ws)
  }
})

test('Case C：决策引用（linkApplicationDecision 登记；decisionId 非法拒绝）', () => {
  const ws = setup()
  try {
    const app = createApplication(ws, { jobId: JOB_ID, personId: 'person_001' }, FIXED_NOW)
    const linked = linkApplicationDecision(ws, app.id, 'decision_20260807_00042')
    assert.equal(linked.decisionId, 'decision_20260807_00042')
    assert.throws(() => linkApplicationDecision(ws, app.id, '非法id'), /非法决策 id/)
  } finally {
    teardown(ws)
  }
})

test('Case D：边界——jobId 不存在拒绝创建（Job 是岗位唯一事实源）', () => {
  const ws = setup()
  try {
    assert.throws(
      () => createApplication(ws, { jobId: '2026-01-01-不存在-岗位', personId: 'person_001' }, FIXED_NOW),
      /岗位不存在/,
    )
  } finally {
    teardown(ws)
  }
})

test('Case E：边界——非法 status / 非法 id / 记录不存在', () => {
  const ws = setup()
  try {
    const app = createApplication(ws, { jobId: JOB_ID, personId: 'person_001' }, FIXED_NOW)
    assert.throws(() => updateApplicationStatus(ws, app.id, '已投递' as never), /非法投递状态/)
    assert.throws(() => updateApplicationStatus(ws, '../x', 'SUBMITTED'), /非法投递记录 id/)
    assert.throws(() => getApplication(ws, 'application_20260808_00099'), /投递记录不存在/)
  } finally {
    teardown(ws)
  }
})

test('Case F：边界——Job 已删除（软删除/物理删除）后不能推进 SUBMITTED（displayFallback 需当时快照）', () => {
  const ws = setup()
  try {
    const app = createApplication(ws, { jobId: JOB_ID, personId: 'person_001' }, FIXED_NOW)
    ws.delete(`jobs/${JOB_ID}.md`)
    assert.throws(() => updateApplicationStatus(ws, app.id, 'SUBMITTED'), /岗位不存在/)
    // 非 SUBMITTED 状态推进不受 Job 生命周期影响（引用语义上仍是岗位的行动记录）
    const prepping = updateApplicationStatus(ws, app.id, 'WITHDRAWN')
    assert.equal(prepping.status, 'WITHDRAWN')
  } finally {
    teardown(ws)
  }
})

test('Case G：状态跃迁校验（Step 3.3）——相邻前进允许，跳变/倒退/终态再动拒绝', () => {
  const ws = setup()
  try {
    const app = createApplication(ws, { jobId: JOB_ID, personId: 'person_001' }, FIXED_NOW)
    // 允许：PREPARING → READY → SUBMITTED → COMMUNICATING → INTERVIEWING → OFFERED
    let cur = updateApplicationStatus(ws, app.id, 'READY')
    assert.equal(cur.status, 'READY')
    cur = updateApplicationStatus(ws, app.id, 'SUBMITTED')
    assert.equal(cur.status, 'SUBMITTED')
    cur = updateApplicationStatus(ws, app.id, 'COMMUNICATING')
    assert.equal(cur.status, 'COMMUNICATING')
    cur = updateApplicationStatus(ws, app.id, 'INTERVIEWING')
    assert.equal(cur.status, 'INTERVIEWING')
    cur = updateApplicationStatus(ws, app.id, 'OFFERED')
    assert.equal(cur.status, 'OFFERED')
    // 允许：PREPARING 直接 SUBMITTED（READY 是可选中间态）——新记录验证
    const direct = createApplication(ws, { jobId: JOB_ID, personId: 'person_001' }, FIXED_NOW)
    assert.equal(updateApplicationStatus(ws, direct.id, 'SUBMITTED').status, 'SUBMITTED')
    // 允许：WITHDRAWN 任何状态可入；REJECTED 仅投出后
    const w = createApplication(ws, { jobId: JOB_ID, personId: 'person_001' }, FIXED_NOW)
    assert.equal(updateApplicationStatus(ws, w.id, 'WITHDRAWN').status, 'WITHDRAWN')
    const r = createApplication(ws, { jobId: JOB_ID, personId: 'person_001' }, FIXED_NOW)
    assert.throws(() => updateApplicationStatus(ws, r.id, 'REJECTED'), /非法状态跃迁：PREPARING → REJECTED/)
  } finally {
    teardown(ws)
  }
})

test('Case H：状态跃迁校验——跳变（PREPARING→OFFERED）/ 倒退 / 终态再动拒绝', () => {
  const ws = setup()
  try {
    const app = createApplication(ws, { jobId: JOB_ID, personId: 'person_001' }, FIXED_NOW)
    // 跳变：PREPARING → OFFERED 禁止（必须经过投出与面试流程）
    assert.throws(() => updateApplicationStatus(ws, app.id, 'OFFERED'), /非法状态跃迁：PREPARING → OFFERED/)
    // 倒退：SUBMITTED → PREPARING 禁止
    updateApplicationStatus(ws, app.id, 'SUBMITTED')
    assert.throws(() => updateApplicationStatus(ws, app.id, 'PREPARING'), /非法状态跃迁：SUBMITTED → PREPARING/)
    // 终态：REJECTED 后再动拒绝
    updateApplicationStatus(ws, app.id, 'REJECTED')
    assert.throws(() => updateApplicationStatus(ws, app.id, 'WITHDRAWN'), /非法状态跃迁：REJECTED → WITHDRAWN/)
  } finally {
    teardown(ws)
  }
})

test('Case I：删除语义（Step 3.5）——仅 PREPARING 可物理删除，行动历史不可删除', () => {
  const ws = setup()
  try {
    // PREPARING 可删（撤销误操作）
    const app = createApplication(ws, { jobId: JOB_ID, personId: 'person_001' }, FIXED_NOW)
    deleteApplication(ws, app.id)
    assert.equal(listApplications(ws).length, 0)
    // 已推进记录删除拒绝（应推进 WITHDRAWN）
    const submitted = createApplication(ws, { jobId: JOB_ID, personId: 'person_001' }, FIXED_NOW)
    updateApplicationStatus(ws, submitted.id, 'SUBMITTED')
    assert.throws(() => deleteApplication(ws, submitted.id), /行动历史不可删除/)
    assert.equal(listApplications(ws).length, 1)
    // WITHDRAWN（历史保留）可推进
    assert.equal(updateApplicationStatus(ws, submitted.id, 'WITHDRAWN').status, 'WITHDRAWN')
  } finally {
    teardown(ws)
  }
})
