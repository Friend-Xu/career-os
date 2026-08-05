/**
 * resume-export（M3-2.3c）：ResumeDocument → Markdown → HTML → PDF 全链 + ExportRecord。
 * - 复用现有 exportPdf（HTML → PDF，Edge headless 固定参数：--headless=new --disable-gpu
 *   --no-first-run --no-pdf-header-footer --print-to-pdf；Browser Rendering Profile 化留 M3-3/Export v1.1）
 * - 失败安全：render/打印失败 → 抛错，不产生 exported 状态（ExportRecord 只在成功时生成）
 * - ExportRecord 携带复现三元组（document + template + rendererVersion）+ checksum（RESUME-EXPORT-M3 §2）
 */
import { createHash, randomUUID } from 'node:crypto'
import type { ResumeDocument, ResumeExportRecord } from '../ir/resume.ts'
import { renderResumeMarkdown } from '../renderers/resume-markdown.ts'
import { markdownToHtml } from '../renderers/markdown-to-html.ts'
import { exportPdf, type PdfResult } from './pdf.ts'

/** 渲染器版本（基础设施版本，不进 ResumeDocument；PDF 复现三元组之一） */
export const RENDERER_VERSION = '0.1.0'

export interface ResumeRenderOutput {
  markdown: string
  html: string
}

/** Document → Markdown → HTML（纯函数链；HTML 携带 claimId 注释溯源） */
export function renderResumeDocument(document: ResumeDocument): ResumeRenderOutput {
  const markdown = renderResumeMarkdown(document)
  return { markdown, html: markdownToHtml(markdown) }
}

export interface ResumePdfExport {
  result: PdfResult
  record: ResumeExportRecord
}

/** Document → PDF 全链：复用 exportPdf；成功才生成 ExportRecord（失败抛错，不产生 exported 状态） */
export async function exportResumePdf(
  document: ResumeDocument,
  pdfFn: (html: string) => Promise<PdfResult> = exportPdf,
  now: Date = new Date(),
): Promise<ResumePdfExport> {
  const { html } = renderResumeDocument(document) // Skills 无 assetRef 在此抛错（失败安全）
  const result = await pdfFn(html) // 打印失败同样抛错，不产生 record
  const record: ResumeExportRecord = {
    id: `export_${randomUUID().slice(0, 8)}`,
    documentId: document.id,
    templateId: document.templateId,
    templateVersion: document.templateVersion,
    rendererVersion: RENDERER_VERSION,
    format: 'pdf',
    exportedAt: now.toISOString(),
    checksum: createHash('sha256').update(result.pdf).digest('hex').slice(0, 16),
  }
  return { result, record }
}

/** ExportRecord → 存储 md（exports/ 目录；复现三元组 + checksum——"这个 PDF 怎么生成的"可回答） */
export function serializeExportRecord(record: ResumeExportRecord): string {
  return `# ${record.id}

## 分析摘要

| 字段 | 值 |
|------|-----|
| document_id | ${record.documentId} |
| template_id | ${record.templateId} |
| template_version | ${record.templateVersion} |
| renderer_version | ${record.rendererVersion} |
| format | ${record.format} |
| exported_at | ${record.exportedAt} |
| checksum | ${record.checksum ?? '-'} |
`
}
