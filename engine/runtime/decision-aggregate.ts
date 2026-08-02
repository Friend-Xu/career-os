/**
 * decision-aggregate：DecisionAggregate 运行时组装（V1.5，方案书 4.3 定稿）。
 *
 * 输入：context 列表（storage/context-watcher 的 ParsedContext）+ 决策记录列表
 * （projection.listDecisions()）。输出：按 context 组装的 DecisionAggregate[]——
 * 内存对象不落盘、引擎只聚合展示不自己打分（评分是 skill/Agent 分析产出的 14 字段值）。
 * 纯函数幂等（同 computeChain）：同输入必同输出，可测。
 *
 * 组装规则：
 * - records：relatedDecisions 按决策 id（文件名无 .md）匹配；invalid 决策排除（同 computeChain）；
 *   匹配不到 → 跳过（文件作者的引用错误，不标记不兜底）；顺序 = 文件声明顺序
 * - options：每关联决策一个，name = 决策 title（现有数据多条决策同 direction，
 *   title 保留每条决策的阶段视角）；status 默认 candidate；文件可选排除项
 *   rejected_decisions（对应 option → rejected，reasons 取 rejected_reasons 按下标对应）
 * - factors/evidence/risks：正文段落（`## 考虑因素` / `## 证据` / `## 风险` 列表）；
 *   conclusion 取 `## 结论` 首项；段落缺失 → 空数组 / 缺省，不崩
 */
import type { DecisionAggregate, DecisionRecord, Validation } from '../ir/schema.ts'
import type { ParsedContext } from '../storage/context-watcher.ts'

/** 按 context 组装聚合（invalid context 尽力组装：能用多少用多少，不崩） */
export function buildAggregates(contexts: ParsedContext[], decisions: DecisionRecord[]): DecisionAggregate[] {
  // 决策按 id 索引（同 computeChain：invalid 不参与聚合展示）
  const validById = new Map<string, DecisionRecord>()
  for (const d of decisions) {
    const validation = (d as DecisionRecord & { validation?: Validation }).validation
    if (validation?.status !== 'invalid') validById.set(d.id, d)
  }

  const sorted = [...contexts].sort(
    (a, b) => (b.record.createdAt ?? '').localeCompare(a.record.createdAt ?? '') || b.sourceFile.localeCompare(a.sourceFile),
  )

  return sorted.map((ctx) => {
    const related = (ctx.record.relatedDecisions ?? [])
      .map((id) => validById.get(id))
      .filter((d): d is DecisionRecord => d !== undefined)

    const rejectedList = ctx.rejectedDecisions ?? []
    const reasons = ctx.rejectedReasons ?? []
    const options = related.map((d) => {
      const ri = rejectedList.indexOf(d.id)
      if (ri === -1) return { name: d.title, status: 'candidate' as const }
      const r = reasons[ri]
      return r !== undefined
        ? { name: d.title, status: 'rejected' as const, reasons: [r] }
        : { name: d.title, status: 'rejected' as const }
    })

    const aggregate: DecisionAggregate = {
      context: ctx.record,
      records: related,
      options,
      factors: ctx.sections.factors,
      evidence: ctx.sections.evidence,
      risks: ctx.sections.risks,
    }
    if (ctx.sections.conclusion) aggregate.conclusion = ctx.sections.conclusion
    return aggregate
  })
}
