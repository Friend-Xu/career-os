/**
 * markdown-to-html renderer（M3-2.3b）：受限 markdown 子集 → HTML 纯函数。
 * - 输入为 resume-markdown renderer 的受控输出（`#` / `##` / `- ` 行），不做通用 markdown 引擎（零依赖）
 * - HTML 是展示层不是 IR（契约 RESUME-EXPORT-M3 §3）：单向 Document → HTML，无回写
 * - claimId HTML 注释原样保留（headless 渲染不显示，产物可追溯）
 */
export function markdownToHtml(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let inList = false
  const closeList = (): void => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }
  for (const line of lines) {
    const h1 = line.match(/^# (.+)$/)
    if (h1) {
      closeList()
      out.push(`<h1>${escapeHtml(h1[1])}</h1>`)
      continue
    }
    const h2 = line.match(/^## (.+)$/)
    if (h2) {
      closeList()
      out.push(`<h2>${escapeHtml(h2[1])}</h2>`)
      continue
    }
    const li = line.match(/^- (.+)$/)
    if (li) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${escapeHtml(li[1])}</li>`)
      continue
    }
    closeList()
  }
  closeList()
  return out.join('\n') + '\n'
}

/** 转义文本但保护 HTML 注释（claimId 溯源注释原样保留——headless 渲染不显示，产物可追溯） */
function escapeHtml(s: string): string {
  const parts = s.split(/(<!--[\s\S]*?-->)/g)
  return parts
    .map((p) => (p.startsWith('<!--') && p.endsWith('-->') ? p : p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')))
    .join('')
}
