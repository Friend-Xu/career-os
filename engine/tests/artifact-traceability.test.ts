/**
 * artifact-traceability 单测（M4-5.4）：Cover Letter Traceability Adapter。
 * 验收：同 sourceRefs → 同 Context（确定性）/ resolver 每次读当前事实（非快照）/
 * 不产生副本（查询不改文件）/ sourceRefs 原始声明顺序 / objectType 按 artifact 决定 /
 * 断链显式（resolved=false + error，无 fallback）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { buildCoverLetterTraceability } from '../artifact-traceability/cover-letter-traceability.ts'

const CL_ID = 'cl_20260805_00001'
const PROJECT_ID = 'project_20260805_00001'
const QA_ID = 'qa_20260805_00001'
const CLAIM_ID = 'claim_20260805_00001'

function tempWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'cos-traceability-'))
  return initWorkspace(root)
}

/** 引用 portfolio project + interview QA + resume claim 的 cover letter（声明顺序：portfolio → interview → resume） */
function writeSources(ws: Workspace): void {
  ws.write(
    `portfolio/projects/${PROJECT_ID}.md`,
    `---
id: ${PROJECT_ID}
created_at: 2026-08-05
---

> status: published
> version: 3

## 项目事实

| id | statement | type | evidence |
|----|-----------|------|----------|
| pf_001 | 完成自动化夹具设计 | engineering_work | design_001 |

## 证据资产

| id | type | location | metadata |
|----|------|----------|----------|
| design_001 | design | figma/project-x/design.pdf | - |

## 演化记录

| version | from | to | at | via |
|---------|------|----|----|-----|
| 1 | - | draft | 2026-08-05T08:00:00Z | - |
`,
  )
  ws.write(
    `interviews/${QA_ID}.md`,
    `---
id: ${QA_ID}
created_at: 2026-08-05
---

> status: ready

## 问题

介绍项目

## 事实

| id | statement | type | evidence |
|----|-----------|------|----------|
| fact_001 | 负责自动化夹具设计 | responsibility | design_001 |

## 证据资产

| id | type | location | metadata |
|----|------|----------|----------|
| design_001 | design | figma/project-x/design.pdf | - |

## 回答

- ans_001（text: "x"；facts: fact_001）

## 策略

- int_001（statement: "y"）

## 演化记录

| from | to | at | via |
|------|----|----|-----|
| - | draft | 2026-08-05T08:00:00Z | - |
`,
  )
  ws.write(
    `claims/${CLAIM_ID}.md`,
    `---
id: ${CLAIM_ID}
---

# 机械结构设计

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | 完成自动化夹具设计 |
| claim_type | fact |
| source | agent_generated |
| captured_at | 2026-08-05 |
`,
  )
}

function writeLetter(ws: Workspace, refsLine: string): void {
  ws.write(
    `cover-letters/${CL_ID}.md`,
    `---
id: ${CL_ID}
created_at: 2026-08-05
---

> status: ready

## 叙述单元

- nu_001（text: "我主导了自动化夹具设计全流程"；refs: ${refsLine}）

## 投递记录

| targetCompany | targetJob | at |
|---------------|-----------|-----|
| - | - | - |

## 演化记录

| from | to | at | via |
|------|----|----|-----|
| - | draft | 2026-08-05T08:00:00Z | - |
`,
  )
}

// ─── Projection ────────────────────────────────────────────────────────────

test('投影：同 sourceRefs → 同 Context（确定性）+ 声明顺序 + factStatement', () => {
  const ws = tempWorkspace()
  writeSources(ws)
  writeLetter(ws, `portfolio.${PROJECT_ID}.pf_001, interview.${QA_ID}.fact_001, resume.${CLAIM_ID}`)
  const ctx = buildCoverLetterTraceability(ws, CL_ID, 'nu_001')
  assert.deepEqual(ctx.owner, { artifact: 'cover-letter', id: CL_ID })
  assert.deepEqual(ctx.node, { type: 'narrative_unit', id: 'nu_001', text: '我主导了自动化夹具设计全流程' })
  // 顺序 = sourceRefs 原始声明顺序（portfolio → interview → resume），resolver 返回顺序不参与排序
  assert.deepEqual(ctx.sources.map((s) => s.locator.artifact), ['portfolio', 'interview', 'resume'])
  assert.deepEqual(ctx.sources.map((s) => s.factStatement), [
    '完成自动化夹具设计',
    '负责自动化夹具设计',
    '完成自动化夹具设计',
  ])
  assert.ok(ctx.sources.every((s) => s.resolved))
  assert.ok(ctx.sources.every((s) => s.error === undefined))
  assert.deepEqual(ctx, buildCoverLetterTraceability(ws, CL_ID, 'nu_001'))
})

test('投影：resolver 每次读取当前事实（地址非快照——改源后重查更新）', () => {
  const ws = tempWorkspace()
  writeSources(ws)
  writeLetter(ws, `portfolio.${PROJECT_ID}.pf_001`)
  const before = buildCoverLetterTraceability(ws, CL_ID, 'nu_001')
  assert.equal(before.sources[0].factStatement, '完成自动化夹具设计')
  // 源事实变更（无 proposal——直接改文件模拟事实演化）
  const md = ws.read(`portfolio/projects/${PROJECT_ID}.md`).replace('完成自动化夹具设计', '完成自动化夹具设计并负责验证')
  ws.write(`portfolio/projects/${PROJECT_ID}.md`, md)
  const after = buildCoverLetterTraceability(ws, CL_ID, 'nu_001')
  assert.equal(after.sources[0].factStatement, '完成自动化夹具设计并负责验证')
})

test('objectType 按 artifact 决定（switch 非字符串猜测）：resume → claim，其余 → fact', () => {
  const ws = tempWorkspace()
  writeSources(ws)
  writeLetter(ws, `portfolio.${PROJECT_ID}.pf_001, interview.${QA_ID}.fact_001, resume.${CLAIM_ID}`)
  const ctx = buildCoverLetterTraceability(ws, CL_ID, 'nu_001')
  assert.deepEqual(ctx.sources.map((s) => [s.locator.artifact, s.locator.objectType]), [
    ['portfolio', 'fact'],
    ['interview', 'fact'],
    ['resume', 'claim'],
  ])
  assert.equal(ctx.sources[2].locator.objectId, CLAIM_ID)
})

// ─── Failure（断链显式，无 fallback）──────────────────────────────────────

test('断链：删除 target → resolved=false + error（不 fallback，factStatement 空）', () => {
  const ws = tempWorkspace()
  writeSources(ws)
  writeLetter(ws, `portfolio.${PROJECT_ID}.pf_001, interview.${QA_ID}.fact_001`)
  ws.delete(`portfolio/projects/${PROJECT_ID}.md`)
  const ctx = buildCoverLetterTraceability(ws, CL_ID, 'nu_001')
  assert.equal(ctx.sources[0].resolved, false)
  assert.equal(ctx.sources[0].factStatement, '')
  assert.ok(ctx.sources[0].error && ctx.sources[0].error.length > 0, '断链必须有显式原因')
  // 其它 source 不受影响
  assert.equal(ctx.sources[1].resolved, true)
  assert.equal(ctx.sources[1].factStatement, '负责自动化夹具设计')
})

// ─── Isolation（查看 Traceability ≠ 产生 Artifact state）──────────────────

test('隔离：查询不修改任何文件（checksum 不变）', () => {
  const ws = tempWorkspace()
  writeSources(ws)
  writeLetter(ws, `portfolio.${PROJECT_ID}.pf_001, interview.${QA_ID}.fact_001, resume.${CLAIM_ID}`)
  const files = [
    `portfolio/projects/${PROJECT_ID}.md`,
    `interviews/${QA_ID}.md`,
    `claims/${CLAIM_ID}.md`,
    `cover-letters/${CL_ID}.md`,
  ]
  const before = files.map((f) => ws.read(f))
  const ctx = buildCoverLetterTraceability(ws, CL_ID, 'nu_001')
  assert.equal(ctx.sources.length, 3)
  files.forEach((f, i) => assert.equal(ws.read(f), before[i], `${f} 被修改`))
})

// ─── 错误输入 ──────────────────────────────────────────────────────────────

test('错误输入：letter 或 unit 不存在 → 抛错（fail fast）', () => {
  const ws = tempWorkspace()
  writeSources(ws)
  writeLetter(ws, `portfolio.${PROJECT_ID}.pf_001`)
  assert.throws(() => buildCoverLetterTraceability(ws, 'cl_nonexistent', 'nu_001'), /Cover Letter 不存在/)
  assert.throws(() => buildCoverLetterTraceability(ws, CL_ID, 'nu_999'), /NarrativeUnit 不存在/)
})
