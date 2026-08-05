import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionRecord } from '../ir/schema.ts'
import { buildAggregates } from '../runtime/decision-aggregate.ts'
import { parseContextMarkdown } from '../storage/context-watcher.ts'

function record(id: string, partial: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id,
    title: partial.title ?? `标题-${id}`,
    skill: 'career-path',
    ...partial,
    direction: partial.direction ?? '',
    directionMatch: partial.directionMatch ?? 80,
    directionConfidence: partial.directionConfidence ?? 'medium',
    city: partial.city ?? '',
    cityScore: partial.cityScore ?? 80,
    salaryFeasible: partial.salaryFeasible ?? true,
    riskLevel: partial.riskLevel ?? 'low',
    keyRisk: partial.keyRisk ?? '',
    status: partial.status ?? 'complete',
    profile: partial.profile ?? '我',
    summary: partial.summary ?? '',
    createdAt: partial.createdAt ?? '2026-07-20',
    protocolVersion: partial.protocolVersion ?? '2.1',
  }
}

function invalidRecord(id: string): DecisionRecord {
  return Object.assign(record(id), {
    validation: { status: 'invalid' as const, issues: [{ path: 'profile', reason: '缺失', severity: 'error' as const }] },
  })
}

/** context md 便捷构造：摘要表 + 可选正文 */
function ctxMd(partial: { question?: string; status?: string; related?: string; rejected?: string; reasons?: string; createdAt?: string; body?: string } = {}): string {
  const { question = '未来方向', status = '评估中', related = '2026-07-20-方向探索', createdAt = '2026-07-20' } = partial
  const rows = [
    `| person | 我 |`,
    `| question | ${question} |`,
    `| status | ${status} |`,
    `| related_decisions | ${related} |`,
    `| created_at | ${createdAt} |`,
  ]
  if (partial.rejected) rows.push(`| rejected_decisions | ${partial.rejected} |`)
  if (partial.reasons) rows.push(`| rejected_reasons | ${partial.reasons} |`)
  return `# ${question}

## 分析摘要

| 字段 | 值 |
|------|-----|
${rows.join('\n')}
${partial.body ?? ''}
`
}

const body = `

## 考虑因素

- 技术延续性：机械核心能力可迁移

## 证据

- 调研：方向探索匹配度 82%（来源：2026-07-20 方向探索）

## 结论

- 机器人结构设计（置信度：中）

## 风险

- 减速器经验为零（缓解：在职补强）
`

test('records：relatedDecisions 按决策 id 匹配、按声明顺序；invalid 决策排除', () => {
  const ctx = parseContextMarkdown(ctxMd({ related: '2026-08-02-JD分析, 2026-07-20-方向探索, 2026-07-22-转行分析' }), '问题.md')
  const aggregates = buildAggregates(
    [ctx],
    [
      record('2026-07-20-方向探索', { title: '方向探索决策' }),
      invalidRecord('2026-07-22-转行分析'),
      record('2026-08-02-JD分析', { title: 'JD 分析决策' }),
    ],
  )
  const agg = aggregates[0]!
  assert.deepEqual(
    agg.records.map((r) => r.id),
    ['2026-08-02-JD分析', '2026-07-20-方向探索'], // 文件声明顺序；invalid 的转行分析被排除
  )
})

test('options：每关联决策一个，name = 决策 title，status 默认 candidate', () => {
  const ctx = parseContextMarkdown(ctxMd({ related: '2026-07-20-方向探索, 2026-08-02-JD分析' }), '问题.md')
  const agg = buildAggregates([ctx], [record('2026-07-20-方向探索', { title: '方向探索决策' }), record('2026-08-02-JD分析', { title: 'JD 分析决策' })])[0]!
  assert.deepEqual(agg.options, [
    { name: '方向探索决策', status: 'candidate' },
    { name: 'JD 分析决策', status: 'candidate' },
  ])
})

test('排除项：rejected_decisions 对应 option → rejected，reasons 按下标对应；无 reasons 不挂', () => {
  const ctx = parseContextMarkdown(
    ctxMd({ related: '2026-07-20-方向探索, 2026-07-22-转行分析', rejected: '2026-07-22-转行分析', reasons: '大模型方向更契合长期目标' }),
    '问题.md',
  )
  const agg = buildAggregates([ctx], [record('2026-07-20-方向探索'), record('2026-07-22-转行分析')])[0]!
  assert.deepEqual(agg.options, [
    { name: '标题-2026-07-20-方向探索', status: 'candidate' },
    { name: '标题-2026-07-22-转行分析', status: 'rejected', reasons: ['大模型方向更契合长期目标'] },
  ])

  const ctxNoReasons = parseContextMarkdown(ctxMd({ related: '2026-07-20-方向探索', rejected: '2026-07-20-方向探索' }), '问题.md')
  const aggNoReasons = buildAggregates([ctxNoReasons], [record('2026-07-20-方向探索')])[0]!
  assert.deepEqual(aggNoReasons.options, [{ name: '标题-2026-07-20-方向探索', status: 'rejected' }])
})

test('factors/evidence/conclusion/risks 从正文段落透传；无段落 → 空数组/缺省', () => {
  const agg = buildAggregates([parseContextMarkdown(ctxMd({ body }), '问题.md')], [record('2026-07-20-方向探索')])[0]!
  assert.deepEqual(agg.factors, [{ name: '技术延续性', description: '机械核心能力可迁移' }])
  assert.deepEqual(agg.evidence, [{ type: '调研', content: '方向探索匹配度 82%', source: '2026-07-20 方向探索' }])
  assert.deepEqual(agg.conclusion, { selected: '机器人结构设计', confidence: 0.7 })
  assert.deepEqual(agg.risks, [{ description: '减速器经验为零', mitigation: '在职补强' }])

  const bare = buildAggregates([parseContextMarkdown(ctxMd(), '问题.md')], [record('2026-07-20-方向探索')])[0]!
  assert.deepEqual(bare.factors, [])
  assert.deepEqual(bare.evidence, [])
  assert.equal(bare.conclusion, undefined)
  assert.deepEqual(bare.risks, [])
})

test('未匹配 relatedDecisions → 跳过（records/options 均不含）', () => {
  const ctx = parseContextMarkdown(ctxMd({ related: '2026-07-20-方向探索, 2026-08-02-不存在的决策' }), '问题.md')
  const agg = buildAggregates([ctx], [record('2026-07-20-方向探索')])[0]!
  assert.deepEqual(agg.records.map((r) => r.id), ['2026-07-20-方向探索'])
  assert.equal(agg.options.length, 1)
})

test('排序：createdAt 降序（同日期按文件名降序）', () => {
  const a = parseContextMarkdown(ctxMd({ question: '问题A', createdAt: '2026-07-20' }), '问题A.md')
  const b = parseContextMarkdown(ctxMd({ question: '问题B', createdAt: '2026-08-01' }), '问题B.md')
  const c = parseContextMarkdown(ctxMd({ question: '问题C', createdAt: '2026-08-01' }), '问题C.md')
  const aggregates = buildAggregates([a, b, c], [])
  assert.deepEqual(
    aggregates.map((x) => x.context.question),
    ['问题C', '问题B', '问题A'],
  )
})

test('空 context 列表 → 空数组', () => {
  assert.deepEqual(buildAggregates([], []), [])
})
