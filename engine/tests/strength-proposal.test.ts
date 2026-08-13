import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import {
  buildStrengthProposalContext,
  decideStrengthProposal,
  scanStrengthProposals,
  submitStrengthProposals,
} from '../storage/strength-proposal-registry.ts'
import { scanPersons } from '../storage/person-watcher.ts'

const MANIFEST = `---
id: person_001
name: Person-A
status: active
created_at: 2026-08-08
---
`

const CLAIM_FIXTURE = `---
id: claim_20260808_00001
owner: person_001
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

- evidence_20260808_00001
`

const EVIDENCE_FIXTURE = `---
id: evidence_20260808_00001
owner: person_001
lifecycle: active
type: independent_project
created_at: 2026-08-08
---
# Project-A 气密性工装

## 分析摘要

| 字段 | 值 |
|------|-----|
| role | 结构负责人 |
| contribution | 主导气密性工装设计 |
| status | trusted |
| source_type | user_input |
| captured_at | 2026-08-08 |
| owner | person_001 |
| type | independent_project |
`

function makeWorkspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-strength-'))
  initWorkspace(dir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return dir
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

test('submit/scan：合法提案 → pending 落盘；scan 按 personId 过滤；非法引用 fail fast', () => {
  const dir = makeWorkspace({
    'persons/person_001/manifest.md': MANIFEST,
    'claims/claim_20260808_00001.md': CLAIM_FIXTURE,
    'evidence/evidence_20260808_00001.md': EVIDENCE_FIXTURE,
  })
  try {
    const ws = initWorkspace(dir)
    const p = submitStrengthProposals(ws, {
      personId: 'person_001',
      items: [{ text: '气密性问题解决：主导工装设计', claimIds: ['claim_20260808_00001'], evidenceIds: ['evidence_20260808_00001'] }],
    })
    assert.equal(p.status, 'pending')
    assert.match(p.id, /^strength_proposal_/)
    const list = scanStrengthProposals(ws, 'person_001')
    assert.equal(list.length, 1)
    assert.deepEqual(list[0]!.items, p.items)
    assert.equal(scanStrengthProposals(ws, 'person_002').length, 0, 'personId 过滤')
    // 非法引用 → throw（Agent 看到拦截原因）
    assert.throws(() => submitStrengthProposals(ws, { personId: 'person_001', items: [{ text: 'x', claimIds: ['claim_99999999_99999'], evidenceIds: [] }] }), /claim 不存在/)
    assert.throws(() => submitStrengthProposals(ws, { personId: 'person_001', items: [{ text: '', claimIds: [], evidenceIds: [] }] }), /不能为空/)
  } finally {
    cleanup(dir)
  }
})

test('buildStrengthProposalContext：Agent 上下文（usable claims + trusted evidence + 已有优势）', () => {
  const dir = makeWorkspace({
    'persons/person_001/manifest.md': MANIFEST,
    'persons/person_001/snapshot/current/summary_strengths.md': `---
id: person_001
---

## 优势条目

- 已有优势 （claims: claim_20260808_00001）
`,
    'claims/claim_20260808_00001.md': CLAIM_FIXTURE,
    'evidence/evidence_20260808_00001.md': EVIDENCE_FIXTURE,
  })
  try {
    const ws = initWorkspace(dir)
    const ctx = buildStrengthProposalContext(ws, 'person_001')
    assert.equal(ctx.personId, 'person_001')
    assert.equal(ctx.claims.length, 1)
    assert.equal(ctx.claims[0]!.id, 'claim_20260808_00001')
    assert.equal(ctx.evidence.length, 1)
    assert.equal(ctx.evidence[0]!.id, 'evidence_20260808_00001')
    assert.equal(ctx.existingStrengths.length, 1)
  } finally {
    cleanup(dir)
  }
})

test('decide：accept 并入优势亮点（同文本去重）→ 提案 accepted；reject 审计保留', () => {
  const dir = makeWorkspace({
    'persons/person_001/manifest.md': MANIFEST,
    'persons/person_001/snapshot/current/summary_strengths.md': `---
id: person_001
---

## 优势条目

- 已有优势 （claims: claim_20260808_00001）
`,
    'claims/claim_20260808_00001.md': CLAIM_FIXTURE,
    'evidence/evidence_20260808_00001.md': EVIDENCE_FIXTURE,
  })
  try {
    const ws = initWorkspace(dir)
    const p = submitStrengthProposals(ws, {
      personId: 'person_001',
      items: [
        { text: '已有优势', claimIds: ['claim_20260808_00001'], evidenceIds: [] },
        { text: '新增优势：气密性问题解决', claimIds: ['claim_20260808_00001'], evidenceIds: [] },
      ],
    })
    const accepted = decideStrengthProposal(ws, p.id, 'accept')
    assert.equal(accepted.status, 'accepted')
    const strengths = scanPersons(ws)[0]!.summaryStrengths ?? []
    assert.equal(strengths.length, 2, '同文本去重——已有优势不重复并入')
    assert.equal(strengths[1]!.text, '新增优势：气密性问题解决')

    const p2 = submitStrengthProposals(ws, { personId: 'person_001', items: [{ text: '被拒优势', claimIds: [], evidenceIds: [] }] })
    const rejected = decideStrengthProposal(ws, p2.id, 'reject', '太主观')
    assert.equal(rejected.status, 'rejected')
    assert.equal(rejected.rejectReason, '太主观')
    assert.equal(scanPersons(ws)[0]!.summaryStrengths?.length, 2, 'reject 不改优势亮点')
    // 已裁决不可再裁决
    assert.throws(() => decideStrengthProposal(ws, p2.id, 'accept'), /已裁决/)
  } finally {
    cleanup(dir)
  }
})
