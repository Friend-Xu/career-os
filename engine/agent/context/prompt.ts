/**
 * Context Bundle → Agent prompt 段（ADR-020 §6.3：Prompt 注入形式——v0.1 最小）。
 * - 输出拼入 AgentStartParams.context（与 buildSkillIdentity 同一字符串通道，不新增 SYSTEM 块）
 * - 空 bundle（references: []）不注入——污染普通对话（开放探索任务无需显式上下文段）
 * - 措辞区分显式上下文 vs 自读：Explicit task context 是确认依据，自读不属于依据清单
 */
import type { AgentContextBundle, AgentTaskType } from '../../ir/agent-task.ts'

export function buildContextSystemPrompt(taskType: AgentTaskType, bundle: AgentContextBundle): string {
  if (bundle.references.length === 0) return ''
  const refs = bundle.references.map((r, i) =>
    [
      `[${i + 1}]`,
      `类型：${r.type}`,
      `名称：${r.label ?? r.id}`,
      `ID：${r.id}`,
      r.snapshot
        ? `快照：${r.snapshot.kind === 'version' ? `版本 ${r.snapshot.value}` : `更新于 ${r.snapshot.value}`}`
        : null,
      `来源：${r.provenance.label}（${r.provenance.kind}）`,
    ]
      .filter(Boolean)
      .join('\n'),
  )
  return [
    `你正在执行任务（taskType）：${taskType}。`,
    '',
    '本次任务的显式上下文（由 Career OS 装配，已确认存在）：',
    ...refs,
    '',
    '规则：',
    '- 以上引用是本次任务确认的显式依据，不得替换为其他对象',
    '- 如需更多信息，可自行探索工作区（自读不属于显式上下文，不进入依据清单）',
  ].join('\n')
}
