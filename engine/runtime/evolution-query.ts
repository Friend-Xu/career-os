/**
 * evolution-query：M7.4 Career Evolution Query（验证层——不改写任何资产，纯读投影）。
 * 验证 Ledger 是否真的可解释"状态为什么变化"，而非只是记录。
 * - whyChanged：变化单位 → 完整事件链（何时/为什么/证据）
 * - replayDecision：决策演化回放（事件 + 当时输入 + 当时未知）
 * - whatChangedRecently：近 N 天变化 + 当前状态中无近期事件覆盖的单位（无变化）
 *
 * 边界：回答事实链（结构化引用），不生成自然语言故事（幻觉边界保持）；
 * "无变化"从事件链反查（当前单位无近期事件），不从快照猜测。
 */
import type { Workspace } from '../storage/workspace.ts'
import { readLedgerEvents, type LedgerEventRecord } from '../storage/ledger-writer.ts'
import { extractUnits } from './ledger-candidate.ts'
import { parseInputRefs } from '../storage/report-watcher.ts'
import { scanContexts } from '../storage/context-watcher.ts'

export interface EvolutionChange {
  eventId: string
  timestamp: string
  changeUnit: string
  changeType: LedgerEventRecord['type']
  before?: string
  after?: string
  beforeRef: string
  afterRef: string
  why: string
  sourceRefs: string[]
  trigger: { type: string; source?: string; refs: string[] }
}

function splitChange(change?: string): { before?: string; after?: string } {
  if (!change) return {}
  const [b, a] = change.split('\n\n→\n\n')
  return {
    ...(b && b !== '（新增）' ? { before: b } : {}),
    ...(a && a !== '（删除）' ? { after: a } : {}),
  }
}

function toChange(e: LedgerEventRecord): EvolutionChange {
  return {
    eventId: e.id,
    timestamp: e.timestamp,
    changeUnit: e.changeUnit,
    changeType: e.type,
    ...splitChange(e.change),
    beforeRef: e.beforeRef,
    afterRef: e.afterRef,
    why: e.why,
    sourceRefs: e.sourceRefs,
    trigger: e.trigger,
  }
}

/** Query 1：为什么变化——按变化单位过滤事件链（无事件 → 空数组） */
export function whyChanged(ws: Workspace, pid: string, unit: string): EvolutionChange[] {
  return readLedgerEvents(ws, pid).filter((e) => e.changeUnit === unit).map(toChange)
}

export interface DecisionReplay {
  eventId: string
  timestamp: string
  changeUnit: string
  before?: string
  after?: string
  why: string
  decisionId: string
  /** 当时输入（decision 文件 `## 输入引用` 段落；无 → 缺省） */
  decisionInputs?: { evidenceRefs: { id: string; snapshot?: string }[]; skillRefs: { id: string; version?: string }[]; constraintRefs: { id: string }[]; knowledgeRefs: { id: string }[] }
  /** 当时未知（关联 DecisionContext `## 未知` 段落；无 → 缺省） */
  unknowns?: string[]
}

/** Query 2：决策演化回放——decision 来源事件 + 关联决策输入 + 当时未知 */
export function replayDecision(ws: Workspace, pid: string): DecisionReplay[] {
  const contexts = scanContexts(ws)
  const events = readLedgerEvents(ws, pid).filter((e) => e.beforeRef.startsWith('decision:'))
  return events.map((e) => {
    const decisionId = e.beforeRef.slice('decision:'.length)
    const ctx = contexts.find((c) => c.record.relatedDecisions.includes(decisionId))
    const md = ws.exists(`decisions/${decisionId}.md`) ? ws.read(`decisions/${decisionId}.md`) : undefined
    const inputs = md ? parseInputRefs(md) : undefined
    return {
      eventId: e.id,
      timestamp: e.timestamp,
      changeUnit: e.changeUnit,
      ...splitChange(e.change),
      why: e.why,
      decisionId,
      ...(inputs && Object.keys(inputs).length > 0 ? { decisionInputs: inputs } : {}),
      ...(ctx?.sections.unknowns.length ? { unknowns: ctx.sections.unknowns } : {}),
    }
  })
}

export interface RecentEvolution {
  changes: EvolutionChange[]
  /** 当前快照的变化单位中，近 N 天无 ledger 事件覆盖的（无变化） */
  unchanged: string[]
}

/** Query 3：近 N 天发生了什么——变化事件 + 无变化单位（从事件链反查） */
export function whyChangedRecently(ws: Workspace, pid: string, days: number): RecentEvolution {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const events = readLedgerEvents(ws, pid)
  const changes = events.filter((e) => Date.parse(e.timestamp) >= cutoff).map(toChange)

  // 当前快照单位集（current/ 或最新版本）
  const files: Record<string, string> = {}
  try {
    for (const f of ws.listMarkdown(`persons/${pid}/snapshot/current`)) {
      files[f] = ws.read(`persons/${pid}/snapshot/current/${f}`)
    }
  } catch {
    // current/ 未创建 → 空（无变化单位的对照源）
  }
  const currentUnits = [...extractUnits(files).keys()]
  const changedUnits = new Set(events.map((e) => e.changeUnit))
  return { changes, unchanged: currentUnits.filter((u) => !changedUnits.has(u)).sort() }
}
