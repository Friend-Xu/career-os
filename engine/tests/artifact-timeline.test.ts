/**
 * artifact-timeline 单测（M4-5.3）：四 adapter 事件映射 + 确定性排序 + 聚合集成。
 * 验收：同 Artifact 文件 → 同 Timeline / 不包含 Proposal 独立事件 / 同 timestamp 稳定排序 /
 * replay 一致 / Resume timeline 不读取 Portfolio。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResumeDocument } from '../ir/resume.ts'
import type { PortfolioProject } from '../ir/portfolio.ts'
import type { InterviewQa } from '../ir/interview.ts'
import type { CoverLetter } from '../ir/cover-letter.ts'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { buildResumeTimeline } from '../artifact-timeline/resume-timeline.ts'
import { buildPortfolioTimeline } from '../artifact-timeline/portfolio-timeline.ts'
import { buildInterviewTimeline } from '../artifact-timeline/interview-timeline.ts'
import { buildCoverLetterTimeline } from '../artifact-timeline/cover-letter-timeline.ts'
import { buildArtifactTimeline } from '../artifact-timeline/index.ts'

// ─── fixture ───────────────────────────────────────────────────────────────

function resumeDoc(overrides: Partial<ResumeDocument> = {}): ResumeDocument {
  return {
    id: 'resume_20260805_00001',
    status: 'exported',
    person: '测试',
    templateId: 't1',
    templateVersion: '1.0',
    sections: [],
    generatedAt: '2026-08-05T10:00:00Z',
    operations: [
      { id: 'operation_001', actor: 'ai', action: 'create', at: '2026-08-05T10:00:00Z' },
      { id: 'operation_002', actor: 'user', action: 'submit_review', at: '2026-08-05T11:00:00Z' },
      { id: 'operation_003', actor: 'user', action: 'export', at: '2026-08-05T12:00:00Z' },
    ],
    ...overrides,
  }
}

function project(overrides: Partial<PortfolioProject> = {}): PortfolioProject {
  return {
    id: 'project_20260805_00001',
    status: 'published',
    version: 4,
    factItems: [],
    evidence: [],
    transitions: [
      { version: 1, from: '', to: 'draft', at: '2026-08-05T08:00:00Z' },
      { version: 2, from: 'draft', to: 'reviewed', at: '2026-08-05T09:00:00Z' },
      { version: 3, from: 'reviewed', to: 'published', at: '2026-08-05T10:00:00Z' },
      { version: 4, from: 'published', to: 'draft', at: '2026-08-05T11:00:00Z', via: 'pp_20260805_00001' },
    ],
    createdAt: '2026-08-05',
    ...overrides,
  }
}

function qa(overrides: Partial<InterviewQa> = {}): InterviewQa {
  return {
    id: 'qa_20260805_00001',
    status: 'ready',
    question: 'q',
    factItems: [],
    evidence: [],
    answerStatements: [],
    intents: [],
    transitions: [
      { from: '', to: 'draft', at: '2026-08-05T08:00:00Z' },
      { from: 'draft', to: 'reviewed', at: '2026-08-05T09:00:00Z' },
      { from: 'reviewed', to: 'ready', at: '2026-08-05T10:00:00Z' },
    ],
    ...overrides,
  }
}

function letter(overrides: Partial<CoverLetter> = {}): CoverLetter {
  return {
    id: 'cl_20260805_00001',
    status: 'ready',
    units: [],
    deliveries: [{ targetCompany: '示例公司', at: '2026-08-05T12:00:00Z' }],
    transitions: [
      { from: '', to: 'draft', at: '2026-08-05T08:00:00Z' },
      { from: 'draft', to: 'reviewed', at: '2026-08-05T09:00:00Z' },
      { from: 'reviewed', to: 'ready', at: '2026-08-05T10:00:00Z', via: 'clp_20260805_00001' },
    ],
    ...overrides,
  }
}

function tempWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'cos-artifact-timeline-'))
  return initWorkspace(root)
}

// ─── Resume ────────────────────────────────────────────────────────────────

test('resume：operations 映射——created / state_transition / expression_changed(source) / 越界跳过', () => {
  const events = buildResumeTimeline([
    resumeDoc({
      operations: [
        { id: 'op1', actor: 'ai', action: 'create', at: '2026-08-01T00:00:00Z' },
        { id: 'op2', actor: 'ai', action: 'attempt_change_status', rejected: true, at: '2026-08-01T01:00:00Z' },
        { id: 'op3', actor: 'user', action: 'submit_review', at: '2026-08-01T02:00:00Z' },
        { id: 'op4', actor: 'ai', action: 'apply_proposal', note: 'proposal_20260801_00001', at: '2026-08-01T03:00:00Z' },
      ],
    }),
  ]).map((t) => t.event)
  assert.deepEqual(events.map((e) => [e.event, e.title]), [
    ['created', 'Created'],
    ['state_transition', 'State changed'],
    ['expression_changed', 'Expression changed'],
  ])
  assert.equal(events[2].source?.id, 'proposal_20260801_00001')
  assert.equal(events[1].detail, 'draft → review')
})

test('resume：无 operations → generatedAt 投影 created；rejected 操作跳过', () => {
  const withOps = buildResumeTimeline([resumeDoc()]).map((t) => t.event)
  assert.deepEqual(withOps.map((e) => [e.event, e.detail]), [
    ['created', undefined],
    ['state_transition', 'draft → review'],
    ['state_transition', 'review → exported'],
  ])
  const noOps = buildResumeTimeline([resumeDoc({ operations: undefined })]).map((t) => t.event)
  assert.equal(noOps.length, 1)
  assert.deepEqual([noOps[0].event, noOps[0].at], ['created', '2026-08-05T10:00:00Z'])
})

// ─── Portfolio / Interview / Cover Letter ──────────────────────────────────

test('portfolio：created / state_transition / expression_changed(via → source 非事件)', () => {
  const events = buildPortfolioTimeline([project()]).map((t) => t.event)
  assert.deepEqual(events.map((e) => [e.event, e.detail, e.source?.id]), [
    ['created', undefined, undefined],
    ['state_transition', 'draft → reviewed', undefined],
    ['state_transition', 'reviewed → published', undefined],
    ['expression_changed', undefined, 'pp_20260805_00001'],
  ])
})

test('portfolio：无 transitions 有 createdAt → 投影 created', () => {
  const events = buildPortfolioTimeline([project({ transitions: [] })]).map((t) => t.event)
  assert.equal(events.length, 1)
  assert.deepEqual([events[0].event, events[0].at], ['created', '2026-08-05'])
})

test('interview：transitions 映射同 Portfolio', () => {
  const events = buildInterviewTimeline([qa()]).map((t) => t.event)
  assert.deepEqual(events.map((e) => [e.event, e.detail]), [
    ['created', undefined],
    ['state_transition', 'draft → reviewed'],
    ['state_transition', 'reviewed → ready'],
  ])
})

test('cover-letter：transitions + delivery 事件', () => {
  const events = buildCoverLetterTimeline([letter()]).map((t) => t.event)
  assert.deepEqual(events.map((e) => [e.event, e.detail, e.source?.id]), [
    ['created', undefined, undefined],
    ['state_transition', 'draft → reviewed', undefined],
    ['expression_changed', undefined, 'clp_20260805_00001'],
    ['delivery', '示例公司', undefined],
  ])
})

// ─── 无 Proposal 独立事件（验收：Proposal 是 source 非事件类型）────────────

test('全部事件不包含 Proposal 独立事件（via 只出现在 source.id）', () => {
  const all = [
    ...buildResumeTimeline([resumeDoc()]),
    ...buildPortfolioTimeline([project()]),
    ...buildInterviewTimeline([qa()]),
    ...buildCoverLetterTimeline([letter()]),
  ].map((t) => t.event)
  const VALID_EVENTS = ['created', 'state_transition', 'expression_changed', 'delivery']
  for (const e of all) {
    assert.ok(VALID_EVENTS.includes(e.event), `非法事件类型：${e.event}`)
    if (e.source) {
      assert.equal(e.source.type, 'proposal')
      assert.ok(e.source.id.length > 0)
    }
  }
})

// ─── 确定性 + 排序 ────────────────────────────────────────────────────────

test('确定性：同一输入两次调用输出相等（四 adapter + 聚合）', () => {
  const a = buildArtifactTimeline(tempWorkspace())
  assert.deepEqual(a, buildArtifactTimeline(tempWorkspace()))
  const once = [
    buildResumeTimeline([resumeDoc()]).map((t) => t.event),
    buildPortfolioTimeline([project()]).map((t) => t.event),
  ]
  const again = [
    buildResumeTimeline([resumeDoc()]).map((t) => t.event),
    buildPortfolioTimeline([project()]).map((t) => t.event),
  ]
  assert.deepEqual(once, again)
})

test('排序：同 timestamp → append order 稳定（created 先于同刻 state_transition）', () => {
  const events = buildPortfolioTimeline([
    project({
      transitions: [
        { version: 1, from: '', to: 'draft', at: '2026-08-05T10:00:00Z' },
        { version: 2, from: 'draft', to: 'reviewed', at: '2026-08-05T10:00:00Z' },
      ],
    }),
  ]).map((t) => t.event)
  assert.deepEqual(events.map((e) => e.event), ['created', 'state_transition'])
})

test('排序：跨实体同 timestamp → 事件 id lexical fallback 稳定（聚合入口）', () => {
  const ws = tempWorkspace()
  const md = (id: string): string => `---
id: ${id}
---

> status: draft
> version: 1

## 项目事实

| id | statement | type | evidence |
|----|-----------|------|----------|

## 证据资产

| id | type | location | metadata |
|----|------|----------|----------|

## 演化记录

| version | from | to | at | via |
|---------|------|----|----|-----|
| 1 | - | draft | 2026-08-05T10:00:00Z | - |
`
  ws.write('portfolio/projects/project_b.md', md('project_b'))
  ws.write('portfolio/projects/project_a.md', md('project_a'))
  const events = buildArtifactTimeline(ws)
  assert.deepEqual(events.map((e) => e.artifactId), ['project_a', 'project_b'])
})

// ─── 隔离 ──────────────────────────────────────────────────────────────────

test('隔离：Resume timeline 只消费 resume 数据', () => {
  const events = buildResumeTimeline([resumeDoc()]).map((t) => t.event)
  assert.ok(events.every((e) => e.artifactType === 'resume'))
  // 聚合入口：portfolio 数据不影响 resume 事件序列
  const all = buildArtifactTimeline(tempWorkspace())
  assert.deepEqual(all.map((e) => e.artifactType), [])
})

// ─── 集成 ──────────────────────────────────────────────────────────────────

test('聚合：空目录 → 空 timeline', () => {
  const all = buildArtifactTimeline(tempWorkspace())
  assert.deepEqual(all, [])
})
