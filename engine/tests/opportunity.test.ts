/**
 * Opportunity Projection 单测（P3.2——契约 resume-opportunity-model-v0.1 §8 验证矩阵）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeOpportunities } from '../runtime/opportunity.ts'
import type { CareerClaim, EvidenceItem, JobRecord } from '../ir/schema.ts'
import type { ResumeDocument, WorkingCopy, WorkingSection } from '../ir/resume.ts'

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
  createdAt: '2026-08-09',
}

const EVIDENCE: EvidenceItem = {
  id: 'e1',
  event: { title: '减速机壳体结构设计项目' },
  role: '结构负责人',
  contribution: '负责机械结构设计，完成强度校核',
  evidence: { scope: [{ content: '减速机壳体结构设计' }] },
  source: { type: 'resume', capturedAt: '2026-08-09T00:00:00' },
  status: 'trusted',
  lifecycle: 'active',
}

const UNRELATED: EvidenceItem = { ...EVIDENCE, id: 'e2', contribution: '负责市场调研与竞品分析', evidence: { scope: [{ content: '市场分析' }] } }

const CLAIM: CareerClaim = {
  id: 'c1',
  statement: '完成减速机壳体结构设计',
  claimType: 'fact',
  provenance: [{ evidenceId: 'e1' }],
  created_at: '2026-08-09T00:00:00',
  source: 'agent_generated',
}

const CLAIM_GHOST: CareerClaim = { ...CLAIM, id: 'c-ghost', provenance: [] }

function wc(sections: WorkingSection[]): WorkingCopy {
  return { id: 'wc-1', owner: 'p1', sections, status: 'active', revision: 0, updatedAt: '2026-08-09T00:00:00' }
}

function doc(sections: { type: string; title: string; bullets: { sentence: string; claimId: string }[] }[]): ResumeDocument {
  return {
    id: 'doc-1',
    status: 'draft',
    person: 'p1',
    templateId: 't1',
    templateVersion: '1.0',
    sections: sections as ResumeDocument['sections'],
    generatedAt: '2026-08-09T00:00:00',
  }
}

const EMPTY_WC = wc([])
const EMPTY_DOC = doc([])

function run(input: { job?: JobRecord; evidenceItems?: EvidenceItem[]; claims?: CareerClaim[]; wc?: WorkingCopy; doc?: ResumeDocument }) {
  return computeOpportunities({
    job: input.job ?? JOB,
    evidenceItems: input.evidenceItems ?? [],
    claims: input.claims ?? [],
    resumeDocument: input.doc ?? EMPTY_DOC,
    wc: input.wc ?? EMPTY_WC,
  })
}

test('Case 1 expressive_gap：无命中块 → alignment/high/improve_value + insert', () => {
  const ops = run({ evidenceItems: [EVIDENCE], claims: [CLAIM] })
  assert.equal(ops.length, 1)
  const o = ops[0]
  assert.equal(o.source, 'alignment')
  assert.equal(o.severity, 'high')
  assert.equal(o.intent, 'improve_value')
  assert.deepEqual(o.applyTarget, { wcId: 'wc-1', action: 'insert' })
  assert.deepEqual(o.refs, { evidenceIds: ['e1'], claimIds: ['c1'] })
  assert.match(o.suggestedAction, /生成候选表达/)
})

test('Case 2 expressive_gap + 弱命中：unbound 块文本关联责任 → rewrite + blockId', () => {
  const ops = run({
    evidenceItems: [EVIDENCE],
    claims: [CLAIM],
    wc: wc([{ id: 's1', title: '项目经验', blocks: [{ id: 'b1', text: '参与机械结构设计相关工作' }] }]),
    doc: doc([{ type: 'projects', title: '项目经验', bullets: [{ sentence: '参与机械结构设计相关工作', claimId: '' }] }]),
  })
  assert.equal(ops[0].applyTarget?.action, 'rewrite')
  assert.equal(ops[0].applyTarget?.blockId, 'b1')
})

test('Case 3 unsupported_claim：bound 块但 claim 无证据 → alignment/high/reduce_risk + delete', () => {
  const ops = run({
    evidenceItems: [EVIDENCE],
    claims: [CLAIM_GHOST],
    wc: wc([{ id: 's1', title: '项目经验', blocks: [{ id: 'b1', text: '主导量产导入', provenanceLinks: ['c-ghost'] }] }]),
    doc: doc([{ type: 'projects', title: '项目经验', bullets: [{ sentence: '主导量产导入', claimId: 'c-ghost' }] }]),
  })
  const o = ops.find((x) => x.source === 'alignment')
  assert.ok(o)
  assert.equal(o.severity, 'high')
  assert.equal(o.intent, 'reduce_risk')
  assert.deepEqual(o.applyTarget, { wcId: 'wc-1', blockId: 'b1', action: 'delete' })
  assert.match(o.severityReason, /可信度风险/)
  assert.match(o.suggestedAction, /补充证据或删除/)
  // c-ghost 无 provenance——e1 同时是未资产化素材（两条机会叠加，语义独立）
  assert.equal(ops.filter((x) => x.source === 'material').length, 1)
})

test('Case 4 covered 行：不产生机会（且 evidence 已被 claim 引用，无 material）', () => {
  const ops = run({
    evidenceItems: [EVIDENCE],
    claims: [CLAIM],
    wc: wc([{ id: 's1', title: '项目经验', blocks: [{ id: 'b1', text: '完成减速机壳体结构设计', provenanceLinks: ['c1'] }] }]),
    doc: doc([{ type: 'projects', title: '项目经验', bullets: [{ sentence: '完成减速机壳体结构设计', claimId: 'c1' }] }]),
  })
  assert.deepEqual(ops, [])
})

test('Case 5 capability_gap 行：不产生机会（诚实留白）', () => {
  const ops = run({ evidenceItems: [UNRELATED] })
  assert.deepEqual(ops, [])
})

test('Case 6 material：evidence 被岗位匹配但无 claim 引用 → material/medium/activate_asset', () => {
  const ops = run({ evidenceItems: [EVIDENCE], claims: [] })
  const o = ops.find((x) => x.source === 'material')
  assert.ok(o)
  assert.equal(o.severity, 'medium')
  assert.equal(o.intent, 'activate_asset')
  assert.equal(o.applyTarget, undefined)
  assert.deepEqual(o.refs, { evidenceIds: ['e1'], claimIds: [] })
  assert.match(o.suggestedAction, /ClaimProposal/)
  // 无 claim 时 e1 同时产生 expressive_gap（岗位对齐机会）——两类机会语义独立
  assert.equal(ops.filter((x) => x.source === 'alignment').length, 1)
})

test('Case 7 evidence 已被 claim 引用：无 material 机会', () => {
  const ops = run({ evidenceItems: [EVIDENCE], claims: [CLAIM] })
  assert.equal(ops.some((o) => o.source === 'material'), false)
})

test('id 确定性派生：同输入两次计算幂等', () => {
  const a = run({ evidenceItems: [EVIDENCE] })
  const b = run({ evidenceItems: [EVIDENCE] })
  assert.deepEqual(a.map((o) => o.id), b.map((o) => o.id))
  assert.equal(a[0].id, 'alignment:job-test:r1')
  assert.equal(a.find((o) => o.source === 'material')?.id, 'material:e1')
})

test('混合：expressive_gap + material 同时存在，severity 排序 high 在前', () => {
  const extra: EvidenceItem = { ...EVIDENCE, id: 'e3', contribution: '完成机械结构设计与 DFM 分析', evidence: { scope: [{ content: 'DFM 分析' }] } }
  const ops = run({ evidenceItems: [EVIDENCE, extra], claims: [CLAIM] })
  const sources = ops.map((o) => o.source)
  assert.deepEqual(sources, ['alignment', 'material'])
  assert.equal(ops[0].severity, 'high')
  assert.equal(ops[1].id, 'material:e3')
})
