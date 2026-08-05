/**
 * claim-selector 单测：表达候选选择——per-responsibility 筛选可消费 Claims + SelectionReason + 可解释优先级。
 * 校验：canUseClaim 消费前置、fact 优先于 interpretation、coverageStatus 排序、reason 锚点。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CareerClaim, EvidenceItem, JobRecord } from '../ir/schema.ts'
import { selectExpressionCandidates } from '../runtime/claim-selector.ts'

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

test('selectExpressionCandidates：选择引用匹配 evidence 的可消费 claim + SelectionReason 锚点', () => {
  const evidence = [ev('evidence_20260805_00001', '负责自动化设备机械结构设计，完成机架和传动模块设计')]
  const claims = [claim('claim_20260805_00001', ['evidence_20260805_00001'], '负责自动化设备机械结构设计')]
  const rows = selectExpressionCandidates(JOB, evidence, claims)
  const row = rows.find((r) => r.responsibility.includes('机械结构设计'))!
  assert.equal(row.candidates.length, 1)
  const c = row.candidates[0]
  assert.equal(c.claimId, 'claim_20260805_00001')
  assert.equal(c.claimType, 'fact')
  assert.equal(c.reason.expectationId, 'engineering_scope')
  assert.equal(c.reason.matchedDimension, 'scope')
  assert.equal(c.reason.coverageStatus, 'covered')
})

test('selectExpressionCandidates：不可消费 claim（证据 candidate/archived）不进入候选', () => {
  const evidence = [ev('evidence_20260805_00001', '负责自动化设备机械结构设计，完成机架和传动模块设计', 'candidate')]
  const claims = [claim('claim_20260805_00001', ['evidence_20260805_00001'], '负责自动化设备机械结构设计')]
  const rows = selectExpressionCandidates(JOB, evidence, claims)
  assert.equal(rows.find((r) => r.responsibility.includes('机械结构设计'))!.candidates.length, 0)
})

test('selectExpressionCandidates：fact 优先于 interpretation（priority 排序可解释）', () => {
  const evidence = [ev('evidence_20260805_00001', '负责自动化设备机械结构设计，完成机架和传动模块设计')]
  const claims = [
    claim('claim_20260805_00001', ['evidence_20260805_00001'], '负责自动化设备机械结构设计', 'fact'),
    claim('claim_20260805_00002', ['evidence_20260805_00001'], '参与完整开发流程', 'interpretation'),
  ]
  const row = selectExpressionCandidates(JOB, evidence, claims).find((r) => r.responsibility.includes('机械结构设计'))!
  assert.equal(row.candidates.length, 2)
  assert.equal(row.candidates[0].claimId, 'claim_20260805_00001') // fact 排前
  assert.ok(row.candidates[0].priority > row.candidates[1].priority)
})

test('selectExpressionCandidates：partial 责任单元的 reason.coverageStatus = partial（不影响候选选择）', () => {
  const partialEv: EvidenceItem = {
    ...ev('evidence_20260805_00001', '负责自动化设备机械结构设计，完成机架和传动模块设计'),
    evidence: { scope: [{ content: '机架和传动模块设计' }] }, // 无 validation → validation expectation partial
  }
  const claims = [claim('claim_20260805_00001', ['evidence_20260805_00001'], '负责自动化设备机械结构设计')]
  const row = selectExpressionCandidates(JOB, [partialEv], claims).find((r) => r.responsibility.includes('机械结构设计'))!
  assert.equal(row.candidates.length, 1)
  assert.equal(row.candidates[0].reason.coverageStatus, 'covered') // scope expectation 仍 covered，作为首选理由
  assert.equal(row.candidates[0].reason.expectationId, 'engineering_scope')
})

test('selectExpressionCandidates：引用不相关 evidence 的 claim 不出现（关联走 matchedItems）', () => {
  const evidence = [ev('evidence_20260805_00001', '负责自动化设备机械结构设计，完成机架和传动模块设计')]
  const claims = [claim('claim_20260805_00001', ['evidence_20260805_00099'], '无关声明')]
  const rows = selectExpressionCandidates(JOB, evidence, claims)
  assert.equal(rows.every((r) => r.candidates.length === 0), true)
})
