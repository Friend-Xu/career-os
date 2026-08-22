import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { appendCandidates, appendSessionTurn, completePersonInit, createPersonSession, deletePerson, listCandidates, parsePersonManifest, parseSnapshotTable, reconcilePersonInitStates, resetPerson, resolveCandidate, scanPersons, upsertSummaryStrengths, watchPersons } from '../storage/person-watcher.ts'
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
| location | City-X/City-W（可出差） |
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
  assert.equal(t.location, 'City-X/City-W（可出差）')
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

test('scanPersons：skill_inventory 括号工具词 → tools 派生（Skill Representation v0.1；无括号 → 缺省）', () => {
  const dir = makeWorkspace({
    'persons/person_001/manifest.md': manifestMd,
    'persons/person_001/snapshot/current/skill_inventory.md': `---
id: person_001
status: v1
---

## A. 技能清单

| skill_id | 技能 | level | usage_context |
|----------|------|-------|---------------|
| skill_001 | 电气制图与接线设计（SolidWorks/Creo/AutoCAD） | applied-professional | 结构设计 |
| skill_007 | 电气仿真（EPLAN） | applied-basic | 基础仿真 |
| skill_005 | 电气原理图设计 | applied-professional | 整机开发 |
`,
  })
  try {
    const ws = initWorkspace(dir)
    const p = scanPersons(ws)[0]!
    assert.deepEqual(p.skills, [
      { skillId: 'skill_001', name: '电气制图与接线设计（SolidWorks/Creo/AutoCAD）', level: 4, tools: ['SolidWorks', 'Creo', 'AutoCAD'] },
      { skillId: 'skill_007', name: '电气仿真（EPLAN）', level: 2, tools: ['EPLAN'] },
      { skillId: 'skill_005', name: '电气原理图设计', level: 4 },
    ])
  } finally {
    cleanup(dir)
  }
})

test('scanPersons：skill_inventory aliases 列 → 同义表达（逗号/分号/顿号分隔；旧四列格式无此列 → 缺省兼容）', () => {
  const dir = makeWorkspace({
    'persons/person_001/manifest.md': manifestMd,
    'persons/person_001/snapshot/current/skill_inventory.md': `---
id: person_001
status: v1
---

## A. 技能清单

| skill_id | 技能 | level | usage_context | aliases |
|----------|------|-------|---------------|---------|
| skill_001 | 电路原理图绘制 | applied-professional | 硬件设计 | 电路图、PCB 绘图 |
| skill_002 | 网络布线设计与施工 | applied-professional | 弱电工程 | 布线, 网络施工; 线缆敷设 |
| skill_003 | 数据库设计与优化 | applied-intermediate | 后端开发 |
`,
  })
  try {
    const ws = initWorkspace(dir)
    const p = scanPersons(ws)[0]!
    assert.deepEqual(p.skills, [
      { skillId: 'skill_001', name: '电路原理图绘制', level: 4, aliases: ['电路图', 'PCB 绘图'] },
      { skillId: 'skill_002', name: '网络布线设计与施工', level: 4, aliases: ['布线', '网络施工', '线缆敷设'] },
      { skillId: 'skill_003', name: '数据库设计与优化', level: 3 },
    ])
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

/** 补齐初始化完成门禁必需快照件（identity/skill_inventory/preference_constraints）——门禁测试辅助 */
function seedCompleteSnapshots(ws: ReturnType<typeof initWorkspace>, personId: string): void {
  ws.write(`persons/${personId}/snapshot/current/identity.md`, '# 身份\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| years_experience | 3 年 |\n| location | 苏州 |\n')
  ws.write(`persons/${personId}/snapshot/current/skill_inventory.md`, '# 技能\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| skill_count | 1 |\n\n## A. 技能清单\n\n| skill_id | 技能 | level | usage_context |\n|----------|------|-------|---------------|\n| skill_001 | 机械设计 | applied-professional | 结构设计 |\n')
  ws.write(`persons/${personId}/snapshot/current/preference_constraints.md`, '# 偏好\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| city | 苏州 |\n| salary_range | 11-13K |\n')
}

test('init_state：创建写入 uploading；completePersonInit 写 completed；scanPersons 回读', () => {
  const dir = makeWorkspace({})
  const ws = initWorkspace(dir)
  try {
    const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
    const manifest = ws.read(`persons/${personId}/manifest.md`)
    assert.ok(manifest.includes('| init_state | uploading |'))
    // parsePersonManifest 回读
    const parsed = parsePersonManifest(manifest)
    assert.equal(parsed?.initState, 'uploading')
    // scanPersons 投影
    assert.equal(scanPersons(ws)[0]!.initState, 'uploading')
    // 门禁：缺快照件 → 拒绝
    assert.throws(() => completePersonInit(ws, personId), /画像未齐备.*identity\.md/)
    // 补齐后完成
    seedCompleteSnapshots(ws, personId)
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
    seedCompleteSnapshots(ws, personId)
    completePersonInit(ws, personId)
    assert.equal(parsePersonManifest(ws.read(`persons/${personId}/manifest.md`))?.initState, 'completed')
    resetPerson(ws, personId)
    assert.equal(parsePersonManifest(ws.read(`persons/${personId}/manifest.md`))?.initState, 'uploading')
  } finally {
    cleanup(dir)
  }
})

test('init_state：旧档案（无字段）→ undefined；completePersonInit 插入行', () => {
  const dir = makeWorkspace({ 'persons/person_001/manifest.md': manifestMd })
  const ws = initWorkspace(dir)
  try {
    assert.equal(parsePersonManifest(ws.read('persons/person_001/manifest.md'))?.initState, undefined)
    seedCompleteSnapshots(ws, 'person_001')
    completePersonInit(ws, 'person_001')
    const md = ws.read('persons/person_001/manifest.md')
    assert.ok(md.includes('| init_state | completed |'))
    assert.equal(parsePersonManifest(md)?.initState, 'completed')
    assert.equal(scanPersons(ws)[0]!.initState, 'completed')
  } finally {
    cleanup(dir)
  }
})

test('completePersonInit 门禁：缺任一必需快照件 → 拒绝并列出缺件（防空壳完成）', () => {
  const dir = makeWorkspace({})
  const ws = initWorkspace(dir)
  try {
    const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
    // 只写 skill_inventory（测试区 person_001 的真实状态）→ 缺 identity/preference → 拒绝
    ws.write(`persons/${personId}/snapshot/current/skill_inventory.md`, '# 技能\n')
    assert.throws(
      () => completePersonInit(ws, personId),
      /画像未齐备，禁止标记完成：缺 identity\.md、preference_constraints\.md/,
    )
    assert.equal(parsePersonManifest(ws.read(`persons/${personId}/manifest.md`))?.initState, 'uploading')
  } finally {
    cleanup(dir)
  }
})

test('reconcilePersonInitStates：历史空壳 completed（manifest 标完成但快照缺件）→ 回滚 candidate_review（对账循环）', () => {
  const dir = makeWorkspace({})
  const ws = initWorkspace(dir)
  try {
    const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
    // 模拟历史空壳：manifest 被旧流程直接标 completed（门禁前的产物），快照只写 1 件（测试区 person_001 镜像）
    ws.write(`persons/${personId}/snapshot/current/skill_inventory.md`, '# 技能\n')
    const manifest = ws.read(`persons/${personId}/manifest.md`)
    ws.write(`persons/${personId}/manifest.md`, manifest.replace('| init_state | uploading |', '| init_state | completed |'))
    assert.equal(parsePersonManifest(ws.read(`persons/${personId}/manifest.md`))?.initState, 'completed')
    // 对账：completed 但缺件 → 回滚 candidate_review（候选清单仍在，可重新确认），并返回缺件说明
    const rolledBack = reconcilePersonInitStates(ws)
    assert.equal(rolledBack.length, 1)
    assert.ok(rolledBack[0]!.includes(personId))
    assert.ok(rolledBack[0]!.includes('identity.md'))
    assert.equal(parsePersonManifest(ws.read(`persons/${personId}/manifest.md`))?.initState, 'candidate_review')
    assert.equal(scanPersons(ws)[0]!.initState, 'candidate_review')
    // 幂等：再次对账零写入零返回
    assert.deepEqual(reconcilePersonInitStates(ws), [])
  } finally {
    cleanup(dir)
  }
})

test('reconcilePersonInitStates：快照齐备的 completed 不受影响（对账不误伤）；无 manifest 目录安全', () => {
  const dir = makeWorkspace({})
  const ws = initWorkspace(dir)
  try {
    const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
    seedCompleteSnapshots(ws, personId)
    completePersonInit(ws, personId)
    assert.deepEqual(reconcilePersonInitStates(ws), [])
    assert.equal(parsePersonManifest(ws.read(`persons/${personId}/manifest.md`))?.initState, 'completed')
    // 无 persons/ 目录 → 空（不抛错）
    const empty = initWorkspace(`${dir}-empty`)
    assert.deepEqual(reconcilePersonInitStates(empty), [])
    cleanup(`${dir}-empty`)
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

// ─── Summary Strength Contract v0.1：优势亮点（引用型资产——锚 claims，不复制事实）───

const CLAIM_FIXTURE = `---
id: claim_20260808_00001
created_at: 2026-08-08
lifecycle: active
---
# 主导气密性工装设计，使装配泄漏率降至 0.5%

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | 主导气密性工装设计，使装配泄漏率降至 0.5% |
| claim_type | fact |
| source | agent_generated |
| captured_at | 2026-08-08 |

## 证据来源

- evidence_20260808_00001
`

const EVIDENCE_FIXTURE = `---
id: evidence_20260808_00001
owner: person_001
lifecycle: active
type: independent_project
created_at: 2026-08-08
---
# Project-A 气密性工装

## 分析摘要

| 字段 | 值 |
|------|-----|
| role | 结构负责人 |
| contribution | 主导气密性工装设计 |
| status | trusted |
| source_type | user_input |
| captured_at | 2026-08-08 |
| owner | person_001 |
| type | independent_project |

## 证据

### scope
- 气密性工装设计

### impact
- 装配泄漏率降至 0.5%
`

const STRENGTHS_FIXTURE = `---
id: person_001
---
# 优势亮点 — person_001

## 分析摘要

| 字段 | 值 |
|------|-----|
| version | 1 |

## 优势条目

- 气密性问题解决：主导工装设计，装配泄漏率降至 0.5%（claims: claim_20260808_00001）
- 动手与落地：全流程独立开发能力（claims: claim_20260808_00001, claim_99999999_00001）（evidence: evidence_20260808_00001）
- 软性优势——无支撑标注
`

test('scanPersons：summary_strengths.md → summaryStrengths（v0.2 结论句 + 多锚标注解析）', () => {
  const dir = makeWorkspace({
    'persons/person_001/manifest.md': manifestMd,
    'persons/person_001/snapshot/current/summary_strengths.md': STRENGTHS_FIXTURE,
  })
  try {
    const ws = initWorkspace(dir)
    const p = scanPersons(ws)[0]!
    assert.deepEqual(p.summaryStrengths, [
      { text: '气密性问题解决：主导工装设计，装配泄漏率降至 0.5%', claimIds: ['claim_20260808_00001'], evidenceIds: [] },
      { text: '动手与落地：全流程独立开发能力', claimIds: ['claim_20260808_00001', 'claim_99999999_00001'], evidenceIds: ['evidence_20260808_00001'] },
      { text: '软性优势——无支撑标注', claimIds: [], evidenceIds: [] },
    ])
  } finally {
    cleanup(dir)
  }
})

test('upsertSummaryStrengths：校验通过 → 写文件 + 返回条目；scanPersons 回读一致', () => {
  const dir = makeWorkspace({
    'persons/person_001/manifest.md': manifestMd,
    'claims/claim_20260808_00001.md': CLAIM_FIXTURE,
    'evidence/evidence_20260808_00001.md': EVIDENCE_FIXTURE,
  })
  try {
    const ws = initWorkspace(dir)
    const cleaned = upsertSummaryStrengths(ws, 'person_001', [
      { text: '  气密性问题解决：主导工装设计  ', claimIds: ['claim_20260808_00001'], evidenceIds: ['evidence_20260808_00001'] },
      { text: '软性优势', claimIds: [], evidenceIds: [] },
    ])
    assert.deepEqual(cleaned, [
      { text: '气密性问题解决：主导工装设计', claimIds: ['claim_20260808_00001'], evidenceIds: ['evidence_20260808_00001'] },
      { text: '软性优势', claimIds: [], evidenceIds: [] },
    ])
    const p = scanPersons(ws)[0]!
    assert.deepEqual(p.summaryStrengths, cleaned, 'scanPersons 回读与 upsert 返回一致')
    const md = ws.read('persons/person_001/snapshot/current/summary_strengths.md')
    assert.ok(md.includes('- 气密性问题解决：主导工装设计 （claims: claim_20260808_00001） （evidence: evidence_20260808_00001）'))
    assert.ok(md.includes('- 软性优势\n'), '软性条目无标注')
  } finally {
    cleanup(dir)
  }
})

test('upsertSummaryStrengths：引用不存在 / 未可信 / 文本空 → fail fast', () => {
  const dir = makeWorkspace({
    'persons/person_001/manifest.md': manifestMd,
    'claims/claim_20260808_00001.md': CLAIM_FIXTURE,
    'evidence/evidence_20260808_00001.md': EVIDENCE_FIXTURE.replace('| status | trusted |', '| status | raw |'),
  })
  try {
    const ws = initWorkspace(dir)
    assert.throws(() => upsertSummaryStrengths(ws, 'person_001', [{ text: 'x', claimIds: ['claim_99999999_99999'], evidenceIds: [] }]), /claim 不存在/)
    assert.throws(() => upsertSummaryStrengths(ws, 'person_001', [{ text: 'x', claimIds: ['claim_20260808_00001'], evidenceIds: [] }]), /不可消费/)
    assert.throws(() => upsertSummaryStrengths(ws, 'person_001', [{ text: 'x', claimIds: [], evidenceIds: ['evidence_20260808_00001'] }]), /不可消费/)
    assert.throws(() => upsertSummaryStrengths(ws, 'person_001', [{ text: 'x', claimIds: [], evidenceIds: ['evidence_99999999_99999'] }]), /evidence 不存在/)
    assert.throws(() => upsertSummaryStrengths(ws, 'person_001', [{ text: '  ', claimIds: [], evidenceIds: [] }]), /不能为空/)
  } finally {
    cleanup(dir)
  }
})
