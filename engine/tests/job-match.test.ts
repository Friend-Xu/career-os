import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { computeJobMatch } from '../transport/websocket.ts'

const skillsMd = `# 技能词表

## 办公软件

- 别名：Office, 办公套件
`

const rolesMd = `# 岗位清单

## 管理培训生（Company-A 医疗）

- essential：办公软件（来源：JD-Company-A 医疗-2026-08-07）
- essential：数据整理与文案（来源：JD-Company-A 医疗-2026-08-07）
- essential：跨部门协作（来源：JD-Company-A 医疗-2026-08-07）
`

const personManifestMd = `---
id: person_001
name: 我
status: active
created_at: 2026-08-06
---

# Person 001 — 我
`

/** person 技能：办公软件 4 级 + 数据整理与文案 2 级（与 roles.md 条目部分重叠）+ 括号工具词声明（tools 派生） */
const skillInvMd = `---
id: person_001
status: v2
---

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill_count | 3 |
| status | v2 resolved |

## A. 通用能力

| skill_id | 技能 | level | evidence_refs | usage_context | confidence |
|----------|------|-------|---------------|---------------|------------|
| skill_a | 办公软件 | applied-professional | 简历 | 日常办公 | high |
| skill_b | 数据整理与文案 | applied-basic | 简历 | 报告整理 | high |
| skill_c | 机械制图与三维建模（SolidWorks/Creo/AutoCAD） | applied-professional | 简历 | 结构设计 | high |
`

function setup(): ReturnType<typeof initWorkspace> {
  const root = mkdtempSync(join(tmpdir(), 'cos-jobmatch-'))
  const ws = initWorkspace(root)
  ws.write('knowledge/skills.md', skillsMd)
  ws.write('knowledge/roles.md', rolesMd)
  ws.write('persons/person_001/manifest.md', personManifestMd)
  ws.write('persons/person_001/snapshot/current/skill_inventory.md', skillInvMd)
  return ws
}

/** 建档 JD：requirements 为长句原文（分号切分），无 `## 岗位智能` 段 */
const jobNoIntelligenceMd = (requirements: string): string => `# 管理培训生 — Company-A 医疗

## 分析摘要

| 字段 | 值 |
|------|-----|
| company | Company-A 医疗 |
| title | 管理培训生 |
| requirements | ${requirements} |
| created_at | 2026-08-07 |
`

/** 建档 JD + `## 岗位智能` 段（AI 双输出写回，capabilities 为唯一匹配输入） */
const jobWithIntelligenceMd = `# 管理培训生 — Company-A 医疗

## 分析摘要

| 字段 | 值 |
|------|-----|
| company | Company-A 医疗 |
| title | 管理培训生 |
| requirements | 熟练使用办公软件;数据整理与文案 |
| created_at | 2026-08-07 |

## 岗位智能

| Responsibility | Priority | Capabilities | Evidence Patterns | Questions |
|----------------|----------|--------------|-------------------|-----------|
| 熟练使用办公软件 | must | 办公软件 | | |
| 跨部门协作 | must | 跨部门协作 | | |
`

test('jobs/match：匹配输入 = 岗位智能段 capabilities（roles.md 存在也不参与实例匹配）', () => {
  const ws = setup()
  try {
    ws.write('jobs/2026-08-07-Company-A 医疗-管理培训生.md', jobWithIntelligenceMd)
    const gap = computeJobMatch(ws, '2026-08-07-Company-A 医疗-管理培训生', '我')
    assert.deepEqual(gap.satisfied, [{ name: '办公软件', level: 4 }])
    assert.deepEqual(gap.transferable, [])
    assert.deepEqual(gap.missing.map((m) => m.name), ['跨部门协作'])
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('jobs/match：工具词命中（Skill Representation v0.1）+ soft 责任单元不消费（Capability Matching Boundary）', () => {
  const ws = setup()
  try {
    ws.write('jobs/2026-08-07-Company-A 医疗-管理培训生.md', `# 管理培训生 — Company-A 医疗

## 分析摘要

| 字段 | 值 |
|------|-----|
| company | Company-A 医疗 |
| title | 管理培训生 |
| requirements | 熟练使用办公软件 |
| created_at | 2026-08-07 |

## 岗位智能

| Responsibility | Priority | Category | Capabilities | Evidence Patterns | Questions |
|----------------|----------|-----------|--------------|-------------------|-----------|
| 熟练使用办公软件 | must | hard | 办公软件 | | |
| 三维建模工具 | must | hard | SolidWorks | | |
| 团队协作 | nice | soft | 团队协作 | | |
`)
    const gap = computeJobMatch(ws, '2026-08-07-Company-A 医疗-管理培训生', '我')
    assert.deepEqual(gap.satisfied, [
      { name: '办公软件', level: 4 },
      { name: '机械制图与三维建模（SolidWorks/Creo/AutoCAD）', level: 4, via: 'SolidWorks' }, // JD 工具词命中声明 tools
    ])
    assert.deepEqual(gap.transferable, [])
    assert.deepEqual(gap.missing, []) // soft 团队协作被过滤，不进匹配
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('jobs/match：未分析岗位（无岗位智能段）→ 空 gap——requirements 长句不产出匹配，roles.md 条目存在也不接续（防 fallback / 防 Artifact Boundary 混淆回归）', () => {
  const ws = setup()
  try {
    // requirements 为长句原文；roles.md 已有「管理培训生（Company-A 医疗）」条目——二者都不参与实例匹配
    ws.write(
      'jobs/2026-08-07-Company-A 医疗-管理培训生.md',
      jobNoIntelligenceMd('2024-2027届本科/硕士/博士应届生，学业基础良好，已顺利毕业并全职入职;生物医学工程、机械、材料等专业'),
    )
    const gap = computeJobMatch(ws, '2026-08-07-Company-A 医疗-管理培训生', '我')
    assert.deepEqual(gap.satisfied, [])
    assert.deepEqual(gap.transferable, [])
    assert.deepEqual(gap.missing, [])
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})
