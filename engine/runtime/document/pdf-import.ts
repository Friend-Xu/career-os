/**
 * pdf-import：Document Ingestion 编排（Document Detector）。
 * 两级提取通道：
 * - extractLocalText：文本层（免费离线，全页）——主流（Word 导出 PDF）
 * - extractVisionPages：UI 渲染的页面图 → 逐页视觉（免费模型 glm-4.6v-flash）
 * 失败建模为状态（completed/needs_review/failed），不抛错打断初始化。
 * 临时页面 PNG 用完即清——引擎内部运行时临时文件。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractPdfText } from '../../storage/pdf-extract.ts'
import type { VisionProvider } from './vision-provider.ts'

export type ExtractionStatus = 'completed' | 'needs_review' | 'failed'

export interface ExtractionResult {
  status: ExtractionStatus
  method: 'text' | 'vision'
  text: string
  error?: string
}

/** 文本层提取的最小可信长度（低于此值视为无文本层/乱码 → 走视觉） */
const TEXT_MIN = 40

const EXTRACT_PROMPT = '逐字提取这份简历图片的完整文本内容（第 {page} 页），不要总结、不要遗漏。'

/** 通道 1：文本层本地提取（同步，免费离线）。文本 ≥40 字 → completed；有部分 → needs_review；无 → failed */
export function extractLocalText(pdfBuf: Buffer): ExtractionResult {
  const local = extractPdfText(pdfBuf)
  if (local.length >= TEXT_MIN) return { status: 'completed', method: 'text', text: local }
  return local.trim()
    ? { status: 'needs_review', method: 'text', text: local, error: '文本层不足（图片型/乱码）——请用视觉通道' }
    : { status: 'failed', method: 'text', text: '', error: 'PDF 无文本层（图片型/扫描件）——请用视觉通道' }
}

/**
 * 通道 2：页面图 → 逐页视觉（多页原生：每页独立调用，拼接结果）。
 * 有成功页且拼接 ≥40 字 → completed；部分成功 → needs_review；全部失败 → failed。
 */
export async function extractVisionPages(pages: string[], vision: VisionProvider): Promise<ExtractionResult> {
  const tmpDir = join(tmpdir(), `cos-pages-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  try {
    const texts: string[] = []
    let failedCount = 0
    let lastError = ''
    for (let i = 0; i < pages.length; i++) {
      const imgPath = join(tmpDir, `page-${i + 1}.png`)
      writeFileSync(imgPath, Buffer.from(pages[i]!, 'base64'))
      try {
        const text = await vision.analyzeImage(imgPath, EXTRACT_PROMPT.replace('{page}', String(i + 1)))
        if (text.trim()) texts.push(text.trim())
        else failedCount++
      } catch (err) {
        failedCount++
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
    const joined = texts.join('\n\n')
    // 真实原因透传（如免费模型限流 1305）——用户可据此判断是重试还是换模型
    const failed = failedCount > 0 ? `${failedCount}/${pages.length} 页视觉提取失败（${lastError}）` : ''
    if (joined.length >= TEXT_MIN) return { status: 'completed', method: 'vision', text: joined }
    if (joined.trim()) {
      return { status: 'needs_review', method: 'vision', text: joined, error: failed }
    }
    return { status: 'failed', method: 'vision', text: '', error: failed || '全部视觉提取失败' }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}
