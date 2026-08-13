/**
 * Asset Bridge 测试矩阵（P5.2——契约 claim-asset-bridge-contract-v0.1 §7）。
 * 验证：资产化闭环（红线型 unsupported_claim → Claim → 绑定 → covered——P4.2 resolved 观察位首次达成）、
 * 无证据拒绝、非 activation 拒绝（含原生 unsupported_claim）、证据不可消费、数字锚、
 * 绑定冲突（Claim 保留可重试）、reject 路径、expectationId 复用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { scanWorkingCopies, upsertWorkingCopy, workingCopyToDocument } from '../storage/working-copy-registry.ts'
import {
  submitOpportunityProposal,
  approveOpportunityProposal,
  applyOpportunityProposal,
  assembleAssetBridge,
  bindClaimToBlock,
  OpportunityProposalError,
} from '../storage/opportunity-proposal-registry.ts'
import {
  createClaimProposal,
  approveClaimProposal,
  rejectClaimProposal,
  scanClaimProposals,
  ClaimProposalError,
} from '../storage/claim-proposal-registry.ts'
import { scanClaims } from '../storage/claim-watcher.ts'
import { scanJobs } from '../storage/job-watcher.ts'
import { scanEvidence } from '../storage/evidence-watcher.ts'
import { computeResumeAlignment } from '../runtime/resume-alignment.ts'
import type { WorkingCopy } from '../ir/resume.ts'

function setupBase(): { ws: Workspace; claimId: string } {
  const root = mkdtempSync(join(tmpdir(), 'cos-ab-'))
  const ws = initWorkspace(root)
  // owner 登记校验（ADR-013/014）：upsert 前 owner 必须是已登记 person
  ws.write('persons/p1/manifest.md', '---\nid: p1\nname: Person-A\nstatus: active\n---\n\n# Person-A\n')
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
| requirements | 机械结构设计；尺寸链计算 |

## 岗位智能

| Responsibility | Priority | Category | Capabilities | Evidence Patterns | Questions |
| 机械结构设计 | must | hard | 结构设计 | scope | 负责哪些模块？ |
| 尺寸链计算 | must | hard | 公差分析 | method | 采用什么设计流程/工具？ |
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
  ws.write(
    'claims/claim_20260808_00001.md',
    `---
id: claim_20260808_00001
created_at: 2026-08-08
lifecycle: active
---
# 主导气密性工装设计，使装配泄漏率降至 0.5%

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | 主导气密性工装设计，使装配泄漏率降至 0.5% |
| claim_type | fact |
| source | agent_generated |
| captured_at | 2026-08-08 |

## 证据来源

- evidence_20260809_00001
`,
  )
  return { ws, claimId: 'claim_20260808_00001' }
}

function setupUnboundWc(ws: Workspace): WorkingCopy {
  return upsertWorkingCopy(
    ws,
    {
      owner: 'p1',
      sections: [{ id: 'sec_1', title: '项目经验', blocks: [{ id: 'blk_1', text: '参与机械结构设计相关工作' }] }],
      revision: 1,
    },
    new Date('2026-08-09T10:00:00Z'),
  ).copy
}

function setupBoundWc(ws: Workspace, claimId: string): WorkingCopy {
  return upsertWorkingCopy(
    ws,
    {
      owner: 'p1',
      sections: [{ id: 'sec_1', title: '项目经验', blocks: [{ id: 'blk_1', text: '主导气密性工装设计，使装配泄漏率降至 0.5%', provenanceLinks: [claimId] }] }],
      revision: 1,
    },
    new Date('2026-08-09T10:00:00Z'),
  ).copy
}

const REWRITE = [{ blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' as const }]

/** 红线型 unsupported_claim 机会：expressive_gap → rewrite apply → 红线降级（evdHit ✓ 但无 claim 锚） */
function setupRedlineOpportunity(ws: Workspace): WorkingCopy {
  const wc = setupUnboundWc(ws)
  const p = submitOpportunityProposal(ws, { opportunityId: 'alignment:job_test:ai-1', wcId: wc.id, changes: REWRITE }, new Date('2026-08-09T10:00:00Z'))
  approveOpportunityProposal(ws, p.id, new Date('2026-08-09T10:05:00Z'))
  applyOpportunityProposal(ws, p.id, new Date('2026-08-09T10:10:00Z'))
  return wc
}

function alignmentOf(ws: Workspace): ReturnType<typeof computeResumeAlignment> {
  const wc = scanWorkingCopies(ws)[0]
  return computeResumeAlignment({
    job: scanJobs(ws).find((j) => j.record.id === 'job_test')!.record,
    evidenceItems: scanEvidence(ws).map((e) => e.record),
    claims: scanClaims(ws).map((c) => c.record),
    resumeDocument: workingCopyToDocument(wc, ws),
  })
}

test('资产化闭环：红线型 unsupported_claim → Claim → 绑定 → covered（P4.2 resolved 观察位首次达成）', () => {
  const { ws } = setupBase()
  const wc = setupRedlineOpportunity(ws)

  // apply 后机会重投影为 unsupported_claim（refs 非空——红线型）
  assert.equal(alignmentOf(ws).rows.find((r) => r.responsibilityId === 'ai-1')!.state, 'unsupported_claim')

  // 资产化：装配（expectationId 复用）→ ClaimProposal 登记 → approve → Claim
  const bridge = assembleAssetBridge(
    ws,
    { opportunityId: 'alignment:job_test:ai-1', wcId: wc.id, evidenceCandidates: ['evidence_20260809_00001'] },
    '负责机械结构设计，完成强度校核',
    '基于减速机壳体结构设计经历资产化',
  )
  assert.equal(bridge.source, 'opportunity_bridge')
  assert.equal(bridge.proposedClaim.expectationId, 'engineering_scope') // 复制不生成（校准 2）
  const cp = createClaimProposal(ws, bridge, new Date('2026-08-09T10:15:00Z'))
  const { claimId } = approveClaimProposal(ws, cp.id, new Date('2026-08-09T10:20:00Z'))

  // 绑定：块 provenanceLinks + claimId，revision+1
  const bind = bindClaimToBlock(ws, wc.id, 'blk_1', claimId, new Date('2026-08-09T10:25:00Z'))
  assert.equal(bind.status, 'bound')
  assert.equal(bind.wcRevisionBefore, 2)
  assert.equal(bind.wcRevisionAfter, 3)
  const wcNow = scanWorkingCopies(ws).find((w) => w.id === wc.id)!
  assert.ok(wcNow.sections[0].blocks[0].provenanceLinks!.includes(claimId))

  // 重诊断：covered——P4.2 resolved 观察位首次达成
  assert.equal(alignmentOf(ws).rows.find((r) => r.responsibilityId === 'ai-1')!.state, 'covered')
})

test('无证据拒绝：evidenceCandidates 空 → 装配抛错', () => {
  const { ws } = setupBase()
  const wc = setupRedlineOpportunity(ws)
  assert.throws(
    () => assembleAssetBridge(ws, { opportunityId: 'alignment:job_test:ai-1', wcId: wc.id, evidenceCandidates: [] }, '负责机械结构设计', ''),
    (e: unknown) => e instanceof OpportunityProposalError && /无证据不资产化/.test(e.message),
  )
})

test('非 activation 拒绝：expressive_gap 机会走桥 → 拒绝', () => {
  const { ws } = setupBase()
  const wc = setupUnboundWc(ws) // 未 apply——机会仍是 expressive_gap
  assert.throws(
    () => assembleAssetBridge(ws, { opportunityId: 'alignment:job_test:ai-1', wcId: wc.id, evidenceCandidates: ['evidence_20260809_00001'] }, '负责机械结构设计', ''),
    (e: unknown) => e instanceof OpportunityProposalError && /仅支持红线型 unsupported_claim/.test(e.message),
  )
})

test('非 activation 拒绝：原生 unsupported_claim（refs 空——!evdHit）→ 拒绝（资产化无意义）', () => {
  const { ws, claimId } = setupBase()
  const wc = setupBoundWc(ws, claimId) // ai-2 method 无证据 → exprHit ✓ !evdHit → 原生 unsupported_claim
  assert.throws(
    () => assembleAssetBridge(ws, { opportunityId: 'alignment:job_test:ai-2', wcId: wc.id, evidenceCandidates: ['evidence_20260809_00001'] }, '尺寸链计算', ''),
    (e: unknown) => e instanceof OpportunityProposalError && /仅支持红线型 unsupported_claim/.test(e.message),
  )
})

test('证据不可消费：候选含 legacy 证据 → P1.1 二次校验拒绝', () => {
  const { ws } = setupBase()
  const wc = setupRedlineOpportunity(ws)
  ws.write(
    'evidence/evidence_20260809_00002.md',
    `---
id: evidence_20260809_00002
created_at: 2026-08-01
lifecycle: legacy
---
# 历史项目

## 分析摘要

| 字段 | 值 |
|------|-----|
| event | 历史项目 |
| role | 成员 |
| contribution | 参与历史项目 |
| status | trusted |
| source_type | user_input |
| captured_at | 2026-08-01 |
| verification_type | user_confirmed |
| confirmed_at | 2026-08-01 |

## 证据

### scope

- 历史项目内容
`,
  )
  const bridge = assembleAssetBridge(
    ws,
    { opportunityId: 'alignment:job_test:ai-1', wcId: wc.id, evidenceCandidates: ['evidence_20260809_00002'] },
    '负责机械结构设计',
    '',
  )
  assert.throws(() => createClaimProposal(ws, bridge, new Date('2026-08-09T10:15:00Z')), (e: unknown) => e instanceof ClaimProposalError)
})

test('数字锚：statement 含证据无锚数字 → createClaimProposal 拒绝', () => {
  const { ws } = setupBase()
  const wc = setupRedlineOpportunity(ws)
  const bridge = assembleAssetBridge(
    ws,
    { opportunityId: 'alignment:job_test:ai-1', wcId: wc.id, evidenceCandidates: ['evidence_20260809_00001'] },
    '负责机械结构设计，效率提升 99%',
    '',
  )
  assert.throws(() => createClaimProposal(ws, bridge, new Date('2026-08-09T10:15:00Z')), (e: unknown) => e instanceof ClaimProposalError)
})

test('绑定失败：目标块不存在 → conflict，Claim 保留可重试', () => {
  const { ws } = setupBase()
  const wc = setupRedlineOpportunity(ws)
  const bridge = assembleAssetBridge(
    ws,
    { opportunityId: 'alignment:job_test:ai-1', wcId: wc.id, evidenceCandidates: ['evidence_20260809_00001'] },
    '负责机械结构设计，完成强度校核',
    '',
  )
  const cp = createClaimProposal(ws, bridge, new Date('2026-08-09T10:15:00Z'))
  const { claimId } = approveClaimProposal(ws, cp.id, new Date('2026-08-09T10:20:00Z'))

  const bind = bindClaimToBlock(ws, wc.id, 'blk_999', claimId, new Date('2026-08-09T10:25:00Z'))
  assert.equal(bind.status, 'conflict')
  assert.equal(bind.wcRevisionBefore, 2)
  // Claim 保留（不撤销）——绑定可重试
  assert.ok(scanClaims(ws).some((c) => c.record.id === claimId))
  assert.ok(scanClaimProposals(ws).some((p) => p.status === 'approved'))
})

test('reject 路径：用户拒绝 ClaimProposal → 无 Claim 登记、无绑定', () => {
  const { ws } = setupBase()
  const wc = setupRedlineOpportunity(ws)
  const bridge = assembleAssetBridge(
    ws,
    { opportunityId: 'alignment:job_test:ai-1', wcId: wc.id, evidenceCandidates: ['evidence_20260809_00001'] },
    '负责机械结构设计，完成强度校核',
    '',
  )
  const cp = createClaimProposal(ws, bridge, new Date('2026-08-09T10:15:00Z'))
  rejectClaimProposal(ws, cp.id, undefined, new Date('2026-08-09T10:20:00Z'))
  assert.equal(scanClaims(ws).length, 1) // 仅 fixture claim——无新登记
  const wcNow = scanWorkingCopies(ws).find((w) => w.id === wc.id)!
  assert.deepEqual(wcNow.sections[0].blocks[0].provenanceLinks, [])
})

test('duplicate bind（P5.2 评审回归）：同 claim 重复绑定 → 幂等成功，revision 不重复增加', () => {
  const { ws } = setupBase()
  const wc = setupRedlineOpportunity(ws)
  const bridge = assembleAssetBridge(
    ws,
    { opportunityId: 'alignment:job_test:ai-1', wcId: wc.id, evidenceCandidates: ['evidence_20260809_00001'] },
    '负责机械结构设计，完成强度校核',
    '',
  )
  const cp = createClaimProposal(ws, bridge, new Date('2026-08-09T10:15:00Z'))
  const { claimId } = approveClaimProposal(ws, cp.id, new Date('2026-08-09T10:20:00Z'))

  const first = bindClaimToBlock(ws, wc.id, 'blk_1', claimId, new Date('2026-08-09T10:25:00Z'))
  assert.equal(first.status, 'bound')
  assert.equal(first.wcRevisionAfter, 3)
  // 重复绑定同 claim：锚已含 → 不追加重复、revision 不增加（幂等）
  const second = bindClaimToBlock(ws, wc.id, 'blk_1', claimId, new Date('2026-08-09T10:30:00Z'))
  assert.equal(second.status, 'bound')
  assert.equal(second.wcRevisionAfter, 3) // revision 不再 +1
  const wcNow = scanWorkingCopies(ws).find((w) => w.id === wc.id)!
  assert.deepEqual(wcNow.sections[0].blocks[0].provenanceLinks, [claimId]) // 无重复
  assert.equal(wcNow.revision, 3)
})
