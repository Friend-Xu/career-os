import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace, WorkspaceError } from '../storage/workspace.ts'
import {
  archiveCurrentSnapshot,
  listSnapshotVersions,
  migrateSnapshotLayout,
  parseSnapshotManifest,
  readSnapshotVersion,
} from '../storage/snapshot-archive.ts'

const manifestMd = `---
id: person_001
name: 我
status: active
created_at: 2026-08-06
---

# Person 001 — 我
`

/** 平铺旧结构 snapshot/*.md（带 frontmatter status，版本号推断源） */
const flatFiles: Record<string, string> = {
  'persons/person_001/manifest.md': manifestMd,
  'persons/person_001/snapshot/identity.md': `---
id: person_001
status: v2
---

# Identity

## 分析摘要

| 字段 | 值 |
|------|-----|
| education | 机械工程本科 |
`,
  'persons/person_001/snapshot/skill_inventory.md': `---
id: person_001
status: v2
---

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill_count | 3 |
| status | v2 resolved |
`,
  'persons/person_001/snapshot/preference_constraints.md': `---
id: person_001
status: v2
---

# Preference

## 分析摘要

| 字段 | 值 |
|------|-----|
| salary_range | 12-15K/月 |
`,
}

function makeWorkspace(): { root: string; ws: ReturnType<typeof initWorkspace> } {
  const root = mkdtempSync(join(tmpdir(), 'cos-snap-'))
  const ws = initWorkspace(root)
  for (const [rel, content] of Object.entries(flatFiles)) ws.write(rel, content)
  return { root, ws }
}

test('migrateSnapshotLayout：旧平铺 → current/ + bootstrap 版本（全量 + parent null + 版本号取 frontmatter max）', () => {
  const { root, ws } = makeWorkspace()
  try {
    const id = migrateSnapshotLayout(ws)
    assert.match(id!, /^snapshot_\d{8}_v2$/) // 无存档 → frontmatter status v2 推断
    // 平铺文件已移入 current/
    assert.equal(ws.exists('persons/person_001/snapshot/identity.md'), false)
    for (const f of ['identity.md', 'skill_inventory.md', 'preference_constraints.md']) {
      assert.equal(ws.exists(`persons/person_001/snapshot/current/${f}`), true)
    }
    // bootstrap 版本：全量 + manifest
    const versions = listSnapshotVersions(ws, 'person_001')
    assert.equal(versions.length, 1)
    const v = versions[0]!
    assert.equal(v.id, id)
    assert.equal(v.personId, 'person_001')
    assert.equal(v.parentVersion, null)
    assert.equal(v.reason, 'bootstrap')
    assert.equal(v.trigger, 'layout_migration')
    assert.deepEqual([...v.changedPaths].sort(), ['identity.md', 'preference_constraints.md', 'skill_inventory.md'])
    assert.equal(v.sourceRefs.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('migrateSnapshotLayout 幂等：无平铺残留 → null', () => {
  const { root, ws } = makeWorkspace()
  try {
    assert.ok(migrateSnapshotLayout(ws))
    assert.equal(migrateSnapshotLayout(ws), null) // 二次调用 no-op
    assert.equal(listSnapshotVersions(ws, 'person_001').length, 1) // 不重复产生版本
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('archiveCurrentSnapshot：增量——只存变化文件 + parent 链 + 版本号递增', () => {
  const { root, ws } = makeWorkspace()
  try {
    const bootstrap = migrateSnapshotLayout(ws)!
    // 更新 skill_inventory（status v3）+ 新增 experience_inventory
    ws.write('persons/person_001/snapshot/current/skill_inventory.md', flatFiles['persons/person_001/snapshot/skill_inventory.md']!.replace('status: v2', 'status: v3'))
    ws.write('persons/person_001/snapshot/current/experience_inventory.md', '---\nid: person_001\nstatus: v1\n---\n\n# Experience\n')
    const v2 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'skill_update', trigger: 'skill_intelligence_v3_completed', sourceRefs: ['evidence_001'] })
    assert.ok(v2)
    assert.match(v2.id, /^snapshot_\d{8}_v3$/) // bootstrap v2 → v3
    assert.equal(v2.parentVersion, bootstrap)
    assert.equal(v2.reason, 'skill_update')
    assert.equal(v2.trigger, 'skill_intelligence_v3_completed')
    assert.deepEqual([...v2.changedPaths].sort(), ['experience_inventory.md', 'skill_inventory.md']) // 只存变化文件
    assert.deepEqual(v2.sourceRefs, ['evidence_001'])
    // 版本目录只写变化文件
    const dirs = ws.listDirs('persons/person_001/snapshot/versions')
    assert.equal(dirs.length, 2)
    // 合并读取：identity 继承 bootstrap，skill/experience 取新版本
    const merged = readSnapshotVersion(ws, 'person_001', v2.id)
    assert.equal(Object.keys(merged).length, 4)
    assert.ok(merged['identity.md']!.includes('机械工程本科'))
    assert.ok(merged['skill_inventory.md']!.includes('status: v3'))
    assert.ok(merged['experience_inventory.md']!.includes('Experience'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('archiveCurrentSnapshot：与 latest 无差异 → null（幂等）；文件删除 → 空内容标记', () => {
  const { root, ws } = makeWorkspace()
  try {
    const bootstrap = migrateSnapshotLayout(ws)!
    assert.equal(archiveCurrentSnapshot(ws, 'person_001', { reason: 'noop' }), null) // 未变化
    // 删除 preference_constraints → changed_paths 含它，合并读取 = 空串
    ws.delete('persons/person_001/snapshot/current/preference_constraints.md')
    const v2 = archiveCurrentSnapshot(ws, 'person_001', { reason: 'preference_removed' })!
    assert.deepEqual(v2.changedPaths, ['preference_constraints.md'])
    assert.equal(v2.parentVersion, bootstrap)
    const merged = readSnapshotVersion(ws, 'person_001', v2.id)
    assert.equal(merged['preference_constraints.md'], '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('archiveCurrentSnapshot：reason 非法 → WorkspaceError（RPC 边界校验）', () => {
  const { root, ws } = makeWorkspace()
  try {
    migrateSnapshotLayout(ws)
    assert.throws(
      () => archiveCurrentSnapshot(ws, 'person_001', { reason: 'skill update' }),
      WorkspaceError,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listSnapshotVersions：正序 v1 → vN（versions/ 缺失 → 空）', () => {
  const { root, ws } = makeWorkspace()
  try {
    assert.deepEqual(listSnapshotVersions(ws, 'person_001'), []) // 未迁移 → 空
    migrateSnapshotLayout(ws)
    ws.write('persons/person_001/snapshot/current/experience_inventory.md', '---\nid: person_001\nstatus: v1\n---\n')
    archiveCurrentSnapshot(ws, 'person_001', { reason: 'experience_update' })
    const versions = listSnapshotVersions(ws, 'person_001')
    assert.equal(versions.length, 2)
    assert.ok(versions[0]!.id.endsWith('_v2')) // bootstrap frontmatter v2
    assert.ok(versions[1]!.id.endsWith('_v3'))
    assert.equal(versions[1]!.parentVersion, versions[0]!.id)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseSnapshotManifest：字段 roundtrip（数组逗号分隔/trigger 可含冒号）', () => {
  const m = parseSnapshotManifest(`---
id: snapshot_20260806_v2
person_id: person_001
created_at: 2026-08-06T02:30:00.000Z
parent_version: snapshot_20260806_v1
reason: skill_update
changed_paths: a.md,b.md
trigger: skill_v3: 完成
source_refs: evidence_001,evidence_002
---

# Snapshot Version
`)
  assert.ok(m)
  assert.equal(m!.id, 'snapshot_20260806_v2')
  assert.equal(m!.reason, 'skill_update')
  assert.deepEqual(m!.changedPaths, ['a.md', 'b.md'])
  assert.equal(m!.trigger, 'skill_v3: 完成') // 冒号在值内保留
  assert.deepEqual(m!.sourceRefs, ['evidence_001', 'evidence_002'])
  assert.equal(parseSnapshotManifest('# 无 frontmatter'), undefined)
})
