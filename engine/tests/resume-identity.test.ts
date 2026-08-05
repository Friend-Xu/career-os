/**
 * resume-identity 单测（M5.2 G6 Boundary 修复）：身份段（profile/education/experience/target_intent）解析/组装/roundtrip。
 * 边界：身份条目无 claim 锚定（非 claim 通道）——Assembly 只投影不校验 claim；序列化用（identity）标记对称解析。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CareerClaim, EvidenceItem } from '../ir/schema.ts'
import { parseDraftManifest, assembleResumeFromDraft } from '../storage/resume-draft.ts'
import { serializeResumeDocument, parseResumeMarkdown } from '../storage/resume-watcher.ts'

const DRAFT = `# 简历（含身份信息）

## 分析摘要

| 字段 | 值 |
|------|-----|
| type | resume_draft |
| template_id | mechanical |

## 身份信息

### profile | 个人简介

- 机械工程本科，3 年医疗检测设备结构设计经验

### education | 教育背景

- 东华大学 | 机械工程 | 本科

### experience | 工作经历

- 某医疗器械公司 | 机械工程师 | 2023.07-2025.03 | 负责医疗检测设备机械结构设计

### target_intent | 求职意向

- 机械结构工程师 | 自动化设备、精密结构

## Claims

- claim_20260805_00001（section: projects）

## Skills

- SolidWorks（asset）
`

function ev(id: string): EvidenceItem {
  return {
    id,
    event: { title: id },
    role: '机械结构负责人',
    contribution: '负责自动化设备机械结构设计',
    evidence: { scope: [{ content: '机架和传动模块设计' }] },
    source: { type: 'user_input', capturedAt: '2026-08-05' },
    status: 'trusted',
  }
}

function claim(id: string, statement: string, evidenceIds: string[]): CareerClaim {
  return {
    id,
    created_at: '2026-08-05',
    source: 'agent_generated',
    statement,
    claimType: 'fact',
    provenance: evidenceIds.map((evidenceId) => ({ evidenceId })),
  }
}

const CLAIMS = [claim('claim_20260805_00001', '负责生化分析仪中心反应盘结构校核', ['evidence_20260805_00001'])]
const EVIDENCE = [ev('evidence_20260805_00001')]

test('M5.2 G6：parseDraftManifest 解析身份段（4 段 + label/body 切分）', () => {
  const { value, validation } = parseDraftManifest(DRAFT, 'resume-identity.md')
  assert.equal(validation, undefined)
  assert.equal(value.identitySections?.length, 4)
  const types = value.identitySections!.map((s) => s.type)
  assert.deepEqual(types, ['profile', 'education', 'experience', 'target_intent'])
  const profile = value.identitySections![0]
  assert.equal(profile.entries.length, 1)
  assert.equal(profile.entries[0].label, undefined)
  assert.equal(profile.entries[0].body, '机械工程本科，3 年医疗检测设备结构设计经验')
  const edu = value.identitySections![1]
  assert.equal(edu.entries[0].label, '东华大学')
  assert.equal(edu.entries[0].body, '机械工程 | 本科')
  const exp = value.identitySections![2]
  assert.equal(exp.entries[0].label, '某医疗器械公司')
  assert.equal(exp.entries[0].body, '机械工程师 | 2023.07-2025.03 | 负责医疗检测设备机械结构设计')
})

test('M5.2 G6：Assembly 身份段前插（顺序 identity → claims → skills + identity 投影）', () => {
  const { document, validation } = assembleResumeFromDraft({
    manifest: parseDraftManifest(DRAFT, 'resume-identity.md').value,
    claims: CLAIMS,
    evidence: EVIDENCE,
    selectorCandidates: [],
  })
  assert.equal(validation.status, 'valid')
  assert.deepEqual(document.sections.map((s) => s.type), ['profile', 'education', 'experience', 'target_intent', 'projects', 'skills'])
  const profile = document.sections[0]
  assert.equal(profile.bullets.length, 0) // 身份段无 claim bullet
  assert.equal(profile.identity?.length, 1)
  assert.equal(profile.identity![0].body, '机械工程本科，3 年医疗检测设备结构设计经验')
  const projects = document.sections[4]
  assert.equal(projects.bullets.length, 1)
  assert.equal(projects.bullets[0].claimId, 'claim_20260805_00001')
})

test('M5.2 G6：serialize → parse roundtrip 身份段还原', () => {
  const manifest = parseDraftManifest(DRAFT, 'resume-identity.md').value
  const { document } = assembleResumeFromDraft({ manifest, claims: CLAIMS, evidence: EVIDENCE, selectorCandidates: [] })
  const md = serializeResumeDocument({ ...document, validation: undefined })
  const parsed = parseResumeMarkdown(md, 'resume_20260805_00001.md').value
  assert.deepEqual(parsed.sections.map((s) => s.type), ['profile', 'education', 'experience', 'target_intent', 'projects', 'skills'])
  assert.deepEqual(parsed.sections[0].identity, [{ body: '机械工程本科，3 年医疗检测设备结构设计经验' }])
  assert.deepEqual(parsed.sections[2].identity, [{ label: '某医疗器械公司', body: '机械工程师 | 2023.07-2025.03 | 负责医疗检测设备机械结构设计' }])
  assert.equal(parsed.sections[4].bullets[0].claimId, 'claim_20260805_00001')
})

test('M6.3：target_id 契约——manifest → document → serialize/parse roundtrip', () => {
  const md = DRAFT.replace('| template_id | mechanical |', '| template_id | mechanical |\n| target_id | target_20260806_00001 |')
  const manifest = parseDraftManifest(md, 'resume-target.md').value
  assert.equal(manifest.targetId, 'target_20260806_00001')
  const { document } = assembleResumeFromDraft({ manifest, claims: CLAIMS, evidence: EVIDENCE, selectorCandidates: [] })
  assert.equal(document.targetId, 'target_20260806_00001')
  const roundtrip = parseResumeMarkdown(serializeResumeDocument(document), 'r.md').value
  assert.equal(roundtrip.targetId, 'target_20260806_00001')
})

test('M6.3：identity body 尾缀（identity）剥离 + warning（防身份污染）', () => {
  const md = DRAFT.replace(
    '- 机械工程本科，3 年医疗检测设备结构设计经验',
    '- 机械工程本科，3 年医疗检测设备结构设计经验（identity）',
  )
  const { document, validation } = assembleResumeFromDraft({
    manifest: parseDraftManifest(md, 'resume-marker.md').value,
    claims: CLAIMS,
    evidence: EVIDENCE,
    selectorCandidates: [],
  })
  assert.equal(document.sections[0].identity![0].body, '机械工程本科，3 年医疗检测设备结构设计经验')
  assert.ok(validation.issues.some((i) => i.code === 'IDENTITY_MARKER_IN_BODY'))
  assert.equal(validation.status, 'warning')
})
