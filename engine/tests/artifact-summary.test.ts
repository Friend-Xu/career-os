/**
 * artifact-summary 单测（M4-5.1）：四 adapter 纯函数投影 + 聚合入口集成。
 * 验收：四 Artifact 均返回 summary / 空目录正常 / 单 Artifact 损坏不污染其它 /
 * 同一输入 → 同一输出（确定性投影）/ summary 不含 Fact Layer。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResumeDocument, ResumeProposal } from '../ir/resume.ts'
import type { PortfolioProject, PortfolioProposal } from '../ir/portfolio.ts'
import type { InterviewQa, InterviewProposal } from '../ir/interview.ts'
import type { CoverLetter, CoverLetterProposal } from '../ir/cover-letter.ts'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { buildResumeSummary } from '../artifact-summary/resume-summary.ts'
import { buildPortfolioSummary } from '../artifact-summary/portfolio-summary.ts'
import { buildInterviewSummary } from '../artifact-summary/interview-summary.ts'
import { buildCoverLetterSummary } from '../artifact-summary/cover-letter-summary.ts'
import { buildArtifactSummaries } from '../artifact-summary/index.ts'

// ─── fixture ───────────────────────────────────────────────────────────────

function resumeDoc(overrides: Partial<ResumeDocument> = {}): ResumeDocument {
  return {
    id: 'resume_20260805_00001',
    status: 'review',
    person: '测试',
    templateId: 't1',
    templateVersion: '1.0',
    sections: [
      {
        type: 'experience',
        title: '经历',
        bullets: [
          { sentence: '完成夹具设计', claimId: 'claim_001' },
          { sentence: '负责验证', claimId: 'claim_002' },
        ],
      },
      { type: 'skills', title: '技能', bullets: [{ sentence: 'SolidWorks', claimId: 'claim_003' }], assetRefs: ['solidworks'] },
    ],
    generatedAt: '2026-08-05T10:00:00Z',
    ...overrides,
  }
}

function resumeProposal(overrides: Partial<ResumeProposal> = {}): ResumeProposal {
  return {
    id: 'proposal_20260805_00001',
    sourceResumeId: 'resume_20260805_00001',
    type: 'improve',
    changes: [{ targetClaimId: 'claim_001', section: 'experience', oldSentence: 'x', suggestedSentence: 'y', reason: '更量化' }],
    status: 'pending',
    createdBy: 'ai',
    ...overrides,
  }
}

function project(overrides: Partial<PortfolioProject> = {}): PortfolioProject {
  return {
    id: 'project_20260805_00001',
    status: 'draft',
    version: 1,
    factItems: [{ id: 'pf_001', statement: '完成自动化夹具设计', type: 'engineering_work', evidenceRefs: ['design_001'] }],
    evidence: [],
    transitions: [{ version: 1, from: '', to: 'draft', at: '2026-08-05T10:00:00Z' }],
    createdAt: '2026-08-05',
    ...overrides,
  }
}

function pp(overrides: Partial<PortfolioProposal> = {}): PortfolioProposal {
  return {
    id: 'pp_20260805_00001',
    projectId: 'project_20260805_00001',
    changes: [{ type: 'rewrite', factId: 'pf_001', old: 'x', new: 'y', reason: '目标岗位强调验证' }],
    status: 'pending',
    createdBy: 'ai',
    ...overrides,
  }
}

function qa(overrides: Partial<InterviewQa> = {}): InterviewQa {
  return {
    id: 'qa_20260805_00001',
    status: 'draft',
    question: '介绍一个项目',
    factItems: [],
    evidence: [],
    answerStatements: [],
    intents: [],
    transitions: [],
    ...overrides,
  }
}

function ip(overrides: Partial<InterviewProposal> = {}): InterviewProposal {
  return {
    id: 'ip_20260805_00001',
    qaId: 'qa_20260805_00001',
    changes: [{ type: 'rewrite', statementId: 'ans_001', old: 'x', new: 'y', reason: '更技术化' }],
    status: 'pending',
    createdBy: 'ai',
    ...overrides,
  }
}

function letter(overrides: Partial<CoverLetter> = {}): CoverLetter {
  return {
    id: 'cl_20260805_00001',
    status: 'draft',
    units: [
      {
        id: 'nu_001',
        text: '我主导了夹具设计',
        sourceRefs: [{ artifact: 'portfolio', scopeId: 'project_20260805_00001', factId: 'pf_001' }],
      },
      {
        id: 'nu_002',
        text: '回答过相关问题',
        sourceRefs: [
          { artifact: 'portfolio', scopeId: 'project_20260805_00001', factId: 'pf_002' },
          { artifact: 'interview', scopeId: 'qa_20260805_00001', factId: 'fact_001' },
        ],
      },
    ],
    deliveries: [],
    transitions: [{ from: '', to: 'draft', at: '2026-08-05T10:00:00Z' }],
    ...overrides,
  }
}

function clp(overrides: Partial<CoverLetterProposal> = {}): CoverLetterProposal {
  return {
    id: 'clp_20260805_00001',
    clId: 'cl_20260805_00001',
    changes: [{ type: 'adapt', unitId: 'nu_001', old: 'x', new: 'y', reason: '适配岗位' }],
    status: 'pending',
    createdBy: 'ai',
    ...overrides,
  }
}

function tempWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'cos-artifact-summary-'))
  return initWorkspace(root)
}

// ─── Resume adapter ────────────────────────────────────────────────────────

test('resume summary：空 → draft / 0 / 0 / 0 / 无 updatedAt', () => {
  const s = buildResumeSummary([], [])
  assert.equal(s.id, 'resume')
  assert.equal(s.type, 'resume')
  assert.deepEqual(s.state, { value: 'draft', label: '草稿' })
  assert.deepEqual(s.counts, { items: 0, pendingProposals: 0, references: 0 })
  assert.equal(s.updatedAt, undefined)
})

test('resume summary：版本状态 + bullets 总数 + pending 计数 + generatedAt', () => {
  const s = buildResumeSummary(
    [resumeDoc()],
    [resumeProposal(), resumeProposal({ id: 'proposal_2', status: 'accepted' })],
  )
  assert.deepEqual(s.state, { value: 'review', label: '评审中' })
  assert.deepEqual(s.counts, { items: 3, pendingProposals: 1, references: 0 })
  assert.equal(s.updatedAt, '2026-08-05T10:00:00Z')
})

test('resume summary：多版本取最新（文件名升序最后 = 时间戳最大）', () => {
  const s = buildResumeSummary(
    [resumeDoc({ id: 'resume_20260701_00001', status: 'draft', generatedAt: '2026-07-01T00:00:00Z' }),
     resumeDoc({ id: 'resume_20260805_00001', status: 'exported', generatedAt: '2026-08-05T00:00:00Z' })],
    [],
  )
  assert.deepEqual(s.state, { value: 'exported', label: '已导出' })
  assert.equal(s.updatedAt, '2026-08-05T00:00:00Z')
})

// ─── Portfolio adapter ─────────────────────────────────────────────────────

test('portfolio summary：published 优先聚合 + projects 数 + pending', () => {
  const s = buildPortfolioSummary(
    [project({ id: 'p1', status: 'reviewed' }), project({ id: 'p2', status: 'published' }), project({ id: 'p3' })],
    [pp(), pp({ id: 'pp_2', status: 'rejected' })],
  )
  assert.deepEqual(s.state, { value: 'published', label: '已发布' })
  assert.deepEqual(s.counts, { items: 3, pendingProposals: 1, references: 0 })
})

test('portfolio summary：updatedAt = 类内 transitions 最大 at；无 transitions 取 createdAt', () => {
  const s = buildPortfolioSummary(
    [project({ transitions: [{ version: 1, from: '', to: 'draft', at: '2026-08-01T00:00:00Z' }], createdAt: '2026-08-01' }),
     project({ transitions: [{ version: 1, from: '', to: 'draft', at: '2026-08-03T00:00:00Z' }] })],
    [],
  )
  assert.equal(s.updatedAt, '2026-08-03T00:00:00Z')
  const noTransition = buildPortfolioSummary([project({ transitions: [], createdAt: '2026-08-02' })], [])
  assert.equal(noTransition.updatedAt, '2026-08-02')
})

// ─── Interview adapter ─────────────────────────────────────────────────────

test('interview summary：ready 优先 + QA 数 + pending', () => {
  const s = buildInterviewSummary(
    [qa({ id: 'q1', status: 'ready' }), qa({ id: 'q2', status: 'reviewed' }), qa({ id: 'q3' })],
    [ip()],
  )
  assert.deepEqual(s.state, { value: 'ready', label: '就绪' })
  assert.deepEqual(s.counts, { items: 3, pendingProposals: 1, references: 0 })
})

// ─── Cover Letter adapter ──────────────────────────────────────────────────

test('cover-letter summary：units 总数 + sourceRefs 总数（唯一发出引用的 Artifact）', () => {
  const s = buildCoverLetterSummary([letter(), letter({ id: 'cl_2', units: [] })], [clp()])
  assert.deepEqual(s.state, { value: 'draft', label: '草稿' })
  assert.deepEqual(s.counts, { items: 2, pendingProposals: 1, references: 3 })
})

// ─── 确定性投影 + 结构约束 ────────────────────────────────────────────────

test('确定性：同一输入两次调用输出相等', () => {
  const inputs = [
    buildResumeSummary([resumeDoc()], [resumeProposal()]),
    buildPortfolioSummary([project({ status: 'published' })], [pp()]),
    buildInterviewSummary([qa({ status: 'ready' })], [ip()]),
    buildCoverLetterSummary([letter()], [clp()]),
  ]
  const again = [
    buildResumeSummary([resumeDoc()], [resumeProposal()]),
    buildPortfolioSummary([project({ status: 'published' })], [pp()]),
    buildInterviewSummary([qa({ status: 'ready' })], [ip()]),
    buildCoverLetterSummary([letter()], [clp()]),
  ]
  assert.deepEqual(inputs, again)
})

test('summary 不含 Fact Layer / Engine Projection 字段', () => {
  const s = buildCoverLetterSummary([letter()], [])
  assert.deepEqual(Object.keys(s).sort(), ['counts', 'id', 'state', 'type', 'updatedAt'])
  assert.deepEqual(Object.keys(s.counts).sort(), ['items', 'pendingProposals', 'references'])
  assert.deepEqual(Object.keys(s.state).sort(), ['label', 'value'])
  // 契约守卫：version / factItems / claims / sourceRefs / transitions 绝不出现在 summary 形状
  const flat = JSON.stringify(s)
  assert.ok(!flat.includes('version'))
  assert.ok(!flat.includes('factItems'))
  assert.ok(!flat.includes('sourceRefs'))
  assert.ok(!flat.includes('transitions'))
})

// ─── 聚合入口集成（真实 workspace）────────────────────────────────────────

test('聚合：空目录 → 四类 summary 全空态', () => {
  const ws = tempWorkspace()
  const all = buildArtifactSummaries(ws)
  assert.equal(all.length, 4)
  assert.deepEqual(all.map((s) => s.type), ['resume', 'portfolio', 'interview', 'cover-letter'])
  for (const s of all) {
    assert.deepEqual(s.state, { value: 'draft', label: '草稿' })
    assert.deepEqual(s.counts, { items: 0, pendingProposals: 0, references: 0 })
    assert.equal(s.updatedAt, undefined)
  }
})

test('聚合：单 Artifact 损坏不污染其它', () => {
  const ws = tempWorkspace()
  // 格式错乱的项目文件（无 frontmatter/表格——parse 容错，record 以文件名兜底）
  ws.write('portfolio/projects/坏项目.md', '# 坏项目\n\n随便写写，没有任何结构化内容\n')
  ws.write('resumes/documents/resume_20260805_00001.md', 'draft\n')
  const all = buildArtifactSummaries(ws)
  assert.equal(all.length, 4)
  // resume 卡不受坏 portfolio 文件影响（类型/状态正常；损坏 resume 文件被过滤——parse 空 record 不进 summary）
  const resume = all.find((s) => s.type === 'resume')
  assert.ok(resume)
  assert.equal(resume.type, 'resume')
  assert.deepEqual(resume.state, { value: 'draft', label: '草稿' })
  assert.deepEqual(resume.counts, { items: 0, pendingProposals: 0, references: 0 })
  // portfolio 卡自身也正常返回（损坏文件 parse 容错结构完整，计入 items）
  const portfolio = all.find((s) => s.type === 'portfolio')
  assert.ok(portfolio)
  assert.equal(portfolio.counts.items, 1)
})
