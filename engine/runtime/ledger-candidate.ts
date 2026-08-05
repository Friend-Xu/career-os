/**
 * ledger-candidate：M7.2 Candidate Generator（Ledger Candidate Contract v1 冻结）。
 * Snapshot Diff → Change Unit → LedgerCandidate（proposed / confirmed）。
 * - diffSnapshotVersions：版本对 → 变化原语（机械层，无认知语义）
 * - buildCandidates：变化原语 × 归因/确认 → Candidate（归因层）
 *
 * 边界（不许越）：
 * - 只产出 candidate，不写 ledger/（M7.2 Writer 负责 committed 落盘）
 * - 无归因 → proposed，不 committed（信息保留在版本链）
 * - confirmed 无 why → fail fast（confirmed + committed 必须 why 非空）
 * - trigger.type 三通道冻结，不扩展枚举
 * - 不编造 why（归因只来自调用方：用户确认/决策/证据）
 */
import type { Workspace } from '../storage/workspace.ts'
import { readSnapshotVersion } from '../storage/snapshot-archive.ts'
import { parseSnapshotTable } from '../storage/person-watcher.ts'

export type LedgerChangeType = 'identity' | 'experience' | 'skill' | 'preference' | 'constraint' | 'decision'
export type TriggerType = 'snapshot_change' | 'decision_changed' | 'external_event'
export type Confidence = 'high' | 'medium' | 'low'

export interface ChangeUnitDiff {
  unit: string
  changeType: LedgerChangeType
  before?: string
  after?: string
  file: string
}

export interface CandidateTrigger {
  type: TriggerType
  source?: string
  refs?: string[]
}

export interface CandidateAttribution {
  why?: string
  sourceRefs?: string[]
}

export interface CandidateConfirmation {
  type: 'user_confirmation' | 'decision_confirmation' | 'evidence_confirmation'
  ref: string
}

export interface LedgerCandidate {
  id: string          // 派生引用 {personId}:{toVersion}#{unit}（不落盘不登记）
  personId: string
  status: 'proposed' | 'confirmed'
  changeType: LedgerChangeType
  changeUnit: string
  diffEvidence: {
    before?: string
    after?: string
    beforeRef: string // {snapshot_version_id}#{unit}（防漂移引用）
    afterRef: string
  }
  trigger: { type: TriggerType; source?: string; refs: string[] }
  attribution?: { why?: string; sourceRefs: string[] }
  confidence: Confidence
  confirmation?: CandidateConfirmation
}

export interface CandidateBuildInput {
  fromId: string
  toId: string
  trigger: CandidateTrigger
  attribution?: CandidateAttribution
  confirmation?: CandidateConfirmation
}

interface Unit { value: string; changeType: LedgerChangeType; file: string }

/** 版本状态 → 变化单位表（按 Contract v1 提取范围：有解析结构的文件） */
function extractUnits(files: Record<string, string>): Map<string, Unit> {
  const units = new Map<string, Unit>()
  const set = (unit: string, value: string, changeType: LedgerChangeType, file: string): void => {
    if (!unit || !value) return
    units.set(unit, { value, changeType, file })
  }

  for (const [file, content] of Object.entries(files)) {
    if (file === 'skill_inventory.md') {
      for (const line of content.split('\n')) {
        const m = line.match(/^\|\s*(skill_\w+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/)
        if (!m) continue
        set(m[1]!, m[3]!.trim().split(/[（(]/)[0]!.trim(), 'skill', file)
      }
    } else if (file === 'preference_constraints.md') {
      for (const line of content.split('\n')) {
        const m = line.match(/^\|\s*(pf-\d+|ct-\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/)
        if (!m) continue
        const id = m[1]!
        set(id, m[3]!.trim(), id.startsWith('pf') ? 'preference' : 'constraint', file)
      }
      const table = parseSnapshotTable(content)
      for (const k of ['salary', 'city'] as const) {
        if (table[k]) set(k, table[k]!, 'preference', file)
      }
    } else if (file === 'career_profile.md') {
      let inTargets = false
      for (const line of content.split('\n')) {
        if (line.startsWith('## 目标方向')) {
          inTargets = true
          continue
        }
        if (inTargets && line.startsWith('## ')) break
        if (!inTargets) continue
        const m = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|/)
        if (!m || m[1]!.startsWith('-') || m[1]!.trim() === '方向') continue // 跳过表头/分隔行
        set(m[1]!.trim(), m[2]!.trim(), 'decision', file)
      }
      const table = parseSnapshotTable(content)
      if (table.current_role) set('current_role', table.current_role!, 'identity', file)
    } else if (file === 'identity.md') {
      for (const [k, v] of Object.entries(parseSnapshotTable(content))) set(k, v, 'identity', file)
    }
    // experience_inventory.md 无解析器（Contract v1 范围外，跳过）
  }
  return units
}

/** 版本对 → 变化原语（新增/删除/变化；摘要值不含认知语义） */
export function diffSnapshotVersions(ws: Workspace, pid: string, fromId: string, toId: string): ChangeUnitDiff[] {
  const from = extractUnits(readSnapshotVersion(ws, pid, fromId))
  const to = extractUnits(readSnapshotVersion(ws, pid, toId))
  const names = new Set([...from.keys(), ...to.keys()])
  const out: ChangeUnitDiff[] = []
  for (const unit of names) {
    const a = from.get(unit)
    const b = to.get(unit)
    if (a?.value === b?.value && a?.changeType === b?.changeType) continue
    out.push({
      unit,
      changeType: (b ?? a)!.changeType,
      before: a?.value,
      after: b?.value,
      file: (b ?? a)!.file,
    })
  }
  return out.sort((x, y) => x.file.localeCompare(y.file) || x.unit.localeCompare(y.unit))
}

/** 变化原语 × 归因/确认 → Candidate[]（无 diff → 空；confirmed 无 why → fail fast） */
export function buildCandidates(ws: Workspace, pid: string, input: CandidateBuildInput): LedgerCandidate[] {
  const diffs = diffSnapshotVersions(ws, pid, input.fromId, input.toId)
  if (diffs.length === 0) return []
  if (input.confirmation && !input.attribution?.why) {
    throw new Error(`confirmed 必须 why 非空（${input.confirmation.ref}，Ledger Candidate Contract v1）`)
  }
  const status: LedgerCandidate['status'] = input.confirmation ? 'confirmed' : 'proposed'
  const confidence: Confidence = input.confirmation ? 'high' : input.attribution?.why ? 'medium' : 'low'
  return diffs.map((d) => ({
    id: `${pid}:${input.toId}#${d.unit}`,
    personId: pid,
    status,
    changeType: d.changeType,
    changeUnit: d.unit,
    diffEvidence: {
      ...(d.before !== undefined ? { before: d.before } : {}),
      ...(d.after !== undefined ? { after: d.after } : {}),
      beforeRef: `${input.fromId}#${d.unit}`,
      afterRef: `${input.toId}#${d.unit}`,
    },
    trigger: {
      type: input.trigger.type,
      ...(input.trigger.source ? { source: input.trigger.source } : {}),
      refs: input.trigger.refs ?? [],
    },
    ...(input.attribution
      ? {
          attribution: {
            ...(input.attribution.why ? { why: input.attribution.why } : {}),
            sourceRefs: input.attribution.sourceRefs ?? [],
          },
        }
      : {}),
    confidence,
    ...(input.confirmation ? { confirmation: input.confirmation } : {}),
  }))
}
