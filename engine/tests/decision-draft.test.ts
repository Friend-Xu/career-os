import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { writeJDAnalysis } from '../storage/jd-analysis-writer.ts'
import { validateJDAnalysisProposal } from '../runtime/jd-analysis-validator.ts'
import { computeConstraintMatch, computeDecisionCandidate } from '../transport/websocket.ts'
import { buildDecisionCandidate, constraintRefOf } from '../runtime/decision-draft.ts'
import type { JDAnalysisProposal } from '../ir/schema.ts'

/**
 * jobs/decision-draft RPC 投影回归（Career Decision Loop v0.1，契约 references/career-decision-loop-contract-v0.1.md）。
 * 断言：只引用不复制（GapRow 无 requirement/status 拷贝）/ MATCHED 不产出 / actionCategory 维度确定性映射 /
 * question 固定模板派生（NOT_MATCHED 无问题）/ capability 未声明 → SKILL_GAP / 边界报错。
 */

const B_ID = '2026-08-08-示例医疗-管理培训生'
const A_ID = '2026-08-08-示例流体-流体机械工程师'
const C_ID = '2026-08-08-示例自动化-机械设计工程师'
const D_ID = '2026-08-08-示例泵阀-泵选型工程师'

function setup(): ReturnType<typeof initWorkspace> {
  const root = mkdtempSync(join(tmpdir(), 'cos-dd-'))
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

function analyze(ws: ReturnType<typeof initWorkspace>, p: JDAnalysisProposal): void {
  writeJDAnalysis(ws, p, validateJDAnalysisProposal(p))
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

const aProposal: JDAnalysisProposal = {
  jobId: A_ID,
  artifactVersion: 2,
  context: {},
  constraints: {
    education: { values: ['本科以上学历优先考虑'], source: '任职要求 1', confidence: 'medium', matchMode: 'preferred' },
    major: { values: ['机械设计、流体机械等相关专业优先考虑'], source: '任职要求 1', confidence: 'medium', matchMode: 'related' },
    experience: { values: ['有流体系统集成经验者优先'], source: '任职要求 5', confidence: 'medium', matchMode: 'preferred' },
  },
  capabilities: [],
  generatedAt: '2026-08-08T10:00:00Z',
}

const dProposal: JDAnalysisProposal = {
  jobId: D_ID,
  artifactVersion: 2,
  context: {},
  constraints: {},
  capabilities: [
    { responsibility: '泵选型', priority: 'must', category: 'hard', capabilities: ['泵选型'], evidencePatterns: [], questions: [] },
    { responsibility: '方案设计', priority: 'must', category: 'hard', capabilities: ['方案设计'], evidencePatterns: [], questions: [] },
  ],
  generatedAt: '2026-08-08T10:00:00Z',
}

function withJob(ws: ReturnType<typeof initWorkspace>, id: string): void {
  ws.write(`jobs/${id}.md`, `# ${id.split('-').slice(3).join('-')} — 示例\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| company | 示例 |\n| title | ${id} |\n| created_at | 2026-08-08 |\n`)
}

test('B 培养型：学历 MATCHED 不产出；专业 → BACKGROUND_RISK + 确认问题；经验 NOT_MATCHED → 无问题', () => {
  const ws = setup()
  try {
    withJob(ws, B_ID)
    analyze(ws, bProposal)
    const candidate = computeDecisionCandidate(ws, B_ID, 'person_001')
    assert.equal(candidate.jobId, B_ID)
    assert.equal(candidate.gaps.length, 2) // major + experience（education MATCHED 不产出）
    const [major, experience] = candidate.gaps
    assert.deepEqual(major!.actionCategory, 'BACKGROUND_RISK')
    assert.equal(major!.question!.type, 'CONFIRM_BACKGROUND')
    assert.equal(major!.question!.targetId, major!.constraintRef)
    assert.equal(major!.question!.template, '请确认「生物医学工程、机械、材料等专业」相关情况')
    assert.equal(experience!.actionCategory, 'BACKGROUND_RISK')
    assert.equal(experience!.question, undefined) // NOT_MATCHED 事实明确，无确认问题
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('只引用不复制：GapRow 不含 requirement/status 拷贝——constraintRef 与门槛行 id 稳定一致', () => {
  const ws = setup()
  try {
    withJob(ws, B_ID)
    analyze(ws, bProposal)
    const rows = computeConstraintMatch(ws, B_ID, 'person_001')
    const candidate = computeDecisionCandidate(ws, B_ID, 'person_001')
    const refs = new Set(candidate.gaps.map((g) => g.constraintRef))
    assert.equal(refs.size, 2)
    for (const row of rows) {
      if (row.status === 'MATCHED') continue
      assert.ok(refs.has(row.id), `GapRow 引用门槛行 id：${row.id}`)
      assert.equal(row.id, constraintRefOf(row.dim, row.requirement)) // 确定性派生，重复调用稳定
    }
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('门槛行携带证据引用（EvidenceRef——画像事实回源，非自由文本）', () => {
  const ws = setup()
  try {
    withJob(ws, B_ID)
    analyze(ws, bProposal)
    const rows = computeConstraintMatch(ws, B_ID, 'person_001')
    const edu = rows.find((r) => r.dim === 'education')!
    assert.deepEqual(edu.personEvidence, [{ source: 'education', id: 'c-001' }])
    const major = rows.find((r) => r.dim === 'major')!
    assert.deepEqual(major.personEvidence, [{ source: 'education', id: 'c-001' }])
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('A 工程型：preferred 不进门槛 → 只留 major 待确认 1 个差距', () => {
  const ws = setup()
  try {
    withJob(ws, A_ID)
    analyze(ws, aProposal)
    const candidate = computeDecisionCandidate(ws, A_ID, 'person_001')
    assert.equal(candidate.gaps.length, 1)
    assert.equal(candidate.gaps[0]!.actionCategory, 'BACKGROUND_RISK')
    assert.equal(candidate.gaps[0]!.question!.type, 'CONFIRM_BACKGROUND')
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('C 无门槛岗位：无差距（空数组——不是全部缺失）', () => {
  const ws = setup()
  try {
    withJob(ws, C_ID)
    analyze(ws, { jobId: C_ID, artifactVersion: 2, context: {}, constraints: {}, capabilities: [], generatedAt: '2026-08-08T10:00:00Z' })
    const candidate = computeDecisionCandidate(ws, C_ID, 'person_001')
    assert.deepEqual(candidate.gaps, [])
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('D 能力差距：hard 能力未声明 → SKILL_GAP + CONFIRM_CAPABILITY（模板派生）', () => {
  const ws = setup()
  try {
    withJob(ws, D_ID)
    analyze(ws, dProposal)
    const candidate = computeDecisionCandidate(ws, D_ID, 'person_001')
    assert.equal(candidate.gaps.length, 2)
    for (const g of candidate.gaps) {
      assert.equal(g.actionCategory, 'SKILL_GAP')
      assert.equal(g.question!.type, 'CONFIRM_CAPABILITY')
      assert.equal(g.question!.targetId, g.constraintRef)
    }
    assert.equal(candidate.gaps[0]!.question!.template, '是否具备「泵选型」？')
    assert.equal(candidate.gaps[0]!.constraintRef, constraintRefOf('capability', '泵选型'))
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('边界：岗位不存在 / 人不存在 → RPC fail fast 报错', () => {
  const ws = setup()
  try {
    withJob(ws, D_ID)
    analyze(ws, dProposal)
    assert.throws(() => computeDecisionCandidate(ws, D_ID, 'person_999'), /人不存在/)
    assert.throws(() => computeDecisionCandidate(ws, '不存在-岗位', 'person_001'), /岗位不存在/)
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('buildDecisionCandidate 纯函数：MATCHED 行排除 + 能力行追加（顺序：门槛行 → 能力行）', () => {
  const rows = [
    { id: 'education:x1', dim: 'education' as const, requirement: '本科', person: '本科', personEvidence: [], status: 'MATCHED' as const },
    { id: 'major:x2', dim: 'major' as const, requirement: '机械', person: '机械工程', personEvidence: [], status: 'NEEDS_CONFIRMATION' as const },
  ]
  const candidate = buildDecisionCandidate('J1', rows, [{ name: '泵选型', essential: true, source: 'JD', action: 'x' }])
  assert.equal(candidate.gaps.length, 2)
  assert.equal(candidate.gaps[0]!.constraintRef, 'major:x2')
  assert.equal(candidate.gaps[1]!.constraintRef, constraintRefOf('capability', '泵选型'))
  assert.equal(candidate.gaps[1]!.actionCategory, 'SKILL_GAP')
})
