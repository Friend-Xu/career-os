import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { writeJDAnalysis } from '../storage/jd-analysis-writer.ts'
import { validateJDAnalysisProposal } from '../runtime/jd-analysis-validator.ts'
import { computeDecisionCandidate, computeConstraintMatch, computeJobMatch, computeResumeRewriteContext } from '../transport/websocket.ts'
import { resolveGapDisplay } from '../runtime/decision-draft.ts'
import { writeDecisionRecord } from '../storage/decision-writer.ts'
import { buildResumeRewriteContext, parseNarrativeSections } from '../runtime/resume-context.ts'
import type { JDAnalysisProposal } from '../ir/schema.ts'

/**
 * Resume Rewrite Context 适配回归（Career Decision Loop v0.1 Step 4，契约 §12）。
 * Decision Record → Adapter → ResumeRewriteContext：resume-writing 只消费结构化上下文，不解析 decisions/ markdown。
 * 语义边界：GapReference 传 dimension/requirement/status/evidence——禁止「缺少流体机械经验」自由文本判断。
 */

const A_ID = '2026-08-08-示例流体-流体机械工程师'

const NOW = new Date('2026-08-08T10:00:00Z')

function setup(): ReturnType<typeof initWorkspace> {
  const root = mkdtempSync(join(tmpdir(), 'cos-rc-'))
  const ws = initWorkspace(root)
  ws.write('persons/person_001/manifest.md', `---
id: person_001
name: 我
status: active
created_at: 2026-08-08
---

# Person 001 — 我
`)
  ws.write('persons/person_001/facts/education.md', `# 教育事实登记

| 候选 ID | 学校 | 专业 | 学历 | 起始年 | 毕业年 | 状态 | 来源 |
|---------|------|------|------|--------|--------|------|------|
| c-001 | University-A | 机械工程 | 本科 | 2019 | 2023 | confirmed | resume |
`)
  ws.write('persons/person_001/snapshot/current/identity.md', '# Person 001\n')
  return ws
}

const aProposal: JDAnalysisProposal = {
  jobId: A_ID,
  artifactVersion: 2,
  context: {},
  constraints: {
    major: { values: ['机械设计、流体机械等相关专业'], source: '任职要求 1', confidence: 'medium', matchMode: 'related' },
  },
  capabilities: [
    { responsibility: '泵选型', priority: 'must', category: 'hard', capabilities: ['泵选型'], evidencePatterns: [], questions: [] },
    { responsibility: '流体系统集成', priority: 'must', category: 'hard', capabilities: ['流体系统集成'], evidencePatterns: [], questions: [] },
  ],
  generatedAt: '2026-08-08T10:00:00Z',
}

function compose(ws: ReturnType<typeof initWorkspace>, narrative?: Record<string, string>): string {
  ws.write(`jobs/${A_ID}.md`, `# ${A_ID} — 示例\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| company | 示例 |\n| title | ${A_ID} |\n| created_at | 2026-08-08 |\n`)
  writeJDAnalysis(ws, aProposal, validateJDAnalysisProposal(aProposal))
  const candidate = computeDecisionCandidate(ws, A_ID, 'person_001')
  const rows = computeConstraintMatch(ws, A_ID, 'person_001')
  const missing = computeJobMatch(ws, A_ID, '我').missing
  return writeDecisionRecord(
    ws,
    { jobId: A_ID, personId: 'person_001', displayRows: resolveGapDisplay(candidate, rows, missing), narrative },
    NOW,
  )
}

test('适配：决策记录 → ResumeRewriteContext——泵选型/流体系统集成 NOT_DECLARED 进入上下文，证据引用回源', () => {
  const ws = setup()
  try {
    const decisionId = compose(ws, {
      summary: '| 字段 | 值 |\n|------|-----|\n| person_id | person_001 |\n| skill | jd-analysis |\n| direction_match | 52% |',
      preparationPlan: '先补泵选型认知（扬程-流量-汽蚀余量），2-3 周。',
    })
    const ctx = computeResumeRewriteContext(ws, decisionId, 'person_001')
    assert.equal(ctx.jobId, A_ID)
    // 差距：能力未声明（证据空）+ 专业待确认（证据 = 教育候选 c-001）
    const pump = ctx.confirmedGaps.find((g) => g.dimension === 'capability' && g.requirement === '泵选型')!
    assert.deepEqual(pump, { dimension: 'capability', requirement: '泵选型', status: 'NOT_DECLARED', evidence: [] })
    const fluid = ctx.confirmedGaps.find((g) => g.requirement === '流体系统集成')!
    assert.equal(fluid.status, 'NOT_DECLARED')
    const major = ctx.confirmedGaps.find((g) => g.dimension === 'major')!
    assert.deepEqual(major.evidence, [{ source: 'education', id: 'c-001' }])
    // 证据亮点：去重（education c-001 只出现一次）
    assert.deepEqual(ctx.evidenceHighlights, [{ source: 'education', id: 'c-001' }])
    // 叙述段：AI 参考内容结构化携带
    assert.deepEqual(ctx.preparationNotes, [{ section: 'preparationPlan', content: '先补泵选型认知（扬程-流量-汽蚀余量），2-3 周。' }])
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('语义边界：叙述中的「缺少经验」自由文本不进差距字段（requirements 全部来自 JD 原文）', () => {
  const ws = setup()
  try {
    const decisionId = compose(ws, {
      preparationPlan: '先补泵选型认知。缺少流体机械经验需要补。',
    })
    const ctx = computeResumeRewriteContext(ws, decisionId, 'person_001')
    for (const g of ctx.confirmedGaps) {
      assert.ok(!g.requirement.includes('缺少'), `requirement 被自由文本污染：${g.requirement}`)
      assert.ok(!g.requirement.includes('不足'))
    }
    assert.ok(ctx.preparationNotes[0]!.content.includes('缺少流体机械经验')) // AI 参考保留原样，但不影响差距字段
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('parseNarrativeSections：剥离 AI 参考标注行；空段不产出；多段按序', () => {
  const md = `## 岗位理解

> AI 参考：以下内容由 Agent 生成，不构成系统事实。

这个岗位主要负责泵阀测试系统。

## 准备建议

> AI 参考：以下内容由 Agent 生成，不构成系统事实。

先补泵选型认知。

## 简历调整方案

> AI 参考：以下内容由 Agent 生成，不构成系统事实。

个人总结置顶 SolidWorks。

## 岗位差距明细

| 引用 | 维度 |
|---|---|
| x | 能力 |
`
  assert.deepEqual(parseNarrativeSections(md), [
    { section: 'understanding', content: '这个岗位主要负责泵阀测试系统。' },
    { section: 'preparationPlan', content: '先补泵选型认知。' },
    { section: 'resumeAdvice', content: '个人总结置顶 SolidWorks。' },
  ])
})

test('buildResumeRewriteContext：evidenceHighlights 按 source:id 去重', () => {
  const ctx = buildResumeRewriteContext(
    'J1',
    [{ constraintRef: 'r1', dim: 'major', requirement: '机械', person: '机械工程', status: 'NEEDS_CONFIRMATION', actionCategory: 'BACKGROUND_RISK' }],
    new Map([
      ['r1', [{ source: 'education', id: 'c-001' }]],
      ['r2', [{ source: 'education', id: 'c-001' }, { source: 'skill_inventory', id: 's1' }]],
    ]),
    [],
  )
  assert.deepEqual(ctx.evidenceHighlights, [
    { source: 'education', id: 'c-001' },
    { source: 'skill_inventory', id: 's1' },
  ])
})

test('边界：决策记录不存在 / 缺 subject_id / 人不存在 → fail fast', () => {
  const ws = setup()
  try {
    assert.throws(() => computeResumeRewriteContext(ws, 'decision_99999999_00000', 'person_001'), /不存在/)
    const decisionId = compose(ws)
    ws.write('decisions/decision_20260808_00099.md', '---\nid: decision_20260808_00099\n---\n# 无 subject_id 记录\n')
    assert.throws(() => computeResumeRewriteContext(ws, 'decision_20260808_00099', 'person_001'), /subject_id/)
    assert.throws(() => computeResumeRewriteContext(ws, decisionId, 'person_999'), /人不存在/)
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})
