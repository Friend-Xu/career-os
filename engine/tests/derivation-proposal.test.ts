import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import {
  buildDeriveContext,
  decideDerivationProposal,
  scanDerivationProposals,
  submitDerivationProposal,
} from '../storage/derivation-proposal-registry.ts'
import { scanWorkingCopies } from '../storage/working-copy-registry.ts'
import type { WorkingSection } from '../ir/resume.ts'

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

const JOB_FIXTURE = `---
created_at: 2026-08-08
---
# 机械结构工程师

## 分析摘要

| 字段 | 值 |
|------|-----|
| company | Company-A |
| title | 机械结构工程师 |
| requirements | 自动化设备结构设计；SolidWorks 建模 |

## JD 原文

负责自动化设备结构设计，熟练使用 SolidWorks。
`

const WC_FIXTURE = `---
id: wc_20260808_00001
owner: person_001
status: active
revision: 2
updated_at: 2026-08-08T00:00:00.000Z
---
# 简历工作副本

## 工作经历

- 主导气密性工装设计 （claims: claim_20260808_00001）
`

const SECTIONS: WorkingSection[] = [
  {
    id: 'sec_1',
    title: '工作经历',
    blocks: [
      { id: 'blk_1', text: '主导气密性工装设计，装配泄漏率降至 0.5%', provenanceLinks: ['claim_20260808_00001'] },
    ],
  },
  {
    id: 'sec_2',
    title: '技能',
    blocks: [{ id: 'blk_1', text: 'SolidWorks 三维建模与工程图', provenanceLinks: [] }],
  },
]

function makeWorkspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-derivation-'))
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

const BASE_FILES = {
  'persons/person_001/manifest.md': MANIFEST,
  'claims/claim_20260808_00001.md': CLAIM_FIXTURE,
  'evidence/evidence_20260808_00001.md': EVIDENCE_FIXTURE,
  'jobs/job_001.md': JOB_FIXTURE,
  'resumes/working-copies/wc_20260808_00001.md': WC_FIXTURE,
}

test('submit/scan：合法提案 → pending 落盘；scan 过滤；边界校验 fail fast', () => {
  const dir = makeWorkspace(BASE_FILES)
  try {
    const ws = initWorkspace(dir)
    const p = submitDerivationProposal(ws, {
      owner: 'person_001',
      sourceWcId: 'wc_20260808_00001',
      jobId: 'job_001',
      sections: SECTIONS,
      changeNotes: ['工作经历：新增量化指标'],
    })
    assert.equal(p.status, 'pending')
    assert.match(p.id, /^derivation_/)
    assert.deepEqual(scanDerivationProposals(ws).length, 1)
    assert.equal(scanDerivationProposals(ws, { owner: 'person_002' }).length, 0, 'owner 过滤')
    assert.equal(scanDerivationProposals(ws, { sourceWcId: 'wc_other' }).length, 0, 'sourceWcId 过滤')
    assert.equal(scanDerivationProposals(ws, { jobId: 'job_other' }).length, 0, 'jobId 过滤')
    // 边界校验 → throw（Agent 看到拦截原因）
    assert.throws(() => submitDerivationProposal(ws, { owner: 'person_002', sourceWcId: 'wc_20260808_00001', jobId: 'job_001', sections: SECTIONS, changeNotes: ['x'] }), /非登记人/)
    assert.throws(() => submitDerivationProposal(ws, { owner: 'person_001', sourceWcId: 'wc_missing', jobId: 'job_001', sections: SECTIONS, changeNotes: ['x'] }), /源副本不存在/)
    assert.throws(() => submitDerivationProposal(ws, { owner: 'person_001', sourceWcId: 'wc_20260808_00001', jobId: 'job_missing', sections: SECTIONS, changeNotes: ['x'] }), /JD 不存在/)
    assert.throws(
      () =>
        submitDerivationProposal(ws, {
          owner: 'person_001',
          sourceWcId: 'wc_20260808_00001',
          jobId: 'job_001',
          sections: [{ id: 'sec_1', title: '工作经历', blocks: [{ id: 'blk_1', text: 'x', provenanceLinks: ['claim_99999999_99999'] }] }],
          changeNotes: ['x'],
        }),
      /claim 不可消费/,
    )
    assert.throws(() => submitDerivationProposal(ws, { owner: 'person_001', sourceWcId: 'wc_20260808_00001', jobId: 'job_001', sections: [], changeNotes: ['x'] }), /sections 必填/)
    assert.throws(() => submitDerivationProposal(ws, { owner: 'person_001', sourceWcId: 'wc_20260808_00001', jobId: 'job_001', sections: SECTIONS, changeNotes: [] }), /changeNotes 必填/)
  } finally {
    cleanup(dir)
  }
})

test('buildDeriveContext：Agent 上下文（源副本 + JD + 可用 claims + 可信 evidence + 已有优势）', () => {
  const dir = makeWorkspace({
    ...BASE_FILES,
    'persons/person_001/snapshot/current/summary_strengths.md': `---
id: person_001
---

## 优势条目

- 已有优势 （claims: claim_20260808_00001）
`,
  })
  try {
    const ws = initWorkspace(dir)
    const ctx = buildDeriveContext(ws, 'wc_20260808_00001', 'job_001')
    assert.equal(ctx.source.id, 'wc_20260808_00001')
    assert.equal(ctx.job.company, 'Company-A')
    assert.equal(ctx.job.responsibilities.length, 2)
    assert.match(ctx.job.jd ?? '', /SolidWorks/)
    assert.equal(ctx.claims.length, 1)
    assert.equal(ctx.claims[0]!.id, 'claim_20260808_00001')
    assert.equal(ctx.evidence.length, 1)
    assert.equal(ctx.strengths.length, 1)
    assert.throws(() => buildDeriveContext(ws, 'wc_missing', 'job_001'), /源副本不存在/)
    assert.throws(() => buildDeriveContext(ws, 'wc_20260808_00001', 'job_missing'), /JD 不存在/)
  } finally {
    cleanup(dir)
  }
})

test('decide accept：引擎创建新工作副本（名称 = 公司 · 岗位，挂接 targetContext）→ 提案 accepted；重复裁决拦截', () => {
  const dir = makeWorkspace(BASE_FILES)
  try {
    const ws = initWorkspace(dir)
    const p = submitDerivationProposal(ws, {
      owner: 'person_001',
      sourceWcId: 'wc_20260808_00001',
      jobId: 'job_001',
      sections: SECTIONS,
      changeNotes: ['工作经历：新增量化指标'],
    })
    const decided = decideDerivationProposal(ws, p.id, 'accept')
    assert.equal(decided.status, 'accepted')
    assert.ok(decided.acceptedWcId)
    // 新副本：名称/挂接/内容/归属
    const copies = scanWorkingCopies(ws)
    const copy = copies.find((c) => c.id === decided.acceptedWcId)
    assert.ok(copy, '新副本已落盘')
    assert.equal(copy!.name, 'Company-A · 机械结构工程师')
    assert.equal(copy!.targetContext?.jobId, 'job_001')
    assert.equal(copy!.owner, 'person_001')
    assert.equal(copy!.sections.length, 2)
    assert.equal(copy!.sections[0]!.blocks[0]!.provenanceLinks![0]!, 'claim_20260808_00001')
    // 提案已裁决 → 再裁决拦截
    assert.throws(() => decideDerivationProposal(ws, p.id, 'accept'), /已裁决/)
  } finally {
    cleanup(dir)
  }
})

test('decide reject：审计保留（拒绝理由落盘，不建副本）', () => {
  const dir = makeWorkspace(BASE_FILES)
  try {
    const ws = initWorkspace(dir)
    const p = submitDerivationProposal(ws, {
      owner: 'person_001',
      sourceWcId: 'wc_20260808_00001',
      jobId: 'job_001',
      sections: SECTIONS,
      changeNotes: ['x'],
    })
    const decided = decideDerivationProposal(ws, p.id, 'reject', '方向不符')
    assert.equal(decided.status, 'rejected')
    assert.equal(decided.rejectReason, '方向不符')
    assert.equal(decided.acceptedWcId, undefined)
    assert.equal(scanWorkingCopies(ws).length, 1, '拒绝不建副本')
    // 扫描仍可见（审计保留）
    assert.equal(scanDerivationProposals(ws)[0]!.status, 'rejected')
  } finally {
    cleanup(dir)
  }
})
