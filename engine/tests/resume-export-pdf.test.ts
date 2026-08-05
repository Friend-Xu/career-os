/**
 * resume-export 单测（M3-2.3c）：验收 4 项——
 * 1. Export 不改变内容（html 文本 == document bullets） 2. ExportRecord 完整性（复现三元组）
 * 3. claim provenance 保留（<!-- claimId -->） 4. 失败安全（render/打印失败不产生 exported 状态）
 * pdfFn 注入（不依赖真实 Edge 环境）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ResumeDocument } from '../ir/resume.ts'
import { renderResumeDocument, exportResumePdf, RENDERER_VERSION } from '../export/resume-export.ts'
import type { PdfResult } from '../export/pdf.ts'

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
          { sentence: '负责自动化设备机械结构设计，完成机架及传动机构优化', claimId: 'claim_20260804_00001' },
          { sentence: '通过装配检查和现场调试解决安装干涉问题', claimId: 'claim_20260804_00002' },
        ],
      },
      { type: 'skills', title: '技能', bullets: [], assetRefs: ['SolidWorks', 'ANSYS'] },
    ],
    generatedAt: '2026-08-05T10:00:00Z',
    ...overrides,
  }
}

const fakePdf: (html: string) => Promise<PdfResult> = async () => ({ pdf: 'fake-base64', fileName: 'resume.pdf' })

test('Test 1：Export 不改变内容（html 文本 == 输入 sentences）', () => {
  const d = doc()
  const { html } = renderResumeDocument(d)
  for (const s of d.sections[0].bullets) assert.ok(html.includes(s.sentence))
  assert.ok(html.includes('SolidWorks'))
})

test('Test 2：ExportRecord 完整性（复现三元组 + format + checksum）', async () => {
  const d = doc()
  const { record } = await exportResumePdf(d, fakePdf, new Date('2026-08-05T10:00:00Z'))
  assert.equal(record.documentId, d.id)
  assert.equal(record.templateId, 'mechanical')
  assert.equal(record.templateVersion, '1.0')
  assert.equal(record.rendererVersion, RENDERER_VERSION)
  assert.equal(record.format, 'pdf')
  assert.equal(record.exportedAt, '2026-08-05T10:00:00.000Z')
  assert.ok(record.checksum && record.checksum.length > 0)
})

test('Test 3：claim provenance 保留（html 含 claimId 注释）', () => {
  const { html } = renderResumeDocument(doc())
  assert.ok(html.includes('<!-- claimId:claim_20260804_00001 -->'))
  assert.ok(html.includes('<!-- claimId:claim_20260804_00002 -->'))
})

test('Test 4a：失败安全——无效 document（Skills 无 assetRef）→ 抛错，不产生 record', async () => {
  const bad = doc({
    sections: [
      { type: 'experience', title: '工作经历', bullets: [{ sentence: '负责结构设计', claimId: 'claim_x' }] },
      { type: 'skills', title: '技能', bullets: [] }, // 无 assetRefs
    ],
  })
  await assert.rejects(() => exportResumePdf(bad, fakePdf))
})

test('Test 4b：失败安全——打印失败 → 抛错，不产生 record', async () => {
  const failPdf: (html: string) => Promise<PdfResult> = async () => {
    throw new Error('Edge 打印失败')
  }
  await assert.rejects(() => exportResumePdf(doc(), failPdf))
})

test('渲染链纯函数稳定（same input → same output）', () => {
  const d = doc()
  assert.equal(renderResumeDocument(d).html, renderResumeDocument(d).html)
})
