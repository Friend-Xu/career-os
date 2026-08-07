import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import {
  appendCandidates,
  listCandidates,
  parseEducationPayload,
  registerEducationFact,
  resolveCandidate,
  scanPersons,
} from '../storage/person-watcher.ts'

const manifestMd = `---
id: person_001
name: 我
status: active
created_at: 2026-08-06
---

# Person 001 — 我
`

function setup(): ReturnType<typeof initWorkspace> {
  const root = mkdtempSync(join(tmpdir(), 'cos-edu-'))
  const ws = initWorkspace(root)
  ws.write('persons/person_001/manifest.md', manifestMd)
  return ws
}

// ─── payload 解析 ─────────────────────────────────────────────────────────

test('parseEducationPayload：键值段全字段解析；缺学校 → undefined（结构化失败原文仍在）', () => {
  const full = parseEducationPayload('学校=东华大学；专业=机械工程；学历=本科；起=2019；止=2023')
  assert.deepEqual(full, { school: '东华大学', major: '机械工程', degree: '本科', startYear: 2019, endYear: 2023 })
  const partial = parseEducationPayload('学校=东华大学；学历=本科')
  assert.equal(partial!.school, '东华大学')
  assert.equal(partial!.degree, '本科')
  assert.equal(partial!.major, undefined)
  assert.equal(parseEducationPayload(undefined), undefined)
  assert.equal(parseEducationPayload('专业=机械工程；学历=本科'), undefined) // 缺学校 → 无结构化
  const noYear = parseEducationPayload('学校=东华大学；起=abc') // 非法年份丢弃，结构化仍在
  assert.equal(noYear!.school, '东华大学')
  assert.equal(noYear!.startYear, undefined)
})

// ─── 候选结构化载荷（提取端） ─────────────────────────────────────────────

test('appendCandidates：education 带 payload → candidates.md 6 列 + listCandidates 回读结构化', () => {
  const ws = setup()
  try {
    const added = appendCandidates(ws, {
      personId: 'person_001',
      candidates: [
        { category: 'education', content: '东华大学机械工程本科（2019-2023）', source: 'resume', payload: '学校=东华大学；专业=机械工程；学历=本科；起=2019；止=2023' },
        { category: 'experience', content: '某医疗器械公司 机械工程师', source: 'resume' },
      ],
    })
    assert.equal(added.length, 2)
    const all = listCandidates(ws, 'person_001')
    assert.equal(all.length, 2)
    const edu = all.find((c) => c.category === 'education')!
    assert.equal(edu.payload, '学校=东华大学；专业=机械工程；学历=本科；起=2019；止=2023')
    assert.deepEqual(edu.education, { school: '东华大学', major: '机械工程', degree: '本科', startYear: 2019, endYear: 2023 })
    assert.equal(all.find((c) => c.category === 'experience')!.education, undefined)
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('listCandidates：5 列旧格式（无 payload）兼容回读', () => {
  const ws = setup()
  try {
    ws.write(
      'persons/person_001/extraction/candidates.md',
      ['# Extraction Candidates', '', '| id | status | category | content | source |', '|----|--------|----------|---------|--------|', '| c-001 | confirmed | 教育 | 东华大学 机械工程 本科（2019-2023） | resume |', ''].join('\n'),
    )
    const all = listCandidates(ws, 'person_001')
    assert.equal(all.length, 1)
    assert.equal(all[0]!.content, '东华大学 机械工程 本科（2019-2023）')
    assert.equal(all[0]!.education, undefined)
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

// ─── Registration（resolve 确认 → facts/education.md） ────────────────────

test('resolveCandidate：education confirmed（含 payload）→ 登记 facts/education.md + scanPersons 派生', () => {
  const ws = setup()
  try {
    appendCandidates(ws, {
      personId: 'person_001',
      candidates: [
        { category: 'education', content: '东华大学机械工程本科（2019-2023）', source: 'resume', payload: '学校=东华大学；专业=机械工程；学历=本科；起=2019；止=2023' },
        { category: 'experience', content: '某医疗器械公司 机械工程师', source: 'resume' },
      ],
    })
    const r = resolveCandidate(ws, { personId: 'person_001', candidateId: 'c-001', action: 'confirmed' })
    assert.equal(r!.status, 'confirmed')

    const edu = scanPersons(ws).find((p) => p.personId === 'person_001')!.education!
    assert.equal(edu.length, 1)
    assert.deepEqual(edu[0], {
      candidateId: 'c-001',
      school: '东华大学',
      major: '机械工程',
      degree: '本科',
      startYear: 2019,
      graduationYear: 2023,
      status: 'confirmed',
      source: 'resume',
    })
    // 非教育候选确认不登记
    const r2 = resolveCandidate(ws, { personId: 'person_001', candidateId: 'c-002', action: 'confirmed' })
    assert.equal(r2!.status, 'confirmed')
    assert.equal(scanPersons(ws).find((p) => p.personId === 'person_001')!.education!.length, 1)
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('resolveCandidate：幂等——同一候选重复确认不重复登记；无 payload 确认不登记', () => {
  const ws = setup()
  try {
    appendCandidates(ws, {
      personId: 'person_001',
      candidates: [
        { category: 'education', content: '东华大学机械工程本科', source: 'user_reported', payload: '学校=东华大学；学历=本科' },
        { category: 'education', content: '某校 硕士', source: 'user_reported' }, // 无 payload
      ],
    })
    resolveCandidate(ws, { personId: 'person_001', candidateId: 'c-001', action: 'confirmed' })
    resolveCandidate(ws, { personId: 'person_001', candidateId: 'c-001', action: 'confirmed' }) // 重复
    resolveCandidate(ws, { personId: 'person_001', candidateId: 'c-002', action: 'confirmed' }) // 无 payload
    const edu = scanPersons(ws).find((p) => p.personId === 'person_001')!.education!
    assert.equal(edu.length, 1) // 幂等 + 无 payload 不登记
    assert.equal(edu[0]!.candidateId, 'c-001')
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('registerEducationFact：直接登记（存量迁移通道）+ 缺件（无 facts → education undefined）', () => {
  const ws = setup()
  try {
    // 缺件：无 facts/education.md → PersonSnapshot.education undefined（与「无教育」区分）
    const before = scanPersons(ws).find((p) => p.personId === 'person_001')!
    assert.equal(before.education, undefined)

    registerEducationFact(ws, 'person_001', {
      candidateId: 'c-001',
      school: '东华大学',
      major: '机械工程',
      degree: '本科',
      startYear: 2019,
      endYear: 2023,
      source: 'resume',
    })
    const edu = scanPersons(ws).find((p) => p.personId === 'person_001')!.education!
    assert.equal(edu.length, 1)
    assert.equal(edu[0]!.school, '东华大学')
    assert.equal(edu[0]!.graduationYear, 2023)
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})
