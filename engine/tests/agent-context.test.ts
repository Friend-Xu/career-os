import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { createJobFile } from '../storage/job-watcher.ts'
import { validateContextPolicy } from '../agent/context/validator.ts'
import { resolveContextRefs, type RegistryStore } from '../agent/context/resolver.ts'
import { assembleContextBundle } from '../agent/context/assembler.ts'
import type { CompanyRecord, DecisionRecord } from '../ir/schema.ts'
import type { AgentTaskRequest } from '../ir/agent-task.ts'

/**
 * Context Assembly（ADR-020 Commit B）：validator（policy 规则）/ resolver（存在性 +
 * snapshot + provenance）/ assembler（组合）。断言：required 缺失拒绝、emptyAllowed:false
 * 空引用拒绝、引用不存在拒绝、合法引用解析带快照、空引用 = 合法 Bundle。
 */

const FIXED_NOW = new Date('2026-08-08T12:00:00Z')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cos-ctx-'))
  const ws = initWorkspace(root)
  createJobFile(ws, { company: '示例智造', title: '机械设计工程师', location: '杭州' }, FIXED_NOW)
  return ws
}

function teardown(ws: ReturnType<typeof initWorkspace>): void {
  rmSync(ws.paths.root, { recursive: true, force: true })
}

const JOB_ID = '2026-08-08-示例智造-机械设计工程师'

function stubStore(companies: CompanyRecord[] = [], decisions: DecisionRecord[] = []): RegistryStore {
  return {
    listCompanies: () => companies,
    listDecisions: () => decisions,
  }
}

function req(taskType: AgentTaskRequest['taskType'], contextRefs?: AgentTaskRequest['contextRefs']): AgentTaskRequest {
  return { taskType, contextRefs, trigger: 'user_action' }
}

test('validator：required 缺失 → MISSING_REQUIRED_CONTEXT（job_analysis 无 job）', () => {
  const rejected = validateContextPolicy(req('job_analysis', []))
  assert.equal(rejected?.reason, 'MISSING_REQUIRED_CONTEXT')
  assert.equal(validateContextPolicy(req('job_analysis', [{ type: 'job', id: 'x' }])), null)
})

test('validator：emptyAllowed:false 空引用拒绝；explanation 空引用合法', () => {
  // resume_adaptation：emptyAllowed:false + 空引用 → 拒绝
  const empty = validateContextPolicy(req('resume_adaptation', []))
  assert.equal(empty?.reason, 'MISSING_REQUIRED_CONTEXT')
  // resume_adaptation：required job+resume，缺 resume → 拒绝
  const rejected = validateContextPolicy(req('resume_adaptation', [{ type: 'job', id: 'x' }]))
  assert.equal(rejected?.reason, 'MISSING_REQUIRED_CONTEXT')
  assert.ok(rejected?.refs.some((r) => r.type === 'resume'))
  // explanation：开放探索，空引用合法
  assert.equal(validateContextPolicy(req('explanation', [])), null)
})

test('resolver：job 存在 → ResolvedContextReference（snapshot + provenance）', () => {
  const ws = setup()
  try {
    const result = resolveContextRefs(ws, stubStore(), [{ type: 'job', id: JOB_ID }])
    assert.ok('resolved' in result)
    const ref = result.resolved[0]
    assert.equal(ref.type, 'job')
    assert.equal(ref.id, JOB_ID)
    assert.equal(ref.label, '示例智造 机械设计工程师')
    assert.deepEqual(ref.snapshot, { kind: 'timestamp', value: '2026-08-08' })
    assert.deepEqual(ref.provenance, { kind: 'jd-analysis', label: '岗位分析' })
  } finally {
    teardown(ws)
  }
})

test('resolver：引用不存在 → INVALID_CONTEXT_REFERENCE（整体拒绝，fail fast）', () => {
  const ws = setup()
  try {
    const result = resolveContextRefs(ws, stubStore(), [{ type: 'job', id: '不存在的岗位' }])
    assert.ok('reason' in result)
    assert.equal(result.reason, 'INVALID_CONTEXT_REFERENCE')
    assert.equal(result.refs[0].error, '引用不存在')
    // 多引用中一个失效 → 整体拒绝
    const mixed = resolveContextRefs(ws, stubStore(), [
      { type: 'job', id: JOB_ID },
      { type: 'resume', id: 'resume-v9' },
    ])
    assert.ok('reason' in mixed)
  } finally {
    teardown(ws)
  }
})

test('resolver：company/decision 经 store 解析；空引用 = 空数组', () => {
  const ws = setup()
  try {
    const store = stubStore(
      [{ id: 'company_001', name: '示例科技', city: '', industry: '', matchScore: 0, riskLevel: 'low', source: '', tags: [], contacted: false }],
      [{ id: 'decision_001', title: '转行评估', skill: '', direction: '', directionMatch: 0, directionConfidence: 'medium', city: '', cityScore: 0, salaryFeasible: true, riskLevel: 'medium', keyRisk: '', status: 'completed', profile: '', summary: '', createdAt: '2026-08-01T00:00:00.000Z', protocolVersion: '2.1' }],
    )
    const r1 = resolveContextRefs(ws, store, [{ type: 'company', id: 'company_001' }])
    assert.ok('resolved' in r1)
    assert.equal(r1.resolved[0].label, '示例科技')
    assert.equal(r1.resolved[0].snapshot, undefined) // 公司无时间字段——snapshot 省略
    const r2 = resolveContextRefs(ws, store, [{ type: 'decision', id: 'decision_001' }])
    assert.ok('resolved' in r2)
    assert.deepEqual(r2.resolved[0].snapshot, { kind: 'timestamp', value: '2026-08-01' })
    // 空引用 → 合法（统一生命周期）
    const empty = resolveContextRefs(ws, store, [])
    assert.ok('resolved' in empty)
    assert.deepEqual(empty.resolved, [])
  } finally {
    teardown(ws)
  }
})

test('assembler：组合 Reference Manifest + generatedAt', () => {
  const bundle = assembleContextBundle([], FIXED_NOW)
  assert.deepEqual(bundle, { references: [], generatedAt: '2026-08-08T12:00:00.000Z' })
  const filled = assembleContextBundle(
    [{ type: 'job', id: JOB_ID, label: '示例智造 机械设计工程师', snapshot: { kind: 'timestamp', value: '2026-08-08' }, provenance: { kind: 'jd-analysis', label: '岗位分析' } }],
    FIXED_NOW,
  )
  assert.equal(filled.references.length, 1)
  assert.equal(filled.references[0].id, JOB_ID)
})
