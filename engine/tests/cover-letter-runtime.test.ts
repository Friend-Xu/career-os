/**
 * M4-3.3 Cover Letter Runtime Validation：真实工作区 replay——
 * 验证 Projection Artifact 的核心纪律：单向读取（不形成双向耦合）。
 *
 * Case A 正常读取隔离   → context 正确生成 + 源文件零变化 + 源 transition 不增加
 * Case B 源 Artifact 演化 → 源事实变化 → Cover Letter 文件不变 + context 快照变化
 *                       （显式可见，不自动同步——拒绝"自动同步文案系统"）
 * 必测项：Resolver 三态 / Proposal 边界（text pass，sourceRefs/factStatement impossible）/
 *        Isolation（context 加载后源 checksum 不变）/ Drift
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoverLetter } from '../ir/cover-letter.ts'
import type { PortfolioProject } from '../ir/portfolio.ts'
import type { InterviewQa } from '../ir/interview.ts'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { serializePortfolioProject, scanPortfolioProjects } from '../storage/portfolio-watcher.ts'
import { serializeInterviewQa, scanInterviewQas } from '../storage/interview-watcher.ts'
import {
  serializeCoverLetter,
  parseCoverLetterProposal,
  scanCoverLetters,
  scanCoverLetterProposals,
  registerCoverLetterFile,
  registerCoverLetterProposalFile,
  transitionCoverLetter,
  acceptCoverLetterProposal,
  buildCoverLetterContext,
  resolveSourceFact,
  resolveSourceRefs,
  CoverLetterTransitionError,
} from '../storage/cover-letter-watcher.ts'

// ─── fixtures ────────────────────────────────────────────────────────────

const CLAIM_ID = 'claim_20260805_00001'
const PROJECT_ID = 'project_20260805_00001'
const QA_ID = 'qa_20260805_00001'
const CL_ID = 'cl_20260805_00001'
const NOW = new Date('2026-08-05T10:00:00Z')
const CLAIM_V1 = '参与自动化设备机械设计'
const CLAIM_V2 = '参与自动化设备机械结构优化'
const UNIT_TEXT = '在自动化设备项目中积累了机械结构设计经验'

const CLAIM_MD = `---
id: ${CLAIM_ID}
---

# 机械结构设计

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | ${CLAIM_V1} |
| claim_type | fact |
| source | agent_generated |
| captured_at | 2026-08-05 |

## 证据来源

- evidence_20260805_00001
`

function portfolioProject(): PortfolioProject {
  return {
    id: PROJECT_ID,
    status: 'draft',
    version: 1,
    factItems: [{ id: 'pf_001', statement: '完成夹具结构设计', type: 'action', evidenceRefs: ['design_001'] }],
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

function baseCl(): CoverLetter {
  return {
    id: CL_ID,
    status: 'draft',
    units: [
      {
        id: 'nu_001',
        text: UNIT_TEXT,
        sourceRefs: [
          { artifact: 'resume', factId: CLAIM_ID },
          { artifact: 'portfolio', scopeId: PROJECT_ID, factId: 'pf_001' },
          { artifact: 'interview', scopeId: QA_ID, factId: 'fact_001' },
        ],
        intent: '突出机械设计能力',
      },
    ],
    transitions: [{ from: '', to: 'draft', at: '2026-08-05T10:00:00Z' }],
    createdAt: '2026-08-05',
    sourceFile: '申请-示例公司',
    deliveries: [],
  }
}

function setupWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'cos-clrv-'))
  const ws = initWorkspace(root)
  ws.write(`claims/${CLAIM_ID}.md`, CLAIM_MD)
  ws.write(`portfolio/projects/${PROJECT_ID}.md`, serializePortfolioProject(portfolioProject()))
  ws.write(`interviews/${QA_ID}.md`, serializeInterviewQa(interviewQa()))
  ws.write(`cover-letters/${CL_ID}.md`, serializeCoverLetter(baseCl()))
  return ws
}

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** 源 Artifact 文件内容 + checksum 快照（隔离断言用） */
function sourceSnapshot(ws: Workspace): Record<string, string> {
  return {
    claim: ws.read(`claims/${CLAIM_ID}.md`),
    portfolio: ws.read(`portfolio/projects/${PROJECT_ID}.md`),
    interview: ws.read(`interviews/${QA_ID}.md`),
  }
}

function proposalMd(changes: string, clId: string = CL_ID): string {
  return `## 提案摘要

| 字段 | 值 |
|------|-----|
| type | cover_letter_proposal |
| cl_id | ${clId} |
| created_by | ai |

## 变更建议

${changes}
`
}

function writeAndRegisterProposal(ws: Workspace, md: string, fileName = 'proposal-适配.md'): string {
  ws.write(`cover-letters/proposals/${fileName}`, md)
  const before = new Set(scanCoverLetterProposals(ws).map((p) => p.record.id))
  assert.equal(registerCoverLetterProposalFile(ws, fileName, NOW), true, '提案应登记成功')
  return scanCoverLetterProposals(ws).find((p) => !before.has(p.record.id))!.record.id
}

// ─── Case A：正常读取隔离 ────────────────────────────────────────────────

test('Case A 正常读取：context 生成正确 + 源文件零变化 + 源 transition 不增加（单向依赖验证）', () => {
  const ws = setupWorkspace()
  const before = sourceSnapshot(ws)
  const beforeChecksum = Object.fromEntries(Object.entries(before).map(([k, v]) => [k, checksum(v)]))
  const beforePortfolioTransitions = scanPortfolioProjects(ws)[0].record.transitions.length
  const beforeInterviewTransitions = scanInterviewQas(ws)[0].record.transitions.length

  // 读取（context 生成 + 源 refs 解析）
  const ctx = buildCoverLetterContext(ws)
  const unit = ctx.coverLetters[0].units[0]
  assert.equal(unit.sourceRefs.length, 3)
  assert.equal(unit.sourceRefs.find((r) => r.artifact === 'resume')?.factStatement, CLAIM_V1)
  assert.equal(unit.sourceRefs.find((r) => r.artifact === 'portfolio')?.factStatement, '完成夹具结构设计')
  assert.equal(unit.sourceRefs.find((r) => r.artifact === 'interview')?.factStatement, '负责视觉检测模块开发')

  // 隔离：源文件 checksum 零变化
  const after = sourceSnapshot(ws)
  for (const k of Object.keys(before)) {
    assert.equal(checksum(after[k]), beforeChecksum[k], `源文件 ${k} 必须零变化`)
  }
  // 源 transition 不增加
  assert.equal(scanPortfolioProjects(ws)[0].record.transitions.length, beforePortfolioTransitions)
  assert.equal(scanInterviewQas(ws)[0].record.transitions.length, beforeInterviewTransitions)
})

// ─── Case B：源 Artifact 演化（快照变化，不自动同步）────────────────────

test('Case B 源演化：claim v1→v2 → Cover Letter 文件不变 + context 快照更新（显式可见，非自动同步）', () => {
  const ws = setupWorkspace()
  const clBefore = ws.read(`cover-letters/${CL_ID}.md`)
  const clChecksum = checksum(clBefore)

  // 源演化：claim statement 变化（人工编辑源 Artifact）
  ws.write(`claims/${CLAIM_ID}.md`, CLAIM_MD.replace(CLAIM_V1, CLAIM_V2))

  // Cover Letter 文件零变化（不自动同步）
  assert.equal(checksum(ws.read(`cover-letters/${CL_ID}.md`)), clChecksum, 'Cover Letter 不得自动同步源变化')

  // context 重读：快照更新（源变化显式可见）
  const ctx = buildCoverLetterContext(ws)
  const resumeRef = ctx.coverLetters[0].units[0].sourceRefs.find((r) => r.artifact === 'resume')
  assert.equal(resumeRef?.factStatement, CLAIM_V2, 'context 快照应反映源 Artifact 当前状态')

  // Cover Letter 内容不变（unit.text 仍是旧叙述——用户决定是否 adapt）
  assert.equal(ctx.coverLetters[0].units[0].text, UNIT_TEXT)
})

// ─── 必测项：Resolver 三态 ───────────────────────────────────────────────

test('Resolver 三态：存在 success / 不存在 explicit error / 引用 Expression 层 reject', () => {
  const ws = setupWorkspace()
  // 存在
  assert.equal(resolveSourceFact(ws, { artifact: 'resume', factId: CLAIM_ID }), CLAIM_V1)
  // 不存在 → explicit error（missing 列表）
  const { resolved, missing } = resolveSourceRefs(ws, [{ artifact: 'resume', factId: 'claim_20990101_99999' }])
  assert.equal(resolved.length, 0)
  assert.equal(missing.length, 1)
  // 引用 Expression 层（bullet/answer 不是 claim/fact id）→ 找不到 → reject
  const exprRef = resolveSourceFact(ws, { artifact: 'resume', factId: 'bullet_001' })
  assert.equal(exprRef, undefined)
  const interviewExpr = resolveSourceFact(ws, { artifact: 'interview', scopeId: QA_ID, factId: 'ans_001' })
  assert.equal(interviewExpr, undefined, '引用 answer statement（Expression 层）必须解析失败')
})

// ─── 必测项：Proposal 边界（adapt only text）────────────────────────────

test('Proposal 边界：修改 text → pass；走私 sourceRefs/factStatement → parse 忽略（impossible）', () => {
  const ws = setupWorkspace()
  // text 修改 → pass
  const pid = writeAndRegisterProposal(
    ws,
    proposalMd(`- nu_001（type: adapt；old: "${UNIT_TEXT}"；new: "在自动化设备项目中主导机械结构设计"；reason: "目标岗位强调主导能力"）`),
  )
  const { coverLetter: c } = acceptCoverLetterProposal(ws, pid, undefined, NOW)
  assert.equal(c.units[0].text, '在自动化设备项目中主导机械结构设计')
  assert.deepEqual(c.units[0].sourceRefs, baseCl().units[0].sourceRefs) // 引用不变量

  // 走私 sourceRefs / factStatement → parse 忽略（schema 无通道）
  const smuggled = proposalMd(
    `- nu_001（type: adapt；sourceRefs: "portfolio.${PROJECT_ID}.pf_999"；factStatement: "编造的事实"；old: "在自动化设备项目中主导机械结构设计"；new: "改写"；reason: "偷换引用"）`,
  )
  const parsed = parseCoverLetterProposal(smuggled, 'smuggled.md')
  assert.equal(parsed.record.changes[0].unitId, 'nu_001')
  assert.equal('sourceRefs' in parsed.record.changes[0], false, '解析结果不应含 sourceRefs')
  assert.equal('factStatement' in parsed.record.changes[0], false, '解析结果不应含 factStatement')
  assert.equal(parsed.record.changes[0].new, '改写')
})

// ─── 必测项：Drift（源事实变化后的决策路径）──────────────────────────────

test('Drift：源 fact 变化 → 旧 proposal 的 old 仍匹配（表达层未变）→ 可应用；引用解析反映新事实', () => {
  const ws = setupWorkspace()
  // 源演化（portfolio fact 变化）
  const project = scanPortfolioProjects(ws)[0].record
  ws.write(
    `portfolio/projects/${PROJECT_ID}.md`,
    serializePortfolioProject({ ...project, factItems: [{ ...project.factItems[0], statement: '主导夹具结构设计' }] }),
  )
  // Cover Letter 表达未变 → old 匹配 → proposal 可正常应用（adapt 只触碰表达层）
  const pid = writeAndRegisterProposal(
    ws,
    proposalMd(`- nu_001（type: adapt；old: "${UNIT_TEXT}"；new: "主导夹具验证并输出测试报告"；reason: "突出验证能力"）`),
  )
  const { coverLetter: c } = acceptCoverLetterProposal(ws, pid, undefined, NOW)
  assert.equal(c.units[0].text, '主导夹具验证并输出测试报告')
  // context 快照反映源新事实
  const ctx = buildCoverLetterContext(ws)
  assert.equal(ctx.coverLetters[0].units[0].sourceRefs.find((r) => r.artifact === 'portfolio')?.factStatement, '主导夹具结构设计')
})

// ─── 完整生命周期 replay ─────────────────────────────────────────────────

test('replay：登记 → 提案 → accept → review → ready → 投递记录 → 再提案 → draft 全链', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-clrv-'))
  const ws = initWorkspace(root)
  ws.write(`claims/${CLAIM_ID}.md`, CLAIM_MD)
  ws.write(`portfolio/projects/${PROJECT_ID}.md`, serializePortfolioProject(portfolioProject()))

  // 1. 用户写求职信（暂存）
  ws.write(
    'cover-letters/申请-示例公司.md',
    `# 申请-示例公司

## 叙述单元

- nu_001（text: "${UNIT_TEXT}"；refs: resume.${CLAIM_ID}, portfolio.${PROJECT_ID}.pf_001）
`,
  )
  assert.equal(registerCoverLetterFile(ws, '申请-示例公司.md', NOW), true)
  const clId = scanCoverLetters(ws)[0].record.id

  // 2. AI 提案 → accept → v2 draft
  const md = proposalMd(`- nu_001（type: adapt；old: "${UNIT_TEXT}"；new: "主导机械结构设计并验证"；reason: "岗位语言升级"）`, clId)
  ws.write('cover-letters/proposals/v1.md', md)
  assert.equal(registerCoverLetterProposalFile(ws, 'v1.md', NOW), true)
  const pid = scanCoverLetterProposals(ws)[0].record.id
  acceptCoverLetterProposal(ws, pid, undefined, NOW)
  assert.equal(scanCoverLetters(ws)[0].record.units[0].text, '主导机械结构设计并验证')

  // 3. review → ready
  transitionCoverLetter(ws, clId, 'reviewed', NOW)
  transitionCoverLetter(ws, clId, 'ready', NOW)
  assert.equal(scanCoverLetters(ws)[0].record.status, 'ready')

  // 4. 投递记录（append-only，不改变 status）
  const current = scanCoverLetters(ws)[0].record
  ws.write(
    `cover-letters/${clId}.md`,
    serializeCoverLetter({
      ...current,
      deliveries: [...current.deliveries, { targetCompany: '示例公司', targetJobId: 'job_20260805_00001', at: '2026-08-06T10:00:00Z' }],
    }),
  )
  const afterDelivery = scanCoverLetters(ws)[0].record
  assert.equal(afterDelivery.status, 'ready', '投递不改变状态机')
  assert.equal(afterDelivery.deliveries.length, 1)

  // 5. 再提案 → draft（ready 修改必须新演化事件）
  const md2 = proposalMd(`- nu_001（type: adapt；old: "主导机械结构设计并验证"；new: "主导机械结构设计与夹具验证"；reason: "补充分工细节"）`, clId)
  ws.write('cover-letters/proposals/v2.md', md2)
  assert.equal(registerCoverLetterProposalFile(ws, 'v2.md', NOW), true)
  const pid2 = scanCoverLetterProposals(ws).find((p) => p.record.id !== pid)!.record.id
  const { coverLetter: c2 } = acceptCoverLetterProposal(ws, pid2, undefined, NOW)
  assert.equal(c2.status, 'draft')
  assert.equal(c2.units[0].text, '主导机械结构设计与夹具验证')

  // 6. 演化链 append-only（初始 → 提案 → review → ready → 提案）
  assert.deepEqual(
    c2.transitions.map((t) => `${t.from || '-'}->${t.to}${t.via ? `:${t.via}` : ''}`),
    ['-->draft', `draft->draft:${pid}`, 'draft->reviewed', 'reviewed->ready', `ready->draft:${pid2}`],
  )
})

// ─── M4-3.3 四类 Runtime Validation ──────────────────────────────────────

test('M4-3.3 Reference Integrity：断链 → 显式 invalid（不静默）；accept 拒绝；修复引用 → 恢复 valid', () => {
  const ws = setupWorkspace()
  const pid = writeAndRegisterProposal(
    ws,
    proposalMd(`- nu_001（type: adapt；old: "${UNIT_TEXT}"；new: "主导机械结构设计"；reason: "岗位语言升级"）`),
  )

  // 断源：删除 claim → context 重建后引用显式失效（无 factStatement，非静默 fallback）
  ws.delete(`claims/${CLAIM_ID}.md`)
  const ctx = buildCoverLetterContext(ws)
  const resumeRef = ctx.coverLetters[0].units[0].sourceRefs.find((r) => r.artifact === 'resume')
  assert.equal(resumeRef?.factStatement, undefined, '断链必须显式可见')
  assert.equal('factStatement' in (resumeRef ?? {}), false)

  // 已登记提案 accept → CL-01 拒绝（状态不变）
  assert.throws(() => acceptCoverLetterProposal(ws, pid, undefined, NOW), CoverLetterTransitionError)
  assert.equal(scanCoverLetterProposals(ws)[0].record.status, 'pending')

  // 修复：改写 unit 引用为存在的事实 → 新提案 valid → accept 成功
  const current = scanCoverLetters(ws)[0].record
  ws.write(
    `cover-letters/${CL_ID}.md`,
    serializeCoverLetter({
      ...current,
      units: [{ ...current.units[0], sourceRefs: [{ artifact: 'portfolio', scopeId: PROJECT_ID, factId: 'pf_001' }] }],
    }),
  )
  const pid2 = writeAndRegisterProposal(
    ws,
    proposalMd(`- nu_001（type: adapt；old: "${UNIT_TEXT}"；new: "完成夹具结构验证"；reason: "修复引用后适配"）`),
    'proposal-修复.md',
  )
  assert.equal(scanCoverLetterProposals(ws).find((p) => p.record.id === pid2)?.record.validation?.status, 'valid')
  const { coverLetter } = acceptCoverLetterProposal(ws, pid2, undefined, NOW)
  assert.equal(coverLetter.units[0].text, '完成夹具结构验证')
})

test('M4-3.3 Cross Artifact Isolation：accept 提案后三源 Artifact 文件零变化（决策不写回源）', () => {
  const ws = setupWorkspace()
  const before = sourceSnapshot(ws)
  const beforeChecksum = Object.fromEntries(Object.entries(before).map(([k, v]) => [k, checksum(v)]))

  const pid = writeAndRegisterProposal(
    ws,
    proposalMd(`- nu_001（type: adapt；old: "${UNIT_TEXT}"；new: "主导机械结构设计"；reason: "岗位语言升级"）`),
  )
  acceptCoverLetterProposal(ws, pid, undefined, NOW)

  const after = sourceSnapshot(ws)
  for (const k of Object.keys(before)) {
    assert.equal(checksum(after[k]), beforeChecksum[k], `accept 后源文件 ${k} 必须零变化`)
  }
  // 源 transition 不增加
  assert.equal(scanPortfolioProjects(ws)[0].record.transitions.length, 1)
  assert.equal(scanInterviewQas(ws)[0].record.transitions.length, 1)
})

test('M4-3.3 Adapt Boundary：参与→负责（无证据升级）→ Runner PASS（语义归人审 + Benchmark debt）', () => {
  const ws = setupWorkspace()
  // claim 只支持"参与自动化设备机械设计"——"负责自动化夹具总体设计"是无证据升级
  const pid = writeAndRegisterProposal(
    ws,
    proposalMd(`- nu_001（type: adapt；old: "${UNIT_TEXT}"；new: "在自动化设备项目中负责自动化夹具总体设计"；reason: "岗位要求总体设计能力"）`),
  )
  // 引擎结构校验全过（CL-01~CL-07 不判语义——Boundary-3 纪律）→ accept 成功
  assert.equal(scanCoverLetterProposals(ws)[0].record.validation?.status, 'valid')
  const { coverLetter } = acceptCoverLetterProposal(ws, pid, undefined, NOW)
  assert.equal(coverLetter.units[0].text, '在自动化设备项目中负责自动化夹具总体设计')

  // 纪律：Cross Artifact Narrative Drift（M5 Benchmark 候选）——引擎不 judge；
  // 事实真相仍在源 Artifact（claim 仍为"参与"），Cover Letter 是表达层
  assert.equal(resolveSourceFact(ws, { artifact: 'resume', factId: CLAIM_ID }), CLAIM_V1)
})

test('M4-3.3 Replay：源演化 → context refresh → 新 adapt 全链', () => {
  const ws = setupWorkspace()

  // 1. 初始提案 accept → draft
  const pid = writeAndRegisterProposal(
    ws,
    proposalMd(`- nu_001（type: adapt；old: "${UNIT_TEXT}"；new: "主导机械结构设计"；reason: "岗位语言升级"）`),
  )
  acceptCoverLetterProposal(ws, pid, undefined, NOW)

  // 2. review → ready → delivery（手写投递记录，不改变状态机）
  transitionCoverLetter(ws, CL_ID, 'reviewed', NOW)
  transitionCoverLetter(ws, CL_ID, 'ready', NOW)
  const current = scanCoverLetters(ws)[0].record
  ws.write(
    `cover-letters/${CL_ID}.md`,
    serializeCoverLetter({ ...current, deliveries: [...current.deliveries, { targetCompany: '示例公司', at: '2026-08-06T10:00:00Z' }] }),
  )
  assert.equal(scanCoverLetters(ws)[0].record.status, 'ready')

  // 3. 源演化（claim v1→v2）
  ws.write(`claims/${CLAIM_ID}.md`, CLAIM_MD.replace(CLAIM_V1, CLAIM_V2))

  // 4. context refresh：快照反映新事实（Cover Letter 文件不自动变）
  const ctx = buildCoverLetterContext(ws)
  assert.equal(ctx.coverLetters[0].units[0].sourceRefs.find((r) => r.artifact === 'resume')?.factStatement, CLAIM_V2)

  // 5. 新 adapt（ready → draft 演化事件，基于新事实的叙述）
  const pid2 = writeAndRegisterProposal(
    ws,
    proposalMd(`- nu_001（type: adapt；old: "主导机械结构设计"；new: "主导机械结构优化并验证"；reason: "基于新事实的适配"）`),
    'proposal-v2.md',
  )
  const { coverLetter: c2 } = acceptCoverLetterProposal(ws, pid2, undefined, NOW)
  assert.equal(c2.status, 'draft')
  assert.equal(c2.units[0].text, '主导机械结构优化并验证')

  // 演化链完整：初始 → 提案 → review → ready → 提案（delivery 不入链）
  assert.deepEqual(
    c2.transitions.map((t) => `${t.from || '-'}->${t.to}${t.via ? `:${t.via}` : ''}`),
    ['-->draft', `draft->draft:${pid}`, 'draft->reviewed', 'reviewed->ready', `ready->draft:${pid2}`],
  )
})
