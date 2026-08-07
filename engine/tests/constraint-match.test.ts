import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { writeJDAnalysis } from '../storage/jd-analysis-writer.ts'
import { validateJDAnalysisProposal } from '../runtime/jd-analysis-validator.ts'
import { computeConstraintMatch } from '../transport/websocket.ts'
import type { JDAnalysisProposal } from '../ir/schema.ts'

/**
 * jobs/constraint-match RPC 投影回归（主线 3：UI 门槛区数据源）。
 * 三类岗位门槛：B 培养型（全维度四态）/ A 工程型（preferred 过滤）/ C 无门槛（空数组——UI 空态）。
 * 断言：学历四态 / 专业经验待确认 / 未登记文案 / 无门槛空数组。
 */

const A_ID = '2026-08-08-示例流体-流体机械工程师'
const B_ID = '2026-08-08-示例医疗-管理培训生'
const C_ID = '2026-08-08-示例自动化-机械设计工程师'

function setup(): ReturnType<typeof initWorkspace> {
  const root = mkdtempSync(join(tmpdir(), 'cos-cm-'))
  const ws = initWorkspace(root)
  // person_001：东华大学机械工程本科（2023 毕业，confirmed）——真实登记形态
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
| c-001 | 东华大学 | 机械工程 | 本科 | 2019 | 2023 | confirmed | resume |
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

test('B 培养型：学历 MATCHED + 专业/经验待确认（相关专业规则未定义 + 2023 毕业非应届 → NOT_MATCHED）', () => {
  const ws = setup()
  try {
    ws.write('jobs/2026-08-08-示例医疗-管理培训生.md', '# 管理培训生 — 示例医疗\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| company | 示例医疗 |\n| title | 管理培训生 |\n| created_at | 2026-08-08 |\n')
    analyze(ws, bProposal)
    const rows = computeConstraintMatch(ws, B_ID, 'person_001')
    assert.deepEqual(rows, [
      {
        dim: 'education',
        requirement: '本科；硕士；博士',
        person: '本科',
        status: 'MATCHED',
        note: undefined,
      },
      {
        dim: 'major',
        requirement: '生物医学工程、机械、材料等专业',
        person: '机械工程',
        status: 'NEEDS_CONFIRMATION',
        note: '相关专业判定规则未定义——需人工确认',
      },
      {
        dim: 'experience',
        requirement: 'fresh',
        person: '2023 年毕业',
        status: 'NOT_MATCHED',
        note: undefined,
      },
    ])
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('A 工程型：preferred 门槛不进入投影（学历/经验无 hard 维度）——只留 major 待确认行', () => {
  const ws = setup()
  try {
    ws.write('jobs/2026-08-08-示例流体-流体机械工程师.md', '# 流体机械工程师 — 示例流体\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| company | 示例流体 |\n| title | 流体机械工程师 |\n| created_at | 2026-08-08 |\n')
    analyze(ws, aProposal)
    const rows = computeConstraintMatch(ws, A_ID, 'person_001')
    assert.equal(rows.length, 1) // education/experience preferred 不产出
    assert.equal(rows[0]!.dim, 'major')
    assert.equal(rows[0]!.status, 'NEEDS_CONFIRMATION')
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('C 无门槛：空数组（UI 显示「暂无明确门槛要求」——不是全部缺失）', () => {
  const ws = setup()
  try {
    ws.write('jobs/2026-08-08-示例自动化-机械设计工程师.md', '# 机械设计工程师 — 示例自动化\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| company | 示例自动化 |\n| title | 机械设计工程师 |\n| created_at | 2026-08-08 |\n')
    analyze(ws, { jobId: C_ID, artifactVersion: 2, context: {}, constraints: {}, capabilities: [], generatedAt: '2026-08-08T10:00:00Z' })
    const rows = computeConstraintMatch(ws, C_ID, 'person_001')
    assert.deepEqual(rows, [])
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('门槛区数据完整性：未分析岗位（无门槛段）→ 空数组；person 不存在 → 报错（RPC 边界 fail fast）', () => {
  const ws = setup()
  try {
    ws.write('jobs/2026-08-08-示例自动化-机械设计工程师.md', '# 机械设计工程师 — 示例自动化\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| company | 示例自动化 |\n| title | 机械设计工程师 |\n| created_at | 2026-08-08 |\n')
    assert.deepEqual(computeConstraintMatch(ws, C_ID, 'person_001'), []) // 未分析 → 空（无门槛要求 ≠ 全部缺失）
    assert.throws(() => computeConstraintMatch(ws, C_ID, 'person_999'), /人不存在/)
    assert.throws(() => computeConstraintMatch(ws, '不存在-岗位', 'person_001'), /岗位不存在/)
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})
