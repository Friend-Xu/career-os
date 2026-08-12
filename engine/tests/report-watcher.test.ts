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
| city | City-X |
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

const cityMd = `# City-X

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill | city-advisor |
| city | City-X |
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
  assert.equal(value.city, 'City-X')
  assert.equal(value.salaryFeasible, true)
  assert.equal(value.riskLevel, 'high') // 中高 → high
  assert.equal(value.createdAt, '2026-08-01')
  assert.ok(value.summary.includes('转行决策摘要') || value.summary.includes('可行但有代价'))
})

test('city_score X/10 → 0-100；city_confidence 映射为 cityConfidence；city_score = - 时缺省', () => {
  const { value, validation } = parseDecisionMarkdown(cityMd, '2026-08-01-城市评估.md')
  assert.equal(value.cityScore, 82) // 8.2/10 → 82
  assert.equal(value.cityConfidence, 'medium') // 中 → medium（v2.8 映射）
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

// ─── v2.8 Decision Payload（业务协议结构化）───

const cityDetailMd = `# 城市评估 — City-X vs City-W

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill | city-advisor |
| profile | 你好 |
| direction | 机器人结构设计 |
| direction_match | - |
| city | - |
| city_score | - |
| city_confidence | 中 |
| salary_feasible | true |
| risk_level | 中 |
| key_risk | 测试风险 |
| status | complete |
| protocol_version | 2.8 |

## 城市评估明细

| 城市 | 得分 | 置信度 | 关键优势 | 关键风险 |
|------|:--:|:--:|---------|---------|
| City-X | 7.6/10 | 中 | 薪酬性价比/政策 | 产业规模小于City-W |
| City-W | 6.95/10 | - | 行业天花板 | 租金负担率高 |

## 结论

**City-X（7.6）> City-W（6.95）**
`

const dirDetailMd = `# 职业方向探索

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill | career-path |
| profile | 你好 |
| direction | - |
| direction_match | - |
| direction_confidence | - |
| city | - |
| city_score | - |
| salary_feasible | true |
| risk_level | 中 |
| key_risk | 测试风险 |
| status | complete |
| protocol_version | 2.8 |

## 方向评估明细

| 方向 | 匹配度 | 置信度 | 关键优势 | 关键风险 |
|------|:--:|:--:|---------|---------|
| 医疗器械结构设计 | 71% | 高 | 画像匹配/经验直接 | - |
| 热管理 | 59% | 中 | 散热经验可迁移 | 需实操验证 |
| 工业软件开发 | 57.5% | 低 | 跨领域 | 技能差距大 |
`

test('城市评估明细段落 → city payload：0-100 归一、优势/风险拆分、direction 口径继承', () => {
  const { value, validation } = parseDecisionMarkdown(cityDetailMd, '2026-08-07-City-XvsCity-W.md')
  assert.equal(validation, undefined)
  assert.equal(value.cityConfidence, 'medium')
  assert.equal(value.payload?.type, 'city')
  const p = value.payload
  if (p?.type !== 'city') throw new Error('payload 应为 city')
  assert.equal(p.direction, '机器人结构设计') // 摘要表 direction 继承为评估口径
  assert.equal(p.cities.length, 2)
  const su = p.cities[0]
  assert.equal(su.name, 'City-X')
  assert.equal(su.score, 76) // 7.6/10 → 76
  assert.equal(su.confidence, 'medium')
  assert.deepEqual(su.strengths, ['薪酬性价比', '政策'])
  assert.deepEqual(su.risks, ['产业规模小于City-W'])
  const sz = p.cities[1]
  assert.equal(sz.name, 'City-W')
  assert.equal(sz.score, 69.5) // 6.95/10 → 69.5（保留两位小数）
  assert.equal(sz.confidence, undefined) // '-' 缺省
  assert.deepEqual(sz.strengths, ['行业天花板'])
})

test('方向评估明细段落 → direction payload：多方向逐行 match/confidence', () => {
  const { value, validation } = parseDecisionMarkdown(dirDetailMd, '2026-08-07-方向探索.md')
  assert.equal(validation, undefined)
  const p = value.payload
  if (p?.type !== 'direction') throw new Error('payload 应为 direction')
  assert.equal(p.directions.length, 3)
  assert.deepEqual(
    p.directions.map((d) => [d.name, d.match, d.confidence]),
    [
      ['医疗器械结构设计', 71, 'high'],
      ['热管理', 59, 'medium'],
      ['工业软件开发', 57.5, 'low'], // 57.5% 保留原始精度
    ],
  )
  assert.deepEqual(p.directions[0].strengths, ['画像匹配', '经验直接'])
  assert.deepEqual(p.directions[0].risks, [])
})

test('无明细段落 → payload undefined（存量决策无 payload 属常态）', () => {
  const { value } = parseDecisionMarkdown(transitionMd, '2026-08-01-转行分析.md')
  assert.equal(value.payload, undefined)
})

test('空明细表（无数据行）→ payload undefined', () => {
  const md = cityDetailMd.replace(/\| City-X \|.*\n\| City-W \|.*\n/, '')
  const { value } = parseDecisionMarkdown(md, '2026-08-07-空明细.md')
  assert.equal(value.payload, undefined)
})

test('明细得分缺单位（裸数字）→ 该行跳过（协议要求显式单位 X/10 或 X%）', () => {
  const md = cityDetailMd.replace('| City-X | 7.6/10 |', '| City-X | 7.6 |')
  const { value } = parseDecisionMarkdown(md, '2026-08-07-裸数字.md')
  const p = value.payload
  if (p?.type !== 'city') throw new Error('payload 应为 city')
  assert.equal(p.cities.length, 1) // City-W行保留
  assert.equal(p.cities[0].name, 'City-W')
})

