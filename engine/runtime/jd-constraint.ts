/**
 * jd-constraint：岗位门槛段（JD Analysis Contract v2.0 `## 岗位门槛` 表格）→ JDConstraint IR。
 * Derived Data Separation：rawValues 保留 JD 原文枚举（Artifact 层），归一化/派生在
 * IR/匹配层，不写回 Artifact（「硕士及以上」→ raw 保留 + normalized 展开）。
 * matchMode（Freeze Review 补丁，2026-08-07）：exact/related/preferred/inferred——
 * preferred → 无 hard 维度；related/inferred → NEEDS_CONFIRMATION（归一化不猜）。
 * 契约：references/jd-constraint-match-contract.md（v0.2 冻结）。
 */
import type { ConstraintMatchMode, PersonEducation } from '../ir/schema.ts'

export const DEGREE_ENUM = ['高中', '大专', '本科', '硕士', '博士'] as const

export const DEGREE_RANK: Record<string, number> = { 高中: 0, 大专: 1, 本科: 2, 硕士: 3, 博士: 4 }

export type NormalizationStatus = 'NORMALIZED' | 'NEEDS_CONFIRMATION'

/** education 维度 IR：rawValues = 原文枚举（永不丢失）；normalizedDegrees = 可归一化的
 *  学历枚举（'及以上'展开）；无法归一化（'应届'/'不限'）→ NEEDS_CONFIRMATION（Parser 不猜）。
 *  matchMode（Freeze Review 补丁）：preferred → 无 hard 维度；related/inferred → 待确认 */
export interface JDConstraintEducationIR {
  rawValues: string[]
  normalizedDegrees?: string[]
  normalizationStatus: NormalizationStatus
  confidence: 'high' | 'medium'
  source: string
  matchMode?: ConstraintMatchMode
}

export interface JDConstraintIR {
  education?: JDConstraintEducationIR
  /** 专业维度：门槛表解析（related → fuzzy「相关专业」）；匹配规则归 Matcher Policy */
  major?: { rawValues: string[]; fuzzy?: boolean; confidence: 'high' | 'medium'; source: string }
  /** 经验维度：门槛表解析（原文枚举保留）；应届/年限判定归 Matcher Policy */
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

/** `## 岗位门槛` 表格 → JDConstraintIR（缺段 → 空对象；行级维度非法 → 跳过）。
 *  表格 5 列（维度/值/来源/置信度/模式）优先，4 列旧格式兼容；matchMode 缺省 exact */
export function parseJdConstraint(md: string): JDConstraintIR {
  const ir: JDConstraintIR = {}
  const m = md.match(/##\s*岗位门槛\s*\n((?:\|[^\n]*\|\n)+)/)
  if (!m) return ir
  const rows = m[1]
    .split('\n')
    .filter((l) => l.trim().startsWith('|') && !/^\|[\s\-|]+\|$/.test(l) && !l.includes('维度'))
  type Field = { value: string; source: string; confidence: 'high' | 'medium'; matchMode?: ConstraintMatchMode }
  const fields: Record<string, Field> = {}
  for (const line of rows) {
    const c5 = line.match(/^\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/)
    const c4 = !c5 ? line.match(/^\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/) : null
    const cols = c5 ?? c4
    if (!cols) continue
    const dim = cols[1]!.trim()
    if (!dim) continue
    const modeRaw = c5 ? cols[5]!.trim() : ''
    const mode: ConstraintMatchMode | undefined =
      modeRaw === 'exact' || modeRaw === 'related' || modeRaw === 'preferred' || modeRaw === 'inferred' ? modeRaw : undefined
    fields[dim] = {
      value: cols[2]!.trim(),
      source: cols[3]!.trim(),
      confidence: cols[4]!.trim() === 'medium' ? 'medium' : 'high',
      ...(mode ? { matchMode: mode } : {}),
    }
  }
  const edu = fields.education
  if (edu && edu.value) {
    const rawValues = edu.value.split(/[；;]/).map((s) => s.trim()).filter(Boolean)
    if (rawValues.length > 0) {
      const mode = edu.matchMode ?? 'exact'
      if (mode === 'preferred') {
        // 偏好非门槛 → 无 hard 维度（Matcher 视 NOT_DECLARED）；继续解析其他维度
      } else if (mode === 'related' || mode === 'inferred') {
        ir.education = { rawValues, normalizationStatus: 'NEEDS_CONFIRMATION', confidence: edu.confidence, source: edu.source, matchMode: mode }
      } else {
        const kinds = rawValues.map(normalizeDegreeValue)
        if (kinds.every((k) => k === 'preferred')) {
          // 4 列旧格式文本层「优先」兜底 → 无 hard 维度
        } else if (kinds.some((k) => k === 'unparseable')) {
          ir.education = { rawValues, normalizationStatus: 'NEEDS_CONFIRMATION', confidence: edu.confidence, source: edu.source, matchMode: mode }
        } else {
          const degrees = kinds.flatMap((k) => (k === 'preferred' ? [] : k.degrees))
          const unique = [...new Set(degrees)]
          if (unique.length > 0) {
            ir.education = { rawValues, normalizedDegrees: unique, normalizationStatus: 'NORMALIZED', confidence: edu.confidence, source: edu.source, matchMode: mode }
          }
        }
      }
    }
  }
  // 专业维度：related → fuzzy（「相关专业」映射归 Policy）；preferred → 偏好非门槛，不产出
  const major = fields.major
  if (major && major.value && (major.matchMode ?? 'exact') !== 'preferred') {
    const rawValues = major.value.split(/[；;]/).map((s) => s.trim()).filter(Boolean)
    if (rawValues.length > 0) {
      ir.major = {
        rawValues,
        ...((major.matchMode ?? 'exact') === 'related' ? { fuzzy: true } : {}),
        confidence: major.confidence,
        source: major.source,
      }
    }
  }
  // 经验维度：preferred → 偏好非门槛，不产出；原文保留（应届/年限判定归 Matcher Policy）
  const experience = fields.experience
  if (experience && experience.value && (experience.matchMode ?? 'exact') !== 'preferred') {
    ir.experience = { rawValue: experience.value, confidence: experience.confidence, source: experience.source }
  }
  return ir
}

/** 档案教育事实 → 参与匹配的 confirmed 学历集合（pending/rejected 不参与——契约 §4） */
export function confirmedDegrees(personEducation: PersonEducation[] | undefined): { degree: string; entry: PersonEducation }[] {
  return (personEducation ?? []).filter((e) => e.status === 'confirmed' && DEGREE_RANK[e.degree] !== undefined)
}
