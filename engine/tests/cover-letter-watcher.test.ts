/**
 * cover-letter-watcher 单测（M4-3.2）：roundtrip / CL-01~CL-08 验证规则 /
 * 登记 / 状态机（单向，ready 不可回退）/ apply 全链（adapt only text +
 * sourceRefs/intent 不变量）/ Source Fact Resolver 三态 / projection。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoverLetter, CoverLetterProposal, CoverLetterProposalChange } from '../ir/cover-letter.ts'
import type { PortfolioProject } from '../ir/portfolio.ts'
import type { InterviewQa } from '../ir/interview.ts'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { serializePortfolioProject } from '../storage/portfolio-watcher.ts'
import { serializeInterviewQa } from '../storage/interview-watcher.ts'
import {
  parseCoverLetterMarkdown,
  serializeCoverLetter,
  parseCoverLetterProposal,
  serializeCoverLetterProposal,
  validateCoverLetterProposal,
  resolveSourceFact,
  resolveSourceRefs,
  scanCoverLetters,
  scanCoverLetterProposals,
  registerCoverLetterFile,
  registerCoverLetterProposalFile,
  transitionCoverLetter,
  acceptCoverLetterProposal,
  rejectCoverLetterProposal,
  buildCoverLetterContext,
  CoverLetterTransitionError,
} from '../storage/cover-letter-watcher.ts'

// ─── 固定 fixture ─────────────────────────────────────────────────────────

const CLAIM_ID = 'claim_20260805_00001'
const PROJECT_ID = 'project_20260805_00001'
const QA_ID = 'qa_20260805_00001'
const CL_ID = 'cl_20260805_00001'
const CLP_ID = 'clp_20260805_00001'
const CLAIM_STATEMENT = '参与自动化设备机械设计'
const PORTFOLIO_FACT = '完成夹具结构设计'
const INTERVIEW_FACT = '负责视觉检测模块开发'
const UNIT_TEXT = '在自动化设备项目中积累了机械结构设计经验'
const UNIT_NEW = '在自动化设备项目中主导机械结构设计，完成夹具结构验证'
const NOW = new Date('2026-08-05T10:00:00Z')

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

function portfolioProject(): PortfolioProject {
  return {
    id: PROJECT_ID,
    status: 'draft',
    version: 1,
    factItems: [{ id: 'pf_001', statement: PORTFOLIO_FACT, type: 'action', evidenceRefs: ['design_001'] }],
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
    factItems: [{ id: 'fact_001', statement: INTERVIEW_FACT, type: 'action', evidenceRefs: [] }],
    evidence: [],
    answerStatements: [{ id: 'ans_001', text: '参与视觉检测模块开发', factRefs: ['fact_001'] }],
    intents: [],
    transitions: [{ from: '', to: 'draft', at: '2026-08-05T10:00:00Z' }],
    createdAt: '2026-08-05',
    sourceFile: '视觉检测',
  }
}

function cl(overrides: Partial<CoverLetter> = {}): CoverLetter {
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
    targetCompany: '示例公司',
    targetJobId: 'job_20260805_00001',
    deliveries: [{ targetCompany: '示例公司', targetJobId: 'job_20260805_00001', at: '2026-08-06T10:00:00Z' }],
    transitions: [{ from: '', to: 'draft', at: '2026-08-05T10:00:00Z' }],
    createdAt: '2026-08-05',
    sourceFile: '申请-示例公司',
    ...overrides,
  }
}

function change(overrides: Partial<CoverLetterProposalChange> = {}): CoverLetterProposalChange {
  return { type: 'adapt', unitId: 'nu_001', old: UNIT_TEXT, new: UNIT_NEW, reason: '目标岗位强调结构设计主导能力', ...overrides }
}

function proposal(overrides: Partial<CoverLetterProposal> = {}): CoverLetterProposal {
  return { id: CLP_ID, clId: CL_ID, changes: [change()], status: 'pending', createdBy: 'ai', ...overrides }
}

/** 用户写入的 Cover Letter 暂存文件（无 frontmatter、无 status 行） */
const RAW_CL_MD = `# 申请-示例公司

> target_company: 示例公司

## 叙述单元

- nu_001（text: "在自动化设备项目中积累了机械结构设计经验"；refs: resume.${CLAIM_ID}, portfolio.${PROJECT_ID}.pf_001, interview.${QA_ID}.fact_001；intent: "突出机械设计能力"）
`

/** AI 写入的提案暂存文件（无 status 行） */
const RAW_PROPOSAL_MD = `## 提案摘要

| 字段 | 值 |
|------|-----|
| type | cover_letter_proposal |
| cl_id | ${CL_ID} |
| created_by | ai |

## 变更建议

- nu_001（type: adapt；old: "${UNIT_TEXT}"；new: "${UNIT_NEW}"；reason: "目标岗位强调结构设计主导能力"）
`

function setupWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'cos-clw-'))
  const ws = initWorkspace(root)
  ws.write(`claims/${CLAIM_ID}.md`, CLAIM_MD)
  ws.write(`portfolio/projects/${PROJECT_ID}.md`, serializePortfolioProject(portfolioProject()))
  ws.write(`interviews/${QA_ID}.md`, serializeInterviewQa(interviewQa()))
  ws.write(`cover-letters/${CL_ID}.md`, serializeCoverLetter(cl()))
  return ws
}

/** 以已登记格式写入提案（scan 判定 status 行存在 → 文件快照） */
function registerProposal(ws: Workspace, p: CoverLetterProposal = proposal()): string {
  ws.write(`cover-letters/proposals/${p.id}.md`, serializeCoverLetterProposal(p))
  return p.id
}

// ─── roundtrip ───────────────────────────────────────────────────────────

test('roundtrip：serializeCoverLetter → parse 还原全部字段（scopeId refs + deliveries + intent + via）', () => {
  const c = cl({
    status: 'ready',
    transitions: [
      { from: '', to: 'draft', at: '2026-08-05T10:00:00Z' },
      { from: 'draft', to: 'reviewed', at: '2026-08-05T11:00:00Z' },
      { from: 'reviewed', to: 'ready', at: '2026-08-05T12:00:00Z' },
      { from: 'ready', to: 'draft', at: '2026-08-05T13:00:00Z', via: 'clp_20260805_00001' },
    ],
  })
  const parsed = parseCoverLetterMarkdown(serializeCoverLetter(c), `${c.id}.md`)
  assert.deepEqual(parsed.record, c)
})

test('roundtrip：serializeCoverLetterProposal → parse 还原全部字段（句子含 ；：）', () => {
  const p = proposal({
    status: 'accepted',
    decidedAt: '2026-08-05T11:00:00Z',
    acceptReason: '表达更契合岗位语言',
    validation: { status: 'warning', issues: [{ code: 'CL-06', message: 'reason 为空', target: 'nu_001' }] },
    changes: [{ ...change(), new: '主导夹具设计；完成验证（实测）：并输出报告' }],
  })
  const parsed = parseCoverLetterProposal(serializeCoverLetterProposal(p), `${p.id}.md`)
  assert.deepEqual(parsed.record, p)
})

test('parse：非法 status/源 Artifact 类型 → warn；refs 空 → error；text 空 → warn', () => {
  const md = serializeCoverLetter(cl())
    .replace('> status: draft', '> status: nope')
    .replace('resume.claim_20260805_00001', 'website.claim_20260805_00001')
  const parsed = parseCoverLetterMarkdown(md, 'c.md')
  assert.equal(parsed.record.status, 'draft') // 降级默认
  assert.ok(parsed.issues.some((i) => i.reason.includes('非法状态')))
  assert.ok(parsed.issues.some((i) => i.reason.includes('非法源 Artifact 类型')))

  const noRefs = parseCoverLetterMarkdown(serializeCoverLetter(cl({ units: [{ id: 'nu_001', text: 'x', sourceRefs: [] }] })), 'c.md')
  assert.ok(noRefs.issues.some((i) => i.severity === 'error' && i.reason.includes('无来源引用')))

  const noText = parseCoverLetterMarkdown(serializeCoverLetter(cl({ units: [{ id: 'nu_001', text: '', sourceRefs: [{ artifact: 'resume', factId: CLAIM_ID }] }] })), 'c.md')
  assert.ok(noText.issues.some((i) => i.reason.includes('unit 文本为空')))
})

// ─── 登记 ────────────────────────────────────────────────────────────────

test('registerCoverLetterFile：暂存 → 系统 ID + draft + 演化记录首行；幂等', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-clw-'))
  const ws = initWorkspace(root)
  ws.write(`claims/${CLAIM_ID}.md`, CLAIM_MD)
  ws.write(`portfolio/projects/${PROJECT_ID}.md`, serializePortfolioProject(portfolioProject()))
  ws.write(`interviews/${QA_ID}.md`, serializeInterviewQa(interviewQa()))
  ws.write('cover-letters/申请-示例公司.md', RAW_CL_MD)
  assert.equal(registerCoverLetterFile(ws, '申请-示例公司.md', NOW), true)
  assert.ok(!ws.exists('cover-letters/申请-示例公司.md'))
  const cls = scanCoverLetters(ws)
  assert.equal(cls.length, 1)
  const c = cls[0].record
  assert.match(c.id, /^cl_20260805_\d{5}$/)
  assert.equal(c.status, 'draft')
  assert.equal(c.sourceFile, '申请-示例公司')
  assert.equal(c.units.length, 1)
  assert.equal(c.units[0].sourceRefs.length, 3)
  assert.equal(c.targetCompany, '示例公司')
  assert.equal(registerCoverLetterFile(ws, `${c.id}.md`, NOW), false) // 已登记
})

test('registerCoverLetterFile：无叙述单元不登记（文件保留）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-clw-'))
  const ws = initWorkspace(root)
  ws.write('cover-letters/空信.md', '# 空\n\n## 叙述单元\n')
  assert.equal(registerCoverLetterFile(ws, '空信.md', NOW), false)
  assert.ok(ws.exists('cover-letters/空信.md'))
})

// ─── 验证规则（CL-01~CL-08 全覆盖）────────────────────────────────────────

test('validateCoverLetterProposal：合法 → valid；CL-01/CL-02/CL-03/CL-04/CL-05/CL-08 → invalid；CL-06/CL-07 → warning', () => {
  const ws = setupWorkspace()
  const c = scanCoverLetters(ws)[0].record
  assert.equal(validateCoverLetterProposal(proposal(), c, (ref) => resolveSourceFact(ws, ref)).status, 'valid')

  const cl08 = validateCoverLetterProposal(proposal(), undefined, (ref) => resolveSourceFact(ws, ref))
  assert.equal(cl08.status, 'invalid')
  assert.ok(cl08.issues.some((i) => i.code === 'CL-08'))

  const noChanges = validateCoverLetterProposal(proposal({ changes: [] }), c, (ref) => resolveSourceFact(ws, ref))
  assert.equal(noChanges.status, 'invalid')
  assert.ok(noChanges.issues.some((i) => i.code === 'NO_CHANGES'))

  // CL-01：断链（factId 不存在）
  const broken = cl({ units: [{ id: 'nu_001', text: UNIT_TEXT, sourceRefs: [{ artifact: 'resume', factId: 'claim_20990101_99999' }] }] })
  const cl01 = validateCoverLetterProposal(proposal(), broken, (ref) => resolveSourceFact(ws, ref))
  assert.ok(cl01.issues.some((i) => i.code === 'CL-01'))
  assert.equal(cl01.status, 'invalid')

  // CL-01：portfolio 缺 scopeId（局部 id 无法唯一定位）
  const noScope = cl({ units: [{ id: 'nu_001', text: UNIT_TEXT, sourceRefs: [{ artifact: 'portfolio', factId: 'pf_001' }] }] })
  const cl01b = validateCoverLetterProposal(proposal(), noScope, (ref) => resolveSourceFact(ws, ref))
  assert.ok(cl01b.issues.some((i) => i.code === 'CL-01'))

  const cl02 = validateCoverLetterProposal(proposal({ changes: [{ ...change(), unitId: 'nu_999' }] }), c, (ref) => resolveSourceFact(ws, ref))
  assert.ok(cl02.issues.some((i) => i.code === 'CL-02'))

  const cl03 = validateCoverLetterProposal(proposal({ changes: [{ ...change(), old: '不匹配的旧文' }] }), c, (ref) => resolveSourceFact(ws, ref))
  assert.ok(cl03.issues.some((i) => i.code === 'CL-03'))

  const cl04 = validateCoverLetterProposal(proposal({ changes: [{ ...change(), new: '  ' }] }), c, (ref) => resolveSourceFact(ws, ref))
  assert.ok(cl04.issues.some((i) => i.code === 'CL-04'))

  const cl05 = validateCoverLetterProposal(proposal({ changes: [{ ...change(), type: 'generate' } as unknown as CoverLetterProposalChange] }), c, (ref) => resolveSourceFact(ws, ref))
  assert.ok(cl05.issues.some((i) => i.code === 'CL-05'))

  const warn = validateCoverLetterProposal(
    proposal({ changes: [{ ...change(), reason: '' }, { ...change(), reason: '' }] }),
    c,
    (ref) => resolveSourceFact(ws, ref),
  )
  assert.equal(warn.status, 'warning')
  assert.ok(warn.issues.some((i) => i.code === 'CL-06'))
  assert.ok(warn.issues.some((i) => i.code === 'CL-07'))
})

test('validateCoverLetterProposal：CL-03 old 匹配做空格标准化', () => {
  const ws = setupWorkspace()
  const c = scanCoverLetters(ws)[0].record
  const spaced = UNIT_TEXT.replace(' ', '  ')
  assert.equal(validateCoverLetterProposal(proposal({ changes: [{ ...change(), old: spaced }] }), c, (ref) => resolveSourceFact(ws, ref)).status, 'valid')
})

// ─── Source Fact Resolver 三态 ───────────────────────────────────────────

test('resolveSourceFact：resume/portfolio/interview 三源存在 → success；缺 scopeId / 不存在 → undefined', () => {
  const ws = setupWorkspace()
  assert.equal(resolveSourceFact(ws, { artifact: 'resume', factId: CLAIM_ID }), CLAIM_STATEMENT)
  assert.equal(resolveSourceFact(ws, { artifact: 'portfolio', scopeId: PROJECT_ID, factId: 'pf_001' }), PORTFOLIO_FACT)
  assert.equal(resolveSourceFact(ws, { artifact: 'interview', scopeId: QA_ID, factId: 'fact_001' }), INTERVIEW_FACT)
  // 缺 scopeId → 无法唯一定位
  assert.equal(resolveSourceFact(ws, { artifact: 'portfolio', factId: 'pf_001' }), undefined)
  // 不存在 → 断链
  assert.equal(resolveSourceFact(ws, { artifact: 'resume', factId: 'claim_20990101_99999' }), undefined)
  assert.equal(resolveSourceFact(ws, { artifact: 'portfolio', scopeId: PROJECT_ID, factId: 'pf_999' }), undefined)
  // 引用 Expression 层（bullet 不是 claim/fact id）→ 找不到
  assert.equal(resolveSourceFact(ws, { artifact: 'resume', factId: 'ans_001' }), undefined)
})

test('resolveSourceRefs：成功快照 + 缺失列表聚合', () => {
  const ws = setupWorkspace()
  const { resolved, missing } = resolveSourceRefs(ws, [
    { artifact: 'resume', factId: CLAIM_ID },
    { artifact: 'portfolio', scopeId: PROJECT_ID, factId: 'pf_999' },
  ])
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].factStatement, CLAIM_STATEMENT)
  assert.equal(missing.length, 1)
  assert.equal(missing[0].factId, 'pf_999')
})

// ─── 提案登记 ────────────────────────────────────────────────────────────

test('registerCoverLetterProposalFile：valid 登记 + 引擎字段写回；CL-08 不登记', () => {
  const ws = setupWorkspace()
  ws.write('cover-letters/proposals/优化叙述.md', RAW_PROPOSAL_MD)
  assert.equal(registerCoverLetterProposalFile(ws, '优化叙述.md', NOW), true)
  assert.ok(!ws.exists('cover-letters/proposals/优化叙述.md'))
  const proposals = scanCoverLetterProposals(ws)
  assert.equal(proposals.length, 1)
  const p = proposals[0].record
  assert.match(p.id, /^clp_20260805_\d{5}$/)
  assert.equal(p.status, 'pending')
  assert.equal(p.clId, CL_ID)
  assert.equal(p.validation?.status, 'valid')
  assert.equal(registerCoverLetterProposalFile(ws, `${p.id}.md`, NOW), false) // 已登记

  const root = mkdtempSync(join(tmpdir(), 'cos-clw-'))
  const ws2 = initWorkspace(root)
  ws2.write('cover-letters/proposals/孤儿.md', RAW_PROPOSAL_MD.replace(CL_ID, 'cl_20990101_99999'))
  assert.equal(registerCoverLetterProposalFile(ws2, '孤儿.md', NOW), false)
  assert.ok(ws2.exists('cover-letters/proposals/孤儿.md'))
})

test('scan：未登记提案实时校验（CL-01 断链——unit 引用不存在的事实）', () => {
  const ws = setupWorkspace()
  ws.write('cover-letters/proposals/断链.md', RAW_PROPOSAL_MD)
  // 断源：claim 被删除 → unit 引用失效 → 提案 invalid
  ws.delete(`claims/${CLAIM_ID}.md`)
  const [p] = scanCoverLetterProposals(ws)
  assert.equal(p.record.validation?.status, 'invalid')
  assert.ok(p.record.validation?.issues.some((i) => i.code === 'CL-01'))
})

// ─── 状态机（单向；ready 不可回退）────────────────────────────────────────

test('transition：draft→reviewed→ready；reviewed→draft 打回；ready 无出口', () => {
  const ws = setupWorkspace()
  assert.equal(transitionCoverLetter(ws, CL_ID, 'reviewed', NOW).status, 'reviewed')
  assert.equal(transitionCoverLetter(ws, CL_ID, 'draft', NOW).status, 'draft') // review 打回
  transitionCoverLetter(ws, CL_ID, 'reviewed', NOW)
  const ready = transitionCoverLetter(ws, CL_ID, 'ready', NOW)
  assert.equal(ready.status, 'ready')
  assert.throws(() => transitionCoverLetter(ws, CL_ID, 'draft', NOW), CoverLetterTransitionError)
  assert.throws(() => transitionCoverLetter(ws, CL_ID, 'reviewed', NOW), CoverLetterTransitionError)
  assert.equal(scanCoverLetters(ws)[0].record.status, 'ready') // 状态不变
})

// ─── 决策（accept → apply / reject）──────────────────────────────────────

test('accept：apply 确定性（text 改写 + status=draft + transitions via + sourceRefs/intent/deliveries 不变量）', () => {
  const ws = setupWorkspace()
  const pid = registerProposal(ws)
  const { coverLetter: c, proposal: p } = acceptCoverLetterProposal(ws, pid, '表达更契合岗位语言', NOW)
  assert.equal(c.status, 'draft')
  assert.equal(c.units[0].text, UNIT_NEW)
  assert.deepEqual(c.units[0].sourceRefs, cl().units[0].sourceRefs) // sourceRefs 不变量
  assert.equal(c.units[0].intent, '突出机械设计能力') // intent 不变量（AI read-only）
  assert.deepEqual(c.deliveries, cl().deliveries) // 投递记录不变
  const last = c.transitions[c.transitions.length - 1]
  assert.equal(last.from, 'draft')
  assert.equal(last.to, 'draft')
  assert.equal(last.via, pid)
  assert.equal(p.status, 'accepted')
  assert.equal(p.acceptReason, '表达更契合岗位语言')
  assert.deepEqual(scanCoverLetters(ws)[0].record, c) // 落盘可重放
})

test('accept：ready → draft（修改必须产生新的 draft 演化事件）', () => {
  const ws = setupWorkspace()
  transitionCoverLetter(ws, CL_ID, 'reviewed', NOW)
  transitionCoverLetter(ws, CL_ID, 'ready', NOW)
  const pid = registerProposal(ws)
  const { coverLetter: c } = acceptCoverLetterProposal(ws, pid, undefined, NOW)
  assert.equal(c.status, 'draft')
  const last = c.transitions[c.transitions.length - 1]
  assert.equal(last.from, 'ready')
  assert.equal(last.to, 'draft')
  assert.equal(last.via, pid)
})

test('accept：old 漂移（unit 文本已变）→ 抛错，状态不变', () => {
  const ws = setupWorkspace()
  const pid = registerProposal(ws)
  const current = scanCoverLetters(ws)[0].record
  ws.write(
    `cover-letters/${CL_ID}.md`,
    serializeCoverLetter({ ...current, units: [{ ...current.units[0], text: '另一个版本' }] }),
  )
  assert.throws(() => acceptCoverLetterProposal(ws, pid, undefined, NOW), CoverLetterTransitionError)
  assert.equal(scanCoverLetterProposals(ws)[0].record.status, 'pending') // 未流转
})

test('reject：pending → rejected + reason；非 pending 双向抛错', () => {
  const ws = setupWorkspace()
  const pid = registerProposal(ws)
  const r = rejectCoverLetterProposal(ws, pid, '表述太主观', NOW)
  assert.equal(r.status, 'rejected')
  assert.equal(r.rejectReason, '表述太主观')
  assert.throws(() => rejectCoverLetterProposal(ws, pid, undefined, NOW), CoverLetterTransitionError)
  assert.throws(() => acceptCoverLetterProposal(ws, pid, undefined, NOW), CoverLetterTransitionError)
})

// ─── projection ──────────────────────────────────────────────────────────

test('buildCoverLetterContext：factStatement 快照 + 断链缺省 + 确定性', () => {
  const ws = setupWorkspace()
  const a = buildCoverLetterContext(ws)
  const b = buildCoverLetterContext(ws)
  assert.deepEqual(a, b)
  const unit = a.coverLetters[0].units[0]
  assert.equal(unit.sourceRefs.length, 3)
  const byArtifact = Object.fromEntries(unit.sourceRefs.map((r) => [r.artifact, r.factStatement]))
  assert.equal(byArtifact.resume, CLAIM_STATEMENT)
  assert.equal(byArtifact.portfolio, PORTFOLIO_FACT)
  assert.equal(byArtifact.interview, INTERVIEW_FACT)

  // 断链：删除 claim → 快照缺省（显式可见，不静默）
  ws.delete(`claims/${CLAIM_ID}.md`)
  const after = buildCoverLetterContext(ws)
  const resumeRef = after.coverLetters[0].units[0].sourceRefs.find((r) => r.artifact === 'resume')
  assert.equal(resumeRef?.factStatement, undefined)
  assert.equal('factStatement' in (resumeRef ?? {}), false)
})
