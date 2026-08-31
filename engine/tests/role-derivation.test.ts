import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { createJobFile } from '../storage/job-watcher.ts'
import { writeJDAnalysis } from '../storage/jd-analysis-writer.ts'
import { validateJDAnalysisProposal } from '../runtime/jd-analysis-validator.ts'
import {
  ensureRoleFromJob,
  deriveRoleInputFromJob,
  backfillRoleProposalsFromJobs,
  resolveCompanyCanonical,
} from '../storage/role-derivation.ts'
import { scanRoleProposals } from '../storage/role-proposal-registry.ts'
import { parseRolesMarkdown } from '../storage/knowledge-watcher.ts'
import type { JDAnalysisProposal } from '../ir/schema.ts'

function setup(): ReturnType<typeof initWorkspace> {
  const root = mkdtempSync(join(tmpdir(), 'cos-rder-'))
  const ws = initWorkspace(root)
  ws.write('knowledge/skills.md', '# 技能词表\n\n## 办公软件\n')
  ws.write('companies/Company-A 医疗.md', '# Company-A 医疗\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| city | City-Y |\n')
  return ws
}

const jobId = '2026-08-07-Company-A 医疗-管理培训生'

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
      priority: 'nice',
      category: 'soft',
      capabilities: ['跨部门协作'],
      evidencePatterns: ['scope'],
      questions: ['你轮岗过哪些部门'],
    },
  ],
  generatedAt: '2026-08-07T10:00:00Z',
}

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

/** 手工写 jobs/{id}.md（摘要表 + JD 原文 + 岗位智能段 —— 模拟存量/旧引擎产物） */
function writeJobFileWithIntelligence(
  ws: ReturnType<typeof initWorkspace>,
  id: string,
  caps: JDAnalysisProposal['capabilities'],
): void {
  const rows = caps.map((c) =>
    `| ${c.responsibility} | ${c.priority} | ${c.category} | ${c.capabilities.join(';')} | ${c.evidencePatterns.join(';')} | ${c.questions.join(';')} |`,
  )
  const md = `# 管理培训生 — Company-A 医疗

## 分析摘要

| 字段 | 值 |
|------|-----|
| company | Company-A 医疗 |
| title | 管理培训生 |
| created_at | 2026-08-07 |

---

## JD 原文

任职要求 1：本科/硕士/博士应届生。

## 岗位智能

| Responsibility | Priority | Category | Capabilities | Evidence Patterns | Questions |
|----------------|----------|-----------|--------------|-------------------|-----------|
${rows.join('\n')}
`
  ws.write(`jobs/${id}.md`, md)
}

function rolesMd(ws: ReturnType<typeof initWorkspace>) {
  return ws.exists('knowledge/roles.md') ? parseRolesMarkdown(ws.read('knowledge/roles.md'), 'roles.md').value : []
}

// ─── 自动派生（writeJDAnalysis 挂载） ─────────────────────────────────────

test('JD 分析落盘 → 自动派生角色提案并投影 roles.md（source/essential/去重）', () => {
  const ws = setup()
  createJob(ws)
  const r = writeJDAnalysis(ws, validProposal, validateJDAnalysisProposal(validProposal))
  assert.equal(r.written, true)

  const proposals = scanRoleProposals(ws)
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0]!.roleId, '管理培训生-Company-A 医疗')
  assert.equal(proposals[0]!.source, 'JD-Company-A 医疗-2026-08-07')
  assert.deepEqual(
    proposals[0]!.skills,
    [
      { name: '办公软件', essential: true },
      { name: '数据整理', essential: true },
    ], // 跨部门协作（category=soft）被域分类整组过滤——Capability Matching Boundary v0.1（v0.3 行为变更）
  )

  const roles = rolesMd(ws)
  assert.equal(roles.length, 1)
  assert.equal(roles[0]!.id, '管理培训生-Company-A 医疗')
  assert.equal(roles[0]!.skills[0]!.source, 'JD-Company-A 医疗-2026-08-07')
})

test('幂等：同岗位二次分析（能力词变化）→ 覆盖更新，不重复建条目', () => {
  const ws = setup()
  createJob(ws)
  writeJDAnalysis(ws, validProposal, validateJDAnalysisProposal(validProposal))
  const v2: JDAnalysisProposal = {
    ...validProposal,
    capabilities: [
      ...validProposal.capabilities,
      {
        responsibility: '新增责任',
        priority: 'must',
        category: 'hard',
        capabilities: ['新增能力词'],
        evidencePatterns: ['method'],
        questions: ['q'],
      },
    ],
  }
  writeJDAnalysis(ws, v2, validateJDAnalysisProposal(v2))

  assert.equal(scanRoleProposals(ws).length, 2) // 提案文件 = 审计链（每次提交各一条）
  const roles = rolesMd(ws)
  assert.equal(roles.length, 1) // roles.md 条目不重复（同 roleId upsert 覆盖）
  assert.ok(roles[0]!.skills.some((s) => s.name === '新增能力词'))
})

test('无智能段（capabilities 空）→ 不派生（岗位实例库要求技能可回溯）', () => {
  const ws = setup()
  createJob(ws)
  const noCap: JDAnalysisProposal = { ...validProposal, capabilities: [] }
  const r = writeJDAnalysis(ws, noCap, validateJDAnalysisProposal(noCap))
  assert.equal(r.written, true) // 岗位理解/门槛仍写入
  assert.equal(scanRoleProposals(ws).length, 0)
  assert.equal(rolesMd(ws).length, 0)
})

test('公司未登记档案 → 不派生（不 throw，分析写入链不阻断）', () => {
  const ws = setup()
  createJob(ws)
  ws.delete('companies/Company-A 医疗.md')
  const r = writeJDAnalysis(ws, validProposal, validateJDAnalysisProposal(validProposal))
  assert.equal(r.written, true)
  assert.equal(scanRoleProposals(ws).length, 0)
})

test('ensureRoleFromJob：岗位不存在 / 无智能段 → null', () => {
  const ws = setup()
  createJob(ws)
  assert.equal(ensureRoleFromJob(ws, '2026-08-07-Company-A 医疗-不存在'), null)

  writeJobFileWithIntelligence(ws, '2026-08-07-Company-A 医疗-无智能段', [])
  const job = ensureRoleFromJob(ws, '2026-08-07-Company-A 医疗-无智能段')
  assert.equal(job, null)
})

// ─── 存量对账补登（backfill） ────────────────────────────────────────────

test('backfill：存量已分析岗位（有智能段无登记）→ 派生；已登记 → 跳过', () => {
  const ws = setup()
  writeJobFileWithIntelligence(ws, jobId, validProposal.capabilities)

  const first = backfillRoleProposalsFromJobs(ws)
  assert.equal(first.derived, 1)
  assert.equal(first.skipped, 0)
  assert.equal(scanRoleProposals(ws).length, 1)
  assert.equal(rolesMd(ws).length, 1)

  const second = backfillRoleProposalsFromJobs(ws)
  assert.equal(second.derived, 0)
  assert.equal(second.skipped, 1)
  assert.equal(scanRoleProposals(ws).length, 1)
  assert.equal(rolesMd(ws).length, 1)
})

// ─── company canonical 解析 ──────────────────────────────────────────────

test('resolveCompanyCanonical：简称/全称双向容错 → 档案名；无档案 → null', () => {
  const ws = setup()
  assert.equal(resolveCompanyCanonical(ws, 'Company-A 医疗'), 'Company-A 医疗')
  assert.equal(resolveCompanyCanonical(ws, 'Company-A'), 'Company-A 医疗') // 简称 → 档案名
  assert.equal(resolveCompanyCanonical(ws, '不存在公司'), null)
})

test('deriveRoleInputFromJob：建档 user 责任段不派生（只认 ai 智能段）', () => {
  const ws = setup()
  const job = createJobFile(
    ws,
    { company: 'Company-A 医疗', title: '管理培训生', requirements: '熟练使用办公软件;数据整理与文案' },
    new Date('2026-08-07T00:00:00Z'),
  )
  const input = deriveRoleInputFromJob(ws, job)
  assert.equal(input, null) // 无 ai 智能段 → 不可派生
})
