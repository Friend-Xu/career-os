import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { createJobFile } from '../storage/job-watcher.ts'
import { writeJDAnalysis } from '../storage/jd-analysis-writer.ts'
import { validateJDAnalysisProposal } from '../runtime/jd-analysis-validator.ts'
import { parseJdConstraint } from '../runtime/jd-constraint.ts'
import { matchEducation } from '../runtime/constraint-matcher.ts'
import type { JDAnalysisProposal } from '../ir/schema.ts'

function setup(): ReturnType<typeof initWorkspace> {
  const root = mkdtempSync(join(tmpdir(), 'cos-jdan-'))
  const ws = initWorkspace(root)
  ws.write('knowledge/skills.md', '# 技能词表\n\n## 办公软件\n')
  return ws
}

const jobId = '2026-08-07-Company-A 医疗-管理培训生'

function createJob(ws: ReturnType<typeof initWorkspace>): void {
  createJobFile(
    ws,
    {
      company: 'Company-A 医疗',
      title: '管理培训生',
      location: 'City-Y',
      salary: '8-15k·15薪',
      requirements: '熟练使用办公软件;数据整理与文案',
      jdText: '任职要求 1：本科/硕士/博士应届生。',
    },
    new Date('2026-08-07T00:00:00Z'),
  )
}

const validProposal: JDAnalysisProposal = {
  jobId,
  artifactVersion: 2,
  context: {
    workMode: [{ value: '轮岗学习；跨部门项目推进', source: '岗位定位', confidence: 'high' }],
    careerPath: [{ value: '入职 → 6 个月轮岗 → 定岗', source: '培养机制', confidence: 'high' }],
    industry: [{ value: '医疗器械（神经介入）', source: '企业简介', confidence: 'medium' }],
  },
  constraints: {
    education: { values: ['本科', '硕士', '博士'], source: '任职要求 1', confidence: 'high' },
    major: { values: ['生物医学工程', '机械'], source: '任职要求 2', confidence: 'high' },
  },
  capabilities: [
    {
      responsibility: '数据整理与文案输出',
      priority: 'must',
      category: 'hard',
      capabilities: ['办公软件', '数据整理'],
      evidencePatterns: ['method', 'validation'],
      questions: ['你用哪些工具整理数据；如何验证数据准确性'],
    },
    {
      responsibility: '多部门轮岗学习',
      priority: 'must',
      category: 'soft',
      capabilities: ['跨部门协作', '学习能力'],
      evidencePatterns: ['scope', 'method'],
      questions: ['你轮岗过哪些部门'],
    },
  ],
  generatedAt: '2026-08-07T10:00:00Z',
}

// ─── Validator（契约 §5：只答「是否符合 Contract」） ───────────────────────

test('Validator：合法 Proposal → 无 issue', () => {
  assert.deepEqual(validateJDAnalysisProposal(validProposal), [])
})

test('Validator：恶意输出（education source=岗位名称）→ reject（Anti-Hallucination 硬校验）', () => {
  const bad: JDAnalysisProposal = {
    ...validProposal,
    constraints: { education: { values: ['本科'], source: '岗位名称', confidence: 'high' } },
  }
  const issues = validateJDAnalysisProposal(bad)
  const edu = issues.filter((i) => i.path.startsWith('constraints.education'))
  assert.equal(edu.length, 1)
  assert.equal(edu[0]!.severity, 'reject')
  assert.match(edu[0]!.reason, /岗位名/)
})

test('Validator：education 值域外值 → reject；缺失锚点 → reject；capabilities 结构非法 → reject', () => {
  const issues = validateJDAnalysisProposal({
    ...validProposal,
    constraints: { education: { values: ['中学'], source: '任职要求 1', confidence: 'high' } },
  })
  assert.equal(issues.filter((i) => i.path === 'constraints.education.values')[0]!.severity, 'reject')

  const noSource = validateJDAnalysisProposal({
    ...validProposal,
    constraints: { education: { values: ['本科'], source: '', confidence: 'high' } },
  })
  assert.equal(noSource.filter((i) => i.path === 'constraints.education.source')[0]!.severity, 'reject')

  const badCap = validateJDAnalysisProposal({
    ...validProposal,
    capabilities: [{ responsibility: '', priority: 'must', category: 'weird' as never, capabilities: [], evidencePatterns: [], questions: [] }],
  })
  assert.equal(badCap.filter((i) => i.path.startsWith('capabilities[0]')).length, 3)
})

test('Validator：matchMode 非法值 → reject（值域校验，不判断语义对错）', () => {
  const issues = validateJDAnalysisProposal({
    ...validProposal,
    constraints: { education: { values: ['本科'], source: '任职要求 1', confidence: 'high', matchMode: 'fuzzyish' as never } },
  })
  assert.equal(issues.filter((i) => i.path === 'constraints.education.matchMode')[0]!.severity, 'reject')
  // 合法值通过（related 模式 + 合法 education 值）
  const ok = validateJDAnalysisProposal({
    ...validProposal,
    constraints: { education: { values: ['本科以上'], source: '任职要求 1', confidence: 'medium', matchMode: 'related' } },
  })
  assert.equal(ok.filter((i) => i.path.startsWith('constraints.education')).length, 0)
})

test('Writer：matchMode 投影到模式列（related）→ Parser 读回 NEEDS_CONFIRMATION', () => {
  const ws = setup()
  try {
    createJob(ws)
    const p: JDAnalysisProposal = {
      ...validProposal,
      constraints: { education: { values: ['本科以上'], source: '任职要求 1', confidence: 'medium', matchMode: 'related' } },
    }
    const issues = validateJDAnalysisProposal(p)
    writeJDAnalysis(ws, p, issues)
    const md = ws.read(`jobs/${jobId}.md`)
    assert.match(md, /\| education \| 本科以上 \| 任职要求 1 \| medium \| related \|/)
    const ir = parseJdConstraint(md)
    assert.equal(ir.education!.matchMode, 'related')
    assert.equal(ir.education!.normalizationStatus, 'NEEDS_CONFIRMATION')
    const result = matchEducation([{ school: 'University-A', degree: '本科', status: 'confirmed', source: 'resume' }], ir.education)
    assert.equal(result.status, 'NEEDS_CONFIRMATION')
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

// ─── Writer + Parser + Matcher（3.4/3.5/3.6：Proposal → Artifact → 匹配闭环） ──

test('Writer：合法 Proposal → 三段式写回 jobs md；parseJdConstraint 读回 → matchEducation MATCHED', () => {
  const ws = setup()
  try {
    createJob(ws)
    const issues = validateJDAnalysisProposal(validProposal)
    const r = writeJDAnalysis(ws, validProposal, issues)
    assert.equal(r.written, true)
    assert.deepEqual(r.skipped, [])

    const md = ws.read(`jobs/${jobId}.md`)
    assert.match(md, /## 岗位理解/)
    assert.match(md, /## 岗位门槛/)
    assert.match(md, /## 岗位智能/)
    assert.match(md, /\| education \| 本科;硕士;博士 \| 任职要求 1 \| high \|/)
    assert.match(md, /\| 数据整理与文案输出 \| must \| hard \| 办公软件;数据整理 \|/)

    const ir = parseJdConstraint(md)
    assert.deepEqual(ir.education!.normalizedDegrees, ['本科', '硕士', '博士'])
    const result = matchEducation(
      [{ school: 'University-A', degree: '本科', status: 'confirmed', source: 'resume' }],
      ir.education,
    )
    assert.equal(result.status, 'MATCHED')
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('Writer：恶意 education（source=岗位名称）→ 该字段不写入（Claim Strength ≤ Evidence Strength 系统层）', () => {
  const ws = setup()
  try {
    createJob(ws)
    const bad: JDAnalysisProposal = {
      ...validProposal,
      constraints: { education: { values: ['本科'], source: '岗位名称', confidence: 'high' } },
    }
    const issues = validateJDAnalysisProposal(bad)
    const r = writeJDAnalysis(ws, bad, issues)
    assert.equal(r.written, true)
    assert.ok(r.skipped.includes('constraints.education.source'))

    const md = ws.read(`jobs/${jobId}.md`)
    const ir = parseJdConstraint(md)
    assert.equal(ir.education, undefined) // education 未写入 → Matcher 视 NOT_DECLARED
    const result = matchEducation(
      [{ school: 'University-A', degree: '本科', status: 'confirmed', source: 'resume' }],
      ir.education,
    )
    assert.equal(result.status, 'NOT_DECLARED')
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('Writer：重复提交 → 分析段替换不重复（幂等段落）', () => {
  const ws = setup()
  try {
    createJob(ws)
    const issues = validateJDAnalysisProposal(validProposal)
    writeJDAnalysis(ws, validProposal, issues)
    writeJDAnalysis(ws, validProposal, issues)
    const md = ws.read(`jobs/${jobId}.md`)
    assert.equal((md.match(/## 岗位门槛/g) ?? []).length, 1)
    assert.equal((md.match(/## 岗位智能/g) ?? []).length, 1)
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})
