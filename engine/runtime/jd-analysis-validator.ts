/**
 * jd-analysis-validator：JD 分析 Proposal Validator（契约 v0.1 冻结）。
 * 只答「这个 Proposal 是否符合 Artifact Contract」——结构/值域/锚点格式；
 * 不做「是否正确」（语义归 Agent 提取 + Benchmark）。
 * Anti-Hallucination 硬校验：education/major/experience 的 source 禁止岗位名/标题类锚点
 * （学历门槛不能由岗位名支撑——Claim Strength ≤ Evidence Strength 系统层）。
 * 校验结果按字段级分发：reject = 不写入 Artifact（Writer 跳过）；warn = 写入但记录。
 */
import type { JDAnalysisProposal } from '../ir/schema.ts'
import { DEGREE_ENUM } from './jd-constraint.ts'

export interface JDAnalysisValidationIssue {
  path: string
  reason: string
  severity: 'reject' | 'warn'
}

/** 岗位名/标题类锚点——不能支撑门槛/理解字段（Anti-Hallucination） */
const ANTI_HALLUCINATION_SOURCES = ['岗位名称', '岗位名', '岗位标题', '标题', '职位名称', '职位名']

/** education 值域外值判定（枚举 + 合法表述变体：「及以上/以上/不限/应届/优先/更佳」） */
function isEducationValueLegal(v: string): boolean {
  if ((DEGREE_ENUM as readonly string[]).includes(v)) return true
  return ['及以上', '以上', '不限', '应届', '优先', '更佳'].some((s) => v.includes(s))
}

export function validateJDAnalysisProposal(p: JDAnalysisProposal): JDAnalysisValidationIssue[] {
  const issues: JDAnalysisValidationIssue[] = []
  if (!p.jobId?.trim()) issues.push({ path: 'jobId', reason: '缺失', severity: 'reject' })
  if (p.artifactVersion !== 2) {
    issues.push({ path: 'artifactVersion', reason: `必须为 2（当前 ${p.artifactVersion}）`, severity: 'reject' })
  }

  // constraints：值非空 + 锚点非空 + Anti-Hallucination 硬校验 + education 值域
  for (const dim of ['education', 'major', 'experience'] as const) {
    const c = p.constraints?.[dim]
    if (!c) continue
    if (!c.values?.length || c.values.some((v) => !v.trim())) {
      issues.push({ path: `constraints.${dim}.values`, reason: '缺失或含空值', severity: 'reject' })
    }
    if (!c.source?.trim()) {
      issues.push({ path: `constraints.${dim}.source`, reason: '缺失（原文锚点必填）', severity: 'reject' })
    } else if (ANTI_HALLUCINATION_SOURCES.some((s) => c.source.includes(s))) {
      issues.push({
        path: `constraints.${dim}.source`,
        reason: `非法锚点「${c.source}」——门槛不能由岗位名/标题支撑（Claim Strength ≤ Evidence Strength）`,
        severity: 'reject',
      })
    }
    if (dim === 'education') {
      const bad = c.values.filter((v) => !isEducationValueLegal(v))
      if (bad.length > 0) {
        issues.push({ path: 'constraints.education.values', reason: `含值域外值：${bad.join('、')}`, severity: 'reject' })
      }
    }
  }

  // context：结构化条目 + 锚点
  for (const k of ['workMode', 'careerPath', 'industry'] as const) {
    for (const f of p.context?.[k] ?? []) {
      if (!f.value?.trim()) issues.push({ path: `context.${k}.value`, reason: '缺失', severity: 'reject' })
      if (!f.source?.trim()) issues.push({ path: `context.${k}.source`, reason: '缺失（原文锚点必填）', severity: 'reject' })
    }
  }

  // capabilities：结构 + 词表
  for (const [i, cap] of (p.capabilities ?? []).entries()) {
    if (!cap.responsibility?.trim()) {
      issues.push({ path: `capabilities[${i}].responsibility`, reason: '缺失', severity: 'reject' })
    }
    if (cap.priority !== 'must' && cap.priority !== 'nice') {
      issues.push({ path: `capabilities[${i}].priority`, reason: '必须为 must/nice', severity: 'reject' })
    }
    if (cap.category !== 'hard' && cap.category !== 'soft' && cap.category !== 'preference') {
      issues.push({ path: `capabilities[${i}].category`, reason: '必须为 hard/soft/preference', severity: 'reject' })
    }
    if (!cap.capabilities?.length) {
      issues.push({ path: `capabilities[${i}].capabilities`, reason: '缺失', severity: 'reject' })
    }
  }
  return issues
}
