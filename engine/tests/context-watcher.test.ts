import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseContextMarkdown, scanContexts } from '../storage/context-watcher.ts'
import { initWorkspace } from '../storage/workspace.ts'

const contextMd = `# 未来三年职业方向选择

## 分析摘要

| 字段 | 值 |
|------|-----|
| person | 我 |
| question | 未来三年职业方向选择 |
| status | 评估中 |
| related_decisions | 2026-07-20-方向探索, 2026-07-22-转行分析 |
| created_at | 2026-07-20 |

---

## 考虑因素

- 技术延续性：机械核心能力可迁移
- 行业前景

## 证据

- 调研：方向探索匹配度 82%（来源：2026-07-20 方向探索）

## 结论

- 机器人结构设计（置信度：中）

## 风险

- 减速器经验为零（缓解：在职补强 3-6 个月）
- 转型成本未知

## 复盘

- 结论：方向决策正确，补强减速器选型后继续推进
- 复盘日期：2026-08-03
`

test('解析合法 context：字段映射 + status 中文映射 + related_decisions 拆分 + 无 validation', () => {
  const p = parseContextMarkdown(contextMd, '未来三年职业方向选择.md')
  assert.equal(p.validation, undefined)
  assert.equal(p.record.id, '未来三年职业方向选择')
  assert.equal(p.record.person, '我')
  assert.equal(p.record.question, '未来三年职业方向选择')
  assert.equal(p.record.status, 'evaluating') // 评估中 → evaluating
  assert.deepEqual(p.record.relatedDecisions, ['2026-07-20-方向探索', '2026-07-22-转行分析'])
  assert.equal(p.record.createdAt, '2026-07-20')
})

test('status 英文原值透传；question 表内缺失回退 H1', () => {
  const md = contextMd
    .replace('| status | 评估中 |', '| status | decided |')
    .replace('| question | 未来三年职业方向选择 |', '| question | - |')
  const p = parseContextMarkdown(md, '未来三年职业方向选择.md')
  assert.equal(p.validation, undefined)
  assert.equal(p.record.status, 'decided')
  assert.equal(p.record.question, '未来三年职业方向选择') // 回退 H1
})

test('正文段落解析：考虑因素/证据/结论/风险/复盘', () => {
  const p = parseContextMarkdown(contextMd, '未来三年职业方向选择.md')
  assert.deepEqual(p.sections.factors, [
    { name: '技术延续性', description: '机械核心能力可迁移' },
    { name: '行业前景', description: '' }, // 无冒号 → 仅名称
  ])
  assert.deepEqual(p.sections.evidence, [{ type: '调研', content: '方向探索匹配度 82%', source: '2026-07-20 方向探索' }])
  assert.deepEqual(p.sections.conclusion, { selected: '机器人结构设计', confidence: 0.7 }) // 中 → 0.7
  assert.deepEqual(p.sections.risks, [
    { description: '减速器经验为零', mitigation: '在职补强 3-6 个月' },
    { description: '转型成本未知' },
  ])
  assert.deepEqual(p.sections.review, { conclusion: '方向决策正确，补强减速器选型后继续推进', date: '2026-08-03' })
})

test('复盘段落缺项 → 不产出（结论或日期缺失）', () => {
  const md = contextMd.replace('- 结论：方向决策正确，补强减速器选型后继续推进\n- 复盘日期：2026-08-03\n', '- 结论：只有结论没有日期\n')
  const p = parseContextMarkdown(md, '未来三年职业方向选择.md')
  assert.equal(p.sections.review, undefined)
})

test('无正文段落 → 空数组/缺省，不崩', () => {
  const md = `# 未来三年职业方向选择

## 分析摘要

| 字段 | 值 |
|------|-----|
| person | 我 |
| question | 未来三年职业方向选择 |
| status | 评估中 |
| related_decisions | 2026-07-20-方向探索 |
| created_at | 2026-07-20 |
`
  const p = parseContextMarkdown(md, '未来三年职业方向选择.md')
  assert.equal(p.validation, undefined)
  assert.deepEqual(p.sections.factors, [])
  assert.deepEqual(p.sections.evidence, [])
  assert.equal(p.sections.conclusion, undefined)
  assert.deepEqual(p.sections.risks, [])
})

test('无分析摘要表 → invalid；id/question 仍派生（H1 回退文件名）', () => {
  const p = parseContextMarkdown('# 无表问题\n\n没有摘要表', '无表问题.md')
  assert.equal(p.validation?.status, 'invalid')
  assert.equal(p.record.id, '无表问题')
  assert.equal(p.record.question, '无表问题')
})

test('必填缺失（person/status/related_decisions/created_at）→ invalid，question 不算缺失', () => {
  const md = contextMd
    .replace('| person | 我 |\n', '')
    .replace('| status | 评估中 |\n', '')
    .replace('| related_decisions | 2026-07-20-方向探索, 2026-07-22-转行分析 |\n', '')
    .replace('| created_at | 2026-07-20 |\n', '')
  const p = parseContextMarkdown(md, '未来三年职业方向选择.md')
  assert.equal(p.validation?.status, 'invalid')
  const paths = p.validation!.issues.map((i) => i.path)
  for (const f of ['person', 'status', 'relatedDecisions', 'createdAt']) {
    assert.ok(paths.includes(f), `${f} 应标记缺失`)
  }
  assert.ok(!paths.includes('question')) // question 可派生不算缺失
})

test('status 值域非法 → degraded（warn）保留原值，不崩', () => {
  const md = contextMd.replace('| status | 评估中 |', '| status | 已定档 |')
  const p = parseContextMarkdown(md, '未来三年职业方向选择.md')
  assert.equal(p.validation?.status, 'degraded')
  assert.ok(p.validation!.issues.every((i) => i.severity === 'warn'))
  assert.equal(p.record.status, '已定档')
})

test('排除项解析：rejected_decisions/rejected_reasons（可选字段，不影响合法性）', () => {
  const md = contextMd.replace(
    '| related_decisions | 2026-07-20-方向探索, 2026-07-22-转行分析 |',
    '| related_decisions | 2026-07-20-方向探索, 2026-07-22-转行分析 |\n| rejected_decisions | 2026-07-22-转行分析 |\n| rejected_reasons | 大模型方向更契合长期目标 |',
  )
  const p = parseContextMarkdown(md, '未来三年职业方向选择.md')
  assert.equal(p.validation, undefined)
  assert.deepEqual(p.rejectedDecisions, ['2026-07-22-转行分析'])
  assert.deepEqual(p.rejectedReasons, ['大模型方向更契合长期目标'])
})

test('scanContexts：全量扫描 + 坏文件标 invalid 不崩', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-ctx-'))
  const ws = initWorkspace(root)
  ws.write('decision-contexts/好问题.md', contextMd)
  ws.write('decision-contexts/坏问题.md', '# 坏问题\n\n没有摘要表')
  const list = scanContexts(ws)
  assert.equal(list.length, 2)
  const good = list.find((c) => c.sourceFile === '好问题.md')
  const bad = list.find((c) => c.sourceFile === '坏问题.md')
  assert.ok(good && !good.validation, '合法 context 不应带 validation')
  assert.equal(bad?.validation?.status, 'invalid')
  rmSync(root, { recursive: true, force: true })
})
