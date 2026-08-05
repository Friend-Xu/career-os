/**
 * career-context 单测（M3.5.4 验收 T1-T7）：投影正确性 + 边界（no decision leakage / 纯函数稳定）。
 * 用临时 workspace 构造最小资产集（evidence/claim/resume/export），验证投影。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { registerArtifacts } from '../storage/artifact-registry.ts'
import { buildCareerContext } from '../context/career-context.ts'
import { serializeResumeDocument } from '../storage/resume-watcher.ts'
import type { ResumeDocument } from '../ir/resume.ts'
import { serializeExportRecord } from '../export/resume-export.ts'
import type { ResumeExportRecord } from '../ir/resume.ts'

/** 最小资产集：1 evidence（trusted）+ 1 claim + 2 resume（引用同一 claim）+ 1 export 记录 */
function seed(ws: ReturnType<typeof initWorkspace>, now: Date): void {
  ws.write('evidence/2026-08-05-自动化设备改造.md', `# 自动化设备改造项目

## 分析摘要

| 字段 | 值 |
|------|-----|
| role | 机械结构负责人 |
| contribution | 负责自动化设备机械结构设计 |
| source_type | user_input |
| captured_at | 2026-08-05 |
| status | trusted |
| verification_type | user_confirmed |
| confirmed_at | 2026-08-05 |

## 证据

### scope
- 负责机架和传动模块设计

`)
  ws.write('claims/2026-08-05-设计能力声明.md', `# 设计能力声明

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | 负责自动化设备机械结构设计，完成机架及传动机构优化 |
| claim_type | fact |
| source | agent_generated |
| captured_at | 2026-08-05 |

## 证据来源

- evidence_20260805_00001
`)
  registerArtifacts(ws, { type: 'evidence', dir: 'evidence', idPrefix: 'evidence_', marker: /##\s*分析摘要/, passthroughFields: [] }, now)
  registerArtifacts(ws, { type: 'claim', dir: 'claims', idPrefix: 'claim_', marker: /##\s*分析摘要/, passthroughFields: [] }, now)

  const base: ResumeDocument = {
    id: 'x',
    status: 'draft',
    person: '我',
    targetJobId: 'job_1',
    templateId: 'mechanical',
    templateVersion: '1.0',
    sections: [{ type: 'experience', title: '工作经历', bullets: [{ sentence: '负责自动化设备机械结构设计，完成机架及传动机构优化', claimId: 'claim_20260805_00001' }] }],
    generatedAt: '2026-08-05T10:00:00Z',
  }
  ws.write('resumes/documents/resume_20260805_00001.md', serializeResumeDocument({ ...base, id: 'resume_20260805_00001' }))
  ws.write('resumes/documents/resume_20260805_00002.md', serializeResumeDocument({ ...base, id: 'resume_20260805_00002', status: 'archived', lineage: { parentResumeId: 'resume_20260805_00001', derivationType: 'clone', createdBy: 'user' } }))
  registerArtifacts(ws, { type: 'resume', dir: 'resumes/documents', idPrefix: 'resume_', marker: /##\s*分析摘要/, passthroughFields: [] }, now)

  const rec: ResumeExportRecord = {
    id: 'export_001',
    documentId: 'resume_20260805_00001',
    templateId: 'mechanical',
    templateVersion: '1.0',
    rendererVersion: '0.1.0',
    format: 'pdf',
    exportedAt: '2026-08-05T12:00:00Z',
    checksum: 'abc',
  }
  ws.write('resumes/exports/export_001.md', serializeExportRecord(rec))
}

test('T1 Claim projection：claims[].usable 正确（canUseClaim 引擎派生）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-ctx-'))
  const ws = initWorkspace(root)
  seed(ws, new Date('2026-08-05T10:00:00Z'))
  const ctx = buildCareerContext(ws, {}, new Date('2026-08-05T10:00:00Z'))
  const c = ctx.claims[0]
  assert.equal(c.usable, true)
  assert.equal(c.type, 'fact')
  assert.deepEqual(c.provenance.evidenceIds, ['evidence_20260805_00001'])
  rmSync(root, { recursive: true, force: true })
})

test('T2 usedByResume：两个 resume 引用同一 claim → 两者列出', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-ctx2-'))
  const ws = initWorkspace(root)
  seed(ws, new Date('2026-08-05T10:00:00Z'))
  const ctx = buildCareerContext(ws)
  assert.deepEqual(ctx.claims[0].usedByResume, ['resume_20260805_00001', 'resume_20260805_00002'])
  rmSync(root, { recursive: true, force: true })
})

test('T3 Lifecycle visibility：archived resume 不隐藏（AI 需要历史）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-ctx3-'))
  const ws = initWorkspace(root)
  seed(ws, new Date('2026-08-05T10:00:00Z'))
  const ctx = buildCareerContext(ws)
  assert.equal(ctx.resumes.length, 2)
  assert.ok(ctx.resumes.some((r) => r.status === 'archived'))
  const archived = ctx.resumes.find((r) => r.status === 'archived')!
  assert.equal(archived.lineage?.parent, 'resume_20260805_00001')
  assert.equal(archived.lineage?.derivationType, 'clone')
  rmSync(root, { recursive: true, force: true })
})

test('T4 No decision leakage：Context 不含推荐/评分/决策字段', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-ctx4-'))
  const ws = initWorkspace(root)
  seed(ws, new Date('2026-08-05T10:00:00Z'))
  const ctx = buildCareerContext(ws)
  const json = JSON.stringify(ctx)
  for (const leaked of ['recommendedClaim', 'bestResume', 'shouldDelete', 'matchScore', 'priority']) {
    assert.ok(!json.includes(leaked), `Context 不应包含 ${leaked}`)
  }
  rmSync(root, { recursive: true, force: true })
})

test('T5 Expressions：bullet → { claimId, statement } 投影', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-ctx5-'))
  const ws = initWorkspace(root)
  seed(ws, new Date('2026-08-05T10:00:00Z'))
  const ctx = buildCareerContext(ws)
  assert.equal(ctx.expressions.length, 2) // 两个 resume 各一条 bullet
  const e = ctx.expressions[0]
  assert.equal(e.claimId, 'claim_20260805_00001')
  assert.equal(e.statement, '负责自动化设备机械结构设计，完成机架及传动机构优化')
  assert.equal(e.id, 'resume_20260805_00001:0:0')
  rmSync(root, { recursive: true, force: true })
})

test('T6 纯函数稳定：same workspace → same context', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-ctx6-'))
  const ws = initWorkspace(root)
  seed(ws, new Date('2026-08-05T10:00:00Z'))
  const a = buildCareerContext(ws, {}, new Date('2026-08-05T10:00:00Z'))
  const b = buildCareerContext(ws, {}, new Date('2026-08-05T10:00:00Z'))
  assert.deepEqual(a, b)
  rmSync(root, { recursive: true, force: true })
})

test('T7 currentJob：带 jobId 时 expectations.coverage 三态投影', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-ctx7-'))
  const ws = initWorkspace(root)
  seed(ws, new Date('2026-08-05T10:00:00Z'))
  ws.write('jobs/2026-08-05-测试自动化-结构设计工程师.md', `# 结构设计工程师 — 测试自动化

## 分析摘要

| 字段 | 值 |
|------|-----|
| company | 测试自动化 |
| title | 结构设计工程师 |
| created_at | 2026-08-05 |

## 岗位智能

| Responsibility | Priority | Capabilities | Evidence Patterns | Questions |
|----------------|----------|--------------|-------------------|-----------|
| 负责自动化设备机械结构设计 | must | 结构设计 | scope | 你负责设计哪些模块？ |

`)
  const ctx = buildCareerContext(ws, { jobId: '2026-08-05-测试自动化-结构设计工程师' }, new Date('2026-08-05T10:00:00Z'))
  assert.ok(ctx.currentJob)
  assert.equal(ctx.currentJob.responsibilities[0], '负责自动化设备机械结构设计')
  const exp = ctx.currentJob.expectations[0]
  assert.equal(exp.dimension, 'scope')
  assert.equal(exp.coverage, 'covered') // evidence.contribution 与 responsibility 双向包含
  rmSync(root, { recursive: true, force: true })
})
