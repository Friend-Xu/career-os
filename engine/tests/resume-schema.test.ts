/**
 * resume IR 单测（M3-2.1）：ResumeDocument 形状约束——claimId 必填（TS 编译期 + 运行时断言）、
 * status 枚举、Skills 章节 assetRefs 模式。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ResumeDocument } from '../ir/resume.ts'

/** 合法 ResumeDocument 构造（Claim 主链：sentence + claimId 必填 + expectation 元数据） */
function doc(overrides: Partial<ResumeDocument> = {}): ResumeDocument {
  return {
    id: 'resume_20260805_00001',
    status: 'draft',
    person: '我',
    targetJobId: 'job_20260805_00001',
    templateId: 'mechanical',
    templateVersion: '1.0',
    sections: [
      {
        type: 'experience',
        title: '工作经历',
        bullets: [
          {
            sentence: '负责自动化设备机械结构设计，完成机架及传动机构优化',
            claimId: 'claim_20260804_00001',
            metadata: {
              expectationId: 'engineering_scope',
              languageFamily: 'mechanical.design',
              generatedAt: '2026-08-05T10:00:00Z',
            },
          },
        ],
      },
      {
        type: 'skills',
        title: '技能',
        bullets: [],
        assetRefs: ['SolidWorks', 'ANSYS'], // Skills 来源 = 资产引用，Assembly 不编造
      },
    ],
    generatedAt: '2026-08-05T10:00:00Z',
    ...overrides,
  }
}

test('ResumeDocument：合法主链文档（claimId 必填 + expectation 元数据 + assetRefs）', () => {
  const d = doc()
  assert.equal(d.status, 'draft')
  assert.equal(d.templateVersion, '1.0')
  const exp = d.sections[0]
  assert.equal(exp.type, 'experience')
  assert.equal(exp.bullets[0].claimId, 'claim_20260804_00001')
  assert.equal(exp.bullets[0].metadata?.expectationId, 'engineering_scope')
  assert.equal(exp.bullets[0].metadata?.languageFamily, 'mechanical.design')
  const skills = d.sections[1]
  assert.deepEqual(skills.assetRefs, ['SolidWorks', 'ANSYS'])
  assert.equal(skills.bullets.length, 0)
})

test('ResumeDocument：status 四枚举合法', () => {
  for (const s of ['draft', 'review', 'exported', 'archived'] as const) {
    const d = doc({ status: s })
    assert.equal(d.status, s)
  }
})

test('ResumeDocument：targetJobId / metadata 可选字段缺省合法', () => {
  const d = doc({
    targetJobId: undefined,
    sections: [{
      type: 'summary',
      title: '个人简介',
      bullets: [{ sentence: '机械结构设计工程师', claimId: 'claim_20260804_00001' }],
    }],
  })
  assert.equal(d.targetJobId, undefined)
  assert.equal(d.sections[0].bullets[0].metadata, undefined)
})
