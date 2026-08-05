/**
 * resume-markdown renderer 单测（M3-2.2）：边界测试优先于格式——
 * 1. sentence 保留（不丢失） 2. 不产生新文本 3. claimId 溯源保留 4. Skills 无 assetRef 拒绝生成
 * 5. 纯函数稳定性（same input → same output） 6. 章节顺序保留
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ResumeDocument } from '../ir/resume.ts'
import { renderResumeMarkdown, ResumeRenderError } from '../renderers/resume-markdown.ts'

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
        type: 'summary',
        title: '个人简介',
        bullets: [{ sentence: '机械结构设计工程师', claimId: 'claim_20260804_00001' }],
      },
      {
        type: 'experience',
        title: '工作经历',
        bullets: [
          {
            sentence: '负责自动化设备机械结构设计，完成机架及传动机构优化',
            claimId: 'claim_20260804_00001',
            metadata: { expectationId: 'engineering_scope', languageFamily: 'mechanical.design' },
          },
          { sentence: '通过装配检查和现场调试解决安装干涉问题', claimId: 'claim_20260804_00002' },
        ],
      },
      {
        type: 'skills',
        title: '技能',
        bullets: [],
        assetRefs: ['SolidWorks', 'ANSYS'],
      },
    ],
    generatedAt: '2026-08-05T10:00:00Z',
    ...overrides,
  }
}

test('Test 1：sentence 完整保留（输入句子出现在输出中）', () => {
  const out = renderResumeMarkdown(doc())
  assert.ok(out.includes('负责自动化设备机械结构设计，完成机架及传动机构优化'))
  assert.ok(out.includes('通过装配检查和现场调试解决安装干涉问题'))
})

test('Test 2：不产生新文本（输出 bullet 文本集合 == 输入 sentence 集合，去除 claimId 注释后）', () => {
  const d = doc()
  const out = renderResumeMarkdown(d)
  const bulletLines = out.split('\n').filter((l) => l.startsWith('- '))
  const texts = bulletLines.map((l) => l.replace(/ <!-- claimId:[^>]+ -->$/, '').slice(2))
  const expected = [...d.sections.flatMap((s) => s.bullets.map((b) => b.sentence)), ...d.sections.flatMap((s) => s.assetRefs ?? [])]
  assert.deepEqual(texts, expected)
})

test('Test 3：claimId 溯源保留（HTML 注释，显示/ATS 忽略，内部可追溯）', () => {
  const out = renderResumeMarkdown(doc())
  assert.ok(out.includes('<!-- claimId:claim_20260804_00001 -->'))
  assert.ok(out.includes('<!-- claimId:claim_20260804_00002 -->'))
})

test('Test 4：Skills 无 assetRef 拒绝生成（抛 ResumeRenderError）', () => {
  const d = doc({
    sections: [
      { type: 'experience', title: '工作经历', bullets: [{ sentence: '负责结构设计', claimId: 'claim_x' }] },
      { type: 'skills', title: '技能', bullets: [] }, // 无 assetRefs——Assembly 不编造技能
    ],
  })
  assert.throws(() => renderResumeMarkdown(d), ResumeRenderError)
})

test('Test 5：纯函数稳定性（same input → same output）', () => {
  const d = doc()
  assert.equal(renderResumeMarkdown(d), renderResumeMarkdown(d))
})

test('Test 6：章节顺序保留（sections 数组顺序 = 输出顺序）；非 skills 空章节照常渲染', () => {
  const d = doc({
    sections: [
      { type: 'summary', title: '个人简介', bullets: [] }, // 空章节不发明内容
      { type: 'experience', title: '工作经历', bullets: [{ sentence: '负责结构设计', claimId: 'claim_x' }] },
    ],
  })
  const out = renderResumeMarkdown(d)
  const titles = [...out.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  assert.deepEqual(titles, ['个人简介', '工作经历'])
  assert.ok(out.includes('## 个人简介'))
})
