import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { writeJDAnalysis } from '../storage/jd-analysis-writer.ts'
import { validateJDAnalysisProposal } from '../runtime/jd-analysis-validator.ts'
import { computeConstraintMatch, computeDecisionCandidate, computeJobMatch } from '../transport/websocket.ts'
import { resolveGapDisplay } from '../runtime/decision-draft.ts'
import { writeDecisionRecord } from '../storage/decision-writer.ts'
import { registerDecisionIdentity } from '../storage/decision-registry.ts'
import { parseDecisionMarkdown } from '../storage/report-watcher.ts'
import type { JDAnalysisProposal } from '../ir/schema.ts'

/**
 * Decision Writer 回归（Career Decision Loop v0.1，契约 references/career-decision-loop-contract-v0.1.md §10）。
 * Engine owns Facts + Agent owns Narrative + Writer owns Merge。
 * Case A 工程型（差距表 + Agent 叙述合并）/ B 培养型（MATCHED 不进表）/ C 无门槛（暂无明确差距）。
 */

const A_ID = '2026-08-08-示例流体-流体机械工程师'
const B_ID = '2026-08-08-示例医疗-管理培训生'
const C_ID = '2026-08-08-示例自动化-机械设计工程师'

const NOW = new Date('2026-08-08T10:00:00Z')

function setup(): ReturnType<typeof initWorkspace> {
  const root = mkdtempSync(join(tmpdir(), 'cos-dw-'))
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

function jobFile(ws: ReturnType<typeof initWorkspace>, id: string): void {
  ws.write(`jobs/${id}.md`, `# ${id} — 示例\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| company | 示例 |\n| title | ${id} |\n| created_at | 2026-08-08 |\n`)
}

function analyze(ws: ReturnType<typeof initWorkspace>, p: JDAnalysisProposal): void {
  jobFile(ws, p.jobId)
  writeJDAnalysis(ws, p, validateJDAnalysisProposal(p))
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
    { responsibility: '方案设计', priority: 'must', category: 'hard', capabilities: ['方案设计'], evidencePatterns: [], questions: [] },
  ],
  generatedAt: '2026-08-08T10:00:00Z',
}

const bProposal: JDAnalysisProposal = {
  jobId: B_ID,
  artifactVersion: 2,
  context: {},
  constraints: {
    education: { values: ['本科', '硕士', '博士'], source: '任职要求 1', confidence: 'high' },
    major: { values: ['生物医学工程、机械、材料等专业'], source: '任职要求 1', confidence: 'medium', matchMode: 'related' },
    experience: { values: ['fresh'], source: '任职要求 1', confidence: 'high' },
  },
  capabilities: [],
  generatedAt: '2026-08-08T10:00:00Z',
}

function compose(ws: ReturnType<typeof initWorkspace>, jobId: string, narrative?: Record<string, string>): string {
  const candidate = computeDecisionCandidate(ws, jobId, 'person_001')
  const rows = computeConstraintMatch(ws, jobId, 'person_001')
  const missing = computeJobMatch(ws, jobId, '我').missing
  return writeDecisionRecord(
    ws,
    { jobId, personId: 'person_001', displayRows: resolveGapDisplay(candidate, rows, missing), narrative },
    NOW,
  )
}

test('Case A 工程型：差距明细表 = Engine 事实（泵选型 NOT_DECLARED 未声明——不代表不具备），Agent 叙述并入 AI 参考段', () => {
  const ws = setup()
  try {
    analyze(ws, aProposal)
    const id = compose(ws, A_ID, {
      summary: '| 字段 | 值 |\n|------|-----|\n| person_id | person_001 |\n| direction_match | 52% |',
      understanding: '这个岗位主要负责泵阀测试系统结构设计。缺少流体机械经验需要补。',
      preparationPlan: '先补泵选型认知（扬程-流量-汽蚀余量），2-3 周。',
      resumeAdvice: '个人总结置顶 SolidWorks 与方案设计。',
    })
    const md = ws.read(`decisions/${id}.md`)
    // 系统登记 frontmatter
    assert.match(md, /^id: decision_\d{8}_\d{5}$/m)
    assert.match(md, /^type: jd-analysis$/m)
    assert.match(md, /^subject_id: 2026-08-08-示例流体-流体机械工程师$/m)
    assert.match(md, /^person_id: person_001$/m) // ADR-014：系统身份字段必写入 frontmatter（缺失 → 投影 invalid）
    // 差距明细：能力行（NOT_DECLARED + 未声明≠不具备）+ 专业行（BACKGROUND_RISK）
    assert.ok(md.includes('## 岗位差距明细'))
    assert.ok(md.includes('| 能力 | 泵选型 | 未声明 | NOT_DECLARED（未声明——不代表不具备） | SKILL_GAP | 是否具备「泵选型」？ |'))
    assert.ok(md.includes('| 专业 | 机械设计、流体机械等相关专业 | 机械工程 | NEEDS_CONFIRMATION（相关专业判定规则未定义——需人工确认） | BACKGROUND_RISK | 请确认「机械设计、流体机械等相关专业」相关情况 |'))
    // Agent 叙述：AI 参考标注，原文保留——「缺少流体机械经验」不影响事实表
    assert.ok(md.includes('AI 参考'))
    assert.ok(md.includes('缺少流体机械经验需要补。'))
    assert.ok(md.includes('## 准备建议'))
    assert.ok(md.includes('先补泵选型认知（扬程-流量-汽蚀余量），2-3 周。'))
    assert.ok(md.includes('## 简历调整方案'))
    assert.ok(md.includes('## 分析摘要'))
    // 记录可被现有决策投影协议解析（摘要表紧跟头——SUMMARY_RE 协议约束；title 非空不触发 NOT NULL）
    const parsed = parseDecisionMarkdown(md, `${id}.md`)
    assert.equal(parsed.value.title, `岗位决策 — ${A_ID}`)
    // subject_id → subjectId：jd-analysis 决策直连岗位 ID（UI 关联不靠标题解析）
    assert.equal(parsed.value.subjectId, A_ID)
    assert.ok(!parsed.validation?.issues.some((i) => i.reason.includes('未找到')))
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('Case B 培养型：学历 MATCHED 不进差距表（只留专业/经验行）', () => {
  const ws = setup()
  try {
    analyze(ws, bProposal)
    const id = compose(ws, B_ID)
    const md = ws.read(`decisions/${id}.md`)
    assert.ok(md.includes('| 专业 | 生物医学工程、机械、材料等专业 | 机械工程 | NEEDS_CONFIRMATION（相关专业判定规则未定义——需人工确认） | BACKGROUND_RISK | 请确认「生物医学工程、机械、材料等专业」相关情况 |'))
    assert.ok(md.includes('| 经验 | fresh | 2023 年毕业 | NOT_MATCHED | BACKGROUND_RISK |  |'))
    assert.ok(!md.includes('| 学历 |')) // MATCHED 不产出
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('Case C 无门槛：暂无明确差距（不是「没有优势」）', () => {
  const ws = setup()
  try {
    analyze(ws, { jobId: C_ID, artifactVersion: 2, context: {}, constraints: {}, capabilities: [], generatedAt: '2026-08-08T10:00:00Z' })
    const id = compose(ws, C_ID)
    const md = ws.read(`decisions/${id}.md`)
    assert.ok(md.includes('暂无明确差距——无未满足的硬性门槛，画像无未声明能力。'))
    assert.ok(!md.includes('| 能力 |'))
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('边界：narrative 含引擎事实区标题（## 岗位差距明细）→ 拒绝（Writer 保护事实区）', () => {
  const ws = setup()
  try {
    analyze(ws, aProposal)
    assert.throws(
      () => compose(ws, A_ID, { understanding: '## 岗位差距明细\n| 能力 | 泵选型 | 未声明 |' }),
      /禁止包含引擎事实区标题/,
    )
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('系统登记：两次写入生成不同系统 ID；registerDecisionIdentity 幂等（已登记命名跳过，registered 0）', () => {
  const ws = setup()
  try {
    analyze(ws, aProposal)
    const id1 = compose(ws, A_ID)
    const id2 = compose(ws, A_ID)
    assert.notEqual(id1, id2)
    assert.match(id1, /^decision_20260808_\d{5}$/)
    assert.match(id2, /^decision_20260808_\d{5}$/)
    assert.equal(registerDecisionIdentity(ws, NOW).registered, 0)
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('无叙述草稿：记录只有 Engine 事实段（差距明细照常，无 AI 参考叙述段）', () => {
  const ws = setup()
  try {
    analyze(ws, aProposal)
    const id = compose(ws, A_ID)
    const md = ws.read(`decisions/${id}.md`)
    assert.ok(md.includes('| 能力 | 泵选型 | 未声明 | NOT_DECLARED（未声明——不代表不具备） | SKILL_GAP | 是否具备「泵选型」？ |'))
    assert.ok(!md.includes('## 岗位理解'))
    assert.ok(!md.includes('## 准备建议'))
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('存量旧记录：无 subject_id frontmatter → subjectId undefined（标题回退合法，解析不破坏）', () => {
  const ws = setup()
  try {
    ws.write(
      'decisions/legacy-1.md',
      `---
id: decision_20260807_00001
created_at: 2026-08-07
---

# JD 分析 — 示例公司 · 机械结构工程师

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill | jd-analysis |
| direction | 机器人本体设计 |
| direction_match | 52% |
| direction_confidence | 中 |
| city | 苏州 |
| city_score | 60% |
| salary_feasible | true |
| risk_level | 中 |
| key_risk | 行业竞争 |
| status | 进行中 |
| protocol_version | 2.1 |
| profile | 我 |
`,
    )
    const parsed = parseDecisionMarkdown(ws.read('decisions/legacy-1.md'), 'legacy-1.md')
    assert.equal(parsed.value.subjectId, undefined)
    assert.equal(parsed.value.title, 'JD 分析 — 示例公司 · 机械结构工程师')
    assert.equal(parsed.value.skill, 'jd-analysis')
    assert.ok(!parsed.validation?.issues.some((i) => i.severity === 'error'))
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('summary 非摘要表格（自由文本）→ 拒绝（fail fast，不写必判 invalid 的记录）', () => {
  const ws = setup()
  try {
    assert.throws(
      () => writeDecisionRecord(ws, { jobId: A_ID, personId: 'person_001', displayRows: [], narrative: { summary: '自由文本不是表格' } }, NOW),
      /摘要表格/,
    )
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})
