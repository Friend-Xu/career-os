/**
 * resume-markdown renderer（M3-2.2）：ResumeDocument IR → Markdown 纯函数。
 * - same input → same output：Renderer 不产生新文本、不删改内容、不排序（排序属 Assembly）
 * - bullet 尾随 HTML 注释保留 claimId 溯源（`<!-- claimId:xxx -->`：显示与 ATS 解析均忽略，内部可追溯）
 * - Skills 章节必须有 assetRefs（资产引用——Assembly 不编造技能），缺失拒绝生成
 * - 只渲染 IR 已表达的结构：`# person` + `## section` + `- bullet/asset`（不发明 Company 等未建模层级）
 */
import type { ResumeDocument } from '../ir/resume.ts'

export class ResumeRenderError extends Error {}

export function renderResumeMarkdown(document: ResumeDocument): string {
  const lines: string[] = [`# ${document.person}`]
  for (const section of document.sections) {
    if (section.type === 'skills' && !section.assetRefs?.length) {
      throw new ResumeRenderError(`Skills 章节缺少资产引用（assetRefs）：${section.title}`)
    }
    lines.push('', `## ${section.title}`)
    for (const b of section.bullets) {
      lines.push(`- ${b.sentence} <!-- claimId:${b.claimId} -->`)
    }
    for (const ref of section.assetRefs ?? []) {
      lines.push(`- ${ref}`)
    }
  }
  return lines.join('\n') + '\n'
}
