import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import {
  appendCandidates,
  listCandidates,
  parseExperiencePayload,
  registerExperienceFact,
  resolveCandidate,
  scanPersons,
} from '../storage/person-watcher.ts'

/**
 * Person Experience Registration（契约 references/person-experience-registration-contract.md）。
 * education 同构：候选 payload 键值段 → resolve 确认 → facts/experience.md 登记 →
 * scanPersons 派生 Person.experiences（identity.md 工作经历表不再解析）。
 */

const manifestMd = `---
id: person_001
name: 我
status: active
created_at: 2026-08-06
---

# Person 001 — 我
`

function setup(): ReturnType<typeof initWorkspace> {
  const root = mkdtempSync(join(tmpdir(), 'cos-exp-'))
  const ws = initWorkspace(root)
  ws.write('persons/person_001/manifest.md', manifestMd)
  return ws
}

// ─── payload 解析 ─────────────────────────────────────────────────────────

test('parseExperiencePayload：键值段解析；缺公司 → undefined；起止保留原文（年限计算归 Matcher）', () => {
  const full = parseExperiencePayload('公司=Company-A 机械；岗位=机械工程师；起=2023.07；止=2025.03')
  assert.deepEqual(full, { company: 'Company-A 机械', role: '机械工程师', start: '2023.07', end: '2025.03' })
  const partial = parseExperiencePayload('公司=Company-A 机械；起=2023.07')
  assert.deepEqual(partial, { company: 'Company-A 机械', role: undefined, start: '2023.07', end: undefined })
  assert.equal(parseExperiencePayload(undefined), undefined)
  assert.equal(parseExperiencePayload('岗位=机械工程师；起=2023.07'), undefined) // 缺公司 → 无结构化
})

// ─── 候选结构化载荷（提取端） ─────────────────────────────────────────────

test('appendCandidates：experience 带 payload → candidates.md 6 列 + listCandidates 回读结构化', () => {
  const ws = setup()
  try {
    const added = appendCandidates(ws, {
      personId: 'person_001',
      candidates: [
        { category: 'experience', content: 'Company-A 机械 机械工程师（2023.07-2025.03）', source: 'resume', payload: '公司=Company-A 机械；岗位=机械工程师；起=2023.07；止=2025.03' },
        { category: 'education', content: 'University-A 机械工程 本科', source: 'resume', payload: '学校=University-A；学历=本科' },
      ],
    })
    assert.equal(added.length, 2)
    const all = listCandidates(ws, 'person_001')
    const exp = all.find((c) => c.category === 'experience')!
    assert.equal(exp.payload, '公司=Company-A 机械；岗位=机械工程师；起=2023.07；止=2025.03')
    assert.deepEqual(exp.experience, { company: 'Company-A 机械', role: '机械工程师', start: '2023.07', end: '2025.03' })
    assert.equal(all.find((c) => c.category === 'education')!.experience, undefined)
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

// ─── Registration（resolve 确认 → facts/experience.md） ───────────────────

test('resolveCandidate：experience confirmed（含 payload）→ 登记 facts/experience.md + scanPersons 派生', () => {
  const ws = setup()
  try {
    appendCandidates(ws, {
      personId: 'person_001',
      candidates: [
        { category: 'experience', content: 'Company-A 机械 机械工程师（2023.07-2025.03）', source: 'resume', payload: '公司=Company-A 机械；岗位=机械工程师；起=2023.07；止=2025.03' },
        { category: 'experience', content: '考研备考 Gap', source: 'user_reported' },
      ],
    })
    const r = resolveCandidate(ws, { personId: 'person_001', candidateId: 'c-001', action: 'confirmed' })
    assert.equal(r!.status, 'confirmed')

    const exp = scanPersons(ws).find((p) => p.personId === 'person_001')!.experiences!
    assert.equal(exp.length, 1)
    assert.deepEqual(exp[0], {
      candidateId: 'c-001',
      company: 'Company-A 机械',
      role: '机械工程师',
      start: '2023.07',
      end: '2025.03',
      status: 'confirmed',
    })
    // 无 payload 经历候选确认不登记
    const r2 = resolveCandidate(ws, { personId: 'person_001', candidateId: 'c-002', action: 'confirmed' })
    assert.equal(r2!.status, 'confirmed')
    assert.equal(scanPersons(ws).find((p) => p.personId === 'person_001')!.experiences!.length, 1)
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('resolveCandidate：幂等——同一候选重复确认不重复登记；rejected 不登记', () => {
  const ws = setup()
  try {
    appendCandidates(ws, {
      personId: 'person_001',
      candidates: [
        { category: 'experience', content: 'Company-A 机械 机械工程师', source: 'user_reported', payload: '公司=Company-A 机械；起=2023.07' },
        { category: 'experience', content: 'Company-B 工程师', source: 'user_reported', payload: '公司=Company-B；起=2020.01' },
      ],
    })
    resolveCandidate(ws, { personId: 'person_001', candidateId: 'c-001', action: 'confirmed' })
    resolveCandidate(ws, { personId: 'person_001', candidateId: 'c-001', action: 'confirmed' }) // 重复
    resolveCandidate(ws, { personId: 'person_001', candidateId: 'c-002', action: 'rejected' }) // 拒绝不登记
    const exp = scanPersons(ws).find((p) => p.personId === 'person_001')!.experiences!
    assert.equal(exp.length, 1)
    assert.equal(exp[0]!.candidateId, 'c-001')
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('scanPersons：经历真相源 = facts/experience.md——identity.md 工作经历表不再解析（历史遗留投影）', () => {
  const ws = setup()
  try {
    // 缺件：无 facts/experience.md → experiences undefined（与「无经历」区分）
    const before = scanPersons(ws).find((p) => p.personId === 'person_001')!
    assert.equal(before.experiences, undefined)

    // identity.md 带工作经历表（历史遗留）——不进入 Person.experiences
    ws.write(
      'persons/person_001/snapshot/current/identity.md',
      ['# 身份档案', '', '## 工作经历', '', '| company | role | start | end |', '|---------|------|-------|-----|', '| 遗留公司 | 工程师 | 2020.01 | 2022.12 |', ''].join('\n'),
    )
    assert.equal(scanPersons(ws).find((p) => p.personId === 'person_001')!.experiences, undefined)

    // 登记通道（存量迁移）：直接写 facts/experience.md → 派生
    registerExperienceFact(ws, 'person_001', {
      candidateId: 'c-001',
      company: 'Company-A 机械',
      role: '机械工程师',
      start: '2023.07',
      end: '2025.03',
      source: 'resume',
    })
    const exp = scanPersons(ws).find((p) => p.personId === 'person_001')!.experiences!
    assert.equal(exp.length, 1)
    assert.equal(exp[0]!.company, 'Company-A 机械')
    assert.equal(exp[0]!.status, 'confirmed')
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})
