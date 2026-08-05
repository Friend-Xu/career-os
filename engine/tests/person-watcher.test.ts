import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { parsePersonManifest, parseSnapshotTable, scanPersons } from '../storage/person-watcher.ts'
import { silentLogger } from './companies.test.ts'

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

const identityMd = `---
id: person_001
---

## 分析摘要

| 字段 | 值 |
|------|-----|
| name | 我 |
| education | 机械工程本科 |
| graduation_year | （待采集） |
| location | 苏州/深圳（可出差） |
| years_experience | 5 |
`

const careerMd = `## 分析摘要

| 字段 | 值 |
|------|-----|
| current_role | 机械结构工程师 |
| target_roles | （待校准） |

## 目标方向（待校准）

- 机器人结构设计 82%
- CAE 仿真 78%
`

function makeWorkspace(personId: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-person-'))
  initWorkspace(dir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return dir
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

test('parsePersonManifest：合法 manifest → 根声明', () => {
  const m = parsePersonManifest(manifestMd, 'persons/person_001/manifest.md')
  assert.ok(m)
  assert.equal(m.id, 'person_001')
  assert.equal(m.name, '我')
  assert.equal(m.status, 'active')
  assert.equal(m.createdAt, '2026-08-06')
})

test('parsePersonManifest：缺 id/name/非法 status → undefined', () => {
  assert.equal(parsePersonManifest('# x\n\n## 分析摘要\n\n| id | person_001 |', 'a.md'), undefined) // 缺 name
  assert.equal(parsePersonManifest(manifestMd.replace('status: active', 'status: banned'), 'a.md'), undefined) // 非法 status
})

test('parseSnapshotTable：摘要表解析 + 待采集/占位过滤', () => {
  const t = parseSnapshotTable(identityMd)
  assert.equal(t.education, '机械工程本科')
  assert.equal(t.location, '苏州/深圳（可出差）')
  assert.equal(t.graduation_year, undefined) // （待采集）过滤
  assert.equal(t.years_experience, '5')
})

test('scanPersons：person_001 完整扫描（identity/career/preference/events 计数）', () => {
  const dir = makeWorkspace('person_001', {
    'persons/person_001/manifest.md': manifestMd,
    'persons/person_001/snapshot/current/identity.md': identityMd,
    'persons/person_001/snapshot/current/career_profile.md': careerMd,
    'persons/person_001/events/event_20260806_000001.md': '# 事件：person_001 建立\n',
  })
  try {
    const ws = initWorkspace(dir)
    const persons = scanPersons(ws)
    assert.equal(persons.length, 1)
    const p = persons[0]!
    assert.equal(p.personId, 'person_001')
    assert.equal(p.name, '我')
    assert.equal(p.status, 'active')
    assert.equal(p.identity?.education, '机械工程本科')
    assert.equal(p.identity?.graduationYear, undefined)
    assert.equal(p.careerProfile?.currentRole, '机械结构工程师')
    assert.deepEqual(p.careerProfile?.targetRoles, ['机器人结构设计', 'CAE 仿真'])
    assert.equal(p.eventCount, 1)
  } finally {
    cleanup(dir)
  }
})

test('scanPersons：缺 manifest / 无 persons 目录 → 降级空数组', () => {
  const dir = makeWorkspace('person_001', { 'persons/person_001/snapshot/current/identity.md': identityMd })
  try {
    const ws = initWorkspace(dir)
    assert.equal(scanPersons(ws).length, 0) // 缺 manifest → 跳过
    rmSync(join(dir, 'persons'), { recursive: true, force: true })
    assert.deepEqual(scanPersons(ws), []) // 无目录 → 空
  } finally {
    cleanup(dir)
  }
})
