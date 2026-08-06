import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { extractPdfText } from '../storage/pdf-extract.ts'
import { extractLocalText, extractVisionPages } from '../runtime/document/pdf-import.ts'

/** 构造最小 PDF（单个 Flate 压缩文本流）——fixture 不依赖外部文件 */
function tinyPdf(text: string): Buffer {
  const stream = ['BT', '/F1 12 Tf', `(${text}) Tj`, 'ET'].join('\n')
  const content = deflateSync(Buffer.from(stream, 'latin1'))
  return Buffer.concat([
    Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n4 0 obj<</Length ' +
        content.length +
        '>>stream\n',
      'latin1',
    ),
    content,
    Buffer.from('\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1'),
  ])
}

/** 1x1 透明 PNG（页面图 fixture——视觉 mock 不真正读图） */
function tinyPng(): string {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ).toString('base64')
}

test('extractPdfText：Flate 文本流 Tj 提取；无可提取文本流 → 空串', () => {
  assert.equal(extractPdfText(tinyPdf('Hello Resume Engineering')), 'Hello Resume Engineering')
  assert.equal(extractPdfText(Buffer.from('%PDF-1.4\n1 0 obj\n%%EOF')), '')
})

test('extractLocalText：文本型 PDF → completed；无文本层 → failed；部分文本 → needs_review', () => {
  const longText =
    'Mechanical Engineer Resume. 5 years non-standard automation equipment design. Skilled in SolidWorks and Creo. Led design of 3 automated production lines. GD&T tolerance analysis. Project management experience. Education, certificates, languages.'
  const r1 = extractLocalText(tinyPdf(longText))
  assert.equal(r1.status, 'completed')
  assert.equal(r1.method, 'text')
  assert.ok(r1.text.includes('Mechanical Engineer'))

  const r2 = extractLocalText(Buffer.from('%PDF-1.4\n%%EOF'))
  assert.equal(r2.status, 'failed')
  assert.equal(r2.text, '')

  const r3 = extractLocalText(tinyPdf('Partial text.'))
  assert.equal(r3.status, 'needs_review')
  assert.equal(r3.text, 'Partial text.')
})

test('extractVisionPages：多页逐页视觉拼接（页码传入）+ 全部失败 → failed', async () => {
  const seenPrompts: string[] = []
  const r = await extractVisionPages([tinyPng(), tinyPng()], {
    analyzeImage: async (_path: string, prompt: string) => {
      seenPrompts.push(prompt)
      return `Page content ${seenPrompts.length}: mechanical engineer, SolidWorks, Creo, GD&T, automated production lines, project management.`
    },
  })
  assert.equal(r.status, 'completed')
  assert.equal(r.method, 'vision')
  assert.ok(r.text.includes('Page content 1'))
  assert.ok(r.text.includes('Page content 2'))
  assert.ok(seenPrompts[0]?.includes('第 1 页'))
  assert.ok(seenPrompts[1]?.includes('第 2 页'))

  const r2 = await extractVisionPages([tinyPng(), tinyPng()], {
    analyzeImage: async () => {
      throw new Error('HTTP 429')
    },
  })
  assert.equal(r2.status, 'failed')
  assert.ok(r2.error?.includes('HTTP 429') || r2.error?.includes('全部视觉提取失败'))
})

test('extractVisionPages：部分页成功 → needs_review（保留成功页文本）', async () => {
  let call = 0
  const r = await extractVisionPages([tinyPng(), tinyPng()], {
    analyzeImage: async (_path: string, _prompt: string) => {
      call++
      if (call === 1) return 'First page extracted content.'
      throw new Error('HTTP 500')
    },
  })
  assert.equal(r.status, 'needs_review')
  assert.ok(r.text.includes('First page'))
  assert.ok(r.error?.includes('1/2 页'))
})
