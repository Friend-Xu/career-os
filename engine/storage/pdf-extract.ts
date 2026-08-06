/**
 * pdf-extract：PDF 文本层提取（Document Ingestion 的第一级——免费离线，模型无关）。
 * Flate 流 + Tj/TJ 文本运算符；中文 CID 字体可能缺失/乱码 → 返回部分文本或空串，
 * 调用方（pdf-import）据此判定走视觉通道。无可提取文本流 → 空串。
 */
import { inflateSync } from 'node:zlib'

export function extractPdfText(buf: Uint8Array): string {
  const re = /stream\r?\n([\s\S]*?)endstream/g
  let m
  let out = ''
  const latin = Buffer.from(buf).toString('latin1')
  while ((m = re.exec(latin)) !== null) {
    let data: Buffer
    try {
      data = inflateSync(Buffer.from(m[1], 'latin1'))
    } catch {
      continue
    }
    const s = data.toString('latin1')
    for (const t of s.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g)) out += t[1] + ' '
    for (const t of s.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      const items = [...t[1].matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)].map((x) => x[1])
      out += items.join('') + '\n'
    }
  }
  return out.trim()
}
