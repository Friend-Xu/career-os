/**
 * jd-constraint：岗位门槛段（JD Analysis Contract v2.0 `## 岗位门槛` 表格）→ JDConstraint IR。
 * Derived Data Separation：rawValues 保留 JD 原文枚举（Artifact 层），归一化/派生在
 * IR/匹配层，不写回 Artifact（「硕士及以上」→ raw 保留 + normalized 展开）。
 * 契约：references/jd-constraint-match-contract.md（v0.2 冻结）。
 */
import type { PersonEducation } from '../ir/schema.ts'

export const DEGREE_ENUM = ['高中', '大专', '本科', '硕士', '博士'] as const

export const DEGREE_RANK: Record<string, number> = { 高中: 0, 大专: 1, 本科: 2, 硕士: 3, 博士: 4 }

export type NormalizationStatus = 'NORMALIZED' | 'NEEDS_CONFIRMATION'

/** education 维度 IR：rawValues = 原文枚举（永不丢失）；normalizedDegrees = 可归一化的
 *  学历枚举（'及以上'展开）；无法归一化（'应届'/'不限'）→ NEEDS_CONFIRMATION（Parser 不猜） */
export interface JDConstraintEducationIR {
  rawValues: string[]
  normalizedDegrees?: string[]
  normalizationStatus: NormalizationStatus
  confidence: 'high' | 'medium'
  source: string
}

export interface JDConstraintIR {
  education?: JDConstraintEducationIR
  /** 专业/经验维度：schema 预留（v0.2 只定义结构，匹配规则后续；fuzzy = 「相关专业」类） */
  major?: { rawValues: string[]; fuzzy?: boolean; confidence: 'high' | 'medium'; source: string }
  experience?: { rawValue: string; confidence: 'high' | 'medium'; source: string }
}

/** 单值归一化：'及以上/以上' → 展开枚举；'优先/更佳' → preferred（v1 无偏好模型，不进 hard
 *  match）；'不限/应届' 与枚举外 → unparseable（不猜） */
function normalizeDegreeValue(v: string): { degrees: string[] } | 'preferred' | 'unparseable' {
  if (v.includes('优先') || v.includes('更佳')) return 'preferred'
  if (v.includes('不限') || v.includes('应届')) return 'unparseable'
  const m = v.match(/^(.+?)(?:及以上|以上)$/)
  if (m) {
    const idx = DEGREE_ENUM.indexOf(m[1]!.trim() as (typeof DEGREE_ENUM)[number])
    return idx >= 0 ? { degrees: DEGREE_ENUM.slice(idx) as unknown as string[] } : 'unparseable'
  }
  if ((DEGREE_ENUM as readonly string[]).includes(v)) return { degrees: [v] }
  return 'unparseable'
}

/** `## 岗位门槛` 表格 → JDConstraintIR（缺段 → 空对象；行级维度非法 → 跳过） */
export function parseJdConstraint(md: string): JDConstraintIR {
  const ir: JDConstraintIR = {}
  const m = md.match(/##\s*岗位门槛\s*\n((?:\|[^\n]*\|\n)+)/)
  if (!m) return ir
  const rows = m[1]
    .split('\n')
    .filter((l) => l.trim().startsWith('|') && !/^\|[\s\-|]+\|$/.test(l) && !l.includes('维度'))
  const fields: Record<string, { value: string; source: string; confidence: 'high' | 'medium' }> = {}
  for (const line of rows) {
    const cols = line.match(/^\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/)
    if (!cols) continue
    const dim = cols[1]!.trim()
    if (!dim) continue
    fields[dim] = {
      value: cols[2]!.trim(),
      source: cols[3]!.trim(),
      confidence: cols[4]!.trim() === 'medium' ? 'medium' : 'high',
    }
  }
  const edu = fields.education
  if (edu && edu.value) {
    const rawValues = edu.value.split(/[;；]/).map((s) => s.trim()).filter(Boolean)
    if (rawValues.length > 0) {
      const kinds = rawValues.map(normalizeDegreeValue)
      // 优先表述（v1 无偏好模型）→ 不进 hard match：全部 preferred → 不产出该维度（Matcher 视 NOT_DECLARED）
      if (kinds.every((k) => k === 'preferred')) return ir
      if (kinds.some((k) => k === 'unparseable')) {
        ir.education = { rawValues, normalizationStatus: 'NEEDS_CONFIRMATION', confidence: edu.confidence, source: edu.source }
      } else {
        const degrees = kinds.flatMap((k) => (k === 'preferred' ? [] : k.degrees))
        const unique = [...new Set(degrees)]
        if (unique.length > 0) {
          ir.education = { rawValues, normalizedDegrees: unique, normalizationStatus: 'NORMALIZED', confidence: edu.confidence, source: edu.source }
        }
      }
    }
  }
  return ir
}

/** 档案教育事实 → 参与匹配的 confirmed 学历集合（pending/rejected 不参与——契约 §4） */
export function confirmedDegrees(personEducation: PersonEducation[] | undefined): { degree: string; entry: PersonEducation }[] {
  return (personEducation ?? []).filter((e) => e.status === 'confirmed' && DEGREE_RANK[e.degree] !== undefined)
}
