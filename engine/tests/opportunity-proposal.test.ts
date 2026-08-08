/**
 * Opportunity Proposal Bridge 测试矩阵（P3.3——契约 opportunity-proposal-contract-v0.1 §7）。
 * 验证：context 组装（责任 + 证据回源 + 当前块）→ 提交候选（FACT_GROUNDING：numeric/capability 锚）→
 * snapshot 固化（wcRevision/evidenceHash/opportunityVersion）→ 生命周期（approve/reject 单向）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { scanWorkingCopies } from '../storage/working-copy-registry.ts'
import { computeOpportunities } from '../runtime/opportunity.ts'
import {
  buildBridgeContext,
  submitOpportunityProposal,
  scanOpportunityProposals,
  approveOpportunityProposal,
  rejectOpportunityProposal,
  OpportunityProposalError,
} from '../storage/opportunity-proposal-registry.ts'

function setup(): { ws: Workspace; root: string; wcId: string; opportunityId: string } {
  const root = mkdtempSync(join(tmpdir(), 'cos-opp-'))
  const ws = initWorkspace(root)
  ws.write(
    'jobs/job_test.md',
    `---
id: job_test
company: 测试公司
title: 结构工程师
created_at: 2026-08-09
---

# 测试公司 · 结构工程师

## 分析摘要

| 字段 | 值 |
|------|-----|
| requirements | 机械结构设计 |

## 岗位智能

| Responsibility | Priority | Category | Capabilities | Evidence Patterns | Questions |
| 机械结构设计 | must | hard | 结构设计 | scope | 负责哪些模块？ |
`,
  )
  ws.write(
    'evidence/evidence_20260809_00001.md',
    `---
id: evidence_20260809_00001
created_at: 2026-08-09
lifecycle: active
---
# 减速机壳体结构设计项目

## 分析摘要

| 字段 | 值 |
|------|-----|
| event | 减速机壳体结构设计项目 |
| role | 机械结构负责人 |
| contribution | 负责机械结构设计，完成强度校核 |
| status | trusted |
| source_type | user_input |
| captured_at | 2026-08-09 |
| verification_type | user_confirmed |
| confirmed_at | 2026-08-09 |

## 证据

### scope

- 减速机壳体结构设计

### impact

- 使装配效率提升 30%
`,
  )
  ws.write(
    'resumes/working-copies/wc_test_00001.md',
    `---
id: wc_test_00001
owner: p1
revision: 2
updated_at: 2026-08-09T00:00:00.000Z
---
# 简历工作副本

## 项目经验

- 参与机械结构设计相关工作
`,
  )

  const wc = scanWorkingCopies(ws)[0]
  const ops = computeOpportunities({
    job: { id: 'job_test', company: '测试公司', title: '结构工程师', responsibilities: [{ id: 'ai-1', statement: '机械结构设计', priority: 'must', capabilities: ['结构设计'], evidenceExpectations: [{ patternId: 'engineering_scope', questions: [] }], source: 'ai', category: 'hard' }], createdAt: '2026-08-09' },
    evidenceItems: [{ id: 'evidence_20260809_00001', event: { title: '减速机壳体结构设计项目' }, role: '机械结构负责人', contribution: '负责机械结构设计，完成强度校核', evidence: { scope: [{ content: '减速机壳体结构设计' }], impact: [{ content: '使装配效率提升 30%' }] }, source: { type: 'user_input', capturedAt: '2026-08-09T00:00:00' }, status: 'trusted', lifecycle: 'active' }],
    claims: [],
    resumeDocument: { id: 'doc-1', status: 'draft', person: 'p1', templateId: 't1', templateVersion: '1.0', sections: [{ type: 'projects', title: '项目经验', bullets: [{ sentence: '参与机械结构设计相关工作', claimId: '' }] }], generatedAt: '2026-08-09T00:00:00' },
    wc,
  })
  const opportunityId = ops.find((o) => o.source === 'alignment')!.id
  return { ws, root, wcId: wc.id, opportunityId }
}

function validChanges() {
  return [{ blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核，使装配效率提升 30%', operation: 'rewrite' as const }]
}

test('context 组装：责任语句 + 证据回源（v0.2 维度全文本）+ 当前块文本（弱命中 rewrite）', () => {
  const { ws, wcId, opportunityId } = setup()
  const ctx = buildBridgeContext(ws, wcId, opportunityId)
  assert.equal(ctx.responsibilityStatement, '机械结构设计')
  assert.equal(ctx.evidence.length, 1)
  assert.equal(ctx.evidence[0].contribution, '负责机械结构设计，完成强度校核')
  assert.equal(ctx.evidence[0].impact, '使装配效率提升 30%')
  assert.match(ctx.evidence[0].content, /使装配效率提升 30%/)
  assert.equal(ctx.currentBlockText, '参与机械结构设计相关工作')
  assert.equal(ctx.opportunity.applyTarget?.action, 'rewrite')
  assert.match(ctx.opportunity.suggestedAction, /生成候选表达/)
})

test('有效提交：FACT_GROUNDING 通过 → pending 登记 + snapshot 固化', () => {
  const { ws, wcId, opportunityId } = setup()
  const p = submitOpportunityProposal(ws, { opportunityId, wcId, changes: validChanges() }, new Date('2026-08-09T10:00:00Z'))
  assert.match(p.id, /^opportunity_proposal_20260809_\d{5}$/)
  assert.equal(p.status, 'pending')
  assert.equal(p.validation.status, 'valid')
  assert.equal(p.validation.sourceSnapshot.wcRevision, 2)
  assert.match(p.validation.sourceSnapshot.opportunityVersion, /^[0-9a-f]{12}$/)
  assert.match(p.validation.sourceSnapshot.evidenceHash, /^[0-9a-f]{12}$/)
  assert.deepEqual(p.changes, validChanges())
})

test('numeric_anchor：after 数字无证据锚 → invalid（Claim Strength ≤ Evidence Strength）', () => {
  const { ws, wcId, opportunityId } = setup()
  assert.throws(
    () => submitOpportunityProposal(ws, { opportunityId, wcId, changes: [{ ...validChanges()[0], after: '使装配效率提升 95%' }] }),
    (e: unknown) => e instanceof OpportunityProposalError && /numeric_anchor/.test(e.message),
  )
})

test('capability_anchor：after 升级词但证据无 → invalid（参与 ≠ 主导）', () => {
  const { ws, wcId, opportunityId } = setup()
  assert.throws(
    () => submitOpportunityProposal(ws, { opportunityId, wcId, changes: [{ ...validChanges()[0], after: '主导机械结构架构设计' }] }),
    (e: unknown) => e instanceof OpportunityProposalError && /capability_anchor/.test(e.message),
  )
})

test('EMPTY_EDIT：before/after 均空 → invalid', () => {
  const { ws, wcId, opportunityId } = setup()
  assert.throws(
    () => submitOpportunityProposal(ws, { opportunityId, wcId, changes: [{ operation: 'rewrite', before: '', after: '' }] }),
    (e: unknown) => e instanceof OpportunityProposalError && /EMPTY_EDIT/.test(e.message),
  )
})

test('OPPORTUNITY_REF：不存在的机会 id → 拒绝', () => {
  const { ws, wcId } = setup()
  assert.throws(
    () => submitOpportunityProposal(ws, { opportunityId: 'alignment:job_test:no-such', wcId, changes: validChanges() }),
    (e: unknown) => e instanceof OpportunityProposalError && /OPPORTUNITY_REF/.test(e.message),
  )
})

test('material 机会不建 Proposal（id 解析拒绝）', () => {
  const { ws, wcId } = setup()
  assert.throws(
    () => submitOpportunityProposal(ws, { opportunityId: 'material:evidence_20260809_00001', wcId, changes: validChanges() }),
    (e: unknown) => e instanceof OpportunityProposalError && /OPPORTUNITY_REF/.test(e.message),
  )
})

test('生命周期：approve → approved；再 approve 拒绝；reject 单向', () => {
  const { ws, wcId, opportunityId } = setup()
  const p = submitOpportunityProposal(ws, { opportunityId, wcId, changes: validChanges() }, new Date('2026-08-09T10:00:00Z'))
  const approved = approveOpportunityProposal(ws, p.id, new Date('2026-08-09T10:05:00Z'))
  assert.equal(approved.status, 'approved')
  assert.ok(approved.decidedAt)
  assert.throws(() => approveOpportunityProposal(ws, p.id), (e: unknown) => e instanceof OpportunityProposalError && /仅 pending/.test(e.message))

  const p2 = submitOpportunityProposal(ws, { opportunityId, wcId, changes: validChanges() }, new Date('2026-08-09T10:10:00Z'))
  const rejected = rejectOpportunityProposal(ws, p2.id, '措辞不准确')
  assert.equal(rejected.status, 'rejected')
  assert.throws(() => rejectOpportunityProposal(ws, p2.id), (e: unknown) => e instanceof OpportunityProposalError && /仅 pending/.test(e.message))
})

test('扫描 round-trip：登记 → 扫描 → changes/snapshot/status 一致', () => {
  const { ws, wcId, opportunityId } = setup()
  submitOpportunityProposal(ws, { opportunityId, wcId, changes: validChanges() }, new Date('2026-08-09T10:00:00Z'))
  const scanned = scanOpportunityProposals(ws)
  assert.equal(scanned.length, 1)
  const p = scanned[0]
  assert.equal(p.opportunityId, opportunityId)
  assert.equal(p.changes.length, 1)
  assert.equal(p.changes[0].operation, 'rewrite')
  assert.equal(p.changes[0].before, '参与机械结构设计相关工作')
  assert.equal(p.changes[0].after, '负责机械结构设计，完成强度校核，使装配效率提升 30%')
  assert.equal(p.validation.sourceSnapshot.wcRevision, 2)
  assert.equal(p.status, 'pending')
})

test('changes 多块（合并方案）：全部校验通过 → 登记', () => {
  const { ws, wcId, opportunityId } = setup()
  const p = submitOpportunityProposal(
    ws,
    {
      opportunityId,
      wcId,
      changes: [
        { blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计', operation: 'rewrite' },
        { before: '', after: '完成强度校核，使装配效率提升 30%', operation: 'insert' },
      ],
    },
    new Date('2026-08-09T10:00:00Z'),
  )
  assert.equal(p.changes.length, 2)
  assert.equal(p.changes[1].operation, 'insert')
  assert.equal(p.changes[1].blockId, undefined)
})
