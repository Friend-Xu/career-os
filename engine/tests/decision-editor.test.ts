/**
 * decision-editor 单测：摘要表字段更新（更新/插入/保留结构/边界 fail fast）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { updateDecisionFile, updateSummaryFields, readDecisionFile } from '../storage/decision-editor.ts'
import { initWorkspace } from '../storage/workspace.ts'
import { parseDecisionMarkdown } from '../storage/report-watcher.ts'

const SAMPLE_MD = `# 我 — 方向探索：机器人方向可行性

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill | career-path |
| direction | 机器人结构设计 |
| direction_match | 82% |
| direction_confidence | 高 |
| city | - |
| city_score | - |
| salary_feasible | true |
| risk_level | 低 |
| key_risk | 需补机器人传动/减速器知识 |
| status | complete |
| protocol_version | 2.1 |
| profile | 我 |

---

## 方向探索摘要

从非标自动化转向机器人结构设计是成熟路径。
`

test('更新已有字段（保留位置与其余字段）', () => {
  const out = updateSummaryFields(SAMPLE_MD, { direction_match: '88%', risk_level: '中' })
  assert.ok(out.includes('| direction_match | 88% |'))
  assert.ok(out.includes('| risk_level | 中 |'))
  assert.ok(out.includes('| direction | 机器人结构设计 |')) // 未更新字段原样
  assert.ok(out.includes('| profile | 我 |')) // 不可编辑字段原样保留
  assert.ok(out.includes('## 方向探索摘要')) // 正文保留
  assert.ok(out.includes('从非标自动化转向机器人结构设计是成熟路径。'))
})

test('插入新字段（表格尾追加）', () => {
  const noKeyRisk = SAMPLE_MD.replace('| key_risk | 需补机器人传动/减速器知识 |\n', '')
  const out = updateSummaryFields(noKeyRisk, { key_risk: '新增风险' })
  assert.ok(out.includes('| key_risk | 新增风险 |'))
})

test('更新后 parseSummaryTable 可解析出新值（格式合法）', () => {
  const out = updateSummaryFields(SAMPLE_MD, { city: '深圳', city_score: '8.5/10' })
  assert.ok(out.includes('| city | 深圳 |'))
  assert.ok(out.includes('| city_score | 8.5/10 |'))
})

test('无摘要表 → fail fast', () => {
  assert.throws(() => updateSummaryFields('# 无表格\n\n正文\n', { direction: 'x' }))
})

test('空 updates → 表格等价原样', () => {
  const out = updateSummaryFields(SAMPLE_MD, {})
  assert.ok(out.includes('| direction_match | 82% |'))
})

test('updateDecisionFile 写回后 parseDecisionMarkdown 解析出新值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-de-editor-'))
  try {
    const ws = initWorkspace(join(dir, 'ws'))
    ws.write('decisions/2026-07-20-方向探索.md', SAMPLE_MD)
    const res = updateDecisionFile(ws, '2026-07-20-方向探索', { direction_match: '91%', risk_level: '中' })
    assert.deepEqual(res.updatedFields, ['direction_match', 'risk_level'])
    const parsed = parseDecisionMarkdown(ws.read('decisions/2026-07-20-方向探索.md'), '2026-07-20-方向探索.md')
    assert.equal(parsed.value.directionMatch, 91)
    assert.equal(parsed.value.riskLevel, 'medium')
    assert.equal(parsed.value.title, '我 — 方向探索：机器人方向可行性') // H1 保留
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateDecisionFile 边界 fail fast', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-de-editor-'))
  try {
    const ws = initWorkspace(join(dir, 'ws'))
    ws.write('decisions/2026-07-20-方向探索.md', SAMPLE_MD)
    assert.throws(() => updateDecisionFile(ws, '不存在', { direction: 'x' })) // 文件不存在
    assert.throws(() => updateDecisionFile(ws, '../profiles/我', { direction: 'x' })) // 路径穿越
    assert.throws(() => updateDecisionFile(ws, '2026-07-20-方向探索', { profile: '别人' })) // 不可编辑字段
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readDecisionFile 返回 md 原文（详情抽屉数据源）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-de-editor-'))
  try {
    const ws = initWorkspace(join(dir, 'ws'))
    ws.write('decisions/2026-07-20-方向探索.md', SAMPLE_MD)
    const { id, markdown } = readDecisionFile(ws, '2026-07-20-方向探索')
    assert.equal(id, '2026-07-20-方向探索')
    assert.ok(markdown.includes('## 方向探索摘要')) // 全文（正文段落原样）
    assert.ok(markdown.includes('| direction_match | 82% |'))
    assert.throws(() => readDecisionFile(ws, '不存在')) // 文件不存在
    assert.throws(() => readDecisionFile(ws, '../profiles/我')) // 路径穿越
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
