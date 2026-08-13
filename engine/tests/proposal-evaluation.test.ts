/**
 * Proposal Outcome Evaluation 测试矩阵（P4.2——契约 proposal-outcome-evaluation-contract-v0.1 §7）。
 * 验证：表达增强（rewrite/insert → unsupported_claim → partial，含 insert 表达锚 invariant）、
 * 治理收敛（delete → capability_gap → effective/riskReduced）、rejected → ignored、
 * conflict → conflicted、状态不变 → unresolved、连续迁移（迭代系统证明）。
 * 注：resolved（→covered）在 v0.1 四态 + 红线下不可达（契约 §4 注记）——有效处置路径是 riskReduced。
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
  rejectOpportunityProposal,
  applyOpportunityProposal,
  scanOpportunityHistory,
} from '../storage/opportunity-proposal-registry.ts'
import { computeProposalOutcomeEvaluation } from '../runtime/proposal-evaluation.ts'
import type { WorkingCopy } from '../ir/resume.ts'

/** job（ai-1 scope 有证据匹配 / ai-2 method 无证据匹配）+ evidence（scope 维度）——四态矩阵基底 */
function setupBase(): { ws: Workspace; claimId: string } {
  const root = mkdtempSync(join(tmpdir(), 'cos-pe-'))
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

/** 无 bound 块 wc（blk 文本与 ai-1 不匹配 → 无弱命中 → ai-1 expressive_gap，applyTarget insert 场景可构造） */
function setupUnboundWc(ws: Workspace): WorkingCopy {
  return upsertWorkingCopy(
    ws,
    {
      owner: 'p1',
      sections: [{ id: 'sec_1', title: '项目经验', blocks: [{ id: 'blk_1', text: '负责样机验证' }] }],
      revision: 1,
    },
    new Date('2026-08-09T10:00:00Z'),
  ).copy
}

/** bound 块 wc（claim 锚 → 所有 responsibility exprHit；ai-2 无证据 → unsupported_claim 机会） */
function setupBoundWc(ws: Workspace, claimId: string): WorkingCopy {
  return upsertWorkingCopy(
    ws,
    {
      owner: 'p1',
      sections: [
        { id: 'sec_1', title: '项目经验', blocks: [{ id: 'blk_1', text: '主导气密性工装设计，使装配泄漏率降至 0.5%', provenanceLinks: [claimId] }] },
      ],
      revision: 1,
    },
    new Date('2026-08-09T10:00:00Z'),
  ).copy
}

function submitApproved(ws: Workspace, wcId: string, opportunityId: string, changes: Parameters<typeof submitOpportunityProposal>[1]['changes']): string {
  const p = submitOpportunityProposal(ws, { opportunityId, wcId, changes }, new Date('2026-08-09T10:00:00Z'))
  approveOpportunityProposal(ws, p.id, new Date('2026-08-09T10:05:00Z'))
  return p.id
}

const REWRITE = [{ blockId: 'blk_1', before: '负责样机验证', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' as const }]

test('表达增强（rewrite）：expressive_gap → applied → unsupported_claim（红线）→ partial', () => {
  const { ws } = setupBase()
  const wc = setupUnboundWc(ws)
  const proposalId = submitApproved(ws, wc.id, 'alignment:job_test:ai-1', REWRITE)
  const result = applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))
  assert.equal(result.status, 'applied')

  const h = scanOpportunityHistory(ws)[0]
  assert.equal(h.afterState, 'unsupported_claim')
  const e = computeProposalOutcomeEvaluation(h)
  assert.equal(e.beforeState, 'expressive_gap')
  assert.equal(e.afterState, 'unsupported_claim')
  assert.deepEqual(e.signals, { accepted: true, applied: true, conflicted: false, resolved: false, riskReduced: false, changed: true })
  assert.equal(e.diagnostics.category, 'partial')
  assert.ok(e.diagnostics.reasons.some((r) => r.includes('expressive_gap → unsupported_claim')))
})

test('表达增强（insert + 锚 invariant）：新块 expectationId = 期望模式，重诊断收敛为 unsupported_claim → partial', () => {
  const { ws } = setupBase()
  const wc = setupUnboundWc(ws)
  // blk_1「负责样机验证」与责任语句不匹配 → 无弱命中 → expressive_gap applyTarget = insert
  const proposalId = submitApproved(ws, wc.id, 'alignment:job_test:ai-1', [
    { before: '', after: '负责机械结构设计，完成强度校核', operation: 'insert' },
  ])
  const result = applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))
  assert.equal(result.status, 'applied')

  const wcNow = scanWorkingCopies(ws).find((w) => w.id === wc.id)!
  const inserted = wcNow.sections[0].blocks[1]
  assert.equal(inserted.expectationId, 'engineering_scope') // ApplyTransaction invariant：insert 打锚
  assert.deepEqual(inserted.provenanceLinks, [])

  const e = computeProposalOutcomeEvaluation(scanOpportunityHistory(ws)[0])
  assert.equal(e.diagnostics.category, 'partial')
  assert.equal(e.afterState, 'unsupported_claim')
})

test('治理收敛：unsupported_claim → delete → capability_gap → effective（riskReduced）', () => {
  const { ws, claimId } = setupBase()
  const wc = setupBoundWc(ws, claimId)
  const proposalId = submitApproved(ws, wc.id, 'alignment:job_test:ai-2', [
    { blockId: 'blk_1', before: '主导气密性工装设计，使装配泄漏率降至 0.5%', after: '', operation: 'delete' },
  ])
  const result = applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))
  assert.equal(result.status, 'applied')

  const e = computeProposalOutcomeEvaluation(scanOpportunityHistory(ws)[0])
  assert.equal(e.beforeState, 'unsupported_claim')
  assert.equal(e.afterState, 'capability_gap')
  assert.deepEqual(e.signals, { accepted: true, applied: true, conflicted: false, resolved: false, riskReduced: true, changed: true })
  assert.equal(e.diagnostics.category, 'effective')
  assert.ok(e.diagnostics.reasons.some((r) => r.includes('可信度风险降低')))
})

test('用户拒绝：pending → rejected → ignored', () => {
  const { ws } = setupBase()
  const wc = setupUnboundWc(ws)
  const p = submitOpportunityProposal(ws, { opportunityId: 'alignment:job_test:ai-1', wcId: wc.id, changes: REWRITE }, new Date('2026-08-09T10:00:00Z'))
  rejectOpportunityProposal(ws, p.id, undefined, new Date('2026-08-09T10:05:00Z'))

  const e = computeProposalOutcomeEvaluation(scanOpportunityHistory(ws)[0])
  assert.deepEqual(e.signals, { accepted: false, applied: false, conflicted: false, resolved: false, riskReduced: false, changed: false })
  assert.equal(e.diagnostics.category, 'ignored')
  assert.ok(e.diagnostics.reasons.some((r) => r.includes('用户拒绝')))
})

test('版本漂移：approved → apply → conflict → conflicted', () => {
  const { ws } = setupBase()
  const wc = setupUnboundWc(ws)
  const proposalId = submitApproved(ws, wc.id, 'alignment:job_test:ai-1', REWRITE)
  upsertWorkingCopy(
    ws,
    { id: wc.id, owner: 'p1', sections: wc.sections, revision: 3 },
    new Date('2026-08-09T10:08:00Z'),
  )
  const result = applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))
  assert.equal(result.status, 'conflict')

  const e = computeProposalOutcomeEvaluation(scanOpportunityHistory(ws)[0])
  assert.deepEqual(e.signals, { accepted: true, applied: false, conflicted: true, resolved: false, riskReduced: false, changed: false })
  assert.equal(e.diagnostics.category, 'conflicted')
  assert.equal(e.afterState, undefined)
})

test('状态不变：unsupported_claim → rewrite（锚保留）→ 仍 unsupported_claim → unresolved', () => {
  const { ws, claimId } = setupBase()
  const wc = setupBoundWc(ws, claimId)
  const proposalId = submitApproved(ws, wc.id, 'alignment:job_test:ai-2', [
    { blockId: 'blk_1', before: '主导气密性工装设计，使装配泄漏率降至 0.5%', after: '气密性工装设计', operation: 'rewrite' },
  ])
  applyOpportunityProposal(ws, proposalId, new Date('2026-08-09T10:10:00Z'))

  const e = computeProposalOutcomeEvaluation(scanOpportunityHistory(ws)[0])
  assert.equal(e.beforeState, 'unsupported_claim')
  assert.equal(e.afterState, 'unsupported_claim')
  assert.equal(e.signals.changed, false)
  assert.equal(e.diagnostics.category, 'unresolved')
})

test('连续迁移（迭代系统证明）：两条 history 各按迁移判定——第一次表达增强（partial），第二次治理收敛（effective）', () => {
  const { ws } = setupBase()
  // History1：ai-1 expressive_gap → rewrite → unsupported_claim（partial——表达增强）
  const wc1 = setupUnboundWc(ws)
  const p1 = submitApproved(ws, wc1.id, 'alignment:job_test:ai-1', REWRITE)
  applyOpportunityProposal(ws, p1, new Date('2026-08-09T10:10:00Z'))

  // History2：ai-2 unsupported_claim → delete → capability_gap（effective——治理收敛）
  const wc2 = setupBoundWc(ws, 'claim_20260808_00001')
  const p2 = submitApproved(ws, wc2.id, 'alignment:job_test:ai-2', [
    { blockId: 'blk_1', before: '主导气密性工装设计，使装配泄漏率降至 0.5%', after: '', operation: 'delete' },
  ])
  applyOpportunityProposal(ws, p2, new Date('2026-08-09T10:20:00Z'))

  const hs = scanOpportunityHistory(ws)
  assert.equal(hs.length, 2)
  const e1 = computeProposalOutcomeEvaluation(hs[0])
  const e2 = computeProposalOutcomeEvaluation(hs[1])
  assert.equal(e1.diagnostics.category, 'partial') // 第一次：表达增强
  assert.equal(e2.diagnostics.category, 'effective') // 第二次：治理收敛
  assert.equal(e2.signals.riskReduced, true)
})
