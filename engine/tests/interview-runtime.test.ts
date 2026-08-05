/**
 * M4-2.3 Interview Runtime Validation：真实工作区 replay——
 * 验证 Interview 三层治理纪律稳定（M3/M4 纪律延续）。
 *
 * Case A 正常 rewrite        → 表达层演化闭环成立
 * Case B 事实膨胀            → Runner PASS（引擎不判强度——Ownership Inflation 属人审 + Benchmark）
 * Case C Fact 触碰           → schema 无通道 / 解析忽略 / apply 后 FactLayer 不变
 * Case D ready 修改          → 必须产生新 draft 演化事件，不能直接回退
 * Case E 无锚点陈述          → I-08 拒绝（结构完整性，非语义判断）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InterviewQa, InterviewProposalChange } from '../ir/interview.ts'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import {
  serializeInterviewQa,
  parseInterviewProposal,
  scanInterviewQas,
  scanInterviewProposals,
  registerInterviewProposalFile,
  transitionInterviewQa,
  acceptInterviewProposal,
  buildInterviewContext,
  InterviewTransitionError,
} from '../storage/interview-watcher.ts'

// ─── fixtures ────────────────────────────────────────────────────────────

const QA_ID = 'qa_20260805_00001'
const NOW = new Date('2026-08-05T10:00:00Z')
const QUESTION = '请描述你的自动化设备设计经验'
const PARTICIPATED = '在项目中我参与视觉检测模块开发'
const LED = '在项目中我负责视觉检测系统架构设计' // 事实膨胀：参与 → 负责 + 系统架构设计
const DESIGN_ID = 'design_001'

function baseQa(): InterviewQa {
  return {
    id: QA_ID,
    status: 'draft',
    question: QUESTION,
    factItems: [{ id: 'fact_001', statement: '参与视觉检测模块开发', type: 'action', evidenceRefs: [DESIGN_ID] }],
    evidence: [{ id: DESIGN_ID, type: 'design', location: 'figma/project-x/vision.pdf', metadata: { 时间: '2026-04' } }],
    answerStatements: [{ id: 'ans_001', text: PARTICIPATED, factRefs: ['fact_001'] }],
    intents: [{ id: 'int_001', statement: '突出视觉检测岗位匹配度' }],
    transitions: [{ from: '', to: 'draft', at: '2026-08-05T10:00:00Z' }],
    createdAt: '2026-08-05',
    sourceFile: '视觉检测经验',
  }
}

function setupWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'cos-ivrv-'))
  const ws = initWorkspace(root)
  ws.write(`interviews/${QA_ID}.md`, serializeInterviewQa(baseQa()))
  return ws
}

/** 模拟 AI 写提案（暂存名，无 status 行）→ 引擎登记 → 返回系统提案 id */
function writeAndRegisterProposal(ws: Workspace, md: string, fileName = 'proposal-改写.md'): string {
  ws.write(`interviews/proposals/${fileName}`, md)
  assert.equal(registerInterviewProposalFile(ws, fileName, NOW), true, '提案应登记成功')
  return scanInterviewProposals(ws)[0].record.id
}

function proposalMd(changes: string, qaId: string = QA_ID): string {
  return `## 提案摘要

| 字段 | 值 |
|------|-----|
| type | interview_proposal |
| qa_id | ${qaId} |
| created_by | ai |

## 变更建议

${changes}
`
}

// ─── Case A：正常 rewrite ────────────────────────────────────────────────

test('Case A 正常 rewrite：表达优化（参与 → 负责+结果），三层闭环成立', () => {
  const ws = setupWorkspace()
  const pid = writeAndRegisterProposal(
    ws,
    proposalMd(`- ans_001（type: rewrite；old: "${PARTICIPATED}"；new: "${LED}"；reason: "表达更突出职责与结果"）`),
  )
  assert.equal(scanInterviewProposals(ws)[0].record.validation?.status, 'valid')

  const { qa: q, proposal } = acceptInterviewProposal(ws, pid, '更契合岗位语言', NOW)
  assert.equal(q.answerStatements[0].text, LED)
  assert.deepEqual(q.answerStatements[0].factRefs, ['fact_001']) // 锚点保留
  assert.equal(proposal.status, 'accepted')
  // 投影一致
  assert.deepEqual(buildInterviewContext(ws).qas[0], q)
})

// ─── Case B：事实膨胀（引擎不越界判强度）──────────────────────────────────

test('Case B 事实膨胀：参与→负责+架构设计（ownership inflation）→ Runner PASS，人审 + Benchmark 领域', () => {
  const ws = setupWorkspace()
  // fact_001 只证明"参与视觉检测模块开发"——"负责系统架构设计"是升级（Boundary-3）
  const pid = writeAndRegisterProposal(
    ws,
    proposalMd(`- ans_001（type: rewrite；old: "${PARTICIPATED}"；new: "在项目中我负责视觉检测系统架构设计"；reason: "岗位要求架构能力"）`),
  )
  // 引擎校验通过：I-01~I-08 全过（结构校验不判语义——无 strength/ownership score）
  const validation = scanInterviewProposals(ws)[0].record.validation
  assert.equal(validation?.status, 'valid')
  assert.equal(validation?.issues.length, 0)

  // accept 成功——Runner 不拦语义
  const { qa: q } = acceptInterviewProposal(ws, pid, undefined, NOW)
  assert.equal(q.answerStatements[0].text, '在项目中我负责视觉检测系统架构设计')

  // 纪律：Ownership/Contribution Inflation 属 Human Review + Benchmark 领域（契约 Boundary-3）
  // —— 引擎无 strengthScore/ownershipScore/confidenceScore；FactLayer 未被触碰
  assert.equal(q.factItems[0].statement, '参与视觉检测模块开发') // 事实仍原始
})

// ─── Case C：Fact 触碰（非法行为无法表达）────────────────────────────────

test('Case C Fact 触碰：schema 无通道 + 解析忽略 + apply 后 FactLayer 不变', () => {
  const ws = setupWorkspace()

  // ① schema 层面：InterviewProposalChange 无 factId/type 修改通道（编译期保证）
  const c: InterviewProposalChange = { type: 'rewrite', statementId: 'ans_001', old: PARTICIPATED, new: '改写', reason: 'r' }
  assert.equal('factId' in c, false, 'change 类型不应存在 factId 字段')
  assert.equal('statement' in c, false, 'change 类型不应存在 statement 修改通道')

  // ② 解析层面：AI 手写提案带 factId/fact_statement 走私字段 → 被忽略
  const smuggled = proposalMd(
    `- ans_001（type: rewrite；factId: "fact_001"；fact_statement: "负责系统架构"；old: "${PARTICIPATED}"；new: "改写"；reason: "偷改事实"）`,
  )
  const parsed = parseInterviewProposal(smuggled, 'smuggled.md')
  assert.equal(parsed.record.changes[0].statementId, 'ans_001')
  assert.equal('factId' in parsed.record.changes[0], false, '解析结果不应含 factId')
  assert.equal(parsed.record.changes[0].new, '改写')

  // ③ apply 层面：accept 后 FactLayer/StrategyLayer 原样保留
  const pid = writeAndRegisterProposal(
    ws,
    proposalMd(`- ans_001（type: rewrite；factId: "fact_001"；old: "${PARTICIPATED}"；new: "改写"；reason: "偷改事实"）`),
  )
  const { qa: q } = acceptInterviewProposal(ws, pid, undefined, NOW)
  assert.equal(q.answerStatements[0].text, '改写')
  assert.deepEqual(q.factItems, baseQa().factItems, 'FactLayer 必须原样保留')
  assert.deepEqual(q.intents, baseQa().intents, 'StrategyLayer 必须原样保留')
  assert.equal(q.evidence.length, 1, 'Evidence 不可被提案触碰')
})

// ─── Case D：ready 修改（必须新 draft 演化事件）──────────────────────────

test('Case D ready 修改：直接回退被拒；Proposal → draft 演化事件', () => {
  const ws = setupWorkspace()
  transitionInterviewQa(ws, QA_ID, 'reviewed', NOW)
  transitionInterviewQa(ws, QA_ID, 'ready', NOW)

  // 直接回退被拒（ready 无出口）
  assert.throws(() => transitionInterviewQa(ws, QA_ID, 'draft', NOW), InterviewTransitionError)
  assert.throws(() => transitionInterviewQa(ws, QA_ID, 'reviewed', NOW), InterviewTransitionError)

  // 修改必须走 Proposal → draft
  const pid = writeAndRegisterProposal(
    ws,
    proposalMd(`- ans_001（type: rewrite；old: "${PARTICIPATED}"；new: "在项目中我负责视觉检测模块开发"；reason: "职责表达升级"）`),
  )
  const { qa: q } = acceptInterviewProposal(ws, pid, undefined, NOW)
  assert.equal(q.status, 'draft')
  assert.equal(q.answerStatements[0].text, '在项目中我负责视觉检测模块开发')

  // 演化链 append-only：draft → reviewed → ready → draft（via 提案）
  assert.deepEqual(
    q.transitions.map((t) => `${t.from || '-'}->${t.to}${t.via ? `:${t.via}` : ''}`),
    ['-->draft', 'draft->reviewed', 'reviewed->ready', `ready->draft:${pid}`],
  )
})

// ─── Case E：无锚点陈述（结构完整性，非语义判断）─────────────────────────

test('Case E 无锚点陈述：I-08 拒绝（factRefs 为空不可改写——与 claimId exists 同类）', () => {
  const ws = setupWorkspace()
  // 用户写入无锚点回答 → QA 解析层 error（数据完整性）
  const current = scanInterviewQas(ws)[0].record
  ws.write(
    `interviews/${QA_ID}.md`,
    serializeInterviewQa({ ...current, answerStatements: [{ id: 'ans_002', text: '我带领团队完成大型项目', factRefs: [] }] }),
  )
  const qas = scanInterviewQas(ws)
  assert.ok(qas.some((q) => q.issues.some((i) => i.severity === 'error' && i.reason.includes('无事实锚点'))))

  // 对无锚点陈述的提案 → I-08 error（登记拒绝）
  const md = proposalMd(
    `- ans_002（type: rewrite；old: "我带领团队完成大型项目"；new: "我主导大型项目并交付"；reason: "强化领导力"）`,
  )
  ws.write('interviews/proposals/无锚点.md', md)
  assert.equal(registerInterviewProposalFile(ws, '无锚点.md', NOW), false, 'I-08 invalid 不登记')
  assert.ok(ws.exists('interviews/proposals/无锚点.md')) // 文件保留，AI 修正后重试
})
