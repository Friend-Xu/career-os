import type { CompanyFact, CompanyFactType } from '../ir/schema.ts'
import { factIdOf } from './company-assessment.ts'

/**
 * CompanyFact Parser（Company Intelligence Layer v0.1，契约 references/company-assessment-contract-v0.1.md §7.2）。
 * - 段落定位：`## 公司事实` 标题 → 下一 `##` / `---` / EOF 之间的首个表格（无 m flag——$ 只匹配输入末尾）
 * - 列映射：类型 / 内容 / 来源 / 链接（可选）；跳过表头与分隔行
 * - 类型列不在枚举 → 进 unknownRows（不静默丢）；缺来源 → 产出但 normalize 降级 NO_EVIDENCE
 * - id = factIdOf(companyId, type, value)——同事实跨次解析 id 稳定，来源变化不改 id；companyId 隔离公司
 */

const FACT_TYPES: readonly CompanyFactType[] = [
  'CERTIFICATION', 'FINANCING', 'PATENT', 'INDUSTRY_STATUS', 'GROWTH', 'OPPORTUNITY', 'RISK',
]

const FACT_SECTION_RE = /##\s*公司事实\s*\n([\s\S]*?)(?=\n##\s|\n---|$)/

export interface ParsedCompanyFacts {
  facts: CompanyFact[]
  /** 类型列不在枚举的行（原文 type/value 保留，不参与计分；上层可展示/记录） */
  unknownRows: { type: string; value: string }[]
}

function cellsOf(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

function isHeader(line: string): boolean {
  return line.includes('类型') || /^\|[\s:|-]+\|$/.test(line)
}

export function parseCompanyFacts(md: string, companyId: string): ParsedCompanyFacts {
  const m = md.match(FACT_SECTION_RE)
  if (!m) return { facts: [], unknownRows: [] }
  const out: ParsedCompanyFacts = { facts: [], unknownRows: [] }
  for (const line of m[1].split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|') || isHeader(trimmed)) continue
    const [type, value, source, url] = cellsOf(trimmed)
    if (!type && !value) continue
    if (!FACT_TYPES.includes(type as CompanyFactType)) {
      out.unknownRows.push({ type, value: value ?? '' })
      continue
    }
    out.facts.push({
      id: factIdOf(companyId, type, value),
      type: type as CompanyFactType,
      value: value ?? '',
      evidence: { source: source ?? '', ...(url ? { url } : {}) },
    })
  }
  return out
}
