import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { appendCandidates, appendSessionTurn, completePersonInit, createPersonSession, deletePerson, listCandidates, parsePersonManifest, parseSnapshotTable, resetPerson, resolveCandidate, scanPersons, watchPersons } from '../storage/person-watcher.ts'
import { createResumeArtifact } from '../storage/pdf-artifact.ts'

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

function makeWorkspace(files: Record<string, string>): string {
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
  const m = parsePersonManifest(manifestMd)
  assert.ok(m)
  assert.equal(m.id, 'person_001')
  assert.equal(m.name, '我')
  assert.equal(m.status, 'active')
  assert.equal(m.createdAt, '2026-08-06')
})

test('parsePersonManifest：缺 id/name/非法 status → undefined', () => {
  assert.equal(parsePersonManifest('# x\n\n## 分析摘要\n\n| id | person_001 |'), undefined) // 缺 name
  assert.equal(parsePersonManifest(manifestMd.replace('status: active', 'status: banned')), undefined) // 非法 status
})

test('parseSnapshotTable：摘要表解析 + 待采集/占位过滤', () => {
  const t = parseSnapshotTable(identityMd)
  assert.equal(t.education, '机械工程本科')
  assert.equal(t.location, '苏州/深圳（可出差）')
  assert.equal(t.graduation_year, undefined) // （待采集）过滤
  assert.equal(t.years_experience, '5')
})

test('scanPersons：person_001 完整扫描（identity/career/preference/events 计数 + skill_inventory）', () => {
  const dir = makeWorkspace({
    'persons/person_001/manifest.md': manifestMd,
    'persons/person_001/snapshot/current/identity.md': identityMd,
    'persons/person_001/snapshot/current/career_profile.md': careerMd,
    'persons/person_001/snapshot/current/skill_inventory.md': `---
id: person_001
status: v1
---

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill_count | 2 |

## A. 技能清单

| skill_id | 技能 | level | usage_context |
|----------|------|-------|---------------|
| skill_a | 机械设计 | applied-professional | 结构设计 |
| skill_b | 公差分析 | applied-basic | 校核 |
`,
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
    // skill_inventory → confirmed 技能（applied-professional→4 / applied-basic→2；inferred/learned 不进）
    assert.deepEqual(p.skills, [
      { skillId: 'skill_a', name: '机械设计', level: 4 },
      { skillId: 'skill_b', name: '公差分析', level: 2 },
    ])
    assert.equal(p.skillInventoryVersion, 'v1')
  } finally {
    cleanup(dir)
  }
})

test('scanPersons：User Career Intent 表 → targetRoles（只取 source=user，recommended 不消费为目标）', () => {
  const dir = makeWorkspace({
    'persons/person_001/manifest.md': manifestMd,
    'persons/person_001/snapshot/current/career_profile.md': `## 分析摘要

| 字段 | 值 |
|------|-----|
| current_role | 机械结构工程师 |

## User Career Intent

| target_role | priority | source |
|-------------|----------|--------|
| 机械结构工程师 | high | user |
| 机器人结构设计 | medium | recommended |
`,
  })
  try {
    const ws = initWorkspace(dir)
    const p = scanPersons(ws)[0]!
    assert.deepEqual(p.careerProfile?.targetRoles, ['机械结构工程师'])
    assert.equal(p.careerProfile?.currentRole, '机械结构工程师')
  } finally {
    cleanup(dir)
  }
})

test('scanPersons：缺 manifest / 无 persons 目录 → 降级空数组', () => {
  const dir = makeWorkspace({ 'persons/person_001/snapshot/current/identity.md': identityMd })
  try {
    const ws = initWorkspace(dir)
    assert.equal(scanPersons(ws).length, 0) // 缺 manifest → 跳过
    rmSync(join(dir, 'persons'), { recursive: true, force: true })
    assert.deepEqual(scanPersons(ws), []) // 无目录 → 空
  } finally {
    cleanup(dir)
  }
})

test('createPersonSession：manifest + intake 落盘，person_id 顺序递增', () => {
  const dir = makeWorkspace({})
  const ws = initWorkspace(dir)
  try {
    const first = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
    assert.equal(first.personId, 'person_001')
    assert.equal(first.sessionId, 'session-001')
    assert.ok(ws.exists('persons/person_001/manifest.md'))
    assert.ok(ws.exists('persons/person_001/intake/session-001.md'))
    const second = createPersonSession(ws, { name: '乙', sourceMode: 'resume' })
    assert.equal(second.personId, 'person_002')
  } finally {
    cleanup(dir)
  }
})

test('appendCandidates：追加批次 + id 递增 + 非法分类跳过；listCandidates 回读', () => {
  const dir = makeWorkspace({})
  const ws = initWorkspace(dir)
  try {
    const first = appendCandidates(ws, {
      personId: 'person_002',
      candidates: [
        { category: 'education', content: '机械设计本科', source: 'user_reported' },
        { category: 'bogus', content: '非法分类', source: 'user_reported' },
        { category: 'experience', content: '非标自动化 3 年', source: 'resume' },
      ],
    })
    assert.equal(first.length, 2)
    assert.equal(first[0]!.id, 'c-001')
    assert.equal(first[0]!.category, 'education')
    assert.equal(first[0]!.status, 'pending')
    assert.equal(first[1]!.source, 'resume')
    const second = appendCandidates(ws, {
      personId: 'person_002',
      candidates: [{ category: 'skill', content: 'Creo 建模', source: 'user_reported' }],
    })
    assert.equal(second[0]!.id, 'c-003')
    const all = listCandidates(ws, 'person_002')
    assert.equal(all.length, 3)
    assert.equal(all[2]!.category, 'skill')
    assert.equal(all[2]!.content, 'Creo 建模')
  } finally {
    cleanup(dir)
  }
})

test('resolveCandidate：确认/拒绝/修改更新状态 + 写 resolution 事件', () => {
  const dir = makeWorkspace({})
  const ws = initWorkspace(dir)
  try {
    const { id: candidateId } = appendCandidates(ws, {
      personId: 'person_002',
      candidates: [{ category: 'education', content: '机械设计本科', source: 'user_reported' }],
    })[0]!
    // 确认
    const r1 = resolveCandidate(ws, { personId: 'person_002', candidateId, action: 'confirmed' })
    assert.equal(r1?.status, 'confirmed')
    assert.equal(listCandidates(ws, 'person_002')[0]!.status, 'confirmed')
    // 事件写入
    const events = ws.listMarkdown('persons/person_002/events')
    assert.equal(events.length, 1)
    assert.ok(ws.read(`persons/person_002/events/${events[0]}`).includes('candidate_resolution'))
    assert.ok(ws.read(`persons/person_002/events/${events[0]}`).includes(`candidate_id: ${candidateId}`))
    // 修改
    const r2 = resolveCandidate(ws, { personId: 'person_002', candidateId, action: 'modified', modifiedContent: '机械设计制造及其自动化本科' })
    assert.equal(r2?.status, 'confirmed')
    assert.equal(listCandidates(ws, 'person_002')[0]!.content, '机械设计制造及其自动化本科')
    // 拒绝
    const r3 = resolveCandidate(ws, { personId: 'person_002', candidateId, action: 'rejected' })
    assert.equal(r3?.status, 'rejected')
    assert.equal(listCandidates(ws, 'person_002')[0]!.status, 'rejected')
    // 不存在 → null
    assert.equal(resolveCandidate(ws, { personId: 'person_002', candidateId: 'c-999', action: 'confirmed' }), null)
  } finally {
    cleanup(dir)
  }
})

test('resetPerson：清子资产重建空 session，manifest 保留；source_mode 回读', () => {
  const dir = makeWorkspace({})
  const ws = initWorkspace(dir)
  try {
    const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'resume' })
    appendCandidates(ws, { personId, candidates: [{ category: 'skill', content: 'Creo', source: 'user_reported' }] })
    appendSessionTurn(ws, { personId, role: 'user', content: '我有三年非标经验' })
    resetPerson(ws, personId)
    // manifest 保留（id/name/source_mode 回读）
    assert.ok(ws.exists(`persons/${personId}/manifest.md`))
    assert.ok(ws.read(`persons/${personId}/manifest.md`).includes('| source_mode | resume |'))
    // 候选清空
    assert.deepEqual(listCandidates(ws, personId), [])
    // session 重建为空模板（对话轮次消失）
    assert.ok(ws.exists(`persons/${personId}/intake/session-001.md`))
    assert.ok(!ws.read(`persons/${personId}/intake/session-001.md`).includes('非标经验'))
    // events 目录移除
    assert.equal(ws.exists(`persons/${personId}/events`), false)
    assert.throws(() => resetPerson(ws, '../evil'), /非法 personId/)
  } finally {
    cleanup(dir)
  }
})

test('deletePerson：整目录物理移除 + 幂等；scanPersons 同步降级', () => {
  const dir = makeWorkspace({})
  const ws = initWorkspace(dir)
  try {
    const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
    assert.equal(scanPersons(ws).length, 1)
    assert.deepEqual(deletePerson(ws, personId), { personId })
    assert.equal(ws.exists(`persons/${personId}/manifest.md`), false)
    assert.equal(scanPersons(ws).length, 0)
    // 幂等：重复删除不抛错
    assert.deepEqual(deletePerson(ws, personId), { personId })
    assert.throws(() => deletePerson(ws, '../evil'), /非法 personId/)
  } finally {
    cleanup(dir)
  }
})

test('createResumeArtifact：编号递增落盘 pdf/meta/extraction + reset 清理 documents', () => {
  const dir = makeWorkspace({})
  const ws = initWorkspace(dir)
  try {
    const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'resume' })
    // 第一次：text artifact
    const r1 = createResumeArtifact(ws, {
      personId,
      fileName: 'my-resume.txt',
      text: '机械结构工程师，5 年非标自动化经验。',
      extraction: { method: 'text' },
    })
    assert.equal(r1.artifactId, 'resume-001')
    assert.equal(r1.format, 'text')
    const meta1 = ws.read(`persons/${personId}/documents/resumes/resume-001.meta.md`)
    assert.ok(meta1.includes('artifactId: resume-001'))
    assert.ok(meta1.includes('source: uploaded_pdf'))
    assert.ok(meta1.includes('filename: my-resume.txt'))
    assert.ok(meta1.includes('method: text'))
    const ext1 = ws.read(`persons/${personId}/documents/resumes/extraction/resume-001.md`)
    assert.ok(ext1.includes('机械结构工程师'))
    // 第二次：pdf artifact（编号递增，不覆盖）
    const pdfBuf = Buffer.from('%PDF-1.4\n%%EOF')
    const r2 = createResumeArtifact(ws, {
      personId,
      fileName: 'resume.pdf',
      pdfBase64: pdfBuf.toString('base64'),
      text: '视觉提取的结果文本',
      extraction: { method: 'vision', model: 'glm-4.6v-flash' },
    })
    assert.equal(r2.artifactId, 'resume-002')
    assert.equal(r2.format, 'pdf')
    assert.ok(ws.exists(`persons/${personId}/documents/resumes/resume-002.pdf`))
    assert.deepEqual(Buffer.from(ws.read(`persons/${personId}/documents/resumes/resume-002.pdf`)), pdfBuf)
    const meta2 = ws.read(`persons/${personId}/documents/resumes/resume-002.meta.md`)
    assert.ok(meta2.includes('method: vision'))
    assert.ok(meta2.includes('model: glm-4.6v-flash'))
    // pdf 场景同时落盘提取文本（Agent 只读 extraction md，不读 pdf）
    assert.ok(ws.read(`persons/${personId}/documents/resumes/extraction/resume-002.md`).includes('视觉提取的结果文本'))
    // 第一次 artifact 未被覆盖
    assert.ok(ws.exists(`persons/${personId}/documents/resumes/extraction/resume-001.md`))
    // 校验：text/pdfBase64 都缺 → 抛错；非法 personId → 抛错
    assert.throws(() => createResumeArtifact(ws, { personId, text: '  ' }), /text 或 pdfBase64/)
    assert.throws(() => createResumeArtifact(ws, { personId: '../evil', text: 'x' }), /非法 personId/)
    // reset 清理 documents
    resetPerson(ws, personId)
    assert.equal(ws.exists(`persons/${personId}/documents/resumes/resume-001.meta.md`), false)
    // reset 后重新创建 → 编号回到 001
    const r3 = createResumeArtifact(ws, { personId, text: '重置后新简历' })
    assert.equal(r3.artifactId, 'resume-001')
  } finally {
    cleanup(dir)
  }
})

test('init_state：创建写入 in_progress；completePersonInit 写 completed；scanPersons 回读', () => {
  const dir = makeWorkspace({})
  const ws = initWorkspace(dir)
  try {
    const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
    const manifest = ws.read(`persons/${personId}/manifest.md`)
    assert.ok(manifest.includes('| init_state | in_progress |'))
    // parsePersonManifest 回读
    const parsed = parsePersonManifest(manifest)
    assert.equal(parsed?.initState, 'in_progress')
    // scanPersons 投影
    assert.equal(scanPersons(ws)[0]!.initState, 'in_progress')
    // 完成
    assert.deepEqual(completePersonInit(ws, personId), { personId, initState: 'completed' })
    assert.equal(parsePersonManifest(ws.read(`persons/${personId}/manifest.md`))?.initState, 'completed')
    assert.equal(scanPersons(ws)[0]!.initState, 'completed')
    assert.throws(() => completePersonInit(ws, '../evil'), /非法 personId/)
  } finally {
    cleanup(dir)
  }
})

test('resetPerson：init_state 重置回 in_progress', () => {
  const dir = makeWorkspace({})
  const ws = initWorkspace(dir)
  try {
    const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'resume' })
    completePersonInit(ws, personId)
    assert.equal(parsePersonManifest(ws.read(`persons/${personId}/manifest.md`))?.initState, 'completed')
    resetPerson(ws, personId)
    assert.equal(parsePersonManifest(ws.read(`persons/${personId}/manifest.md`))?.initState, 'in_progress')
  } finally {
    cleanup(dir)
  }
})

test('init_state：旧档案（无字段）→ undefined；completePersonInit 插入行', () => {
  const dir = makeWorkspace({ 'persons/person_001/manifest.md': manifestMd })
  const ws = initWorkspace(dir)
  try {
    assert.equal(parsePersonManifest(ws.read('persons/person_001/manifest.md'))?.initState, undefined)
    completePersonInit(ws, 'person_001')
    const md = ws.read('persons/person_001/manifest.md')
    assert.ok(md.includes('| init_state | completed |'))
    assert.equal(parsePersonManifest(md)?.initState, 'completed')
    assert.equal(scanPersons(ws)[0]!.initState, 'completed')
  } finally {
    cleanup(dir)
  }
})

/** 轮询等待条件（chokidar 事件异步到达；默认 3s 超时） */
function waitFor(pred: () => boolean, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv)
        resolve()
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv)
        reject(new Error('waitFor 超时'))
      }
    }, 25)
  })
}

test('watchPersons：add/change/unlink 任一触发 onChanged（P1 Person Aggregate 生命周期闭环）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-wps-'))
  const ws = initWorkspace(dir)
  let fired = 0
  const { close } = watchPersons(ws, () => { fired++ })
  try {
    await new Promise((r) => setTimeout(r, 250)) // chokidar 就绪
    const rel = 'persons/person_001/snapshot/current/skill_inventory.md'
    ws.write(rel, '# 技能\n')
    await waitFor(() => fired >= 1)
    ws.write(rel, '# 技能 v2\n')
    await waitFor(() => fired >= 2)
    rmSync(join(dir, rel), { recursive: true })
    await waitFor(() => fired >= 3)
    assert.equal(fired, 3, 'add/change/unlink 三次都应触发')
  } finally {
    await close()
    cleanup(dir)
  }
})
