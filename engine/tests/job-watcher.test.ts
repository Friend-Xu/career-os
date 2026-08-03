/**
 * job-watcher 单测：解析（摘要表 + requirements 分号列表）、create 写文件闭环、边界 fail fast。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createJobFile, parseJobMarkdown, scanJobs } from '../storage/job-watcher.ts'
import { initWorkspace } from '../storage/workspace.ts'

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

test('parseJobMarkdown：摘要表字段 + requirements 结构化', () => {
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
  assert.deepEqual(j.requirements, [
    { name: 'Python', essential: true },
    { name: 'PyTorch', essential: true },
    { name: 'LLM', essential: true },
  ])
  assert.ok(j.jd!.includes('负责机器人本体结构设计')) // JD 原文从 `## JD 原文` 段解析
})

test('parseJobMarkdown：必填缺失 → invalid', () => {
  const p = parseJobMarkdown('# 只有标题\n\n## 分析摘要\n\n| 字段 | 值 |\n|---|---|\n| title | X |\n', 'x.md')
  assert.equal(p.validation?.status, 'invalid')
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
    assert.equal(scanned[0].record.requirements.length, 2)
    assert.ok(scanned[0].record.requirements.every((r) => r.essential))
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
