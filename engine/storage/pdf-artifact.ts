/**
 * pdf-artifact：简历 Artifact 落盘（Document Ingestion 的资产层）。
 * persons/{id}/documents/resumes/
 *   ├── resume-00X.pdf          PDF 原文（图片型/全部上传的 PDF 存档，可追溯）
 *   ├── resume-00X.meta.md      元数据（source/filename/created_at/extraction 方法+模型）
 *   └── extraction/resume-00X.md 提取文本（Agent 消费；跟随 artifact 编号，重新上传递增不覆盖）
 * PDF 是 Artifact 不是临时输入——Artifact → Extraction → Candidate → Resolution → Fact 链的一环。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Workspace } from './workspace.ts'
import { readManifestInitState, setManifestInitState } from './person-watcher.ts'

export interface ResumeArtifactParams {
  personId: string
  fileName?: string
  text?: string
  pdfBase64?: string
  extraction?: { method: 'text' | 'vision'; model?: string }
}

export interface ResumeArtifactResult {
  artifactId: string // resume-001
  format: 'text' | 'pdf'
}

/** 编号递增：documents/resumes/ 下 resume-(\d+).meta.md 最大编号 + 1（无目录 → 1） */
function nextArtifactSeq(ws: Workspace, personId: string): number {
  const dir = join(ws.paths.persons, personId, 'documents', 'resumes')
  try {
    return (
      readdirSync(dir).reduce((m, f) => {
        const mm = f.match(/^resume-(\d+)\.meta\.md$/)
        return mm ? Math.max(m, Number(mm[1])) : m
      }, 0) + 1
    )
  } catch {
    return 1
  }
}

export function createResumeArtifact(ws: Workspace, params: ResumeArtifactParams): ResumeArtifactResult {
  const { personId } = params
  if (!/^person_\d{3}$/.test(personId)) throw new Error(`非法 personId: ${personId}`)
  if (!params.pdfBase64 && !params.text?.trim()) throw new Error('text 或 pdfBase64 至少提供一个')
  const seq = nextArtifactSeq(ws, personId)
  const artifactId = `resume-${String(seq).padStart(3, '0')}`
  const base = `persons/${personId}/documents/resumes/${artifactId}`
  const method = params.extraction?.method ?? 'text'
  const model = method === 'vision' ? (params.extraction?.model ?? '') : 'local'

  if (params.pdfBase64) {
    const buf = Buffer.from(params.pdfBase64, 'base64')
    if (buf.length === 0) throw new Error('pdfBase64 为空')
    ws.write(`${base}.pdf`, buf)
  }
  const meta = [
    '---',
    `artifactId: ${artifactId}`,
    'source: uploaded_pdf',
    `filename: ${params.fileName ?? '(粘贴)'}`,
    `created_at: ${new Date().toISOString()}`,
    'extraction:',
    `  method: ${method}`,
    ...(model ? [`  model: ${model}`] : []),
    '---',
    '',
  ].join('\n')
  ws.write(`${base}.meta.md`, meta)
  if (params.text?.trim()) {
    ws.write(`persons/${personId}/documents/resumes/extraction/${artifactId}.md`, params.text.trim() + '\n')
  }
  // 状态机（PR-2）：提取文本落盘 → extracting（仅未完成档案；completed 不降级）
  const cur = readManifestInitState(ws, personId)
  if (cur === 'uploading' || cur === 'in_progress') {
    setManifestInitState(ws, personId, 'extracting')
  }
  return { artifactId, format: params.pdfBase64 ? 'pdf' : 'text' }
}
