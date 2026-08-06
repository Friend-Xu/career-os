/**
 * pdf-pages：PDF 页面渲染（浏览器侧，pdfjs-dist 官方库，不自己写解析）。
 * 150 DPI（scale 2.08）是视觉 OCR 的甜点：A4 页 1275×1650px ≈ 500KB PNG，
 * 视觉模型识别清晰且传输量可控。渲染在 Web Worker（pdfjs 内置），不阻塞主线程。
 */
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

const RENDER_SCALE = 2.08

/** PDF 文件 → 每页 PNG base64（不含 data: 前缀；多页原生） */
export async function renderPdfToPages(file: File): Promise<string[]> {
  const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: RENDER_SCALE })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    await page.render({ canvas, viewport }).promise
    pages.push(canvas.toDataURL('image/png').split(',')[1]!)
    canvas.width = 0
    canvas.height = 0
  }
  return pages
}
