/**
 * portfolio-watcher 单测（M4-1.2）：roundtrip / P-01~P-07 验证规则 /
 * 登记（invalid 不登记）/ 状态机（单向，published 不可回退）/ apply 全链
 * （immutable published + version+1 + transitions via + 确定性）/ projection。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  PortfolioProject,
  PortfolioProposal,
  PortfolioProposalChange,
} from '../ir/portfolio.ts'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import {
  parseProjectMarkdown,
  serializePortfolioProject,
  parsePortfolioProposal,
  serializePortfolioProposal,
  validatePortfolioProposal,
  scanPortfolioProjects,
  scanPortfolioProposals,
  registerPortfolioProjectFile,
  registerPortfolioProposalFile,
  transitionPortfolioProject,
  acceptPortfolioProposal,
  rejectPortfolioProposal,
  buildPortfolioContext,
  PortfolioTransitionError,
} from '../storage/portfolio-watcher.ts'

// ─── 固定 fixture ─────────────────────────────────────────────────────────

const PROJECT_ID = 'project_20260805_00001'
const PP_ID = 'pp_20260805_00001'
const OLD = '完成自动化夹具设计'
const NEW = '完成自动化夹具设计并负责验证夹具可靠性'
const NOW = new Date('2026-08-05T10:00:00Z')

function project(overrides: Partial<PortfolioProject> = {}): PortfolioProject {
  return {
    id: PROJECT_ID,
    status: 'draft',
    version: 1,
    factItems: [{ id: 'pf_001', statement: OLD, type: 'engineering_work', evidenceRefs: ['design_001'] }],
    evidence: [{ id: 'design_001', type: 'design', location: 'figma/project-x/design.pdf', metadata: { 时间: '2026-03' } }],
    transitions: [{ version: 1, from: '', to: 'draft', at: '2026-08-05T10:00:00Z' }],
    createdAt: '2026-08-05',
    sourceFile: '夹具设计',
    ...overrides,
  }
}

function change(overrides: Partial<PortfolioProposalChange> = {}): PortfolioProposalChange {
  return { type: 'rewrite', factId: 'pf_001', old: OLD, new: NEW, reason: '目标岗位强调验证能力', ...overrides }
}

function pp(overrides: Partial<PortfolioProposal> = {}): PortfolioProposal {
  return { id: PP_ID, projectId: PROJECT_ID, changes: [change()], status: 'pending', createdBy: 'ai', ...overrides }
}

/** 用户写入的项目暂存文件（无 frontmatter、无 status/version——引擎单方管理） */
const RAW_PROJECT_MD = `# 自动化夹具设计项目

## 项目事实

| id | statement | type | evidence |
|----|-----------|------|----------|
| pf_001 | ${OLD} | engineering_work | design_001 |

## 证据资产

| id | type | location | metadata |
|----|------|----------|----------|
| design_001 | design | figma/project-x/design.pdf | 时间=2026-03 |
`

/** AI 写入的提案暂存文件（无 status 行——引擎登记时写回 pending） */
const PP_RAW_MD = `## 提案摘要

| 字段 | 值 |
|------|-----|
| type | portfolio_proposal |
| project_id | ${PROJECT_ID} |
| created_by | ai |

## 变更建议

- pf_001（type: rewrite；old: "${OLD}"；new: "${NEW}"；reason: "目标岗位强调验证能力"）
`

function setupWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'cos-portfolio-'))
  const ws = initWorkspace(root)
  ws.write(`portfolio/projects/${PROJECT_ID}.md`, serializePortfolioProject(project()))
  return ws
}

/** 以已登记格式写入提案（scan 判定 status 行存在 → 文件快照） */
function registerProposal(ws: Workspace, p: PortfolioProposal = pp()): string {
  ws.write(`portfolio/proposals/${p.id}.md`, serializePortfolioProposal(p))
  return p.id
}

// ─── roundtrip ───────────────────────────────────────────────────────────

test('roundtrip：serializePortfolioProject → parse 还原全部字段（含 metadata 与 via 演化记录）', () => {
  const p = project({
    version: 2,
    status: 'draft',
    transitions: [
      { version: 1, from: '', to: 'draft', at: '2026-08-05T10:00:00Z' },
      { version: 1, from: 'draft', to: 'published', at: '2026-08-05T11:00:00Z' },
      { version: 2, from: 'published', to: 'draft', at: '2026-08-05T12:00:00Z', via: 'pp_20260805_00001' },
    ],
  })
  const parsed = parseProjectMarkdown(serializePortfolioProject(p), `${p.id}.md`)
  assert.deepEqual(parsed.record, p)
})

test('roundtrip：serializePortfolioProposal → parse 还原全部字段（句子含 ；：与引号保护）', () => {
  const p = pp({
    status: 'accepted',
    decidedAt: '2026-08-05T11:00:00Z',
    acceptReason: '表达更契合岗位语言',
    resultVersion: 3,
    validation: { status: 'warning', issues: [{ code: 'P-06', message: 'reason 为空', target: 'pf_001' }] },
    changes: [{ ...change(), new: '主导机架设计；完成验证（实测）：并输出报告' }],
  })
  const parsed = parsePortfolioProposal(serializePortfolioProposal(p), `${p.id}.md`)
  assert.deepEqual(parsed.record, p)
})

test('parse：非法 status/证据类型/版本 → issues warn（降级不崩）；变更行非法 type → warn', () => {
  const md = serializePortfolioProject(project())
    .replace('> status: draft', '> status: nope')
    .replace('| design_001 | design |', '| design_001 | video |')
  const parsed = parseProjectMarkdown(md, 'p.md')
  assert.equal(parsed.record.status, 'draft') // 降级默认
  assert.equal(parsed.record.evidence[0].type, 'video') // 值域非法保留原值
  assert.ok(parsed.issues.some((i) => i.reason.includes('非法状态')))
  assert.ok(parsed.issues.some((i) => i.reason.includes('非法证据类型')))

  const pmd = serializePortfolioProposal(pp()).replace('type: rewrite', 'type: nope')
  const ppParsed = parsePortfolioProposal(pmd, 'p.md')
  assert.equal(ppParsed.record.changes[0].type, 'rewrite') // 降级默认
  assert.ok(ppParsed.issues.some((i) => i.reason.includes('非法变更类型')))
})

// ─── 项目登记 ────────────────────────────────────────────────────────────

test('registerPortfolioProjectFile：暂存 → 系统 ID + draft/v1 + 演化记录首行；幂等', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-portfolio-'))
  const ws = initWorkspace(root)
  ws.write('portfolio/projects/夹具设计.md', RAW_PROJECT_MD)
  assert.equal(registerPortfolioProjectFile(ws, '夹具设计.md', NOW), true)
  assert.ok(!ws.exists('portfolio/projects/夹具设计.md'))
  const projects = scanPortfolioProjects(ws)
  assert.equal(projects.length, 1)
  const p = projects[0].record
  assert.match(p.id, /^project_20260805_\d{5}$/)
  assert.equal(p.status, 'draft') // status/version 引擎初始化
  assert.equal(p.version, 1)
  assert.equal(p.sourceFile, '夹具设计')
  assert.equal(p.factItems.length, 1)
  assert.equal(p.factItems[0].statement, OLD)
  assert.equal(p.evidence[0].metadata?.['时间'], '2026-03')
  assert.equal(p.transitions.length, 1)
  assert.equal(p.transitions[0].to, 'draft')
  assert.equal(registerPortfolioProjectFile(ws, `${p.id}.md`, NOW), false) // 已登记
})

test('registerPortfolioProjectFile：无事实行不登记（文件保留）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-portfolio-'))
  const ws = initWorkspace(root)
  ws.write(
    'portfolio/projects/空项目.md',
    '# 空项目\n\n## 项目事实\n\n| id | statement | type | evidence |\n|----|-----------|------|----------|\n',
  )
  assert.equal(registerPortfolioProjectFile(ws, '空项目.md', NOW), false)
  assert.ok(ws.exists('portfolio/projects/空项目.md'))
})

// ─── 验证规则（P-01~P-07 全覆盖）──────────────────────────────────────────

test('validatePortfolioProposal：合法提案 → valid；P-01~P-05 → invalid，P-06/P-07 → warning', () => {
  const proj = setupWorkspace()
  const p = scanPortfolioProjects(proj)[0].record
  assert.equal(validatePortfolioProposal(pp(), p).status, 'valid')

  const p01 = validatePortfolioProposal(pp(), undefined)
  assert.equal(p01.status, 'invalid')
  assert.ok(p01.issues.some((i) => i.code === 'P-01'))

  const noChanges = validatePortfolioProposal(pp({ changes: [] }), p)
  assert.equal(noChanges.status, 'invalid')
  assert.ok(noChanges.issues.some((i) => i.code === 'NO_CHANGES'))

  const p02 = validatePortfolioProposal(pp({ changes: [{ ...change(), factId: 'pf_999' }] }), p)
  assert.ok(p02.issues.some((i) => i.code === 'P-02'))

  const p03 = validatePortfolioProposal(pp({ changes: [{ ...change(), old: '不匹配的旧文' }] }), p)
  assert.ok(p03.issues.some((i) => i.code === 'P-03'))

  const p04 = validatePortfolioProposal(pp({ changes: [{ ...change(), new: '  ' }] }), p)
  assert.ok(p04.issues.some((i) => i.code === 'P-04'))

  const p05 = validatePortfolioProposal(pp({ changes: [{ ...change(), type: 'archive' } as unknown as PortfolioProposalChange] }), p)
  assert.ok(p05.issues.some((i) => i.code === 'P-05'))

  const warn = validatePortfolioProposal(
    pp({ changes: [{ ...change(), reason: '' }, { ...change(), reason: '' }] }),
    p,
  )
  assert.equal(warn.status, 'warning')
  assert.ok(warn.issues.some((i) => i.code === 'P-06'))
  assert.ok(warn.issues.some((i) => i.code === 'P-07'))
})

test('validatePortfolioProposal：P-03 old 匹配做空格标准化（空白差异不判漂移）', () => {
  const p = scanPortfolioProjects(setupWorkspace())[0].record
  const spaced = OLD.replace(' ', '  ')
  assert.equal(validatePortfolioProposal(pp({ changes: [{ ...change(), old: spaced }] }), p).status, 'valid')
})

// ─── 提案登记 ────────────────────────────────────────────────────────────

test('registerPortfolioProposalFile：valid 登记 + 引擎字段写回（status=pending）；invalid 不登记', () => {
  const ws = setupWorkspace()
  ws.write('portfolio/proposals/改写夹具.md', PP_RAW_MD)
  assert.equal(registerPortfolioProposalFile(ws, '改写夹具.md', NOW), true)
  assert.ok(!ws.exists('portfolio/proposals/改写夹具.md'))
  const proposals = scanPortfolioProposals(ws)
  assert.equal(proposals.length, 1)
  const p = proposals[0].record
  assert.match(p.id, /^pp_20260805_\d{5}$/)
  assert.equal(p.status, 'pending')
  assert.equal(p.projectId, PROJECT_ID)
  assert.equal(p.createdBy, 'ai')
  assert.equal(p.validation?.status, 'valid')
  assert.equal(registerPortfolioProposalFile(ws, `${p.id}.md`, NOW), false) // 已登记
})

test('registerPortfolioProposalFile：P-01 项目不存在 → invalid 不登记（文件保留）', () => {
  const ws = setupWorkspace()
  ws.write('portfolio/proposals/孤儿提案.md', PP_RAW_MD.replace(PROJECT_ID, 'project_20990101_99999'))
  assert.equal(registerPortfolioProposalFile(ws, '孤儿提案.md', NOW), false)
  assert.ok(ws.exists('portfolio/proposals/孤儿提案.md'))
})

test('scan：未登记提案实时校验（P-02 factId 不存在）', () => {
  const ws = setupWorkspace()
  ws.write('portfolio/proposals/错误事实.md', PP_RAW_MD.replace('pf_001', 'pf_999'))
  const [p] = scanPortfolioProposals(ws)
  assert.equal(p.record.validation?.status, 'invalid')
  assert.ok(p.record.validation?.issues.some((i) => i.code === 'P-02'))
})

// ─── 状态机（单向；published 不可回退）────────────────────────────────────

test('transition：draft→reviewed→published；reviewed→draft 打回；published 无出口；version 不变', () => {
  const ws = setupWorkspace()
  assert.equal(transitionPortfolioProject(ws, PROJECT_ID, 'reviewed', NOW).status, 'reviewed')
  const bounced = transitionPortfolioProject(ws, PROJECT_ID, 'draft', NOW) // review 打回
  assert.equal(bounced.status, 'draft')
  assert.equal(bounced.version, 1) // transition 不改内容版本
  transitionPortfolioProject(ws, PROJECT_ID, 'reviewed', NOW)
  const published = transitionPortfolioProject(ws, PROJECT_ID, 'published', NOW)
  assert.equal(published.status, 'published')
  assert.throws(() => transitionPortfolioProject(ws, PROJECT_ID, 'draft', NOW), PortfolioTransitionError)
  assert.throws(() => transitionPortfolioProject(ws, PROJECT_ID, 'reviewed', NOW), PortfolioTransitionError)
  assert.equal(scanPortfolioProjects(ws)[0].record.status, 'published') // 状态不变
})

// ─── 决策（accept → apply / reject）──────────────────────────────────────

test('accept：apply 确定性（statement 改写 + version+1 + status=draft + transitions via + resultVersion + evidenceRefs 不变量）', () => {
  const ws = setupWorkspace()
  const pid = registerProposal(ws)
  const { project: p, proposal } = acceptPortfolioProposal(ws, pid, '表达更契合岗位语言', NOW)
  assert.equal(p.version, 2)
  assert.equal(p.status, 'draft')
  assert.equal(p.factItems[0].statement, NEW)
  assert.deepEqual(p.factItems[0].evidenceRefs, ['design_001']) // 不变量未触碰
  assert.equal(p.evidence.length, 1) // Evidence 未变
  assert.equal(p.factItems.length, 1) // 未新增 FactItem
  const last = p.transitions[p.transitions.length - 1]
  assert.equal(last.version, 2)
  assert.equal(last.from, 'draft')
  assert.equal(last.to, 'draft')
  assert.equal(last.via, pid)
  assert.equal(proposal.status, 'accepted')
  assert.equal(proposal.resultVersion, 2)
  assert.equal(proposal.acceptReason, '表达更契合岗位语言')
  // 落盘可重放：scan 结果 = 函数返回值（roundtrip 一致）
  assert.deepEqual(scanPortfolioProjects(ws)[0].record, p)
  assert.equal(scanPortfolioProposals(ws)[0].record.status, 'accepted')
})

test('accept：published 项目 → draft(v+1)（immutable published——修改必须 draft(v2)）', () => {
  const ws = setupWorkspace()
  transitionPortfolioProject(ws, PROJECT_ID, 'reviewed', NOW)
  transitionPortfolioProject(ws, PROJECT_ID, 'published', NOW)
  const pid = registerProposal(ws)
  const { project: p } = acceptPortfolioProposal(ws, pid, undefined, NOW)
  assert.equal(p.status, 'draft')
  assert.equal(p.version, 2)
  const last = p.transitions[p.transitions.length - 1]
  assert.equal(last.from, 'published')
  assert.equal(last.to, 'draft')
  assert.equal(last.via, pid)
})

test('accept：old 漂移（项目已变）→ 抛错，项目与提案状态不变', () => {
  const ws = setupWorkspace()
  const pid = registerProposal(ws)
  const current = scanPortfolioProjects(ws)[0].record
  ws.write(
    `portfolio/projects/${PROJECT_ID}.md`,
    serializePortfolioProject({ ...current, factItems: [{ ...current.factItems[0], statement: '另一个版本' }] }),
  )
  assert.throws(() => acceptPortfolioProposal(ws, pid, undefined, NOW), PortfolioTransitionError)
  assert.equal(scanPortfolioProjects(ws)[0].record.version, 1) // 未应用
  assert.equal(scanPortfolioProposals(ws)[0].record.status, 'pending') // 未流转
})

test('reject：pending → rejected + reason；非 pending 双向抛错', () => {
  const ws = setupWorkspace()
  const pid = registerProposal(ws)
  const r = rejectPortfolioProposal(ws, pid, '表述太主观', NOW)
  assert.equal(r.status, 'rejected')
  assert.equal(r.rejectReason, '表述太主观')
  assert.throws(() => rejectPortfolioProposal(ws, pid, undefined, NOW), PortfolioTransitionError)
  assert.throws(() => acceptPortfolioProposal(ws, pid, undefined, NOW), PortfolioTransitionError)
})

// ─── projection ──────────────────────────────────────────────────────────

test('buildPortfolioContext：确定性（same files → same output）；未登记暂存项目保留', () => {
  const ws = setupWorkspace()
  ws.write('portfolio/projects/未登记项目.md', RAW_PROJECT_MD)
  const a = buildPortfolioContext(ws)
  const b = buildPortfolioContext(ws)
  assert.deepEqual(a, b)
  assert.equal(a.projects.length, 2) // 已登记 + 未登记暂存
  const raw = a.projects.find((x) => x.id === '未登记项目')
  assert.equal(raw?.status, 'draft')
  assert.equal(raw?.factItems.length, 1)
})
