/**
 * resume-version 单测（M3.5.3）：Lifecycle 状态机 / clone lineage / identity diff /
 * serialize-parse roundtrip / assembleDraftFile 端到端（drafts → documents 登记）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResumeDocument } from '../ir/resume.ts'
import { initWorkspace } from '../storage/workspace.ts'
import {
  serializeResumeDocument,
  parseResumeMarkdown,
  transitionResumeStatusFile,
  cloneResumeFile,
  markResumeExported,
  diffResumes,
  assembleDraftFile,
  scanResumes,
  ResumeTransitionError,
} from '../storage/resume-watcher.ts'
import { registerArtifacts } from '../storage/artifact-registry.ts'

function doc(overrides: Partial<ResumeDocument> = {}): ResumeDocument {
  return {
    id: 'resume_20260805_00001',
    status: 'draft',
    person: '我',
    targetJobId: 'job_20260805_00001',
    templateId: 'mechanical',
    templateVersion: '1.2',
    sections: [
      {
        type: 'experience',
        title: '工作经历',
        bullets: [
          { sentence: '负责自动化设备机械结构设计，完成机架及传动机构优化', claimId: 'claim_20260804_00001', metadata: { expectationId: 'engineering_scope' } },
          { sentence: '通过装配检查和现场调试解决安装干涉问题', claimId: 'claim_20260804_00002' },
        ],
      },
      { type: 'skills', title: '技能', bullets: [], assetRefs: ['SolidWorks', 'ANSYS'] },
    ],
    generatedAt: '2026-08-05T10:00:00Z',
    lineage: { derivationType: 'jd_generate', createdBy: 'ai' },
    operations: [{ id: 'operation_001', actor: 'ai', action: 'create', at: '2026-08-05T10:00:00Z' }],
    ...overrides,
  }
}

test('roundtrip：serialize → parse 还原全部字段（lineage + operations + metadata）', () => {
  const md = serializeResumeDocument(doc())
  const { value, validation } = parseResumeMarkdown(md, 'resume_20260805_00001.md')
  assert.equal(validation, undefined)
  assert.equal(value.id, 'resume_20260805_00001')
  assert.equal(value.status, 'draft')
  assert.equal(value.lineage?.derivationType, 'jd_generate')
  assert.equal(value.lineage?.createdBy, 'ai')
  assert.equal(value.operations?.[0].id, 'operation_001')
  assert.equal(value.sections[0].bullets[0].metadata?.expectationId, 'engineering_scope')
  assert.deepEqual(value.sections[1].assetRefs, ['SolidWorks', 'ANSYS'])
})

test('parseResumeMarkdown：person 字段归一（旧流程 `甲（person_003）` → personId；新流程 `person_003` 原样）', () => {
  const legacy = parseResumeMarkdown(
    `# 简历\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| status | draft |\n| person | 甲（person_003） |\n| template_id | mechanical |\n| template_version | 1.2 |\n| generated_at | 2026-08-05T10:00:00Z |\n`,
    'resume_legacy.md',
  )
  assert.equal(legacy.value.person, 'person_003')
  const modern = parseResumeMarkdown(
    `# 简历\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| status | draft |\n| person | person_003 |\n| template_id | mechanical |\n| template_version | 1.2 |\n| generated_at | 2026-08-05T10:00:00Z |\n`,
    'resume_modern.md',
  )
  assert.equal(modern.value.person, 'person_003')
})

test('transition：合法转移 + operations 审计（draft → review）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-rv-'))
  const ws = initWorkspace(root)
  ws.write('resumes/documents/resume_20260805_00001.md', serializeResumeDocument(doc()))
  const next = transitionResumeStatusFile(ws, 'resume_20260805_00001.md', 'review', 'user', new Date('2026-08-05T11:00:00Z'))
  assert.equal(next.status, 'review')
  assert.equal(next.operations?.length, 2)
  assert.equal(next.operations?.[1].action, 'submit_review')
  assert.equal(next.operations?.[1].actor, 'user')
  // 写回后可读回
  assert.equal(parseResumeMarkdown(ws.read('resumes/documents/resume_20260805_00001.md'), 'x.md').value.status, 'review')
  rmSync(root, { recursive: true, force: true })
})

test('transition：非法转移拒绝（draft→exported / review→draft / archived→任意）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-rv2-'))
  const ws = initWorkspace(root)
  ws.write('resumes/documents/r.md', serializeResumeDocument(doc()))
  assert.throws(() => transitionResumeStatusFile(ws, 'r.md', 'exported', 'user'), ResumeTransitionError) // exported 仅 export 链
  assert.throws(() => transitionResumeStatusFile(ws, 'r.md', 'archived', 'user') && transitionResumeStatusFile(ws, 'r.md', 'draft', 'user'), ResumeTransitionError)
  rmSync(root, { recursive: true, force: true })
})

test('markResumeExported：系统流转（draft/review → exported + operation export）；非 draft/review 拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-rv3-'))
  const ws = initWorkspace(root)
  ws.write('resumes/documents/r.md', serializeResumeDocument(doc()))
  const exported = markResumeExported(ws, 'r.md', new Date('2026-08-05T12:00:00Z'))
  assert.equal(exported.status, 'exported')
  assert.equal(exported.operations?.[1].action, 'export')
  assert.equal(exported.operations?.[1].actor, 'system')
  // exported → 再导出拒绝
  assert.throws(() => markResumeExported(ws, 'r.md'), ResumeTransitionError)
  rmSync(root, { recursive: true, force: true })
})

test('clone：lineage.parent + createdBy=user + status=draft；不复制源 operations', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-rv4-'))
  const ws = initWorkspace(root)
  const source = doc()
  const clone = cloneResumeFile(ws, source, new Date('2026-08-05T10:00:00Z'))
  assert.equal(clone.status, 'draft')
  assert.equal(clone.lineage?.parentResumeId, 'resume_20260805_00001')
  assert.equal(clone.lineage?.derivationType, 'clone')
  assert.equal(clone.lineage?.createdBy, 'user')
  assert.equal(clone.operations?.length, 1) // 只有 clone 操作，不复制源 operations
  assert.equal(clone.operations?.[0].action, 'clone')
  assert.deepEqual(clone.sections, source.sections) // 内容引用复制
  assert.equal(clone.templateVersion, '1.2')
  rmSync(root, { recursive: true, force: true })
})

test('diff：identity 对比——claimId 不同视为 removed+added，不丢 provenance', () => {
  const a = doc()
  const b = doc({
    sections: [
      {
        type: 'experience',
        title: '工作经历',
        bullets: [
          { sentence: '负责自动化设备机械结构设计，完成机架及传动机构优化', claimId: 'claim_20260804_00001', metadata: { expectationId: 'engineering_scope' } }, // 与 a identity 相同 → unchanged
          { sentence: '全新句子', claimId: 'claim_20260804_00099' }, // added
        ],
      },
    ],
  })
  const diff = diffResumes(a, b)
  assert.equal(diff.added.length, 1)
  assert.equal(diff.added[0].claimId, 'claim_20260804_00099')
  assert.equal(diff.removed.length, 1) // a 的 00002 被移除
  assert.equal(diff.removed[0].claimId, 'claim_20260804_00002')
  assert.equal(diff.unchanged.length, 1)
  assert.equal(diff.unchanged[0].expectationId, 'engineering_scope') // provenance 保留
})

test('assembleDraftFile 端到端：drafts/ → documents/ 登记 → 源清理；invalid 不落盘', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-rv5-'))
  const ws = initWorkspace(root)
  // 准备 claim（trusted）与 evidence
  ws.write('evidence/2026-08-05-自动化设备改造.md', `# 自动化设备改造项目

## 分析摘要

| 字段 | 值 |
|------|-----|
| role | 机械结构负责人 |
| contribution | 负责自动化设备机械结构设计 |
| source_type | user_input |
| captured_at | 2026-08-05 |
| status | trusted |
| verification_type | user_confirmed |
| confirmed_at | 2026-08-05 |

## 证据

### scope
- 负责机架和传动模块设计

`)
  ws.write('claims/2026-08-05-设计能力声明.md', `# 设计能力声明

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | 负责自动化设备机械结构设计，完成机架及传动机构优化 |
| claim_type | fact |
| source | agent_generated |
| captured_at | 2026-08-05 |

## 证据来源

- evidence_20260804_00001
`)
  registerArtifacts(ws, { type: 'evidence', dir: 'evidence', idPrefix: 'evidence_', marker: /##\s*分析摘要/, passthroughFields: [] }, new Date('2026-08-05T10:00:00Z'))
  registerArtifacts(ws, { type: 'claim', dir: 'claims', idPrefix: 'claim_', marker: /##\s*分析摘要/, passthroughFields: [] }, new Date('2026-08-05T10:00:00Z'))

  const draft = `# 结构设计工程师简历

## 分析摘要

| 字段 | 值 |
|------|-----|
| type | resume_draft |
| template_id | mechanical |

## Claims

- claim_20260805_00001（section: experience）

## Skills

- SolidWorks（asset）
`
  ws.write('resumes/drafts/resume-draft-结构设计.md', draft)
  const assembled = assembleDraftFile(ws, 'resume-draft-结构设计.md', new Date('2026-08-05T10:00:00Z'))
  assert.ok(assembled)
  assert.equal(assembled.status, 'draft')
  assert.equal(assembled.sections[0].bullets[0].sentence, '负责自动化设备机械结构设计，完成机架及传动机构优化')
  // 源清理 + 登记
  assert.equal(ws.exists('resumes/drafts/resume-draft-结构设计.md'), false)
  assert.deepEqual(ws.listMarkdown('resumes/documents'), ['resume_20260805_00001.md'])
  assert.equal(scanResumes(ws)[0].record.lineage?.derivationType, 'jd_generate')

  // invalid 不落盘：claim 不存在
  ws.write('resumes/drafts/resume-draft-坏.md', draft.replace('claim_20260805_00001', 'claim_20999999_99999'))
  assert.equal(assembleDraftFile(ws, 'resume-draft-坏.md'), null)
  assert.equal(ws.exists('resumes/drafts/resume-draft-坏.md'), true) // 保留供 AI 修正
  assert.equal(ws.listMarkdown('resumes/documents').length, 1)
  rmSync(root, { recursive: true, force: true })
})
