/**
 * claim-coverage 单测：岗位上下文 Claim Coverage——responsibility → 关联 trusted evidence → 可消费 Claims。
 * 复用 Coverage 引擎责任关联（contribution × statement 双向包含）；claim 关联走 provenance。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CareerClaim, EvidenceItem, JobRecord } from '../ir/schema.ts'
import { computeClaimCoverage } from '../runtime/claim-coverage.ts'

const JOB: JobRecord = {
  id: 'job_20260805_00001',
  company: '某自动化设备公司',
  title: '自动化设备结构设计工程师',
  responsibilities: [
    {
      id: 'ai-1',
      statement: '负责自动化设备机械结构设计',
      priority: 'must',
      capabilities: ['结构设计'],
      evidenceExpectations: [
        { patternId: 'engineering_scope', questions: ['设计哪些模块？'] },
        { patternId: 'engineering_validation', questions: ['如何验证？'] },
      ],
      source: 'ai',
    },
    {
      id: 'ai-2',
      statement: '负责产线节拍优化',
      priority: 'must',
      capabilities: ['节拍优化'],
      evidenceExpectations: [{ patternId: 'engineering_impact', questions: ['改善了什么指标？'] }],
      source: 'ai',
    },
  ],
  createdAt: '2026-08-05',
}

function ev(id: string, contribution: string, status: EvidenceItem['status'] = 'trusted'): EvidenceItem {
  return {
    id,
    event: { title: id },
    role: '机械结构负责人',
    contribution,
    evidence: { scope: [{ content: '机架和传动模块设计' }], validation: [{ content: '完成样机测试' }] },
    source: { type: 'user_input', capturedAt: '2026-08-05' },
    status,
  }
}

function claim(id: string, evidenceIds: string[], statement: string, claimType: CareerClaim['claimType'] = 'fact'): CareerClaim {
  return {
    id,
    created_at: '2026-08-05',
    source: 'agent_generated',
    statement,
    claimType,
    provenance: evidenceIds.map((evidenceId) => ({ evidenceId })),
  }
}

test('computeClaimCoverage：responsibility → 关联 trusted evidence → 可消费 Claims', () => {
  const evidence = [ev('evidence_20260805_00001', '负责自动化设备机械结构设计，完成机架和传动模块设计')]
  const claims = [claim('claim_20260805_00001', ['evidence_20260805_00001'], '负责自动化设备机械结构设计')]
  const rows = computeClaimCoverage(JOB, evidence, claims)
  assert.equal(rows.length, 2) // 两个有 evidenceExpectations 的责任单元
  const row = rows.find((r) => r.responsibility.includes('机械结构设计'))!
  assert.equal(row.evidenceStatus, 'covered')
  assert.deepEqual(row.matchedItems, ['evidence_20260805_00001'])
  assert.equal(row.claims.length, 1)
  assert.equal(row.claims[0].statement, '负责自动化设备机械结构设计')
  assert.equal(row.claims[0].claimType, 'fact')
})

test('computeClaimCoverage：引用不相关证据的 claim 不出现（关联走 matchedItems）', () => {
  const evidence = [ev('evidence_20260805_00001', '负责自动化设备机械结构设计，完成机架和传动模块设计')]
  const claims = [claim('claim_20260805_00001', ['evidence_20260805_00099'], '无关声明')]
  const rows = computeClaimCoverage(JOB, evidence, claims)
  assert.equal(rows[0].claims.length, 0)
})

test('computeClaimCoverage：不可消费 claim（证据 candidate）不出现', () => {
  const evidence = [ev('evidence_20260805_00001', '负责自动化设备机械结构设计，完成机架和传动模块设计', 'candidate')]
  const claims = [claim('claim_20260805_00001', ['evidence_20260805_00001'], '负责自动化设备机械结构设计')]
  const rows = computeClaimCoverage(JOB, evidence, claims)
  assert.equal(rows[0].claims.length, 0)
})

test('computeClaimCoverage：responsibility 级三态取 expectations 最差（partial/missing 时 claims 仍列出）', () => {
  // 关联 item 但 validation 维度缺失 → partial；claims 引用该 item 仍可列出（表达候选不依赖维度覆盖）
  const partialEv: EvidenceItem = {
    ...ev('evidence_20260805_00001', '负责自动化设备机械结构设计，完成机架和传动模块设计'),
    evidence: { scope: [{ content: '机架和传动模块设计' }] }, // 无 validation
  }
  const claims = [claim('claim_20260805_00001', ['evidence_20260805_00001'], '负责自动化设备机械结构设计')]
  const rows = computeClaimCoverage(JOB, [partialEv], claims)
  const row = rows.find((r) => r.responsibility.includes('机械结构设计'))!
  assert.equal(row.evidenceStatus, 'partial')
  assert.equal(row.claims.length, 1)
})
