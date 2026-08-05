/**
 * interview-watcher 单测（M4-2.2）：roundtrip / I-01~I-08 验证规则 /
 * 登记（无问题不登记）/ 状态机（单向，ready 不可回退）/ apply 全链
 * （三层分离 + ready→draft 演化事件 + 确定性）/ projection。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InterviewProposal, InterviewProposalChange, InterviewQa } from '../ir/interview.ts'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import {
  parseInterviewQaMarkdown,
  serializeInterviewQa,
  parseInterviewProposal,
  serializeInterviewProposal,
  validateInterviewProposal,
  scanInterviewQas,
  scanInterviewProposals,
  registerInterviewQaFile,
  registerInterviewProposalFile,
  transitionInterviewQa,
  acceptInterviewProposal,
  rejectInterviewProposal,
  buildInterviewContext,
  InterviewTransitionError,
} from '../storage/interview-watcher.ts'

// ─── 固定 fixture ─────────────────────────────────────────────────────────

const QA_ID = 'qa_20260805_00001'
const IP_ID = 'ip_20260805_00001'
const QUESTION = '请描述你的自动化设备设计经验'
const OLD_TEXT = '在项目中我参与自动化夹具设计'
const NEW_TEXT = '在项目中我负责自动化夹具设计部分，解决了装配效率问题'
const NOW = new Date('2026-08-05T10:00:00Z')

function qa(overrides: Partial<InterviewQa> = {}): InterviewQa {
  return {
    id: QA_ID,
    status: 'draft',
    question: QUESTION,
    factItems: [
      { id: 'fact_001', statement: '完成自动化夹具设计', type: 'action', evidenceRefs: ['design_001'] },
      { id: 'fact_002', statement: '公司在开发自动化设备', type: 'project_context', evidenceRefs: [] },
    ],
    evidence: [{ id: 'design_001', type: 'design', location: 'figma/project-x/design.pdf', metadata: { 时间: '2026-03' } }],
    answerStatements: [{ id: 'ans_001', text: OLD_TEXT, factRefs: ['fact_001', 'fact_002'] }],
    intents: [{ id: 'int_001', statement: '突出机械设计岗位匹配度' }],
    transitions: [{ from: '', to: 'draft', at: '2026-08-05T10:00:00Z' }],
    createdAt: '2026-08-05',
    sourceFile: '自我介绍',
    metadata: { targetRole: '机械结构工程师', company: '示例公司' },
    ...overrides,
  }
}

function change(overrides: Partial<InterviewProposalChange> = {}): InterviewProposalChange {
  return { type: 'rewrite', statementId: 'ans_001', old: OLD_TEXT, new: NEW_TEXT, reason: '表达更突出职责与结果', ...overrides }
}

function proposal(overrides: Partial<InterviewProposal> = {}): InterviewProposal {
  return { id: IP_ID, qaId: QA_ID, changes: [change()], status: 'pending', createdBy: 'ai', ...overrides }
}

/** 用户写入的 QA 暂存文件（无 frontmatter、无 status 行——引擎单方管理） */
const RAW_QA_MD = `# 自我介绍

## 问题

${QUESTION}

## 事实

| id | statement | type | evidence |
|----|-----------|------|----------|
| fact_001 | 完成自动化夹具设计 | action | design_001 |
| fact_002 | 公司在开发自动化设备 | project_context | - |

## 证据资产

| id | type | location | metadata |
|----|------|----------|----------|
| design_001 | design | figma/project-x/design.pdf | 时间=2026-03 |

## 回答

- ans_001（text: "在项目中我参与自动化夹具设计"；facts: fact_001, fact_002）

## 策略

- int_001（statement: "突出机械设计岗位匹配度"）
`

/** AI 写入的提案暂存文件（无 status 行——引擎登记时写回 pending） */
const RAW_PROPOSAL_MD = `## 提案摘要

| 字段 | 值 |
|------|-----|
| type | interview_proposal |
| qa_id | ${QA_ID} |
| created_by | ai |

## 变更建议

- ans_001（type: rewrite；old: "${OLD_TEXT}"；new: "${NEW_TEXT}"；reason: "表达更突出职责与结果"）
`

function setupWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'cos-ivw-'))
  const ws = initWorkspace(root)
  ws.write(`interviews/${QA_ID}.md`, serializeInterviewQa(qa()))
  return ws
}

/** 以已登记格式写入提案（scan 判定 status 行存在 → 文件快照） */
function registerProposal(ws: Workspace, p: InterviewProposal = proposal()): string {
  ws.write(`interviews/proposals/${p.id}.md`, serializeInterviewProposal(p))
  return p.id
}

// ─── roundtrip ───────────────────────────────────────────────────────────

test('roundtrip：serializeInterviewQa → parse 还原全部字段（三层 + metadata + via 演化记录）', () => {
  const q = qa({
    status: 'reviewed',
    transitions: [
      { from: '', to: 'draft', at: '2026-08-05T10:00:00Z' },
      { from: 'draft', to: 'reviewed', at: '2026-08-05T11:00:00Z' },
      { from: 'ready', to: 'draft', at: '2026-08-05T12:00:00Z', via: 'ip_20260805_00001' },
    ],
    answerStatements: [{ id: 'ans_001', text: '主导夹具设计；完成验证（实测）并输出报告', factRefs: ['fact_001'] }],
  })
  const parsed = parseInterviewQaMarkdown(serializeInterviewQa(q), `${q.id}.md`)
  assert.deepEqual(parsed.record, q)
})

test('roundtrip：serializeInterviewProposal → parse 还原全部字段（句子含 ；：）', () => {
  const p = proposal({
    status: 'accepted',
    decidedAt: '2026-08-05T11:00:00Z',
    acceptReason: '表达更契合岗位语言',
    validation: { status: 'warning', issues: [{ code: 'I-06', message: 'reason 为空', target: 'ans_001' }] },
    changes: [{ ...change(), new: '主导机架设计；完成验证（实测）：并输出报告' }],
  })
  const parsed = parseInterviewProposal(serializeInterviewProposal(p), `${p.id}.md`)
  assert.deepEqual(parsed.record, p)
})

test('parse：非法 status/事实类型/证据类型 → issues warn（降级不崩）；变更行非法 type → warn', () => {
  const md = serializeInterviewQa(qa())
    .replace('> status: draft', '> status: nope')
    .replace('| fact_002 | 公司在开发自动化设备 | project_context |', '| fact_002 | 公司在开发自动化设备 | weird |')
    .replace('| design_001 | design |', '| design_001 | video |')
  const parsed = parseInterviewQaMarkdown(md, 'q.md')
  assert.equal(parsed.record.status, 'draft') // 降级默认
  assert.ok(parsed.issues.some((i) => i.reason.includes('非法状态')))
  assert.ok(parsed.issues.some((i) => i.reason.includes('非法事实类型')))
  assert.ok(parsed.issues.some((i) => i.reason.includes('非法证据类型')))

  const pmd = serializeInterviewProposal(proposal()).replace('type: rewrite', 'type: nope')
  const pp = parseInterviewProposal(pmd, 'p.md')
  assert.equal(pp.record.changes[0].type, 'rewrite') // 降级默认
  assert.ok(pp.issues.some((i) => i.reason.includes('非法变更类型')))
})

test('parse：statement 无事实锚点（factRefs 空）→ issues error（I-08 数据完整性）', () => {
  const md = serializeInterviewQa(qa()).replace('facts: fact_001, fact_002', 'facts: -')
  const parsed = parseInterviewQaMarkdown(md, 'q.md')
  assert.equal(parsed.record.answerStatements[0].factRefs.length, 0)
  assert.ok(parsed.issues.some((i) => i.severity === 'error' && i.reason.includes('无事实锚点')))
})

// ─── QA 登记 ─────────────────────────────────────────────────────────────

test('registerInterviewQaFile：暂存 → 系统 ID + draft + 演化记录首行；幂等', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-ivw-'))
  const ws = initWorkspace(root)
  ws.write('interviews/自我介绍.md', RAW_QA_MD)
  assert.equal(registerInterviewQaFile(ws, '自我介绍.md', NOW), true)
  assert.ok(!ws.exists('interviews/自我介绍.md'))
  const qas = scanInterviewQas(ws)
  assert.equal(qas.length, 1)
  const q = qas[0].record
  assert.match(q.id, /^qa_20260805_\d{5}$/)
  assert.equal(q.status, 'draft') // status 引擎初始化
  assert.equal(q.sourceFile, '自我介绍')
  assert.equal(q.question, QUESTION)
  assert.equal(q.factItems.length, 2)
  assert.equal(q.answerStatements[0].factRefs.length, 2)
  assert.equal(q.intents.length, 1)
  assert.equal(q.transitions.length, 1)
  assert.equal(q.transitions[0].to, 'draft')
  assert.equal(registerInterviewQaFile(ws, `${q.id}.md`, NOW), false) // 已登记
})

test('registerInterviewQaFile：无问题不登记（文件保留）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-ivw-'))
  const ws = initWorkspace(root)
  ws.write('interviews/空问题.md', '# 空问题\n\n## 问题\n\n\n## 事实\n\n| id | statement | type | evidence |\n|----|-----------|------|----------|\n')
  assert.equal(registerInterviewQaFile(ws, '空问题.md', NOW), false)
  assert.ok(ws.exists('interviews/空问题.md'))
})

// ─── 验证规则（I-01~I-08 全覆盖）──────────────────────────────────────────

test('validateInterviewProposal：合法提案 → valid；I-01~I-05/I-08 → invalid，I-06/I-07 → warning', () => {
  const ws = setupWorkspace()
  const q = scanInterviewQas(ws)[0].record
  assert.equal(validateInterviewProposal(proposal(), q).status, 'valid')

  const i01 = validateInterviewProposal(proposal(), undefined)
  assert.equal(i01.status, 'invalid')
  assert.ok(i01.issues.some((i) => i.code === 'I-01'))

  const noChanges = validateInterviewProposal(proposal({ changes: [] }), q)
  assert.equal(noChanges.status, 'invalid')
  assert.ok(noChanges.issues.some((i) => i.code === 'NO_CHANGES'))

  const i02 = validateInterviewProposal(proposal({ changes: [{ ...change(), statementId: 'ans_999' }] }), q)
  assert.ok(i02.issues.some((i) => i.code === 'I-02'))

  const i03 = validateInterviewProposal(proposal({ changes: [{ ...change(), old: '不匹配的旧文' }] }), q)
  assert.ok(i03.issues.some((i) => i.code === 'I-03'))

  const i04 = validateInterviewProposal(proposal({ changes: [{ ...change(), new: '  ' }] }), q)
  assert.ok(i04.issues.some((i) => i.code === 'I-04'))

  const i05 = validateInterviewProposal(proposal({ changes: [{ ...change(), type: 'modify_fact' } as unknown as InterviewProposalChange] }), q)
  assert.ok(i05.issues.some((i) => i.code === 'I-05'))

  // I-08：目标 statement 无事实锚点
  const anchorless = validateInterviewProposal(
    proposal({ changes: [{ ...change(), statementId: 'ans_anchorless' }] }),
    { ...q, answerStatements: [...q.answerStatements, { id: 'ans_anchorless', text: OLD_TEXT, factRefs: [] }] },
  )
  assert.ok(anchorless.issues.some((i) => i.code === 'I-08'))
  assert.equal(anchorless.status, 'invalid')

  const warn = validateInterviewProposal(proposal({ changes: [{ ...change(), reason: '' }, { ...change(), reason: '' }] }), q)
  assert.equal(warn.status, 'warning')
  assert.ok(warn.issues.some((i) => i.code === 'I-06'))
  assert.ok(warn.issues.some((i) => i.code === 'I-07'))
})

test('validateInterviewProposal：I-03 old 匹配做空格标准化', () => {
  const q = scanInterviewQas(setupWorkspace())[0].record
  const spaced = OLD_TEXT.replace(' ', '  ')
  assert.equal(validateInterviewProposal(proposal({ changes: [{ ...change(), old: spaced }] }), q).status, 'valid')
})

// ─── 提案登记 ────────────────────────────────────────────────────────────

test('registerInterviewProposalFile：valid 登记 + 引擎字段写回；invalid（I-01）不登记', () => {
  const ws = setupWorkspace()
  ws.write('interviews/proposals/优化回答.md', RAW_PROPOSAL_MD)
  assert.equal(registerInterviewProposalFile(ws, '优化回答.md', NOW), true)
  assert.ok(!ws.exists('interviews/proposals/优化回答.md'))
  const proposals = scanInterviewProposals(ws)
  assert.equal(proposals.length, 1)
  const p = proposals[0].record
  assert.match(p.id, /^ip_20260805_\d{5}$/)
  assert.equal(p.status, 'pending')
  assert.equal(p.qaId, QA_ID)
  assert.equal(p.validation?.status, 'valid')
  assert.equal(registerInterviewProposalFile(ws, `${p.id}.md`, NOW), false) // 已登记

  const root = mkdtempSync(join(tmpdir(), 'cos-ivw-'))
  const ws2 = initWorkspace(root)
  ws2.write('interviews/proposals/孤儿.md', RAW_PROPOSAL_MD.replace(QA_ID, 'qa_20990101_99999'))
  assert.equal(registerInterviewProposalFile(ws2, '孤儿.md', NOW), false)
  assert.ok(ws2.exists('interviews/proposals/孤儿.md'))
})

test('scan：未登记提案实时校验（I-02 statementId 不存在）', () => {
  const ws = setupWorkspace()
  ws.write('interviews/proposals/错误陈述.md', RAW_PROPOSAL_MD.replace('ans_001', 'ans_999'))
  const [p] = scanInterviewProposals(ws)
  assert.equal(p.record.validation?.status, 'invalid')
  assert.ok(p.record.validation?.issues.some((i) => i.code === 'I-02'))
})

// ─── 状态机（单向；ready 不可回退）────────────────────────────────────────

test('transition：draft→reviewed→ready；reviewed→draft 打回；ready 无出口', () => {
  const ws = setupWorkspace()
  assert.equal(transitionInterviewQa(ws, QA_ID, 'reviewed', NOW).status, 'reviewed')
  assert.equal(transitionInterviewQa(ws, QA_ID, 'draft', NOW).status, 'draft') // review 打回
  transitionInterviewQa(ws, QA_ID, 'reviewed', NOW)
  const ready = transitionInterviewQa(ws, QA_ID, 'ready', NOW)
  assert.equal(ready.status, 'ready')
  assert.throws(() => transitionInterviewQa(ws, QA_ID, 'draft', NOW), InterviewTransitionError)
  assert.throws(() => transitionInterviewQa(ws, QA_ID, 'reviewed', NOW), InterviewTransitionError)
  assert.equal(scanInterviewQas(ws)[0].record.status, 'ready') // 状态不变
})

// ─── 决策（accept → apply / reject）──────────────────────────────────────

test('accept：apply 确定性（text 改写 + status=draft + transitions via + 三层不变）', () => {
  const ws = setupWorkspace()
  const pid = registerProposal(ws)
  const { qa: q, proposal: p } = acceptInterviewProposal(ws, pid, '表达更契合岗位语言', NOW)
  assert.equal(q.status, 'draft')
  assert.equal(q.answerStatements[0].text, NEW_TEXT)
  assert.deepEqual(q.answerStatements[0].factRefs, ['fact_001', 'fact_002']) // 锚点不变量
  assert.deepEqual(q.factItems, qa().factItems) // FactLayer 不可触碰
  assert.deepEqual(q.intents, qa().intents) // StrategyLayer 不可触碰
  assert.equal(q.evidence.length, 1)
  const last = q.transitions[q.transitions.length - 1]
  assert.equal(last.from, 'draft')
  assert.equal(last.to, 'draft')
  assert.equal(last.via, pid)
  assert.equal(p.status, 'accepted')
  assert.equal(p.acceptReason, '表达更契合岗位语言')
  // 落盘可重放
  assert.deepEqual(scanInterviewQas(ws)[0].record, q)
  assert.equal(scanInterviewProposals(ws)[0].record.status, 'accepted')
})

test('accept：ready QA → draft（修改必须产生新的 draft 演化事件）', () => {
  const ws = setupWorkspace()
  transitionInterviewQa(ws, QA_ID, 'reviewed', NOW)
  transitionInterviewQa(ws, QA_ID, 'ready', NOW)
  const pid = registerProposal(ws)
  const { qa: q } = acceptInterviewProposal(ws, pid, undefined, NOW)
  assert.equal(q.status, 'draft')
  const last = q.transitions[q.transitions.length - 1]
  assert.equal(last.from, 'ready')
  assert.equal(last.to, 'draft')
  assert.equal(last.via, pid)
})

test('accept：old 漂移（回答已变）→ 抛错，QA 与提案状态不变', () => {
  const ws = setupWorkspace()
  const pid = registerProposal(ws)
  const current = scanInterviewQas(ws)[0].record
  ws.write(
    `interviews/${QA_ID}.md`,
    serializeInterviewQa({ ...current, answerStatements: [{ ...current.answerStatements[0], text: '另一个版本' }] }),
  )
  assert.throws(() => acceptInterviewProposal(ws, pid, undefined, NOW), InterviewTransitionError)
  assert.equal(scanInterviewProposals(ws)[0].record.status, 'pending') // 未流转
})

test('reject：pending → rejected + reason；非 pending 双向抛错', () => {
  const ws = setupWorkspace()
  const pid = registerProposal(ws)
  const r = rejectInterviewProposal(ws, pid, '表述太主观', NOW)
  assert.equal(r.status, 'rejected')
  assert.equal(r.rejectReason, '表述太主观')
  assert.throws(() => rejectInterviewProposal(ws, pid, undefined, NOW), InterviewTransitionError)
  assert.throws(() => acceptInterviewProposal(ws, pid, undefined, NOW), InterviewTransitionError)
})

// ─── projection ──────────────────────────────────────────────────────────

test('buildInterviewContext：确定性（same files → same output）；未登记暂存 QA 保留', () => {
  const ws = setupWorkspace()
  ws.write('interviews/未登记.md', RAW_QA_MD)
  const a = buildInterviewContext(ws)
  const b = buildInterviewContext(ws)
  assert.deepEqual(a, b)
  assert.equal(a.qas.length, 2) // 已登记 + 未登记暂存
  const raw = a.qas.find((x) => x.id === '未登记')
  assert.equal(raw?.status, 'draft')
  assert.equal(raw?.question, QUESTION)
})
