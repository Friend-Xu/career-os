/**
 * evidence-coverage 单测：双层过滤（contribution × statement 双向包含 + 维度覆盖）三态判定、
 * archived 排除、pattern 词表外跳过、无 expectations 责任跳过。
 * evidence-policy：canConsumeEvidence 仅 trusted。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EvidenceItem, JobRecord } from '../ir/schema.ts'
import { computeEvidenceCoverage } from '../runtime/evidence-coverage.ts'
import { canConsumeEvidence } from '../storage/evidence-policy.ts'

function item(over: Partial<EvidenceItem> & { id: string; contribution: string }): EvidenceItem {
  return {
    event: { title: 'x' },
    role: '工程师',
    evidence: {},
    source: { type: 'user_input', capturedAt: '2026-08-05T00:00:00Z' },
    status: 'candidate',
    ...over,
  }
}

const JOB: JobRecord = {
  id: 'job-1',
  company: '某公司',
  title: '机械结构工程师',
  responsibilities: [
    {
      id: 'ai-1',
      statement: '自动化设备结构设计',
      priority: 'must',
      capabilities: ['机械设计'],
      evidenceExpectations: [
        { patternId: 'engineering_scope', questions: ['你负责哪些模块？'] },
        { patternId: 'engineering_validation', questions: ['如何验证？'] },
        { patternId: 'engineering_impact', questions: ['改善了哪些指标？'] },
      ],
      source: 'ai',
    },
    {
      id: 'user-1',
      statement: 'SolidWorks',
      priority: 'must',
      capabilities: [],
      evidenceExpectations: [],
      source: 'user',
    },
  ],
  createdAt: '2026-08-05',
}

test('covered：关联 item 且维度有值；missing：无关联；partial：关联但维度缺', () => {
  const items = [
    item({ id: 'evidence_1', contribution: '负责自动化设备结构设计，机架与传动模块', evidence: { scope: [{ content: '机架' }], validation: [{ content: '样机测试' }] } }),
    item({ id: 'evidence_2', contribution: '负责自动化设备结构设计的后期维护与改造', evidence: {} }),
    item({ id: 'evidence_3', contribution: '非相关经历：市场调研', evidence: { impact: [{ content: 'x' }] } }),
  ]
  const out = computeEvidenceCoverage(JOB, items)
  assert.equal(out.length, 1) // 无 expectations 的 user-1 跳过
  const exp = out[0].expectations
  assert.equal(exp.length, 3)
  const scope = exp.find((e) => e.patternId === 'engineering_scope')!
  assert.equal(scope.status, 'covered')
  assert.deepEqual(scope.matchedItems, ['evidence_1', 'evidence_2']) // 双向包含关联（evidence_2 也被关联）
  const validation = exp.find((e) => e.patternId === 'engineering_validation')!
  assert.equal(validation.status, 'covered')
  const impact = exp.find((e) => e.patternId === 'engineering_impact')!
  assert.equal(impact.status, 'partial') // 关联了 evidence_1/2 但无 impact 值
  assert.equal(impact.reason, 'missing_dimension')
  assert.deepEqual(impact.missingDimensions, ['impact'])
})

test('missing：无关联 item → no_evidence', () => {
  const out = computeEvidenceCoverage(JOB, [item({ id: 'e1', contribution: '市场调研经历' })])
  const exp = out[0].expectations
  assert.ok(exp.every((e) => e.status === 'missing'))
  assert.ok(exp.every((e) => e.reason === 'no_evidence'))
})

test('archived 排除：已退役条目不参与覆盖', () => {
  const items = [
    item({ id: 'e1', contribution: '负责自动化设备结构设计', evidence: { scope: [{ content: '机架' }] }, status: 'archived' }),
    item({ id: 'e2', contribution: '不相关' }),
  ]
  const out = computeEvidenceCoverage(JOB, items)
  assert.equal(out[0].expectations[0].status, 'missing')
})

test('pattern 词表外（数据异常）→ 该 expectation 跳过不产出', () => {
  const job: JobRecord = {
    ...JOB,
    responsibilities: [{ ...JOB.responsibilities[0], evidenceExpectations: [{ patternId: 'bad_pattern', questions: [] }] }],
  }
  const out = computeEvidenceCoverage(job, [item({ id: 'e1', contribution: '自动化设备结构设计' })])
  assert.equal(out.length, 0)
})

test('canConsumeEvidence：仅 trusted 可消费（raw/candidate/archived 不得提级）', () => {
  const base = item({ id: 'e1', contribution: 'x' })
  assert.equal(canConsumeEvidence({ ...base, status: 'trusted' }, 'resume'), true)
  assert.equal(canConsumeEvidence({ ...base, status: 'candidate' }, 'resume'), false)
  assert.equal(canConsumeEvidence({ ...base, status: 'raw' }, 'interview'), false)
  assert.equal(canConsumeEvidence({ ...base, status: 'archived' }, 'interview'), false)
})
