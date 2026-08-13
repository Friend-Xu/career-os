/**
 * Observation Stats 测试（P6——契约 observation-threshold-contract-v0.1 §5）。
 * 验证：只读派生投影——机会分布/提案行为/迁移路径/资产化计数；阈值 met/unmet 判断（纯派生不写盘）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { upsertWorkingCopy } from '../storage/working-copy-registry.ts'
import { submitOpportunityProposal, approveOpportunityProposal, applyOpportunityProposal, submitClaimBridge, scanOpportunityHistory } from '../storage/opportunity-proposal-registry.ts'
import { approveClaimProposal } from '../storage/claim-proposal-registry.ts'
import { computeObservationStats } from '../runtime/observation.ts'

function setupBase(): { ws: Workspace } {
  const root = mkdtempSync(join(tmpdir(), 'cos-obs-'))
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
owner: p1
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
  return { ws }
}

function setupWc(ws: Workspace) {
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

test('观察投影：一条应用事件 → 分布/迁移/资产化计数正确，阈值全 unmet', () => {
  const { ws } = setupBase()
  const wc = setupWc(ws)
  // expressive_gap → rewrite apply → 红线 unsupported_claim（一条历史事件）
  const p = submitOpportunityProposal(
    ws,
    { opportunityId: 'alignment:job_test:ai-1', wcId: wc.id, changes: [{ blockId: 'blk_1', before: '参与机械结构设计相关工作', after: '负责机械结构设计，完成强度校核', operation: 'rewrite' }] },
    new Date('2026-08-09T10:00:00Z'),
  )
  approveOpportunityProposal(ws, p.id, new Date('2026-08-09T10:05:00Z'))
  applyOpportunityProposal(ws, p.id, new Date('2026-08-09T10:10:00Z'))

  // 资产化提案（登记 + 采用——Asset Loop 计数）
  submitClaimBridge(
    ws,
    { opportunityId: 'alignment:job_test:ai-1', wcId: wc.id, evidenceCandidates: ['evidence_20260809_00001'], statement: '负责机械结构设计，完成强度校核', explanation: '' },
    new Date('2026-08-09T10:15:00Z'),
  )
  const asset = submitClaimBridge(
    ws,
    { opportunityId: 'alignment:job_test:ai-1', wcId: wc.id, evidenceCandidates: ['evidence_20260809_00001'], statement: '负责机械结构设计', explanation: '' },
    new Date('2026-08-09T10:16:00Z'),
  )
  approveClaimProposal(ws, asset.id, new Date('2026-08-09T10:20:00Z'))

  const s = computeObservationStats(ws)
  assert.equal(s.historyCount, 1)
  assert.equal(s.opportunityDistribution.state['expressive_gap'], 1)
  assert.equal(s.opportunityDistribution.intent['improve_value'], 1)
  assert.equal(s.proposalBehavior.approved, 1)
  assert.equal(s.proposalBehavior.acceptRate, 100)
  // 迁移：expressive_gap → unsupported_claim（红线）→ partial
  assert.equal(s.resolutionPaths.category['partial'], 1)
  assert.equal(s.resolutionPaths.transitions['expressive_gap → unsupported_claim'], 1)
  // 资产化：2 提案 1 采用
  assert.equal(s.assetLoop.proposals, 2)
  assert.equal(s.assetLoop.accepted, 1)
  // 阈值：仅「单一状态占比」（单条样本必然 100%）达成——其余 3 项未达
  assert.equal(s.thresholds.met.length, 1)
  assert.equal(s.thresholds.unmet.length, 3)
  assert.ok(s.thresholds.met[0].includes('40%'))
  // 只读：统计不产生任何新历史
  assert.equal(scanOpportunityHistory(ws).length, 1)
})
