/**
 * M4-4.2 Reference Protocol fixture 验证：
 * Case A 引用可解析 + 源修改零变化 + 投影 refresh（不自动同步）
 * Case B target 删除 → ReferenceInvalid（显式，无 fallback/stale）
 * Case C supports 双向 → 拒绝（acyclic dependency edge）
 * Case D 跨 Artifact 演化漂移：reference 不变 + resolver 返回最新事实（地址非快照）
 * + Level 1 结构校验矩阵（objectType 白名单 / scopeId / cover-letter 边界）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArtifactReference } from '../ir/reference.ts'
import type { PortfolioProject } from '../ir/portfolio.ts'
import type { InterviewQa } from '../ir/interview.ts'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { serializePortfolioProject, scanPortfolioProjects } from '../storage/portfolio-watcher.ts'
import { serializeInterviewQa } from '../storage/interview-watcher.ts'
import { resolveLocator } from '../reference/locator-resolver.ts'
import { validateReference, structuralErrors, sameLocator } from '../reference/reference-validator.ts'

// ─── fixtures ────────────────────────────────────────────────────────────

const CLAIM_ID = 'claim_20260805_00001'
const PROJECT_ID = 'project_20260805_00001'
const QA_ID = 'qa_20260805_00001'
const CLAIM_STATEMENT = '参与自动化设备机械设计'

const CLAIM_MD = `---
id: ${CLAIM_ID}
---

# 机械结构设计

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | ${CLAIM_STATEMENT} |
| claim_type | fact |
| source | agent_generated |
| captured_at | 2026-08-05 |

## 证据来源

- evidence_20260805_00001
`

function portfolioProject(factStatement = '参与机械结构设计'): PortfolioProject {
  return {
    id: PROJECT_ID,
    status: 'draft',
    version: 1,
    factItems: [{ id: 'pf_001', statement: factStatement, type: 'action', evidenceRefs: ['design_001'] }],
    evidence: [{ id: 'design_001', type: 'design', location: 'figma/project-x/design.pdf' }],
    transitions: [{ version: 1, from: '', to: 'draft', at: '2026-08-05T10:00:00Z' }],
    createdAt: '2026-08-05',
    sourceFile: '夹具项目',
  }
}

function interviewQa(): InterviewQa {
  return {
    id: QA_ID,
    status: 'draft',
    question: '请描述你的视觉检测经验',
    factItems: [{ id: 'fact_001', statement: '负责视觉检测模块开发', type: 'action', evidenceRefs: [] }],
    evidence: [],
    answerStatements: [{ id: 'ans_001', text: '参与视觉检测模块开发', factRefs: ['fact_001'] }],
    intents: [],
    transitions: [{ from: '', to: 'draft', at: '2026-08-05T10:00:00Z' }],
    createdAt: '2026-08-05',
    sourceFile: '视觉检测',
  }
}

function setupWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'cos-ref-'))
  const ws = initWorkspace(root)
  ws.write(`claims/${CLAIM_ID}.md`, CLAIM_MD)
  ws.write(`portfolio/projects/${PROJECT_ID}.md`, serializePortfolioProject(portfolioProject()))
  ws.write(`interviews/${QA_ID}.md`, serializeInterviewQa(interviewQa()))
  return ws
}

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

// ─── Case A：引用可解析 + 源修改零变化 + 投影 refresh ─────────────────────

test('Case A：owner 引用可解析；target 修改 → owner 零变化 + resolver 返回最新事实', () => {
  const ws = setupWorkspace()
  const resolve = (loc: Parameters<typeof resolveLocator>[1]): ReturnType<typeof resolveLocator> => resolveLocator(ws, loc)
  const ref: ArtifactReference = {
    id: 'ref_001',
    owner: { artifact: 'resume', objectType: 'claim', objectId: CLAIM_ID },
    target: { artifact: 'portfolio', scopeId: PROJECT_ID, objectType: 'fact', objectId: 'pf_001' },
    relation: 'supports',
    createdAt: '2026-08-05T10:00:00Z',
  }

  // 引用可解析（Level 1+2 valid）
  assert.deepEqual(validateReference(ref, { resolve, existing: [] }), { valid: true, errors: [] })
  assert.deepEqual(resolve(ref.target), { exists: true, statement: '参与机械结构设计' })

  // owner 源文件快照（协议只读——解析/校验不触碰 owner）
  const ownerBefore = ws.read(`claims/${CLAIM_ID}.md`)
  const ownerChecksum = checksum(ownerBefore)

  // target 演化：portfolio fact v1→v2
  const project = scanPortfolioProjects(ws)[0].record
  ws.write(
    `portfolio/projects/${PROJECT_ID}.md`,
    serializePortfolioProject({ ...project, factItems: [{ ...project.factItems[0], statement: '负责机械结构设计' }] }),
  )

  // owner 零变化（不自动同步）
  assert.equal(checksum(ws.read(`claims/${CLAIM_ID}.md`)), ownerChecksum, 'target 修改不得触碰 owner')
  // 投影 refresh：resolver 返回最新事实（地址非快照）
  assert.deepEqual(resolve(ref.target), { exists: true, statement: '负责机械结构设计' })
  // reference 本身不变
  assert.equal(ref.id, 'ref_001')
  assert.equal(ref.target.objectId, 'pf_001')
})

// ─── Case B：target 删除 → ReferenceInvalid ───────────────────────────────

test('Case B：target 删除 → ReferenceInvalid（显式 error，无 fallback/stale snapshot）', () => {
  const ws = setupWorkspace()
  const resolve = (loc: Parameters<typeof resolveLocator>[1]): ReturnType<typeof resolveLocator> => resolveLocator(ws, loc)
  const ref: ArtifactReference = {
    id: 'ref_002',
    owner: { artifact: 'resume', objectType: 'claim', objectId: CLAIM_ID },
    target: { artifact: 'portfolio', scopeId: PROJECT_ID, objectType: 'fact', objectId: 'pf_001' },
    relation: 'supports',
    createdAt: '2026-08-05T10:00:00Z',
  }
  assert.equal(validateReference(ref, { resolve, existing: [] }).valid, true)

  // 删除整个项目（target 容器消失）
  ws.delete(`portfolio/projects/${PROJECT_ID}.md`)

  // resolver：显式 ReferenceInvalid（无 fallback——不返回旧 statement）
  const resolution = resolve(ref.target)
  assert.equal(resolution.exists, false)
  assert.equal(resolution.statement, undefined, '不允许 stale snapshot')
  assert.ok(resolution.error?.includes('项目不存在'), '断链原因显式可见')
  // validator Level 2：invalid（显式 error，非 skip）
  const result = validateReference(ref, { resolve, existing: [] })
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes('ReferenceInvalid')), '必须 ReferenceInvalid，不能静默通过')
})

// ─── Case C：supports 双向 → 拒绝（acyclic dependency edge）───────────────

test('Case C：supports A→B 后 B→A 拒绝（循环检测）；mentions 语义空间不受影响（定义不实现）', () => {
  const ws = setupWorkspace()
  const resolve = (loc: Parameters<typeof resolveLocator>[1]): ReturnType<typeof resolveLocator> => resolveLocator(ws, loc)
  const refAtoB: ArtifactReference = {
    id: 'ref_a',
    owner: { artifact: 'resume', objectType: 'claim', objectId: CLAIM_ID },
    target: { artifact: 'portfolio', scopeId: PROJECT_ID, objectType: 'fact', objectId: 'pf_001' },
    relation: 'supports',
    createdAt: '2026-08-05T10:00:00Z',
  }
  const refBtoA: ArtifactReference = {
    id: 'ref_b',
    owner: { artifact: 'portfolio', scopeId: PROJECT_ID, objectType: 'fact', objectId: 'pf_001' },
    target: { artifact: 'resume', objectType: 'claim', objectId: CLAIM_ID },
    relation: 'supports',
    createdAt: '2026-08-05T10:01:00Z',
  }

  // A→B 成立
  assert.equal(validateReference(refAtoB, { resolve, existing: [] }).valid, true)
  // B→A 拒绝（existing 含 A→B）
  const result = validateReference(refBtoA, { resolve, existing: [refAtoB] })
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes('循环引用拒绝')), 'supports 双向必须拒绝')
})

// ─── Case D：跨 Artifact 演化漂移（reference 是地址不是快照）──────────────

test('Case D：跨 Artifact 演化漂移——reference 不变 + resolver 永远最新（Reference ≠ Copy ≠ Sync）', () => {
  const ws = setupWorkspace()
  const resolve = (loc: Parameters<typeof resolveLocator>[1]): ReturnType<typeof resolveLocator> => resolveLocator(ws, loc)
  const ref: ArtifactReference = {
    id: 'ref_003',
    owner: { artifact: 'resume', objectType: 'claim', objectId: CLAIM_ID },
    target: { artifact: 'portfolio', scopeId: PROJECT_ID, objectType: 'fact', objectId: 'pf_001' },
    relation: 'supports',
    createdAt: '2026-08-05T10:00:00Z',
  }
  assert.equal(resolve(ref.target).statement, '参与机械结构设计')

  // Portfolio 演化：参与 → 负责（v1→v2）
  const project = scanPortfolioProjects(ws)[0].record
  ws.write(
    `portfolio/projects/${PROJECT_ID}.md`,
    serializePortfolioProject({ ...project, factItems: [{ ...project.factItems[0], statement: '负责机械结构设计' }] }),
  )

  // reference 本身 unchanged（id/owner/target/relation/createdAt 原样）
  assert.deepEqual(ref, {
    id: 'ref_003',
    owner: { artifact: 'resume', objectType: 'claim', objectId: CLAIM_ID },
    target: { artifact: 'portfolio', scopeId: PROJECT_ID, objectType: 'fact', objectId: 'pf_001' },
    relation: 'supports',
    createdAt: '2026-08-05T10:00:00Z',
  })
  // resolver 返回最新事实——不是存储的旧文本
  assert.equal(resolve(ref.target).statement, '负责机械结构设计')
  // 校验仍 valid（地址指向的事实存在）
  assert.equal(validateReference(ref, { resolve, existing: [] }).valid, true)
})

// ─── Level 1 结构校验矩阵 ────────────────────────────────────────────────

test('Level 1 结构：objectType 白名单 / scopeId 规则 / cover-letter 边界 / claim 特例', () => {
  // 非法 objectType（Expression 引用不存在）
  assert.ok(
    structuralErrors({ artifact: 'portfolio', scopeId: PROJECT_ID, objectType: 'unit' as never, objectId: 'nu_001' }, 'target').some((e) => e.includes('objectType')),
  )
  // cover-letter 不可作 target（无 Fact Layer）
  assert.ok(
    structuralErrors({ artifact: 'cover-letter', objectType: 'fact' as never, objectId: 'x' }, 'target').some((e) => e.includes('cover-letter')),
  )
  // claim 仅存在于 resume
  assert.ok(
    structuralErrors({ artifact: 'portfolio', scopeId: PROJECT_ID, objectType: 'claim' as never, objectId: 'x' }, 'target').some((e) => e.includes('claim 仅存在于 resume')),
  )
  // fact 仅存在于 portfolio/interview
  assert.ok(
    structuralErrors({ artifact: 'resume', objectType: 'fact' as never, objectId: 'x' }, 'target').some((e) => e.includes('fact 仅存在于')),
  )
  // portfolio fact 缺 scopeId → 结构 error（Local Addressing）
  assert.ok(
    structuralErrors({ artifact: 'portfolio', objectType: 'fact', objectId: 'pf_001' }, 'target').some((e) => e.includes('scopeId')),
  )
  // 合法结构（resume claim / portfolio fact with scope）零 error
  assert.deepEqual(
    structuralErrors({ artifact: 'resume', objectType: 'claim', objectId: CLAIM_ID }, 'owner'),
    [],
  )
  assert.deepEqual(
    structuralErrors({ artifact: 'portfolio', scopeId: PROJECT_ID, objectType: 'fact', objectId: 'pf_001' }, 'owner'),
    [],
  )
})

test('sameLocator：全字段相等判定（scopeId 缺省与空串等价）', () => {
  assert.equal(sameLocator(
    { artifact: 'resume', objectType: 'claim', objectId: CLAIM_ID },
    { artifact: 'resume', objectType: 'claim', objectId: CLAIM_ID },
  ), true)
  assert.equal(sameLocator(
    { artifact: 'portfolio', scopeId: PROJECT_ID, objectType: 'fact', objectId: 'pf_001' },
    { artifact: 'portfolio', scopeId: PROJECT_ID, objectType: 'fact', objectId: 'pf_001' },
  ), true)
  assert.equal(sameLocator(
    { artifact: 'resume', objectType: 'claim', objectId: CLAIM_ID },
    { artifact: 'portfolio', objectType: 'claim' as never, objectId: CLAIM_ID },
  ), false)
})
