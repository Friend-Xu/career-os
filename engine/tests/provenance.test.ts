import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { parseDecisionMarkdown } from '../storage/report-watcher.ts'
import { buildCareerContext } from '../context/career-context.ts'

function tmpWs(): string {
  const dir = mkdtempSync(join(tmpdir(), 'career-os-provenance-'))
  initWorkspace(dir)
  return dir
}

const manifestMd = `---
id: person_001
name: 我
status: active
created_at: 2026-08-06
---

# Person 001 — 我

## 分析摘要

| 字段 | 值 |
|------|-----|
| id | person_001 |
| name | 我 |
| status | active |
`

/** 旧世界污染数据（M6.5 迁移前 profiles 声明的旧事实） */
const pollutedProfile = `# 我

## 目标方向

| 方向 | 匹配度 |
|------|:--:|
| 机器人结构设计 | 82% |
| CAE 仿真 | 75% |

## 技能

- 减速器设计：精通
- 机器人结构设计：精通
`

test('Direction Input Integrity：Person Aggregate 是唯一输入源——profiles/ 污染不影响 CareerContext', () => {
  const dir = tmpWs()
  try {
    // persons/ 真相源
    mkdirSync(join(dir, 'persons', 'person_001'), { recursive: true })
    writeFileSync(join(dir, 'persons', 'person_001', 'manifest.md'), manifestMd, 'utf8')
    // 旧世界污染（profiles/ 含已被废弃的旧声明）
    writeFileSync(join(dir, 'profiles', '我.md'), pollutedProfile, 'utf8')
    const ws = initWorkspace(dir)

    const ctx = buildCareerContext(ws)
    assert.ok(ctx.persons.length >= 1, 'persons 段应含扫描结果')
    const me = ctx.persons.find((p) => p.personId === 'person_001')
    assert.ok(me, '应能按 person_id 找到 person_001')
    assert.equal(me.name, '我')

    // 污染删除前后 persons 段一致（profiles/ 不被消费）
    const before = JSON.stringify(ctx.persons)
    const removed = rmSync(join(dir, 'profiles', '我.md'), { force: true })
    assert.equal(removed, undefined)
    const ctxAfter = buildCareerContext(initWorkspace(dir))
    assert.deepEqual(JSON.stringify(ctxAfter.persons), before, '删除 profiles 后 persons 段不变——唯一输入源是 persons/')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Decision Provenance：决策记录反查 Person Aggregate 引用（inputs + person_id）', () => {
  const md = `# 方向探索：机器人方向可行性

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill | career-path |
| direction | 机器人结构设计 |
| direction_match | 82% |
| direction_confidence | 中 |
| salary_feasible | true |
| risk_level | 低 |
| key_risk | 需补机器人传动/减速器知识 |
| status | complete |
| protocol_version | 2.1 |
| profile | 我 |
| person_id | person_001 |

---

## 输入引用

- evidence: evidence_20260806_00003@active
- skill: skill_python@v2
- constraint: constraint_salary
- knowledge: robotics_market_001
- unknown: 未知类型应跳过
`

  const parsed = parseDecisionMarkdown(md, 'decision_20260804_00001.md')
  assert.equal(parsed.value.personId, 'person_001')
  assert.deepEqual(parsed.value.inputs, {
    evidenceRefs: [{ id: 'evidence_20260806_00003', snapshot: 'active' }],
    skillRefs: [{ id: 'skill_python', version: 'v2' }],
    constraintRefs: [{ id: 'constraint_salary' }],
    knowledgeRefs: [{ id: 'robotics_market_001' }],
  })

  // 无输入引用段 → inputs undefined（存量决策兼容）
  const bare = `# 方向探索

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill | career-path |
| direction | 机器人结构设计 |
| direction_match | 82% |
| direction_confidence | 中 |
| salary_feasible | true |
| risk_level | 低 |
| key_risk | 无 |
| status | complete |
| protocol_version | 2.1 |
| profile | 我 |
`
  const parsedBare = parseDecisionMarkdown(bare, 'decision_20260804_00002.md')
  assert.equal(parsedBare.value.inputs, undefined)
  assert.equal(parsedBare.value.personId, undefined)
})
