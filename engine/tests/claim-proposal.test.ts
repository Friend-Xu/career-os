/**
 * Claim Registration Contract v0.1 测试矩阵（P1.1——8 条闭环）。
 * 验证：Evidence → ClaimProposal（create）→ approve → registerClaim → claims/{id}.md → 可消费。
 * 硬边界：evidenceRefs 前置（legacy/不存在/非 trusted 拒绝）；锚点红线（statement 数字须有证据锚）；
 * approve 二次校验（证据变化 → invalid 不登记）；reject 审计保留。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { scanClaims } from '../storage/claim-watcher.ts'
import { scanClaimProposals, createClaimProposal, approveClaimProposal, rejectClaimProposal, ClaimProposalError } from '../storage/claim-proposal-registry.ts'

function evidenceMd(id: string, title: string, contribution: string, extra = ''): string {
  return `---
id: ${id}
owner: p1
created_at: 2026-08-08
lifecycle: active
---
# ${title}

## 分析摘要

| 字段 | 值 |
|------|-----|
| event | ${title} |
| role | 机械结构负责人 |
| contribution | ${contribution} |
| status | trusted |
| source_type | user_input |
| captured_at | 2026-08-08 |
| verification_type | user_confirmed |
| confirmed_at | 2026-08-08 |

## 证据

### impact

- 使装配效率提升 30%

### validation

- 通过样机实测验证
${extra}
`
}

function setup(): { ws: Workspace; root: string; evId: string; evId2: string } {
  const root = mkdtempSync(join(tmpdir(), 'cos-cp-'))
  const ws = initWorkspace(root)
  ws.write('evidence/evidence_20260808_00001.md', evidenceMd('evidence_20260808_00001', '气密性工装设计项目', '主导气密性工装设计，使装配泄漏率从 3% 降至 0.5%'))
  ws.write('evidence/evidence_20260808_00002.md', evidenceMd('evidence_20260808_00002', '机器人维护项目', '负责机器人日常维护'))
  return { ws, root, evId: 'evidence_20260808_00001', evId2: 'evidence_20260808_00002' }
}

function validInput(evId: string) {
  return {
    source: 'star_reconstructor' as const,
    evidenceRefs: [evId],
    proposedClaim: { statement: '主导气密性工装设计，使装配泄漏率降至 0.5%', section: 'experience' },
    explanation: '依据气密性工装设计项目的实测数据',
  }
}

test('Test 1：Evidence → create → pending → approve → claims 生成 → 可消费', () => {
  const { ws, evId } = setup()
  const proposal = createClaimProposal(ws, validInput(evId), new Date('2026-08-08T10:00:00Z'))
  assert.equal(proposal.status, 'pending')
  assert.match(proposal.id, /^claim_proposal_20260808_\d{5}$/)
  assert.equal(proposal.provenanceSummary.level, 'high') // user_confirmed → high
  assert.deepEqual(proposal.provenanceSummary.derivedFrom, ['user_confirmed'])

  const { claimId } = approveClaimProposal(ws, proposal.id, new Date('2026-08-08T10:05:00Z'))
  assert.match(claimId, /^claim_\d{8}_\d{5}$/)

  const claims = scanClaims(ws).map((c) => c.record)
  const created = claims.find((c) => c.id === claimId)
  assert.ok(created, 'claims/{id}.md 已生成')
  assert.equal(created.statement, '主导气密性工装设计，使装配泄漏率降至 0.5%')
  assert.equal(created.lifecycle, 'active')
  assert.deepEqual(created.provenance.map((p) => p.evidenceId), [evId])

  const approved = scanClaimProposals(ws).find((p) => p.id === proposal.id)
  assert.equal(approved?.status, 'approved')
})

test('Test 2：evidenceRefs 含 legacy/不存在 → create 拒绝', () => {
  const { ws } = setup()
  assert.throws(() => createClaimProposal(ws, validInput('evidence_20260808_99999')), ClaimProposalError, '不存在的证据拒绝')
  assert.throws(
    () => createClaimProposal(ws, { ...validInput('evidence_20260808_00001'), evidenceRefs: ['evidence_20260805_00001'] }),
    ClaimProposalError,
    'legacy 证据拒绝',
  )
})

test('Test 3：statement 空/过短 → 拒绝', () => {
  const { ws, evId } = setup()
  assert.throws(() => createClaimProposal(ws, { ...validInput(evId), proposedClaim: { statement: '  ' } }), ClaimProposalError)
  assert.throws(() => createClaimProposal(ws, { ...validInput(evId), proposedClaim: { statement: '太短' } }), ClaimProposalError)
})

test('Test 4：reject → 审计保留（不产生 claim）', () => {
  const { ws, evId } = setup()
  const proposal = createClaimProposal(ws, validInput(evId))
  const rejected = rejectClaimProposal(ws, proposal.id, '用户不需要')
  assert.equal(rejected.status, 'rejected')
  assert.ok(rejected.decidedAt)
  assert.equal(scanClaims(ws).length, 0, 'reject 不产生 claim')
  assert.throws(() => approveClaimProposal(ws, proposal.id), ClaimProposalError, 'rejected 不可 approve')
  assert.throws(() => rejectClaimProposal(ws, proposal.id), ClaimProposalError, '单向不 reopen')
})

test('Test 5：approved 后 evidence 失效 → invalid（派生）', () => {
  const { ws, evId } = setup()
  const proposal = createClaimProposal(ws, validInput(evId))
  // 模拟：approve 时证据已变为 legacy（写入方更新 lifecycle——中间时间窗口证据变化）
  const md = ws.read(`evidence/${evId}.md`).replace('lifecycle: active', 'lifecycle: legacy')
  ws.write(`evidence/${evId}.md`, md)
  assert.throws(() => approveClaimProposal(ws, proposal.id), ClaimProposalError, '二次校验拒绝')
  assert.equal(scanClaimProposals(ws).find((p) => p.id === proposal.id)?.status, 'invalid', '提案标记 invalid')
  assert.equal(scanClaims(ws).length, 0, '不登记')
})

test('Test 6：双通道产物等价（RPC create 与 Agent 写文件解析结构一致）', () => {
  const { ws, evId } = setup()
  const viaRpc = createClaimProposal(ws, validInput(evId))
  // Agent 通道：直接写 md（无系统 id——解析兜底文件名）→ 扫描解析
  const agentMd = `---
created_at: 2026-08-08
source: star_reconstructor
status: pending
---
# 主导气密性工装设计，使装配泄漏率降至 0.5%

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | 主导气密性工装设计，使装配泄漏率降至 0.5% |
| source | star_reconstructor |
| section | experience |
| explanation | 依据气密性工装设计项目的实测数据 |

## 证据来源

- ${evId}
`
  ws.write(`claim-proposals/agent-written.md`, agentMd)
  const viaAgent = scanClaimProposals(ws).find((p) => p.id === 'agent-written')
  assert.ok(viaAgent)
  assert.equal(viaAgent.proposedClaim.statement, viaRpc.proposedClaim.statement)
  assert.deepEqual(viaAgent.evidenceRefs, viaRpc.evidenceRefs)
  assert.equal(viaAgent.source, viaRpc.source)
})

test('Test 7：Claim Strength 红线——statement 数字无证据锚点 → 拒绝', () => {
  const { ws, evId2 } = setup()
  // evidence 只有「机器人日常维护」——statement 声称 40% 提升 → 无锚拒绝
  assert.throws(
    () => createClaimProposal(ws, { ...validInput(evId2), proposedClaim: { statement: '主导机器人控制算法优化，使效率提升 40%' } }),
    /无证据锚点/,
  )
})

test('Test 8：approve 二次校验——create 后证据变化 → invalid，不 register', () => {
  const { ws, evId } = setup()
  const proposal = createClaimProposal(ws, validInput(evId))
  // create 后证据内容变化（原证据删除 impact 维度——statement 的 0.5% 锚消失）
  const md = ws.read(`evidence/${evId}.md`)
  ws.write(`evidence/${evId}.md`, md.replace(/使装配泄漏率从 3% 降至 0\.5%/, '负责工装设计'))
  assert.throws(() => approveClaimProposal(ws, proposal.id), ClaimProposalError, '二次校验拒绝')
  assert.equal(scanClaimProposals(ws).find((p) => p.id === proposal.id)?.status, 'invalid')
  assert.equal(scanClaims(ws).length, 0)
})

test('Test 9：owner 派生——approve 从证据 owner 登记 Claim（Engine Registration）', () => {
  const { ws, evId } = setup()
  const proposal = createClaimProposal(ws, validInput(evId))
  const { claimId } = approveClaimProposal(ws, proposal.id, new Date('2026-08-08T10:05:00Z'))
  const created = scanClaims(ws).find((c) => c.record.id === claimId)?.record
  assert.ok(created, 'claims/{id}.md 已生成')
  assert.equal(created.owner, 'p1', 'Claim.owner 从证据 owner 派生')
  assert.match(ws.read(`claims/${claimId}.md`), /owner: p1/, '落盘 owner 非空')
})

test('Test 10：证据缺 owner → 拒绝（归属不明不登记）', () => {
  const { ws } = setup()
  const noOwner = evidenceMd('evidence_20260808_00003', '无归属项目', '负责结构设计').replace('owner: p1\n', '')
  ws.write('evidence/evidence_20260808_00003.md', noOwner)
  assert.throws(
    () => createClaimProposal(ws, validInput('evidence_20260808_00003')),
    /缺少 owner/,
  )
})

test('Test 11：证据归属多人 → 拒绝（跨人提案不登记）', () => {
  const { ws, evId } = setup()
  const otherOwner = evidenceMd('evidence_20260808_00004', '跨组项目', '负责跨组协作').replace('owner: p1', 'owner: p2')
  ws.write('evidence/evidence_20260808_00004.md', otherOwner)
  assert.throws(
    () => createClaimProposal(ws, { ...validInput(evId), evidenceRefs: [evId, 'evidence_20260808_00004'] }),
    /归属多人/,
  )
})
