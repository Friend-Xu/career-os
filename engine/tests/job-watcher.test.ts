/**
 * job-watcher 单测：解析（摘要表 + responsibilities 责任单元迁移映射）、create 写文件闭环、边界 fail fast。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createJobFile, ensureCompanyPlaceholder, parseJobMarkdown, scanJobs } from '../storage/job-watcher.ts'
import { initWorkspace } from '../storage/workspace.ts'
import { parseCompanyMarkdown } from '../storage/projection.ts'

const SAMPLE_MD = `# 机器人结构工程师 — 澜山自动化

## 分析摘要

| 字段 | 值 |
|------|-----|
| company | 澜山自动化 |
| title | 机器人结构工程师 |
| location | 苏州 |
| salary | 25-35万 |
| jd_source | https://example.com/jd |
| requirements | Python;PyTorch;LLM |
| created_at | 2026-08-04 |

---

## JD 原文

负责机器人本体结构设计，熟悉谐波/RV 减速器选型，5 年机械设计经验。
`

test('parseJobMarkdown：摘要表字段 + responsibilities 迁移映射（旧技能词 → statement，source=user）', () => {
  const p = parseJobMarkdown(SAMPLE_MD, '2026-08-04-澜山自动化-机器人结构工程师.md')
  assert.equal(p.validation, undefined)
  const j = p.value
  assert.equal(j.id, '2026-08-04-澜山自动化-机器人结构工程师')
  assert.equal(j.company, '澜山自动化')
  assert.equal(j.title, '机器人结构工程师')
  assert.equal(j.location, '苏州')
  assert.equal(j.salary, '25-35万')
  assert.equal(j.jdSource, 'https://example.com/jd')
  assert.equal(j.createdAt, '2026-08-04')
  assert.deepEqual(j.responsibilities, [
    { id: 'user-1', statement: 'Python', priority: 'must', capabilities: [], evidenceExpectations: [], source: 'user' },
    { id: 'user-2', statement: 'PyTorch', priority: 'must', capabilities: [], evidenceExpectations: [], source: 'user' },
    { id: 'user-3', statement: 'LLM', priority: 'must', capabilities: [], evidenceExpectations: [], source: 'user' },
  ])
  assert.ok(j.jd!.includes('负责机器人本体结构设计')) // JD 原文从 `## JD 原文` 段解析
})

test('parseJobMarkdown：必填缺失 → invalid', () => {
  const p = parseJobMarkdown('# 只有标题\n\n## 分析摘要\n\n| 字段 | 值 |\n|---|---|\n| title | X |\n', 'x.md')
  assert.equal(p.validation?.status, 'invalid')
})

test('parseJobMarkdown：岗位智能段 → ai responsibilities（user+ai 合并、pattern 短名映射 Registry id、词表外过滤）', () => {
  const md = SAMPLE_MD + `
## 岗位智能

| Responsibility | Priority | Capabilities | Evidence Patterns | Questions |
|---|---|---|---|---|
| 自动化设备结构设计 | must | 机械设计;结构优化 | scope;validation | 你负责设计哪些模块？;如何验证设计有效？ |
| 成本优化 | nice | 成本分析 | impact;bad_dim | 优化后成本变化多少？; |
`
  const j = parseJobMarkdown(md, '2026-08-04-澜山自动化-机器人结构工程师.md').value
  assert.equal(j.responsibilities.length, 5) // 3 user（建档迁移）+ 2 ai（岗位智能）
  const ai = j.responsibilities.filter((r) => r.source === 'ai')
  assert.equal(ai.length, 2)
  assert.equal(ai[0].statement, '自动化设备结构设计')
  assert.equal(ai[0].priority, 'must')
  assert.deepEqual(ai[0].capabilities, ['机械设计', '结构优化'])
  assert.deepEqual(ai[0].evidenceExpectations, [
    { patternId: 'engineering_scope', questions: ['你负责设计哪些模块？'] },
    { patternId: 'engineering_validation', questions: ['如何验证设计有效？'] },
  ])
  assert.equal(ai[1].priority, 'nice')
  // 词表外 dimension（bad_dim）被过滤；questions 与 patterns 同序配对
  assert.deepEqual(ai[1].evidenceExpectations, [{ patternId: 'engineering_impact', questions: ['优化后成本变化多少？'] }])
})

test('岗位智能 questions：分号分隔正常拆分 + 同序配对（Case 1）', () => {
  const md = SAMPLE_MD + `
## 岗位智能

| Responsibility | Priority | Capabilities | Evidence Patterns | Questions |
|---|---|---|---|---|
| 自动化设备结构设计 | must | 机械设计 | scope;method;validation | 你负责设计哪些模块？;采用什么流程？;如何验证设计有效？ |
`
  const ai = parseJobMarkdown(md, 'x.md').value.responsibilities.filter((r) => r.source === 'ai')
  assert.deepEqual(ai[0].evidenceExpectations, [
    { patternId: 'engineering_scope', questions: ['你负责设计哪些模块？'] },
    { patternId: 'engineering_method', questions: ['采用什么流程？'] },
    { patternId: 'engineering_validation', questions: ['如何验证设计有效？'] },
  ])
})

test('岗位智能 questions：逗号连接 → 不崩溃、原文保留、warn 标记（Case 2 防御）', () => {
  const md = SAMPLE_MD + `
## 岗位智能

| Responsibility | Priority | Capabilities | Evidence Patterns | Questions |
|---|---|---|---|---|
| 自动化设备结构设计 | must | 机械设计 | scope | 你负责设计哪些模块？,采用什么流程？ |
`
  const p = parseJobMarkdown(md, 'x.md')
  const ai = p.value.responsibilities.filter((r) => r.source === 'ai')
  // 不拆分、不修复：逗号不参与切分，整句保留为单个追问
  assert.deepEqual(ai[0].evidenceExpectations, [
    { patternId: 'engineering_scope', questions: ['你负责设计哪些模块？,采用什么流程？'] },
  ])
  // 解析不崩 + 明确标记输出方质量问题（degraded，不降为 invalid）
  assert.equal(p.validation?.status, 'degraded')
  const warn = p.validation?.issues.find((i) => i.severity === 'warn')
  assert.ok(warn?.reason.includes('逗号连接'))
})

test('岗位智能 questions：问句内部正常逗号不误报（单问句）', () => {
  const md = SAMPLE_MD + `
## 岗位智能

| Responsibility | Priority | Capabilities | Evidence Patterns | Questions |
|---|---|---|---|---|
| 自动化设备结构设计 | must | 机械设计 | scope | 你负责哪些模块，如何设计？ |
`
  const p = parseJobMarkdown(md, 'x.md')
  assert.equal(p.validation, undefined)
})

test('createJobFile：写文件闭环 + scanJobs 读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-job-test-'))
  try {
    const ws = initWorkspace(join(dir, 'ws'))
    const now = new Date('2026-08-04T10:00:00Z')
    const created = createJobFile(ws, {
      company: '澜山自动化',
      title: '机器人结构工程师',
      location: '苏州',
      salary: '25-35万',
      requirements: 'Python;SolidWorks',
      jdText: '负责机器人本体结构设计。',
    }, now)
    assert.equal(created.id, '2026-08-04-澜山自动化-机器人结构工程师')
    assert.ok(ws.exists(`jobs/${created.id}.md`))
    const scanned = scanJobs(ws)
    assert.equal(scanned.length, 1)
    assert.equal(scanned[0].record.responsibilities.length, 2)
    assert.ok(scanned[0].record.responsibilities.every((r) => r.source === 'user' && r.priority === 'must'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createJobFile 边界 fail fast：重名/非法名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-job-test-'))
  try {
    const ws = initWorkspace(join(dir, 'ws'))
    const now = new Date('2026-08-04T10:00:00Z')
    createJobFile(ws, { company: 'A公司', title: '工程师' }, now)
    assert.throws(() => createJobFile(ws, { company: 'A公司', title: '工程师' }, now)) // 重名
    assert.throws(() => createJobFile(ws, { company: '../x', title: 'y' }, now)) // 路径穿越
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createJobFile 自动建占位公司：invalid = 待尽调；同名已存在不重复建（简称/全称容错）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-job-test-'))
  try {
    const ws = initWorkspace(join(dir, 'ws'))
    const now = new Date('2026-08-04T10:00:00Z')
    createJobFile(ws, { company: '澜山自动化', title: '机器人结构工程师', location: '苏州' }, now)
    assert.ok(ws.exists('companies/澜山自动化.md'), '建档应自动创建占位公司')
    const { value, validation } = parseCompanyMarkdown(ws.read('companies/澜山自动化.md'), '澜山自动化.md')
    assert.equal(value.name, '澜山自动化')
    assert.equal(value.city, '苏州') // location 带入占位档案
    assert.equal(validation?.status, 'invalid') // 必填缺失 = 待尽调标记
    // 全称已建档 → 简称建档不重复建占位
    assert.equal(ensureCompanyPlaceholder(ws, '澜山自动化科技有限公司'), null)
    assert.equal(ws.listMarkdown('companies').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
