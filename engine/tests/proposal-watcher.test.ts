/**
 * proposal-watcher 单测（M3.5.6）：roundtrip（引号内 ；：）/ 验证规则逐条 /
 * 登记（invalid 不登记）/ 状态机（单向不 reopen）/ apply 全链（checksum + lineage +
 * apply_proposal 审计 + 确定性）/ Assembler override_source=proposal。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CareerClaim, EvidenceItem, JobRecord } from '../ir/schema.ts'
import type { ProposalChange, ResumeDocument, ResumeProposal } from '../ir/resume.ts'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import {
  checksumOf,
  serializeResumeProposal,
  parseProposalMarkdown,
  validateProposal,
  scanProposals,
  registerProposalFile,
  registerPendingProposals,
  acceptProposalFile,
  rejectProposalFile,
  buildProposalManifest,
  buildProposalFeedback,
  ProposalTransitionError,
  type ProposalContext,
} from '../storage/proposal-watcher.ts'
import { serializeResumeDocument, scanResumes } from '../storage/resume-watcher.ts'
import { assembleResumeFromDraft } from '../storage/resume-draft.ts'
import { createJobFile } from '../storage/job-watcher.ts'

// ─── 固定 fixture ─────────────────────────────────────────────────────────

const EVIDENCE_ID = 'evidence_20260805_00001'
const CLAIM_ID = 'claim_20260805_00001'
const JOB_ID = 'job_20260805_00001'
const RESUME_ID = 'resume_20260805_00001'
const OLD = '负责自动化设备机械结构设计，完成机架及传动机构优化'
const NEW = '主导自动化设备机架结构设计，传动精度由 0.1mm 提升至 0.05mm'

function ev(id: string = EVIDENCE_ID): EvidenceItem {
  return {
    id,
    event: { title: '新机型平台开发项目' },
    role: '机械结构负责人',
    contribution: '负责机架和传动模块设计',
    evidence: { scope: [{ content: '负责机架和传动模块设计' }] },
    source: { type: 'user_input', capturedAt: '2026-08-05' },
    status: 'trusted',
  }
}

function claim(id: string = CLAIM_ID, statement = OLD): CareerClaim {
  return { id, created_at: '2026-08-05', source: 'agent_generated', statement, claimType: 'fact', provenance: [{ evidenceId: EVIDENCE_ID }] }
}

function job(): JobRecord {
  return {
    id: JOB_ID,
    company: '示例公司',
    title: '机械结构工程师',
    responsibilities: [
      {
        id: 'ai-1',
        statement: '自动化设备结构设计',
        priority: 'must',
        capabilities: ['SolidWorks'],
        evidenceExpectations: [{ patternId: 'engineering_validation', questions: ['如何验证设计有效？'] }],
        source: 'ai',
      },
    ],
    createdAt: '2026-08-05',
  }
}

function resume(overrides: Partial<ResumeDocument> = {}): ResumeDocument {
  return {
    id: RESUME_ID,
    status: 'draft',
    person: '我',
    targetJobId: JOB_ID,
    templateId: 'mechanical',
    templateVersion: '1.2',
    sections: [
      {
        type: 'experience',
        title: '工作经历',
        bullets: [{ sentence: OLD, claimId: CLAIM_ID, metadata: { expectationId: 'engineering_validation' } }],
      },
      { type: 'skills', title: '技能', bullets: [], assetRefs: ['SolidWorks'] },
    ],
    generatedAt: '2026-08-05T10:00:00Z',
    lineage: { derivationType: 'jd_generate', createdBy: 'ai' },
    operations: [{ id: 'operation_001', actor: 'ai', action: 'create', at: '2026-08-05T10:00:00Z' }],
    ...overrides,
  }
}

function change(overrides: Partial<ProposalChange> = {}): ProposalChange {
  return {
    targetClaimId: CLAIM_ID,
    section: 'experience',
    oldSentence: OLD,
    suggestedSentence: NEW,
    reason: 'target_job 强调量化结果，期望 engineering_validation 有可度量输出',
    expectationId: 'engineering_validation',
    ...overrides,
  }
}

function proposal(overrides: Partial<ResumeProposal> = {}): ResumeProposal {
  return { id: 'proposal_20260805_00001', sourceResumeId: RESUME_ID, type: 'improve', changes: [change()], status: 'pending', createdBy: 'ai', ...overrides }
}

function ctx(): ProposalContext {
  return { source: resume(), anchorJob: job(), claims: [claim()], evidence: [ev()] }
}

// ─── 文件 fixture（workspace 级：claim/evidence/job/resume/proposal 落盘）──

const CLAIM_MD = `---
id: ${CLAIM_ID}
---

# 机械结构设计

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | ${OLD} |
| claim_type | fact |
| source | agent_generated |
| captured_at | 2026-08-05 |

## 证据来源

- ${EVIDENCE_ID}
`

const EVIDENCE_MD = `---
id: ${EVIDENCE_ID}
---

# 新机型平台开发项目

## 分析摘要

| 字段 | 值 |
|------|-----|
| role | 机械结构负责人 |
| contribution | 负责机架和传动模块设计 |
| source_type | user_input |
| captured_at | 2026-08-05 |
| status | trusted |

## 事件

公司新机型平台开发项目。

## 证据

### scope
- 负责机架和传动模块设计

## 来源

用户口述整理
`

function setupWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'cos-proposal-'))
  const ws = initWorkspace(root)
  ws.write(`claims/${CLAIM_ID}.md`, CLAIM_MD)
  ws.write(`evidence/${EVIDENCE_ID}.md`, EVIDENCE_MD)
  const job = createJobFile(ws, { company: '示例公司', title: '机械结构工程师', requirements: '自动化设备结构设计' })
  ws.write(`resumes/documents/${RESUME_ID}.md`, serializeResumeDocument(resume({ targetJobId: job.id })))
  return ws
}

// ─── roundtrip ───────────────────────────────────────────────────────────

test('roundtrip：serialize → parse 还原全部字段（句子含 ；：（）与引号保护）', () => {
  const p = proposal({
    status: 'accepted',
    decidedAt: '2026-08-05T11:00:00Z',
    acceptReason: '表达更契合岗位语言',
    resultResumeId: 'resume_20260805_00002',
    sourceChecksum: 'abc123',
    validation: { status: 'warning', issues: [{ code: 'REASON_EMPTY', message: 'reason 为空', target: CLAIM_ID }] },
    changes: [{ ...change(), suggestedSentence: '主导机架设计；传动精度提升至 0.05mm（实测）：并完成装配验证' }],
  })
  const { value, validation } = parseProposalMarkdown(serializeResumeProposal(p), 'proposal_20260805_00001.md')
  assert.equal(validation, undefined)
  assert.deepEqual(value, p)
})

test('parse：变更行非法 section/source 标 BAD_*（保留降级不崩）', () => {
  const md = serializeResumeProposal(proposal()).replace('section: experience', 'section: nope').replace('；expectation: engineering_validation', '')
  const { value, validation } = parseProposalMarkdown(md, 'p.md')
  assert.equal(value.changes[0].section, 'experience') // 降级默认
  assert.ok(validation?.issues.some((i) => i.reason.includes('BAD_SECTION')))
})

// ─── 验证规则（12 code 全覆盖关键路径）────────────────────────────────────

test('validateProposal：合法提案 → valid', () => {
  assert.equal(validateProposal(proposal(), ctx()).status, 'valid')
})

test('validateProposal：invalid 类错误 → invalid（source 缺失/类型非法/adapt_jd 缺 job/无变更/claim 缺失/old 不匹配/new 空/expectation 缺失）', () => {
  const base = ctx()
  const cases: [Partial<ResumeProposal>, string][] = [
    [{ sourceResumeId: 'resume_nope' }, 'SOURCE_NOT_FOUND'],
    [{ type: 'weird' as ResumeProposal['type'] }, 'PROPOSAL_TYPE_INVALID'],
    [{ type: 'adapt_jd' }, 'TARGET_JOB_MISSING'],
    [{ changes: [] }, 'NO_CHANGES'],
    [{ changes: [change({ targetClaimId: 'claim_nope' })] }, 'CLAIM_NOT_FOUND'],
    [{ changes: [change({ oldSentence: '不存在的原文' })] }, 'OLD_SENTENCE_MISMATCH'],
    [{ changes: [change({ suggestedSentence: '' })] }, 'NEW_SENTENCE_EMPTY'],
    [{ changes: [change({ expectationId: 'nope' })] }, 'EXPECTATION_NOT_FOUND'],
  ]
  for (const [overrides, code] of cases) {
    const v = validateProposal(proposal(overrides), base)
    assert.equal(v.status, 'invalid', code)
    assert.ok(v.issues.some((i) => i.code === code), code)
  }
})

test('validateProposal：warning 类错误 → warning（claim 不可消费/reason 空）', () => {
  const notUsable = { ...ctx(), evidence: [ev('evidence_20260805_00099')] }
  const v1 = validateProposal(proposal(), notUsable)
  assert.equal(v1.status, 'warning')
  assert.ok(v1.issues.some((i) => i.code === 'CLAIM_NOT_USABLE'))
  const v2 = validateProposal(proposal({ changes: [change({ reason: '' })] }), ctx())
  assert.equal(v2.status, 'warning')
  assert.ok(v2.issues.some((i) => i.code === 'REASON_EMPTY'))
})

test('validateProposal：adapt_jd 期望锚点空间 = 提案目标岗位（非源版本岗位）', () => {
  const targetJob = { ...job(), id: 'job_20260805_00002', responsibilities: [{ ...job().responsibilities[0], evidenceExpectations: [{ patternId: 'engineering_impact', questions: [] }] }] }
  const v = validateProposal(proposal({ type: 'adapt_jd', targetJobId: 'job_20260805_00002' }), { source: resume(), anchorJob: targetJob, claims: [claim()], evidence: [ev()] })
  // engineering_validation 不在新岗位期望 → invalid
  assert.equal(v.status, 'invalid')
  assert.ok(v.issues.some((i) => i.code === 'EXPECTATION_NOT_FOUND'))
})

// ─── 登记（invalid 不登记）──────────────────────────────────────────────

function proposalMd(overrides: Partial<ResumeProposal> = {}): string {
  const p = proposal(overrides)
  const changeLine = p.changes.map((c) => {
    const kvs = [`section: ${c.section}`, `old: "${c.oldSentence}"`, `new: "${c.suggestedSentence}"`, `reason: "${c.reason}"`, `expectation: ${c.expectationId}`]
    return `- ${c.targetClaimId}（${kvs.join('；')}）`
  }).join('\n')
  return `# 改进建议

## 分析摘要

| 字段 | 值 |
|------|-----|
| type | resume_proposal |
| source_resume_id | ${p.sourceResumeId} |
| proposal_type | ${p.type} |
${p.targetJobId ? `| target_job_id | ${p.targetJobId} |` : ''}

## 变更建议

${changeLine}
`
}

test('登记：合法提案 → 系统 ID + 引擎字段写回（pending/checksum/validation）', () => {
  const ws = setupWorkspace()
  ws.write('proposals/ai-改进-1.md', proposalMd())
  const ok = registerProposalFile(ws, 'ai-改进-1.md', new Date('2026-08-05T12:00:00Z'))
  assert.equal(ok, true)
  const list = ws.listMarkdown('proposals')
  assert.deepEqual(list, ['proposal_20260805_00001.md'])
  const parsed = parseProposalMarkdown(ws.read('proposals/proposal_20260805_00001.md'), list[0]).value
  assert.equal(parsed.status, 'pending')
  assert.equal(parsed.createdBy, 'ai')
  assert.equal(parsed.sourceChecksum, checksumOf(resume()))
  assert.equal(parsed.validation?.status, 'valid')
  rmSync(ws.paths.root, { recursive: true, force: true })
})

test('登记：invalid 提案不登记（文件保留原暂存名，AI 修正后可重试）', () => {
  const ws = setupWorkspace()
  ws.write('proposals/ai-bad.md', proposalMd({ changes: [change({ oldSentence: '胡编的原文' })] }))
  assert.equal(registerProposalFile(ws, 'ai-bad.md'), false)
  assert.deepEqual(ws.listMarkdown('proposals'), ['ai-bad.md'])
  // 修正后重试 → 登记成功
  ws.write('proposals/ai-bad.md', proposalMd())
  assert.equal(registerProposalFile(ws, 'ai-bad.md'), true)
  rmSync(ws.paths.root, { recursive: true, force: true })
})

test('registerPendingProposals：启动补登幂等（已登记跳过）', () => {
  const ws = setupWorkspace()
  ws.write('proposals/ai-1.md', proposalMd())
  assert.equal(registerPendingProposals(ws), 1)
  assert.equal(registerPendingProposals(ws), 0)
  rmSync(ws.paths.root, { recursive: true, force: true })
})

// ─── 状态机 ─────────────────────────────────────────────────────────────

test('reject：pending → rejected（可选原因）；非 pending 拒绝；rejected 不 reopen', () => {
  const ws = setupWorkspace()
  ws.write('proposals/ai-1.md', proposalMd())
  registerProposalFile(ws, 'ai-1.md')
  const rejected = rejectProposalFile(ws, 'proposal_20260805_00001', '与当前版本不匹配', new Date('2026-08-05T13:00:00Z'))
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.rejectReason, '与当前版本不匹配')
  assert.equal(rejected.decidedAt, new Date('2026-08-05T13:00:00Z').toISOString())
  // 已 reject → 不能再次 accept/reject
  assert.throws(() => acceptProposalFile(ws, 'proposal_20260805_00001'), ProposalTransitionError)
  assert.throws(() => rejectProposalFile(ws, 'proposal_20260805_00001'), ProposalTransitionError)
  rmSync(ws.paths.root, { recursive: true, force: true })
})

test('accept：非 pending 拒绝（accepted 后不能重复应用）', () => {
  const ws = setupWorkspace()
  ws.write('proposals/ai-1.md', proposalMd())
  registerProposalFile(ws, 'ai-1.md')
  acceptProposalFile(ws, 'proposal_20260805_00001', undefined, new Date('2026-08-05T12:00:00Z'))
  assert.throws(() => acceptProposalFile(ws, 'proposal_20260805_00001'), ProposalTransitionError)
  rmSync(ws.paths.root, { recursive: true, force: true })
})

// ─── apply 全链 ─────────────────────────────────────────────────────────

test('accept 全链：确定性应用 → 新版本（不覆盖源）——lineage ai_revision + 替换句 + apply_proposal 审计 + 双向追溯', () => {
  const ws = setupWorkspace()
  ws.write('proposals/ai-1.md', proposalMd())
  registerProposalFile(ws, 'ai-1.md')
  const { document, proposal: updated } = acceptProposalFile(ws, 'proposal_20260805_00001', undefined, new Date('2026-08-05T12:00:00Z'))
  // 源版本未被覆盖
  const sources = scanResumes(ws).filter((r) => r.record.id === RESUME_ID)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].record.sections[0].bullets[0].sentence, OLD)
  // 新版本：替换句 + 原句保留逻辑（本提案只有一条 change）
  const v4 = scanResumes(ws).find((r) => r.record.id === updated.resultResumeId)!
  assert.equal(v4.record.id, document.id)
  assert.equal(v4.record.lineage?.parentResumeId, RESUME_ID)
  assert.equal(v4.record.lineage?.derivationType, 'ai_revision')
  assert.equal(v4.record.person, '我') // 继承源版本归属人（防 person 缺失标 invalid）
  const bullet = v4.record.sections.find((s) => s.type === 'experience')!.bullets[0]
  assert.equal(bullet.sentence, NEW)
  assert.equal(bullet.claimId, CLAIM_ID)
  assert.equal(bullet.metadata?.expectationId, 'engineering_validation')
  // skills assetRefs 保留（模板沿用）
  assert.deepEqual(v4.record.sections.find((s) => s.type === 'skills')!.assetRefs, ['SolidWorks'])
  assert.equal(v4.record.templateId, 'mechanical')
  assert.equal(v4.record.targetJobId, sources[0].record.targetJobId) // 沿用源版本岗位锚点
  // apply_proposal 审计（含 proposal id 引用）
  const applyOp = v4.record.operations?.find((o) => o.action === 'apply_proposal')
  assert.ok(applyOp)
  assert.equal(applyOp.actor, 'system')
  assert.equal(applyOp.note, 'proposal_20260805_00001')
  // Proposal 回填
  assert.equal(updated.status, 'accepted')
  assert.equal(updated.resultResumeId, document.id)
  // 回读文件确认持久化
  const onDisk = parseProposalMarkdown(ws.read('proposals/proposal_20260805_00001.md'), 'x.md').value
  assert.equal(onDisk.status, 'accepted')
  assert.equal(onDisk.resultResumeId, document.id)
  rmSync(ws.paths.root, { recursive: true, force: true })
})

test('accept：checksum 不匹配（源内容已变化）→ 拒绝且状态不变', () => {
  const ws = setupWorkspace()
  ws.write('proposals/ai-1.md', proposalMd())
  registerProposalFile(ws, 'ai-1.md')
  // 源版本内容变化（append-only 纪律下模拟人工误改：替换 bullet 文本）
  const modified = resume()
  modified.sections[0].bullets[0].sentence = '被外部修改的句子'
  ws.write(`resumes/documents/${RESUME_ID}.md`, serializeResumeDocument(modified))
  assert.throws(() => acceptProposalFile(ws, 'proposal_20260805_00001'), /checksum 不匹配/)
  assert.equal(parseProposalMarkdown(ws.read('proposals/proposal_20260805_00001.md'), 'x.md').value.status, 'pending')
  rmSync(ws.paths.root, { recursive: true, force: true })
})

test('buildProposalManifest 确定性：同输入两次调用产物一致', () => {
  const m1 = buildProposalManifest(resume(), proposal(), new Date('2026-08-05T12:00:00Z'))
  const m2 = buildProposalManifest(resume(), proposal(), new Date('2026-08-05T12:00:00Z'))
  assert.deepEqual(m1, m2)
  assert.equal(m1.parentResumeId, RESUME_ID)
  assert.equal(m1.derivationType, 'ai_revision')
  assert.equal(m1.claims[0].sentenceOverride, NEW)
  assert.equal(m1.claims[0].overrideSource, 'proposal')
  assert.deepEqual(m1.skills, ['SolidWorks'])
})

// ─── Assembler override 进入规则 ─────────────────────────────────────────

test('assembleResumeFromDraft：override_source=proposal 进入（user 进入；ai 拒绝标 warning）', () => {
  const base = { claims: [claim()], evidence: [ev()], selectorCandidates: [] }
  const mkManifest = (overrideSource: 'user' | 'ai' | 'proposal') => ({
    id: 'd1',
    type: 'resume_draft' as const,
    templateId: 'mechanical',
    parentResumeId: RESUME_ID,
    derivationType: 'ai_revision' as const,
    claims: [{ claimId: CLAIM_ID, section: 'experience' as const, sentenceOverride: NEW, overrideSource }],
    skills: [],
  })
  for (const source of ['user', 'proposal'] as const) {
    const { document, validation } = assembleResumeFromDraft({ manifest: mkManifest(source), ...base })
    assert.equal(document.sections[0].bullets[0].sentence, NEW, source)
    assert.equal(validation.status, 'valid', source)
  }
  const ai = assembleResumeFromDraft({ manifest: mkManifest('ai'), ...base })
  assert.equal(ai.document.sections[0].bullets[0].sentence, claim().statement) // 拒绝 AI 句子，用 claim.statement
  assert.equal(ai.validation.status, 'warning')
  assert.ok(ai.validation.issues.some((i) => i.code === 'OVERRIDE_NOT_USER'))
})

// ─── 扫描视图 ───────────────────────────────────────────────────────────

test('scanProposals：未登记 invalid 提案实时验证可见（UI 可展示错误）', () => {
  const ws = setupWorkspace()
  ws.write('proposals/ai-bad.md', proposalMd({ changes: [change({ oldSentence: '胡编的原文' })] }))
  const list = scanProposals(ws)
  assert.equal(list.length, 1)
  assert.equal(list[0].record.status, 'pending') // 未登记 → 默认 pending 语义
  assert.equal(list[0].record.validation?.status, 'invalid')
  assert.ok(list[0].record.validation?.issues.some((i) => i.code === 'OLD_SENTENCE_MISMATCH'))
  rmSync(ws.paths.root, { recursive: true, force: true })
})

// ─── M3.5.7：Proposal Feedback Projection（决策反馈投影）───────────────

test('accept reason：带 reason 写回 accept_reason（与 rejectReason 对称）；不带则无字段', () => {
  const ws = setupWorkspace()
  ws.write('proposals/ai-1.md', proposalMd())
  ws.write('proposals/ai-2.md', proposalMd())
  registerProposalFile(ws, 'ai-1.md')
  registerProposalFile(ws, 'ai-2.md')
  acceptProposalFile(ws, 'proposal_20260805_00001', '表达更契合岗位语言', new Date('2026-08-05T12:00:00Z'))
  acceptProposalFile(ws, 'proposal_20260805_00002', undefined, new Date('2026-08-05T13:00:00Z'))
  const p1 = parseProposalMarkdown(ws.read('proposals/proposal_20260805_00001.md'), 'x.md').value
  assert.equal(p1.acceptReason, '表达更契合岗位语言')
  const p2 = parseProposalMarkdown(ws.read('proposals/proposal_20260805_00002.md'), 'x.md').value
  assert.equal(p2.acceptReason, undefined)
  rmSync(ws.paths.root, { recursive: true, force: true })
})

test('buildProposalFeedback：pending 不入历史；decidedAt 降序；stats/byType/byExpectation/reasons 原样', () => {
  const ws = setupWorkspace()
  ws.write('proposals/ai-1.md', proposalMd())
  ws.write('proposals/ai-2.md', proposalMd())
  registerProposalFile(ws, 'ai-1.md')
  registerProposalFile(ws, 'ai-2.md')
  acceptProposalFile(ws, 'proposal_20260805_00001', '表达更契合岗位语言', new Date('2026-08-05T12:00:00Z'))
  rejectProposalFile(ws, 'proposal_20260805_00002', '与当前方向不符', new Date('2026-08-05T13:00:00Z'))
  const fb = buildProposalFeedback(ws)
  assert.equal(fb.proposalHistory.length, 2)
  assert.equal(fb.proposalHistory[0].action, 'rejected') // 降序：后决策的在前
  assert.equal(fb.proposalHistory[0].reason, '与当前方向不符')
  assert.equal(fb.proposalHistory[1].action, 'accepted')
  assert.equal(fb.proposalHistory[1].reason, '表达更契合岗位语言')
  assert.equal(fb.proposalHistory[0].actor, 'user')
  assert.equal(fb.proposalInsights.stats.total, 2)
  assert.equal(fb.proposalInsights.stats.accepted, 1)
  assert.equal(fb.proposalInsights.stats.rejected, 1)
  assert.equal(fb.proposalInsights.stats.acceptRate, 0.5)
  assert.deepEqual(fb.proposalInsights.byType.improve, { accepted: 1, rejected: 1 })
  assert.deepEqual(fb.proposalInsights.byExpectation.engineering_validation, { accepted: 1, rejected: 1 })
  assert.deepEqual(fb.proposalInsights.rejectedReasons, ['与当前方向不符'])
  assert.deepEqual(fb.proposalInsights.acceptedReasons, ['表达更契合岗位语言'])
  rmSync(ws.paths.root, { recursive: true, force: true })
})

test('buildProposalFeedback：空历史 acceptRate 0；仅 pending 提案不入历史', () => {
  const ws = setupWorkspace()
  const fb = buildProposalFeedback(ws)
  assert.equal(fb.proposalHistory.length, 0)
  assert.equal(fb.proposalInsights.stats.acceptRate, 0)
  assert.deepEqual(fb.proposalInsights.byType, {})
  assert.deepEqual(fb.proposalInsights.rejectedReasons, [])
  ws.write('proposals/ai-1.md', proposalMd())
  registerProposalFile(ws, 'ai-1.md')
  const fb2 = buildProposalFeedback(ws)
  assert.equal(fb2.proposalHistory.length, 0)
  assert.equal(fb2.proposalInsights.stats.total, 0)
  rmSync(ws.paths.root, { recursive: true, force: true })
})
