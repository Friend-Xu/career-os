import type { Workspace } from './workspace.ts'
import type { DecisionQuestion, GapActionCategory, MatchStatus } from '../ir/schema.ts'
import { nextDecisionId } from './decision-registry.ts'

/**
 * Decision Writer（契约 career-decision-loop-contract-v0.1）：Engine owns Artifact Facts +
 * Agent owns Narrative Content + Writer owns Merge。
 * - 差距明细段 = Engine 事实（displayRows 由 transport 回源解析，写时快照——权威经 constraintRef 回源）
 * - 叙述段 = Agent 内容（AI 参考显式标注，不构成系统事实）
 * - 记录文件 = decisions/{id}.md，ID 经 nextDecisionId 系统登记（幂等：已登记命名跳过 re-register）
 */

export interface GapDisplayRow {
  constraintRef: string
  dim: 'capability' | 'education' | 'major' | 'experience'
  requirement: string
  person: string
  status: MatchStatus
  note?: string
  actionCategory: GapActionCategory
  question?: DecisionQuestion
}

/** Agent 叙述草稿（内容型，AI 参考）——禁止携带引擎事实区标题 */
export interface DecisionNarrativeDraft {
  summary?: string // 摘要表 markdown（AI 参考；含 AI 推断字段 direction_match/risk_level 等）
  understanding?: string // ## 岗位理解
  preparationPlan?: string // ## 准备建议
  resumeAdvice?: string // ## 简历调整方案
}

export interface DecisionWriteInput {
  jobId: string
  personId: string
  displayRows: GapDisplayRow[]
  narrative?: DecisionNarrativeDraft
}

const RESERVED_FACT_HEADERS = ['## 岗位差距明细', '## 城市评估明细', '## 方向评估明细']

/** 一键存档摘要表（2026-08-16 简化：引擎确定性组装——方向/风险/关键风险来自当前岗位与公司数据，
 *  用户叙述走 AI 面板不进表单；direction_match 填 -（匹配详情见岗位差距明细段，不混用 Agent 匹配口径）） */
export function composeAutoSummaryTable(fields: { direction: string; profile: string; riskLevel: string; keyRisk: string }): string {
  return [
    '| 字段 | 值 |',
    '|------|-----|',
    '| skill | jd-analysis |',
    `| direction | ${fields.direction || '-'} |`,
    '| direction_match | - |',
    `| profile | ${fields.profile || '-'} |`,
    `| risk_level | ${fields.riskLevel} |`,
    `| key_risk | ${fields.keyRisk.slice(0, 30)} |`,
    '| status | complete |',
    '| protocol_version | 2.9 |',
  ].join('\n')
}
const AI_REF_MARK = '> AI 参考：以下内容由 Agent 生成，不构成系统事实；系统事实见「岗位差距明细」（Engine 投影）。'
const DIM_LABEL: Record<GapDisplayRow['dim'], string> = {
  education: '学历',
  major: '专业',
  experience: '经验',
  capability: '能力',
}

function cell(v: string | undefined): string {
  return (v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function gapSection(rows: GapDisplayRow[]): string {
  if (rows.length === 0) return '暂无明确差距——无未满足的硬性门槛，画像无未声明能力。'
  return [
    '| constraintRef | 维度 | 要求 | 你的情况 | 状态 | 行动类别 | 确认问题 |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${cell(r.constraintRef)} | ${DIM_LABEL[r.dim]} | ${cell(r.requirement)} | ${cell(r.person)} | ${cell(r.status)}${r.note ? `（${cell(r.note)}）` : ''} | ${r.actionCategory} | ${cell(r.question?.template)} |`,
    ),
  ].join('\n')
}

function narrativeSection(title: string, body: string | undefined): string[] {
  if (!body || body.trim().length === 0) return []
  return ['', `## ${title}`, '', AI_REF_MARK, '', body.trim(), '']
}

/** 写决策记录（合并 Engine 事实段 + Agent 叙述段）→ 返回系统 ID。narrative 含事实区标题 → 拒绝（边界校验） */
export function writeDecisionRecord(ws: Workspace, input: DecisionWriteInput, now: Date = new Date()): string {
  for (const v of Object.values(input.narrative ?? {})) {
    if (v && RESERVED_FACT_HEADERS.some((h) => v.includes(h))) {
      throw new Error(`narrative 禁止包含引擎事实区标题（${RESERVED_FACT_HEADERS.join(' / ')}）`)
    }
  }
  // 边界校验：summary 语义 = 14 字段摘要表格（SUMMARY_RE 协议）——自由文本会写出必判 invalid 的记录；
  // 拒绝而非写脏（自由文本归 understanding/preparationPlan/resumeAdvice 段）
  if (input.narrative?.summary && input.narrative.summary.trim().length > 0) {
    if (!/^\| 字段 \| 值 \|/m.test(input.narrative.summary)) {
      throw new Error('narrative.summary 需为摘要表格（首行 | 字段 | 值 |，字段见 SKILL 摘要字段表）；自由文本请放 understanding/preparationPlan/resumeAdvice')
    }
  }
  const id = nextDecisionId(ws, now)
  const day = now.toISOString().slice(0, 10)
  const md = [
    '---',
    `id: ${id}`,
    `created_at: ${day}`,
    `source_file: ${input.jobId}`,
    'type: jd-analysis',
    `subject_id: ${input.jobId}`,
    `person_id: ${input.personId}`,
    '---',
    '',
    `# 岗位决策 — ${input.jobId}`,
    '',
    '> 来源：jobs/decision-draft（Engine 差距投影）+ decision/narrative-submit（Agent 叙述）',
    '> 生命周期：DRAFT（契约登记——未做状态机，见 career-decision-loop-contract-v0.1）',
    '',
  ]
  if (input.narrative?.summary && input.narrative.summary.trim().length > 0) {
    // 摘要表必须紧贴 `## 分析摘要` 头（ir/summary-table.ts SUMMARY_RE 协议——头与表间不能有中间行）
    md.push('## 分析摘要', '', input.narrative.summary.trim().replace(/^##\s*分析摘要\s*\n/, ''), '')
  }
  md.push(
    '## 岗位差距明细',
    '',
    '> 系统事实：Engine 投影（jobs/decision-draft），非 AI 生成；权威语义经 constraintRef 回源',
    '',
    gapSection(input.displayRows),
    ...narrativeSection('岗位理解', input.narrative?.understanding),
    ...narrativeSection('准备建议', input.narrative?.preparationPlan),
    ...narrativeSection('简历调整方案', input.narrative?.resumeAdvice),
  )
  ws.write(`decisions/${id}.md`, md.join('\n') + '\n')
  return id
}
