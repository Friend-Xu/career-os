/**
 * OpportunityHistory 测试矩阵（P4.1——契约 opportunity-history-contract-v0.1 §8）。
 * 验证：决策终态登记（applied/conflict/rejected）；submit 时快照固化且重诊断后仍完整（P4.1 核心价值）；
 * 同提案幂等（不重复条目）；无快照旧提案不登记；reject 审计先行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { scanWorkingCopies, upsertWorkingCopy } from '../storage/working-copy-registry.ts'
import { scanJobs } from '../storage/job-watcher.ts'
import { scanEvidence } from '../storage/evidence-watcher.ts'
import { scanClaims } from '../storage/claim-watcher.ts'
import { workingCopyToDocument } from '../storage/working-copy-registry.ts'
import { computeOpportunities } from '../runtime/opportunity.ts'
import {
  submitOpportunityProposal,
  approveOpportunityProposal,
  rejectOpportunityProposal,
  applyOpportunityProposal,
  scanOpportunityProposals,
  scanOpportunityHistory,
} from '../storage/opportunity-proposal-registry.ts'
import type { WorkingCopy } from '../ir/resume.ts'

function wcInput(sections: WorkingCopy['sections']): { owner: string; sections: WorkingCopy['sections']; revision: number } {
  return { owner: 'p1', sections, revision: 2 }
}

function setup(): { ws: Workspace; wc: WorkingCopy; opportunityId: string } {
  const root = mkdtempSync(join(tmpdir(), 'cos-oh-'))
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
`,
  )
  const wc = upsertWorkingCopy(
    ws,
    wcInput([
      {
        id: 'sec_1',
        title: '项目经验',
        blocks: [
          { id: 'blk_1', text: '参与机械结构设计相关工作' },
          { id: 'blk_2', text: '负责样机验证' },
        ],
      },
    ]),
    new Date('2026-08-09T10:00:00Z'),
  ).copy
  return { ws, wc, opportunityId: 'alignment:job_test:ai-1' }
}

function submitApproved(ws: Workspace, wcId: string, opportunityId: string, changes: Parameters<typeof submitOpportunityProposal>[1]['changes']): string {
  const p = submitOpportunityProposal(ws, { opportunityId, wcId, changes }, new Date('2026-08-09T10:00:00Z'))
  approveOpportunityProposal(ws, p.id, new Date('2026-08-09T10:05:00Z'))
  return p.id
}

test('submit 固化快照：opportunitySnapshot 完整（source/severity/intent/anchor/reason/refs）', () => {
  const { ws, wc, opportunityId } = setup()
  const p = submitOpportunityProposal(
    ws,
    { opportunityId, wcId: wc.id, changes: [{ blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' }] },
    new Date('2026-08-09T10:00:00Z'),
  )
  const reloaded = scanOpportunityProposals(ws).find((x) => x.id === p.id)!
  const s = reloaded.opportunitySnapshot!
  assert.equal(s.source, 'alignment')
  assert.equal(s.severity, 'high')
  assert.equal(s.intent, 'improve_value')
  assert.equal(s.anchor.kind, 'alignment')
  assert.equal(s.anchor.jobId, 'job_test')
  assert.equal(s.anchor.responsibilityId, 'ai-1')
  assert.equal(s.anchor.state, 'expressive_gap')
  assert.equal(s.applyTarget?.action, 'rewrite')
  assert.equal(s.applyTarget?.blockId, 'blk_1')
  assert.ok(s.reason.length > 0)
  assert.ok(s.refs.evidenceIds.includes('evidence_20260809_00001'))
})

test('approve + apply（revision 一致）→ 1 条 history：approved/applied，afterRevision = before + 1', () => {
  const { ws, wc, opportunityId } = setup()
  const proposalId = submitApproved(ws, wc.id, opportunityId, [
    { blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' },
  ])
  const result = applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))
  assert.equal(result.status, 'applied')
  const hs = scanOpportunityHistory(ws)
  assert.equal(hs.length, 1)
  const h = hs[0]
  assert.equal(h.proposalId, proposalId)
  assert.equal(h.decision, 'approved')
  assert.equal(h.outcome, 'applied')
  assert.equal(h.beforeRevision, 1)
  assert.equal(h.afterRevision, 2)
  assert.equal(h.expectedRevision, undefined)
  assert.equal(h.decidedAt, '2026-08-09T10:05:00.000Z')
})

test('apply 漂移（conflict）→ 1 条 history：approved/conflict，expected/current 如实', () => {
  const { ws, wc, opportunityId } = setup()
  const proposalId = submitApproved(ws, wc.id, opportunityId, [
    { blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' },
  ])
  upsertWorkingCopy(
    ws,
    { id: wc.id, owner: 'p1', sections: [{ id: 'sec_1', title: '项目经验', blocks: [{ id: 'blk_1', text: '用户新编辑的内容' }] }], revision: 3 },
    new Date('2026-08-09T10:08:00Z'),
  )
  const result = applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))
  assert.equal(result.status, 'conflict')
  const h = scanOpportunityHistory(ws)[0]
  assert.equal(h.decision, 'approved')
  assert.equal(h.outcome, 'conflict')
  assert.equal(h.expectedRevision, 1)
  assert.equal(h.currentRevision, 2)
  assert.equal(h.afterRevision, undefined)
})

test('reject → 1 条 history：rejected/rejected（审计先行——登记后提案状态才更新）', () => {
  const { ws, wc, opportunityId } = setup()
  const p = submitOpportunityProposal(
    ws,
    { opportunityId, wcId: wc.id, changes: [{ blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' }] },
    new Date('2026-08-09T10:00:00Z'),
  )
  rejectOpportunityProposal(ws, p.id, undefined, new Date('2026-08-09T10:05:00Z'))
  const hs = scanOpportunityHistory(ws)
  assert.equal(hs.length, 1)
  assert.equal(hs[0].decision, 'rejected')
  assert.equal(hs[0].outcome, 'rejected')
  assert.equal(hs[0].beforeRevision, 1)
  const proposal = scanOpportunityProposals(ws).find((x) => x.id === p.id)!
  assert.equal(proposal.status, 'rejected')
  assert.equal(proposal.decidedAt, '2026-08-09T10:05:00.000Z')
})

test('快照漂移（P4.1 核心价值）：apply 后重诊断机会收敛（expressive_gap → unsupported_claim），history.opportunitySnapshot 仍旧完整', () => {
  const { ws, wc, opportunityId } = setup()
  const proposalId = submitApproved(ws, wc.id, opportunityId, [
    { blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' },
  ])
  applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))

  // apply 打表达锚：块.expectationId = 机会锚定 responsibility 的首个期望模式（重诊断据此判定表达已写入）
  const wcNow = scanWorkingCopies(ws).find((w) => w.id === wc.id)!
  const job = scanJobs(ws).find((j) => j.record.id === 'job_test')!.record
  const respPatternId = job.responsibilities.find((r) => r.id === 'ai-1')!.evidenceExpectations[0].patternId
  assert.equal(wcNow.sections[0].blocks[0].expectationId, respPatternId)

  // apply 后重诊断：同 id 机会收敛为 unsupported_claim（写了但未资产化——需走 Claim 资产化/删除），不再重复推荐改写
  const ops = computeOpportunities({
    job,
    evidenceItems: scanEvidence(ws).map((e) => e.record),
    claims: scanClaims(ws).map((c) => c.record),
    resumeDocument: workingCopyToDocument(wcNow, ws),
    wc: wcNow,
  })
  const after = ops.find((o) => o.id === opportunityId)
  assert.ok(after)
  assert.equal(after.anchor.state, 'unsupported_claim')
  assert.equal(after.intent, 'reduce_risk')

  // 但历史条目快照完整——事后可解释「当时为什么改」（expressive_gap 语义被固化）
  const h = scanOpportunityHistory(ws)[0]
  assert.equal(h.opportunityId, opportunityId)
  assert.equal(h.opportunitySnapshot.source, 'alignment')
  assert.equal(h.opportunitySnapshot.severity, 'high')
  assert.equal(h.opportunitySnapshot.intent, 'improve_value')
  assert.equal(h.opportunitySnapshot.anchor.state, 'expressive_gap')
  assert.equal(h.opportunitySnapshot.anchor.responsibilityId, 'ai-1')
  assert.ok(h.opportunitySnapshot.reason.length > 0)
  assert.deepEqual(h.changesSnapshot, [
    { blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' },
  ])
})

test('幂等：同一提案重复 apply（apply 不改 proposal.status）→ 不产生重复条目', () => {
  const { ws, wc, opportunityId } = setup()
  const proposalId = submitApproved(ws, wc.id, opportunityId, [
    { blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' },
  ])
  applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))
  // 第二次 apply：revision 已漂移 → conflict，但不重复登记
  const second = applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:15:00Z'))
  assert.equal(second.status, 'conflict')
  const hs = scanOpportunityHistory(ws)
  assert.equal(hs.length, 1)
  assert.equal(hs[0].outcome, 'applied')
})

test('无快照旧格式提案：reject → 不登记、不抛错（契约 Case 6——不制造数据）', () => {
  const { ws, wc, opportunityId } = setup()
  // 手工构造旧格式提案文件（无 ## 机会快照 块——P4.1 实现前格式）
  const p = submitOpportunityProposal(
    ws,
    { opportunityId, wcId: wc.id, changes: [{ blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' }] },
    new Date('2026-08-09T10:00:00Z'),
  )
  const md = ws.read(`opportunity-proposals/${p.id}.md`)
  const stripped = md.replace(/\n## 机会快照[\s\S]*?(?=\n## 变更 1)/, '')
  ws.write(`opportunity-proposals/${p.id}.md`, stripped)
  assert.equal(scanOpportunityProposals(ws).find((x) => x.id === p.id)!.opportunitySnapshot, undefined)

  rejectOpportunityProposal(ws, p.id, undefined, new Date('2026-08-09T10:05:00Z'))
  assert.equal(scanOpportunityHistory(ws).length, 0)
  assert.equal(scanOpportunityProposals(ws).find((x) => x.id === p.id)!.status, 'rejected')
})

test('history roundtrip：序列化后重扫字段完整（含 conflict revision 与 changesSnapshot）', () => {
  const { ws, wc, opportunityId } = setup()
  const proposalId = submitApproved(ws, wc.id, opportunityId, [
    { blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' },
  ])
  upsertWorkingCopy(ws, { id: wc.id, owner: 'p1', sections: wc.sections, revision: 4 }, new Date('2026-08-09T10:08:00Z'))
  applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))
  const h = scanOpportunityHistory(ws)[0]
  assert.equal(h.outcome, 'conflict')
  assert.equal(h.expectedRevision, 1)
  assert.equal(h.currentRevision, 2)
  assert.equal(h.changesSnapshot.length, 1)
  assert.equal(h.changesSnapshot[0].after, '负责机械结构设计，完成强度校核')
  assert.equal(h.opportunitySnapshot.suggestedAction.length > 0, true)
  assert.equal(h.recordedAt, '2026-08-09T10:10:00.000Z')
})
