/**
 * ApplyTransaction 测试矩阵（P3.4——契约 apply-transaction-contract-v0.1 §8）。
 * 验证：approved → apply（rewrite/insert/delete）→ revision+1 + 锚处理；
 * revision 漂移 → conflict（不覆盖用户新内容）；多 changes 原子；事务审计落盘。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { scanWorkingCopies, upsertWorkingCopy } from '../storage/working-copy-registry.ts'
import {
  submitOpportunityProposal,
  approveOpportunityProposal,
  applyOpportunityProposal,
  scanApplyTransactions,
  OpportunityProposalError,
} from '../storage/opportunity-proposal-registry.ts'
import type { WorkingCopy } from '../ir/resume.ts'

/** 直接构造 wc 对象（不经 md——upsert 序列化） */
function wcInput(sections: WorkingCopy['sections']): { owner: string; sections: WorkingCopy['sections']; revision: number } {
  return { owner: 'p1', sections, revision: 2 }
}

function setup(): { ws: Workspace; wc: WorkingCopy; opportunityId: string } {
  const root = mkdtempSync(join(tmpdir(), 'cos-atx-'))
  const ws = initWorkspace(root)
  // 岗位 + 证据（机会投影需要）
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

  // 机会投影（expressive_gap → rewrite 弱命中 blk_1）
  const doc = { id: 'doc-1', status: 'draft' as const, person: 'p1', templateId: 't1', templateVersion: '1.0', sections: [] as never[], generatedAt: '2026-08-09T00:00:00' }
  const ops = [
    {
      id: 'alignment:job_test:ai-1',
      source: 'alignment' as const,
      severity: 'high' as const,
      intent: 'improve_value' as const,
      severityReason: '',
      anchor: { kind: 'alignment' as const, jobId: 'job_test', responsibilityId: 'ai-1', state: 'expressive_gap' as const },
      applyTarget: { wcId: wc.id, blockId: 'blk_1', action: 'rewrite' as const },
      reason: '',
      suggestedAction: '生成候选表达（基于已有证据改写）',
      refs: { evidenceIds: ['evidence_20260809_00001'], claimIds: [] },
    },
  ]
  void doc
  void ops
  return { ws, wc, opportunityId: 'alignment:job_test:ai-1' }
}

function submitApproved(ws: Workspace, wcId: string, opportunityId: string, changes: Parameters<typeof submitOpportunityProposal>[1]['changes']): string {
  const p = submitOpportunityProposal(ws, { opportunityId, wcId, changes }, new Date('2026-08-09T10:00:00Z'))
  approveOpportunityProposal(ws, p.id, new Date('2026-08-09T10:05:00Z'))
  return p.id
}

test('rewrite：revision 一致 → applied，块文本替换 + 锚继承', () => {
  const { ws, wc, opportunityId } = setup()
  const proposalId = submitApproved(ws, wc.id, opportunityId, [
    { blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' },
  ])
  const result = applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))
  assert.equal(result.status, 'applied')
  assert.equal(result.newRevision, 2)
  const wcNow = scanWorkingCopies(ws).find((w) => w.id === wc.id)!
  assert.equal(wcNow.revision, 2)
  const blk1 = wcNow.sections[0].blocks.find((b) => b.id === 'blk_1')!
  assert.equal(blk1.text, '负责机械结构设计，完成强度校核')
  assert.equal(wcNow.sections[0].blocks.length, 2)
})

test('块文本规范化：after 带行首「- 」前缀 → 应用后剥离（双破折号防护）', () => {
  const { ws, wc, opportunityId } = setup()
  const proposalId = submitApproved(ws, wc.id, opportunityId, [
    { blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '- 负责机械结构设计，完成强度校核', operation: 'rewrite' },
  ])
  applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))
  const wcNow = scanWorkingCopies(ws).find((w) => w.id === wc.id)!
  assert.equal(wcNow.sections[0].blocks[0].text, '负责机械结构设计，完成强度校核')
})

test('insert：revision 一致 → applied，新块追加（provenanceLinks = []）', () => {
  const { ws, wc, opportunityId } = setup()
  const proposalId = submitApproved(ws, wc.id, opportunityId, [
    { before: '', after: '完成样机验证与强度校核', operation: 'insert' },
  ])
  const result = applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))
  assert.equal(result.status, 'applied')
  const wcNow = scanWorkingCopies(ws).find((w) => w.id === wc.id)!
  const blocks = wcNow.sections[0].blocks
  assert.equal(blocks.length, 3)
  const inserted = blocks[2]
  assert.equal(inserted.text, '完成样机验证与强度校核')
  assert.deepEqual(inserted.provenanceLinks, [])
})

test('delete：revision 一致 → applied，块移除', () => {
  const { ws, wc, opportunityId } = setup()
  const proposalId = submitApproved(ws, wc.id, opportunityId, [
    { blockId: 'blk_2', before: '负责样机验证', after: '', operation: 'delete' },
  ])
  const result = applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))
  assert.equal(result.status, 'applied')
  const wcNow = scanWorkingCopies(ws).find((w) => w.id === wc.id)!
  assert.equal(wcNow.sections[0].blocks.length, 1)
  assert.equal(wcNow.sections[0].blocks[0].id, 'blk_1')
})

test('revision 漂移：快照 wcRevision ≠ 当前 → conflict（不应用、不覆盖用户新内容）', () => {
  const { ws, wc, opportunityId } = setup()
  // 提交提案后用户编辑（revision 3）
  const proposalId = submitApproved(ws, wc.id, opportunityId, [
    { blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' },
  ])
  upsertWorkingCopy(
    ws,
    {
      id: wc.id,
      owner: 'p1',
      sections: [
        { id: 'sec_1', title: '项目经验', blocks: [{ id: 'blk_1', text: '用户新编辑的内容' }] },
      ],
      revision: 3,
    },
    new Date('2026-08-09T10:08:00Z'),
  )
  const result = applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))
  assert.equal(result.status, 'conflict')
  assert.equal(result.reason, 'WORKING_COPY_CHANGED')
  assert.equal(result.expectedRevision, 1)
  assert.equal(result.currentRevision, 2)
  // 用户新内容未被覆盖
  const wcNow = scanWorkingCopies(ws).find((w) => w.id === wc.id)!
  assert.equal(wcNow.sections[0].blocks[0].text, '用户新编辑的内容')
  assert.equal(wcNow.revision, 2)
})

test('仅 approved 可 apply（pending 拒绝）', () => {
  const { ws, wc, opportunityId } = setup()
  const p = submitOpportunityProposal(
    ws,
    { opportunityId, wcId: wc.id, changes: [{ blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' }] },
    new Date('2026-08-09T10:00:00Z'),
  )
  assert.throws(() => applyOpportunityProposal(ws, p.id), (e: unknown) => e instanceof OpportunityProposalError && /仅 approved/.test(e.message))
})

test('多 changes 原子：一次写盘全部应用', () => {
  const { ws, wc, opportunityId } = setup()
  const proposalId = submitApproved(ws, wc.id, opportunityId, [
    { blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' },
    { blockId: 'blk_2', before: '负责样机验证', after: '', operation: 'delete' },
    { before: '', after: '完成尺寸链计算', operation: 'insert' },
  ])
  const result = applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))
  assert.equal(result.status, 'applied')
  const wcNow = scanWorkingCopies(ws).find((w) => w.id === wc.id)!
  const blocks = wcNow.sections[0].blocks
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].text, '负责机械结构设计，完成强度校核')
  assert.equal(blocks[1].text, '完成尺寸链计算')
})

test('事务审计：applied 与 conflict 均落盘 apply-transactions/', () => {
  const { ws, wc, opportunityId } = setup()
  const ok = submitApproved(ws, wc.id, opportunityId, [
    { blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' },
  ])
  applyOpportunityProposal(ws, ok, new Date('2026-08-09T10:10:00Z'))

  // 漂移案例
  const conflict = submitApproved(ws, wc.id, opportunityId, [
    { blockId: 'blk_1', before: '负责机械结构设计，完成强度校核', after: '负责机械结构设计', operation: 'rewrite' },
  ])
  upsertWorkingCopy(ws, { id: wc.id, owner: 'p1', sections: wc.sections, revision: 4 }, new Date('2026-08-09T10:12:00Z'))
  applyOpportunityProposal(ws, conflict, new Date('2026-08-09T10:15:00Z'))

  const txs = scanApplyTransactions(ws)
  assert.equal(txs.length, 2)
  const applied = txs.find((t) => t.status === 'applied')!
  const conflicted = txs.find((t) => t.status === 'conflict')!
  assert.equal(applied.afterRevision, 2)
  assert.equal(applied.changes[0].operation, 'rewrite')
  assert.equal(conflicted.conflict?.reason, 'WORKING_COPY_CHANGED')
  assert.equal(conflicted.conflict?.expectedRevision, 2)
})
