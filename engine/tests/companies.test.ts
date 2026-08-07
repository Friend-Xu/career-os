import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjection, parseCompanyMarkdown } from '../storage/projection.ts'
import { initWorkspace } from '../storage/workspace.ts'
import { buildGraph } from '../storage/graph-builder.ts'
import type { Logger } from '../logger.ts'

/** 静默 logger（投影/解析测试不关心日志输出） */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  trace() {},
}

const companyMd = `# 澜山自动化

## 分析摘要

| 字段 | 值 |
|------|-----|
| city | 苏州 |
| industry | 工业自动化/机器人 |
| match_score | 85% |
| risk_level | 低 |
| source | JD 分析 + 公司官网 |
| tags | 国产工控龙头, 伺服/变频器, 机器人 |
| contacted | 否 |
| park_id | 1 |

---

## 公司档案摘要

澜山自动化（300124.SZ）：国产工控自动化龙头，机器人业务位于苏州。
`

test('解析合法公司档案：字段映射 + 值转换 + 无 validation', () => {
  const { value, validation } = parseCompanyMarkdown(companyMd, '澜山自动化.md')
  assert.equal(validation, undefined)
  assert.equal(value.id, '澜山自动化')
  assert.equal(value.name, '澜山自动化') // name 取 H1
  assert.equal(value.city, '苏州')
  assert.equal(value.industry, '工业自动化/机器人')
  assert.equal(value.matchScore, 85) // 85% → 85
  assert.equal(value.riskLevel, 'low') // 低 → low
  assert.equal(value.source, 'JD 分析 + 公司官网')
  assert.deepEqual(value.tags, ['国产工控龙头', '伺服/变频器', '机器人']) // 逗号分隔 → 拆分
  assert.equal(value.contacted, false) // 否 → false
  assert.equal(value.parkId, 1)
})

test('match_score X/10 → 0-100；中高 → high；是 → true；全角逗号拆分', () => {
  const md = companyMd
    .replace('| match_score | 85% |', '| match_score | 8.5/10 |')
    .replace('| risk_level | 低 |', '| risk_level | 中高 |')
    .replace('| contacted | 否 |', '| contacted | 是 |')
    .replace('| tags | 国产工控龙头, 伺服/变频器, 机器人 |', '| tags | 龙头，机器人 |')
  const { value, validation } = parseCompanyMarkdown(md, '澜山自动化.md')
  assert.equal(validation, undefined)
  assert.equal(value.matchScore, 85)
  assert.equal(value.riskLevel, 'high') // 中高 → high
  assert.equal(value.contacted, true)
  assert.deepEqual(value.tags, ['龙头', '机器人'])
})

test('无分析摘要表 → invalid', () => {
  const { validation } = parseCompanyMarkdown('# 澜山自动化\n\n没有摘要表', '澜山自动化.md')
  assert.equal(validation?.status, 'invalid')
  assert.equal(validation?.issues[0]?.severity, 'error')
})

test('缺必填字段（city/contacted 未填）→ invalid，parkId 缺失合法', () => {
  const md = companyMd
    .replace('| city | 苏州 |\n', '')
    .replace('| contacted | 否 |\n', '')
    .replace('| park_id | 1 |\n', '')
  const { value, validation } = parseCompanyMarkdown(md, '澜山自动化.md')
  assert.equal(validation?.status, 'invalid')
  const paths = validation!.issues.map((i) => i.path)
  assert.ok(paths.includes('city') && paths.includes('contacted'))
  assert.ok(!paths.includes('parkId')) // parkId 可选
  assert.equal(value.parkId, undefined)
})

test('contacted 填 -（未联系）→ false，不判 invalid；其余字段 - 仍跳过', () => {
  const md = companyMd.replace('| contacted | 否 |', '| contacted | - |')
  const { value, validation } = parseCompanyMarkdown(md, '澜山自动化.md')
  assert.equal(validation, undefined)
  assert.equal(value.contacted, false)
})

test('值域非法 → degraded（warn）保留原值展示，不崩', () => {
  const md = companyMd
    .replace('| risk_level | 低 |', '| risk_level | 超高 |')
    .replace('| match_score | 85% |', '| match_score | 很高 |')
    .replace('| contacted | 否 |', '| contacted | 也许 |')
    .replace('| park_id | 1 |', '| park_id | 一区 |')
  const { value, validation } = parseCompanyMarkdown(md, '澜山自动化.md')
  assert.equal(validation?.status, 'degraded')
  assert.ok(validation!.issues.every((i) => i.severity === 'warn'))
  assert.equal(value.riskLevel, '超高') // 保留原值
  assert.equal(value.matchScore, '很高')
  assert.equal(value.contacted, '也许')
  assert.equal(value.parkId, '一区')
})

test('listPersons：snapshot 带 skill_inventory → Person.skills 映射（生产契约闭环投影层）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-prs-'))
  const ws = initWorkspace(root)
  ws.write(
    'persons/person_001/manifest.md',
    '---\nid: person_001\nname: 我\nstatus: active\n---\n\n# Person 001 — 我\n',
  )
  ws.write(
    'persons/person_001/snapshot/current/skill_inventory.md',
    `---
id: person_001
status: v1
---

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill_count | 1 |

## A. 技能清单

| skill_id | 技能 | level | usage_context |
|----------|------|-------|---------------|
| skill_a | 机械设计 | applied-professional | 结构设计 |
`,
  )

  const projection = createProjection({ dbPath: join(root, '.db'), workspace: ws, logger: silentLogger })
  const persons = projection.listPersons()
  assert.equal(persons.length, 1)
  assert.deepEqual(persons[0]!.skills, [{ skillId: 'skill_a', name: '机械设计', level: 4 }])
  projection.close() // 释放 SQLite 文件锁（Windows 下 rmSync 需要）
  rmSync(root, { recursive: true, force: true })
})

test('listCompanies：完整 CompanyRecord + validation 标记；graph 跳过 invalid 公司', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-cmp-'))
  const ws = initWorkspace(root)
  ws.write('companies/澜山自动化.md', companyMd)
  ws.write('companies/无摘要公司.md', '# 无摘要公司\n\n没有摘要表')

  const projection = createProjection({ dbPath: join(root, '.db'), workspace: ws, logger: silentLogger })
  const list = projection.listCompanies()
  assert.equal(list.length, 2)
  const ok = list.find((c) => c.id === '澜山自动化')
  const bad = list.find((c) => c.id === '无摘要公司')
  assert.ok(ok && !ok.validation, '合法公司不应带 validation')
  assert.equal(ok?.matchScore, 85)
  assert.equal(bad?.validation?.status, 'invalid')

  const graph = buildGraph({
    decisions: [],
    companies: list,
    profileNames: [],
  })
  assert.ok(graph.nodes.some((n) => n.id === 'company:澜山自动化' && n.matchScore === 85 && n.riskLevel === 'low'))
  assert.ok(!graph.nodes.some((n) => n.id === 'company:无摘要公司'), 'invalid 公司不应出现在图谱')
  projection.close() // 释放 SQLite 文件锁（Windows 下 rmSync 需要）
  rmSync(root, { recursive: true, force: true })
})
