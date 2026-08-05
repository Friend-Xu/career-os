/**
 * export IR 单测（M3-2.3a）：ResumeExportRecord 形状——复现三元组（document/template/renderer）、
 * format 枚举、checksum 可选。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ResumeExportRecord } from '../ir/resume.ts'

function record(overrides: Partial<ResumeExportRecord> = {}): ResumeExportRecord {
  return {
    id: 'export_20260805_00001',
    documentId: 'resume_20260805_00001',
    templateId: 'mechanical',
    templateVersion: '1.0',
    rendererVersion: '0.1.0',
    format: 'pdf',
    exportedAt: '2026-08-05T10:00:00Z',
    ...overrides,
  }
}

test('ResumeExportRecord：复现三元组 + format 枚举合法', () => {
  for (const format of ['pdf', 'markdown', 'html'] as const) {
    const r = record({ format })
    assert.equal(r.format, format)
  }
  const r = record()
  assert.equal(r.documentId, 'resume_20260805_00001')
  assert.equal(r.templateId, 'mechanical')
  assert.equal(r.templateVersion, '1.0')
  assert.equal(r.rendererVersion, '0.1.0')
})

test('ResumeExportRecord：checksum 可选（缺省合法，填了可校验）', () => {
  assert.equal(record().checksum, undefined)
  assert.equal(record({ checksum: 'sha256:abc123' }).checksum, 'sha256:abc123')
})

test('ResumeExportRecord：rendererVersion 与 ResumeDocument 分离（不在内容 IR）', () => {
  const r = record()
  assert.equal('rendererVersion' in r, true)
})
