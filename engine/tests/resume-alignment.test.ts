/**
 * Resume Alignment Projection 单测（R2.1——契约 v0.1 §9 验证矩阵 4 case + 红线补充）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeResumeAlignment, type ResumeAlignmentInput } from '../runtime/resume-alignment.ts'
import type { CareerClaim, EvidenceItem, JobRecord } from '../ir/schema.ts'
import type { ResumeDocument } from '../ir/resume.ts'

const JOB: JobRecord = {
  id: 'job-test',
  company: '测试公司',
  title: '结构工程师',
  responsibilities: [
    {
      id: 'r1',
      statement: '机械结构设计',
      priority: 'must',
      capabilities: ['结构设计'],
      evidenceExpectations: [{ patternId: 'engineering_scope', questions: [] }],
      source: 'ai',
      category: 'hard',
    },
  ],
  createdAt: '2026-08-08',
}

const EVIDENCE: EvidenceItem = {
  id: 'e1',
  event: { title: '减速机壳体结构设计项目' },
  role: '结构负责人',
  contribution: '负责机械结构设计，完成强度校核',
  evidence: { scope: ['减速机壳体结构设计'] },
  source: 'resume_import',
  status: 'trusted',
  lifecycle: 'active',
}

const UNRELATED_EVIDENCE: EvidenceItem = {
  ...EVIDENCE,
  id: 'e2',
  contribution: '负责市场调研与竞品分析',
  evidence: { scope: ['市场分析'] },
}

const CLAIM: CareerClaim = {
  id: 'c1',
  statement: '完成减速机壳体结构设计',
  claimType: 'fact',
  provenance: [{ evidenceId: 'e1' }],
  created_at: '2026-08-08T00:00:00',
  source: 'agent_generated',
}

const RESUME_WITH_BULLET: ResumeDocument = {
  id: 'resume-test',
  status: 'draft',
  person: 'test',
  templateId: 't1',
  templateVersion: '1.0',
  sections: [
    {
      type: 'projects',
      title: '项目经验',
      bullets: [
        { sentence: '完成减速机壳体结构设计', claimId: 'c1', metadata: { expectationId: 'engineering_scope' } },
      ],
    },
  ],
  generatedAt: '2026-08-08T00:00:00',
}

const RESUME_EMPTY: ResumeDocument = { ...RESUME_WITH_BULLET, id: 'resume-empty', sections: [] }

function run(input: Partial<ResumeAlignmentInput> & { resumeDocument: ResumeDocument }): ReturnType<typeof computeResumeAlignment> {
  return computeResumeAlignment({
    job: JOB,
    evidenceItems: [],
    claims: [],
    ...input,
  })
}

test('Case 1 covered：证据 + 简历表达（挂锚）→ covered', () => {
  const p = run({ evidenceItems: [EVIDENCE], claims: [CLAIM], resumeDocument: RESUME_WITH_BULLET })
  assert.equal(p.jobId, 'job-test')
  assert.equal(p.rows.length, 1)
  const row = p.rows[0]
  assert.equal(row.state, 'covered')
  assert.deepEqual(row.evidenceRefs, ['e1'])
  assert.deepEqual(row.claimRefs, ['c1'])
  assert.deepEqual(row.bulletRefs, ['完成减速机壳体结构设计'])
  assert.match(row.explanation, /已覆盖/)
})

test('Case 2 expressive_gap：有证据但简历未表达 → expressive_gap', () => {
  const p = run({ evidenceItems: [EVIDENCE], claims: [CLAIM], resumeDocument: RESUME_EMPTY })
  const row = p.rows[0]
  assert.equal(row.state, 'expressive_gap')
  assert.deepEqual(row.bulletRefs, [])
  assert.match(row.explanation, /未体现/)
})

test('Case 3a unsupported（红线）：简历表达但 claimId 无证据锚 → unsupported_claim', () => {
  const ghost: ResumeDocument = {
    ...RESUME_WITH_BULLET,
    sections: [
      {
        type: 'projects',
        title: '项目经验',
        bullets: [{ sentence: '主导百万级项目', claimId: 'c-ghost', metadata: { expectationId: 'engineering_scope' } }],
      },
    ],
  }
  const p = run({ evidenceItems: [EVIDENCE], claims: [CLAIM], resumeDocument: ghost })
  const row = p.rows[0]
  // 有证据但 bullet 无 claim 锚 → 红线强制 unsupported（不因 evdHit 降级）
  assert.equal(row.state, 'unsupported_claim')
  assert.match(row.explanation, /找不到可信事实来源/)
})

test('Case 3b unsupported：简历表达（挂锚）但无相关证据 → unsupported_claim', () => {
  const p = run({ evidenceItems: [UNRELATED_EVIDENCE], claims: [], resumeDocument: RESUME_WITH_BULLET })
  const row = p.rows[0]
  assert.equal(row.state, 'unsupported_claim')
})

test('Case 4 capability_gap：无证据且无表达 → capability_gap', () => {
  const p = run({ evidenceItems: [UNRELATED_EVIDENCE], claims: [], resumeDocument: RESUME_EMPTY })
  const row = p.rows[0]
  assert.equal(row.state, 'capability_gap')
  assert.deepEqual(row.evidenceRefs, [])
  assert.match(row.explanation, /留白/)
})

test('多责任单元：只遍历有 evidenceExpectations 的责任（无期望的责任不产出行）', () => {
  const job: JobRecord = {
    ...JOB,
    responsibilities: [
      JOB.responsibilities[0],
      { id: 'r2', statement: '文档编写', priority: 'nice', capabilities: [], evidenceExpectations: [], source: 'user' },
    ],
  }
  const p = computeResumeAlignment({ job, evidenceItems: [EVIDENCE], claims: [CLAIM], resumeDocument: RESUME_WITH_BULLET })
  assert.equal(p.rows.length, 1)
  assert.equal(p.rows[0].responsibilityId, 'r1')
})
