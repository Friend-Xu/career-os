import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDecisionMarkdown, scanDecisions } from '../storage/report-watcher.ts'
import { initWorkspace } from '../storage/workspace.ts'

const transitionMd = `# 李明 — 转行可行性分析：非标自动化 → 机器人结构设计

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill | career-transition |
| direction | 机器人结构设计 |
| direction_match | 75% |
| direction_confidence | 中 |
| city | 苏州 |
| city_score | - |
| salary_feasible | true |
| risk_level | 中高 |
| key_risk | 机器人传动/减速器经验为零 |
| status | complete |
| protocol_version | 2.0 |

---

## 转行决策摘要

从非标自动化机械设计转向机器人本体结构设计是**可行但有代价**的转行路径。
`

const cityMd = `# 苏州

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill | city-advisor |
| city | 苏州 |
| city_score | 8.2/10 |
| city_confidence | 中 |
| salary_feasible | true |
| risk_level | 低 |
| key_risk | 房价收入比偏高 |
| status | complete |
| protocol_version | 2.0 |
`

test('解析 2.0 记录：字段映射 + 值转换 + 无 validation（协议必填齐）', () => {
  const { value, validation } = parseDecisionMarkdown(transitionMd, '2026-08-01-转行分析.md')
  assert.equal(validation, undefined)
  assert.equal(value.id, '2026-08-01-转行分析')
  assert.equal(value.title, '李明 — 转行可行性分析：非标自动化 → 机器人结构设计')
  assert.equal(value.skill, 'career-transition')
  assert.equal(value.direction, '机器人结构设计')
  assert.equal(value.directionMatch, 75) // 75% → 75
  assert.equal(value.directionConfidence, 'medium') // 中 → medium
  assert.equal(value.city, '苏州')
  assert.equal(value.salaryFeasible, true)
  assert.equal(value.riskLevel, 'high') // 中高 → high
  assert.equal(value.createdAt, '2026-08-01')
  assert.ok(value.summary.includes('转行决策摘要') || value.summary.includes('可行但有代价'))
})

test('city_score X/10 → 0-100；缺失字段（city_confidence 无 IR 映射、city_score 为 - 时缺省）', () => {
  const { value, validation } = parseDecisionMarkdown(cityMd, '2026-08-01-城市评估.md')
  assert.equal(value.cityScore, 82) // 8.2/10 → 82
  assert.equal(value.riskLevel, 'low')
  assert.equal(validation, undefined)
})

test('无分析摘要表 → invalid', () => {
  const { validation } = parseDecisionMarkdown('# 没有摘要表\n\n正文', '2026-08-02-坏文件.md')
  assert.equal(validation?.status, 'invalid')
})

test('city_score = - → 缺省（合法，协议可选）', () => {
  const { value, validation } = parseDecisionMarkdown(transitionMd, '2026-08-01-转行分析.md')
  assert.equal(value.cityScore, undefined)
  assert.equal(validation, undefined)
})

test('scanDecisions：全量扫描', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-rw-'))
  const ws = initWorkspace(root)
  ws.write('decisions/2026-08-01-转行分析.md', transitionMd)
  ws.write('decisions/2026-08-02-城市评估.md', cityMd)
  const parsed = scanDecisions(ws)
  assert.equal(parsed.length, 2)
  assert.deepEqual(
    parsed.map((p) => p.record.skill),
    ['career-transition', 'city-advisor'],
  )
  assert.ok(parsed.every((p) => p.validation === undefined))
  rmSync(root, { recursive: true, force: true })
})

test('scanDecisions：坏文件标 invalid 不崩', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-rw-'))
  const ws = initWorkspace(root)
  ws.write('decisions/2026-08-01-好.md', transitionMd)
  ws.write('decisions/2026-08-02-坏.md', '# 没有摘要表')
  const parsed = scanDecisions(ws)
  assert.equal(parsed.length, 2)
  const bad = parsed.find((p) => p.sourceFile === '2026-08-02-坏.md')
  assert.equal(bad?.validation?.status, 'invalid')
  const good = parsed.find((p) => p.sourceFile === '2026-08-01-好.md')
  assert.equal(good?.validation, undefined)
  rmSync(root, { recursive: true, force: true })
})

test('登记后文件（frontmatter）：id/created_at 取系统值，正文照常解析', () => {
  const md = `---
id: decision_20260805_00001
created_at: 2026-08-05
source_file: 2026-08-01-转行分析
---

${transitionMd}`
  const { value, validation } = parseDecisionMarkdown(md, 'decision_20260805_00001.md')
  assert.equal(validation, undefined)
  assert.equal(value.id, 'decision_20260805_00001')
  assert.equal(value.createdAt, '2026-08-05')
  assert.equal(value.direction, '机器人结构设计')
  assert.equal(value.title, '李明 — 转行可行性分析：非标自动化 → 机器人结构设计')
})

test('decision_ 文件名（无 frontmatter）：createdAt 从系统文件名派生', () => {
  const { value } = parseDecisionMarkdown(transitionMd, 'decision_20260805_00002.md')
  assert.equal(value.id, 'decision_20260805_00002')
  assert.equal(value.createdAt, '2026-08-05')
})

