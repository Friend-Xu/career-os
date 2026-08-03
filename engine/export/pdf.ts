/**
 * PDF 导出服务：spawn Windows 自带 Edge（headless --print-to-pdf）渲染 HTML → PDF。
 * 零依赖方案（借鉴 md-to-pdf 等工具链）：不装 puppeteer，用系统浏览器。
 * 中文质量 = 真打印（矢量文本），与 window.print 同内核。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

function findEdge(): string | null {
  for (const p of EDGE_PATHS) {
    if (existsSync(p)) return p
  }
  return null
}

export interface PdfResult {
  pdf: string // base64
  fileName: string
}

/** HTML → PDF（临时文件落 tmpdir，完成后清理）。Edge 缺失抛错（调用方降级）。 */
export function exportPdf(html: string): Promise<PdfResult> {
  const edge = findEdge()
  if (!edge) throw new Error('未找到 Edge 浏览器（导出 PDF 依赖 Windows 自带 Edge）')
  const id = randomUUID()
  const htmlPath = join(tmpdir(), `cos-resume-${id}.html`)
  const pdfPath = join(tmpdir(), `cos-resume-${id}.pdf`)
  writeFileSync(htmlPath, html, 'utf8')

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      try { unlinkSync(htmlPath) } catch { /* 已删除 */ }
      try { unlinkSync(pdfPath) } catch { /* 未生成 */ }
    }
    const p = spawn(
      edge,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-pdf-header-footer',
        `--print-to-pdf=${pdfPath}`,
        `file:///${htmlPath.replace(/\\/g, '/')}`,
      ],
      { stdio: 'ignore' },
    )
    p.on('error', (err) => {
      cleanup()
      reject(err)
    })
    p.on('exit', (code) => {
      if (code !== 0) {
        cleanup()
        reject(new Error(`Edge 打印失败（退出码 ${code}）`))
        return
      }
      try {
        const pdf = readFileSync(pdfPath).toString('base64')
        cleanup()
        resolve({ pdf, fileName: `resume-${Date.now()}.pdf` })
      } catch (err) {
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  })
}
