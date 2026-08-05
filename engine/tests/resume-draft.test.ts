/**
 * resume-draft 单测（M3.5.2 纯函数闭环）：Draft Parser / ClaimResolver / Validation 三态 / Assembly。
 * 重点边界：Mode A 默认 / Mode B 仅 user override / CLAIM_NOT_FOUND invalid / CLAIM_NOT_USABLE warning /
 * CLAIM_NOT_IN_SELECTOR warning / SKILL_NO_ASSET invalid / lineage + operations 写入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CareerClaim, EvidenceItem } from '../ir/schema.ts'
import { parseDraftManifest, assembleResumeFromDraft } from '../storage/resume-draft.ts'

const SAMPLE_DRAFT = `# 结构设计工程师简历

## 分析摘要

| 字段 | 值 |
|------|-----|
| type | resume_draft |
| target_job_id | job_20260805_00001 |
| template_id | mechanical |
| template_version | 1.2 |

## Claims

- claim_20260805_00001（section: experience；expectation: engineering_scope）
- claim_20260805_00002（section: experience；expectation: engineering_validation；sentence_override: "通过装配检查和现场调试解决安装干涉问题"；override_source: user）

## Skills

- SolidWorks（asset）
- ANSYS（asset）
`

function ev(id: string, status: EvidenceItem['status'] = 'trusted'): EvidenceItem {
  return {
    id,
    event: { title: id },
    role: '机械结构负责人',
    contribution: '负责自动化设备机械结构设计',
    evidence: { scope: [{ content: '机架和传动模块设计' }] },
    source: { type: 'user_input', capturedAt: '2026-08-05' },
    status,
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

const CLAIMS = [
  claim('claim_20260805_00001', '负责自动化设备机械结构设计，完成机架及传动机构优化', ['evidence_20260805_00001']),
  claim('claim_20260805_00002', '完成装配检查与生产调试', ['evidence_20260805_00001']),
]
const EVIDENCE = [ev('evidence_20260805_00001')]

test('parseDraftManifest：md → manifest（claims/section/expectation/override/skills/parent）', () => {
  const md = SAMPLE_DRAFT.replace('| template_version | 1.2 |', '| template_version | 1.2 |\n| parent_resume_id | resume_20260805_00001 |')
  const { value, validation } = parseDraftManifest(md, 'resume-draft-结构设计.md')
  assert.equal(validation, undefined)
  assert.equal(value.type, 'resume_draft')
  assert.equal(value.targetJobId, 'job_20260805_00001')
  assert.equal(value.templateId, 'mechanical')
  assert.equal(value.templateVersion, '1.2')
  assert.equal(value.parentResumeId, 'resume_20260805_00001')
  assert.equal(value.claims.length, 2)
  assert.equal(value.claims[0].section, 'experience')
  assert.equal(value.claims[0].expectationId, 'engineering_scope')
  assert.equal(value.claims[1].sentenceOverride, '通过装配检查和现场调试解决安装干涉问题')
  assert.equal(value.claims[1].overrideSource, 'user')
  assert.deepEqual(value.skills, ['SolidWorks', 'ANSYS'])
})

test('Mode A：无 override → sentence = claim.statement（默认表达）', () => {
  const { document, validation } = assembleResumeFromDraft({
    manifest: parseDraftManifest(SAMPLE_DRAFT, 'x.md').value,
    claims: CLAIMS,
    evidence: EVIDENCE,
    selectorCandidates: ['claim_20260805_00001', 'claim_20260805_00002'],
    now: new Date('2026-08-05T10:00:00Z'),
  })
  assert.equal(validation.status, 'valid')
  const exp = document.sections.find((s) => s.type === 'experience')!
  assert.equal(exp.bullets[0].sentence, '负责自动化设备机械结构设计，完成机架及传动机构优化')
  assert.equal(exp.bullets[0].metadata?.expectationId, 'engineering_scope')
})

test('Mode B：user override 进入；AI override 忽略 + OVERRIDE_NOT_USER warning', () => {
  const md = SAMPLE_DRAFT.replace(
    '；override_source: user',
    '；override_source: ai',
  )
  const { document, validation } = assembleResumeFromDraft({
    manifest: parseDraftManifest(md, 'x.md').value,
    claims: CLAIMS,
    evidence: EVIDENCE,
    selectorCandidates: ['claim_20260805_00001', 'claim_20260805_00002'],
  })
  const exp = document.sections.find((s) => s.type === 'experience')!
  assert.equal(exp.bullets[1].sentence, '完成装配检查与生产调试') // ai override 忽略 → claim.statement
  assert.equal(validation.status, 'warning')
  assert.ok(validation.issues.some((i) => i.code === 'OVERRIDE_NOT_USER'))
})

test('CLAIM_NOT_FOUND：claimId 不存在 → invalid', () => {
  const md = SAMPLE_DRAFT.replace('claim_20260805_00002', 'claim_20999999_99999')
  const { document, validation } = assembleResumeFromDraft({
    manifest: parseDraftManifest(md, 'x.md').value,
    claims: CLAIMS,
    evidence: EVIDENCE,
    selectorCandidates: ['claim_20260805_00001'],
  })
  assert.equal(validation.status, 'invalid')
  assert.ok(validation.issues.some((i) => i.code === 'CLAIM_NOT_FOUND'))
  assert.equal(document.status, 'draft') // invalid 不阻塞 draft（阻塞的是 draft → review）
})

test('CLAIM_NOT_USABLE：证据非 trusted → warning（claim 存在但不可消费）', () => {
  const { validation } = assembleResumeFromDraft({
    manifest: parseDraftManifest(SAMPLE_DRAFT, 'x.md').value,
    claims: CLAIMS,
    evidence: [ev('evidence_20260805_00001', 'candidate')],
    selectorCandidates: ['claim_20260805_00001', 'claim_20260805_00002'],
  })
  assert.equal(validation.status, 'warning')
  assert.ok(validation.issues.some((i) => i.code === 'CLAIM_NOT_USABLE'))
})

test('CLAIM_NOT_IN_SELECTOR：claim 不在岗位候选集 → warning；无 targetJobId 跳过候选校验', () => {
  const { validation } = assembleResumeFromDraft({
    manifest: parseDraftManifest(SAMPLE_DRAFT, 'x.md').value,
    claims: CLAIMS,
    evidence: EVIDENCE,
    selectorCandidates: ['claim_20260805_00001'], // 00002 不在候选
  })
  assert.equal(validation.status, 'warning')
  assert.ok(validation.issues.some((i) => i.code === 'CLAIM_NOT_IN_SELECTOR'))

  const md = SAMPLE_DRAFT.replace('| target_job_id | job_20260805_00001 |', '| target_job_id | - |')
  const noTarget = assembleResumeFromDraft({
    manifest: parseDraftManifest(md, 'x.md').value,
    claims: CLAIMS,
    evidence: EVIDENCE,
    selectorCandidates: [], // 无目标 → 空候选 → 跳过
  })
  assert.equal(noTarget.validation.issues.some((i) => i.code === 'CLAIM_NOT_IN_SELECTOR'), false)
})

test('SKILL_NO_ASSET：skills 章节有 claim bullet 但无 assetRefs → invalid', () => {
  const mdSkillNoAsset = `# 简历

## 分析摘要

| 字段 | 值 |
|------|-----|
| type | resume_draft |
| template_id | mechanical |

## Claims

- claim_20260805_00001（section: skills）
`
  const { validation } = assembleResumeFromDraft({
    manifest: parseDraftManifest(mdSkillNoAsset, 'x.md').value,
    claims: CLAIMS,
    evidence: EVIDENCE,
    selectorCandidates: ['claim_20260805_00001'],
  })
  assert.equal(validation.status, 'invalid')
  assert.ok(validation.issues.some((i) => i.code === 'SKILL_NO_ASSET'))
})

test('Assembly：lineage + operations 写入（clone 派生 / jd_generate）', () => {
  const mdWithParent = SAMPLE_DRAFT.replace('| template_version | 1.2 |', '| template_version | 1.2 |\n| parent_resume_id | resume_20260805_00001 |')
  const clone = assembleResumeFromDraft({
    manifest: parseDraftManifest(mdWithParent, 'x.md').value,
    claims: CLAIMS,
    evidence: EVIDENCE,
    selectorCandidates: ['claim_20260805_00001', 'claim_20260805_00002'],
    now: new Date('2026-08-05T10:00:00Z'),
  })
  assert.equal(clone.document.lineage?.parentResumeId, 'resume_20260805_00001')
  assert.equal(clone.document.lineage?.derivationType, 'clone')
  assert.equal(clone.document.lineage?.createdBy, 'ai')
  assert.equal(clone.document.operations?.[0].action, 'create')
  assert.equal(clone.document.operations?.[0].actor, 'ai')

  const fresh = assembleResumeFromDraft({
    manifest: parseDraftManifest(SAMPLE_DRAFT, 'x.md').value,
    claims: CLAIMS,
    evidence: EVIDENCE,
    selectorCandidates: ['claim_20260805_00001', 'claim_20260805_00002'],
  })
  assert.equal(fresh.document.lineage?.derivationType, 'jd_generate')
  assert.equal(fresh.document.lineage?.parentResumeId, undefined)
  assert.equal(fresh.document.status, 'draft')
})

test('Assembly：skills assetRefs 落位 + templateVersion 缺省 1.0', () => {
  const { document } = assembleResumeFromDraft({
    manifest: parseDraftManifest(SAMPLE_DRAFT, 'x.md').value,
    claims: CLAIMS,
    evidence: EVIDENCE,
    selectorCandidates: ['claim_20260805_00001', 'claim_20260805_00002'],
  })
  const skills = document.sections.find((s) => s.type === 'skills')!
  assert.deepEqual(skills.assetRefs, ['SolidWorks', 'ANSYS'])
  assert.equal(document.templateVersion, '1.2')
})
