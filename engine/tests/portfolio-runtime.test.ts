/**
 * M4-1.3 Portfolio Runtime Validation：真实工作区 replay——
 * 验证同一套治理纪律在第二类 Artifact（Portfolio）上稳定（M3-3 纪律迁移）。
 *
 * Case A 正常 rewrite        → 演化闭环成立
 * Case B 事实膨胀            → Runner PASS（引擎确定性不越界），语义审查留给 Benchmark
 * Case C evidence 偷改       → schema 无通道 / 解析忽略 / apply 不变量——非法行为无法表达
 * Case D published 修改      → 必须 draft(v2)，不能 overwrite
 *
 * 纪律断言（M3-3 延续）：引擎只做结构校验，不判语义；演化不可覆盖历史。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PortfolioProject, PortfolioProposalChange } from '../ir/portfolio.ts'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import {
  serializePortfolioProject,
  parsePortfolioProposal,
  scanPortfolioProjects,
  scanPortfolioProposals,
  registerPortfolioProjectFile,
  registerPortfolioProposalFile,
  transitionPortfolioProject,
  acceptPortfolioProposal,
  buildPortfolioContext,
  PortfolioTransitionError,
} from '../storage/portfolio-watcher.ts'

// ─── fixtures ────────────────────────────────────────────────────────────

const PROJECT_ID = 'project_20260805_00001'
const NOW = new Date('2026-08-05T10:00:00Z')
const DESIGN_ID = 'design_001'
const BASE_STATEMENT = '完成机械结构设计'
const REWRITE_STATEMENT = '完成自动化设备机械结构设计'
const INFLATED_STATEMENT = '完成高精度机器人结构设计，实现±0.01mm精度'

function baseProject(): PortfolioProject {
  return {
    id: PROJECT_ID,
    status: 'draft',
    version: 1,
    factItems: [{ id: 'pf_001', statement: BASE_STATEMENT, type: 'engineering_work', evidenceRefs: [DESIGN_ID] }],
    evidence: [{ id: DESIGN_ID, type: 'design', location: 'figma/project-x/design.pdf', metadata: { 时间: '2026-03' } }],
    transitions: [{ version: 1, from: '', to: 'draft', at: '2026-08-05T10:00:00Z' }],
    createdAt: '2026-08-05',
    sourceFile: '夹具设计',
  }
}

function setupWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'cos-porv-'))
  const ws = initWorkspace(root)
  ws.write(`portfolio/projects/${PROJECT_ID}.md`, serializePortfolioProject(baseProject()))
  return ws
}

/** 模拟 AI 写提案（暂存名，无 status 行）→ 引擎登记 → 返回系统提案 id */
function writeAndRegisterProposal(ws: Workspace, md: string, fileName = 'proposal-改写.md'): string {
  ws.write(`portfolio/proposals/${fileName}`, md)
  assert.equal(registerPortfolioProposalFile(ws, fileName, NOW), true, '提案应登记成功')
  return scanPortfolioProposals(ws)[0].record.id
}

/** AI 提案暂存文件（用户/AI 手写格式：无 frontmatter、无 status 行） */
function proposalMd(changes: string): string {
  return `## 提案摘要

| 字段 | 值 |
|------|-----|
| type | portfolio_proposal |
| project_id | ${PROJECT_ID} |
| created_by | ai |

## 变更建议

${changes}
`
}

// ─── Case A：正常 rewrite ────────────────────────────────────────────────

test('Case A 正常 rewrite：完成机械结构设计 → 完成自动化设备机械结构设计（演化闭环成立）', () => {
  const ws = setupWorkspace()
  const pid = writeAndRegisterProposal(
    ws,
    proposalMd(`- pf_001（type: rewrite；old: "${BASE_STATEMENT}"；new: "${REWRITE_STATEMENT}"；reason: "目标岗位强调结构设计能力"）`),
  )
  // 登记时校验通过
  assert.equal(scanPortfolioProposals(ws)[0].record.validation?.status, 'valid')

  const { project, proposal } = acceptPortfolioProposal(ws, pid, '表达更契合岗位语言', NOW)
  assert.equal(project.version, 2)
  assert.equal(project.factItems[0].statement, REWRITE_STATEMENT)
  assert.deepEqual(project.factItems[0].evidenceRefs, [DESIGN_ID]) // 证据锚点保留
  assert.equal(proposal.status, 'accepted')
  assert.equal(proposal.resultVersion, 2)

  // 投影一致（同文件 → 同输出）
  assert.deepEqual(buildPortfolioContext(ws).projects[0], project)
})

// ─── Case B：事实膨胀（引擎不越界判语义）──────────────────────────────────

test('Case B 事实膨胀：±0.01mm 精度无证据支持 → Runner PASS（确定性不越界），语义审查留给 Benchmark', () => {
  const ws = setupWorkspace()
  // 无证据支持的量级声明：design_001 只证明"设计图存在"，不支撑精度数字
  const pid = writeAndRegisterProposal(
    ws,
    proposalMd(`- pf_001（type: rewrite；old: "${BASE_STATEMENT}"；new: "${INFLATED_STATEMENT}"；reason: "岗位要求高精度能力"）`),
  )
  // 引擎校验通过：P-01~P-07 全过（结构校验不判语义）
  const validation = scanPortfolioProposals(ws)[0].record.validation
  assert.equal(validation?.status, 'valid')
  assert.equal(validation?.issues.length, 0)

  // accept 成功——Runner 不拦语义
  const { project } = acceptPortfolioProposal(ws, pid, undefined, NOW)
  assert.equal(project.factItems[0].statement, INFLATED_STATEMENT)

  // 纪律：语义越界（无证据支撑的量化声明）由人审 + Portfolio Benchmark 审计，引擎不 judge（M3-3 延续）
  // —— Runner PASS 不等同于"事实正确"，确定性检查不越界语义空间
})

// ─── Case C：evidence 偷改（非法行为无法表达）────────────────────────────

test('Case C evidence 偷改：schema 无通道 + 解析忽略 + apply 不变量——必须无法表达', () => {
  const ws = setupWorkspace()

  // ① schema 层面：PortfolioProposalChange 无 evidenceRefs/新增 FactItem 通道（编译期保证）
  const c: PortfolioProposalChange = { type: 'rewrite', factId: 'pf_001', old: BASE_STATEMENT, new: '改写', reason: 'r' }
  assert.equal('evidenceRefs' in c, false, 'change 类型不应存在 evidenceRefs 字段')
  assert.equal('type' in c && c.type, 'rewrite')

  // ② 解析层面：AI 手写提案带 evidenceRefs 字段声明 → 被忽略（解析只认 type/factId/old/new/reason）
  const smuggled = proposalMd(
    `- pf_001（type: rewrite；evidenceRefs: "design_999"；old: "${BASE_STATEMENT}"；new: "改写"；reason: "偷换证据"）`,
  )
  const parsed = parsePortfolioProposal(smuggled, 'smuggled.md')
  assert.equal(parsed.record.changes[0].factId, 'pf_001')
  assert.equal('evidenceRefs' in parsed.record.changes[0], false, '解析结果不应含 evidenceRefs')
  assert.equal(parsed.record.changes[0].new, '改写') // 合法字段正常解析

  // ③ apply 层面：accept 后 evidenceRefs 不变量（证据锚点不可被提案触碰）
  const pid = writeAndRegisterProposal(
    ws,
    proposalMd(`- pf_001（type: rewrite；evidenceRefs: "design_999"；old: "${BASE_STATEMENT}"；new: "改写"；reason: "偷换证据"）`),
  )
  const { project } = acceptPortfolioProposal(ws, pid, undefined, NOW)
  assert.deepEqual(project.factItems[0].evidenceRefs, [DESIGN_ID], 'evidenceRefs 必须原样保留')
  assert.equal(project.factItems[0].statement, '改写')
  assert.equal(project.evidence.length, 1, 'Evidence 资产不可被提案新增/修改')
  assert.equal(project.factItems.length, 1, '不可新增 FactItem')
})

// ─── Case D：published 修改（immutable——不能 overwrite）────────────────

test('Case D published 修改：published v1 → draft v2，历史不可覆盖', () => {
  const ws = setupWorkspace()
  transitionPortfolioProject(ws, PROJECT_ID, 'reviewed', NOW)
  transitionPortfolioProject(ws, PROJECT_ID, 'published', NOW)
  assert.equal(scanPortfolioProjects(ws)[0].record.status, 'published')

  // 直接回退/原地修改被拒绝
  assert.throws(() => transitionPortfolioProject(ws, PROJECT_ID, 'draft', NOW), PortfolioTransitionError)
  assert.throws(() => transitionPortfolioProject(ws, PROJECT_ID, 'reviewed', NOW), PortfolioTransitionError)

  // 修改必须走 Proposal → draft(v2)
  const pid = writeAndRegisterProposal(
    ws,
    proposalMd(`- pf_001（type: rewrite；old: "${BASE_STATEMENT}"；new: "${REWRITE_STATEMENT}"；reason: "岗位语言升级"）`),
  )
  const { project } = acceptPortfolioProposal(ws, pid, undefined, NOW)
  assert.equal(project.status, 'draft')
  assert.equal(project.version, 2)

  // published(v1) 历史完整保留（append-only）：v1 建立 → review → publish → proposal 应用
  const transitions = project.transitions
  assert.equal(transitions.length, 4)
  assert.deepEqual(
    transitions.map((t) => `${t.version}:${t.from || '-'}->${t.to}`),
    ['1:-->draft', '1:draft->reviewed', '1:reviewed->published', '2:published->draft'],
  )
  assert.equal(transitions[transitions.length - 1].via, pid)
})

// ─── 完整生命周期 replay（真实使用序列）──────────────────────────────────

test('replay：用户写项目 → 登记 → AI 提案 → accept → review → publish → 再提案 → draft(v3) 全链', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-porv-'))
  const ws = initWorkspace(root)

  // 1. 用户写事实（暂存文件，无系统身份）
  ws.write(
    'portfolio/projects/自动化夹具.md',
    `# 自动化夹具设计项目

## 项目事实

| id | statement | type | evidence |
|----|-----------|------|----------|
| pf_001 | ${BASE_STATEMENT} | engineering_work | ${DESIGN_ID} |

## 证据资产

| id | type | location | metadata |
|----|------|----------|----------|
| ${DESIGN_ID} | design | figma/project-x/design.pdf | 时间=2026-03 |
`,
  )
  assert.equal(registerPortfolioProjectFile(ws, '自动化夹具.md', NOW), true)
  const projectId = scanPortfolioProjects(ws)[0].record.id

  // 2. AI 提案（指向登记后的系统项目 id）
  const md = `## 提案摘要

| 字段 | 值 |
|------|-----|
| type | portfolio_proposal |
| project_id | ${projectId} |
| created_by | ai |

## 变更建议

- pf_001（type: rewrite；old: "${BASE_STATEMENT}"；new: "${REWRITE_STATEMENT}"；reason: "岗位语言升级"）
`
  ws.write('portfolio/proposals/v1.md', md)
  assert.equal(registerPortfolioProposalFile(ws, 'v1.md', NOW), true)
  const pid = scanPortfolioProposals(ws)[0].record.id

  // 3. accept → v2 draft
  acceptPortfolioProposal(ws, pid, undefined, NOW)
  assert.equal(scanPortfolioProjects(ws)[0].record.version, 2)

  // 4. review → publish
  transitionPortfolioProject(ws, projectId, 'reviewed', NOW)
  transitionPortfolioProject(ws, projectId, 'published', NOW)
  assert.equal(scanPortfolioProjects(ws)[0].record.status, 'published')

  // 5. 再提案 → draft(v3)（immutable published）
  ws.write(
    'portfolio/proposals/v2.md',
    `## 提案摘要

| 字段 | 值 |
|------|-----|
| type | portfolio_proposal |
| project_id | ${projectId} |
| created_by | ai |

## 变更建议

- pf_001（type: rewrite；old: "${REWRITE_STATEMENT}"；new: "主导自动化夹具设计并验证"；reason: "职责升级"）
`,
  )
  assert.equal(registerPortfolioProposalFile(ws, 'v2.md', NOW), true)
  const pid2 = scanPortfolioProposals(ws).find((p) => p.record.id !== pid)!.record.id
  const { project } = acceptPortfolioProposal(ws, pid2, undefined, NOW)
  assert.equal(project.version, 3)
  assert.equal(project.status, 'draft')
  assert.equal(project.factItems[0].statement, '主导自动化夹具设计并验证')

  // 6. 投影：完整演化链可见（append-only，无覆盖）
  const ctx = buildPortfolioContext(ws)
  assert.equal(ctx.projects.length, 1)
  const v = ctx.projects[0]
  assert.equal(v.transitions.length, 5)
  assert.deepEqual(v.transitions.map((t) => `${t.version}:${t.from || '-'}->${t.to}`), [
    '1:-->draft',
    '2:draft->draft',
    '2:draft->reviewed',
    '2:reviewed->published',
    '3:published->draft',
  ])
  // 提案决策历史完整（append-only 决策记录）
  const decided = scanPortfolioProposals(ws).map((p) => p.record.status).sort()
  assert.deepEqual(decided, ['accepted', 'accepted'])
})
