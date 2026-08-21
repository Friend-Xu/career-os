import type { Person, ResumeDocument } from '../types'
import type { DecisionView } from './engine-client'
import { hasPersonDirection } from '../utils/direction-state'

/**
 * 导航 Attention 状态：当前事实的持续反映（≠ Attention 事件）。
 * - recommended：建议开始（档案可用但方向未探索）
 * - waiting：前置条件未满足（等待方向确定）
 * - completed：已有产物（简历版本数）
 * 只显示有意义的导航项，其他导航不带状态（避免仪表盘化）。
 * 与 attention-store 的分工：这里是持续状态（角标），attention 是事件（浮层卡片）。
 */
export type NavStateKind = 'recommended' | 'waiting' | 'completed'

export interface NavAttention {
  kind: NavStateKind
  reason: string
  detail?: string
}

export type NavigationState = Partial<Record<'workbench' | 'companies' | 'resumes', NavAttention>>

export function deriveNavigationState(
  person: Person,
  decisions: DecisionView[],
  resumes: ResumeDocument[],
): NavigationState {
  const out: NavigationState = {}
  const hasDirection = hasPersonDirection(decisions, person)

  if (person.initStatus === 'pending') {
    out.workbench = { kind: 'waiting', reason: '初始化采集中' }
  } else {
    if (!hasDirection) {
      out.workbench = { kind: 'recommended', reason: '建议探索职业方向' }
      out.companies = { kind: 'waiting', reason: '等待职业方向确定' }
    }
  }

  // 引擎真实简历版本（resumes/documents/ 登记物，person = owner personId）；mock RESUMES 已退出导航统计
  const personResumes = resumes.filter((r) => r.person === person.personId)
  if (personResumes.length > 0) {
    out.resumes = {
      kind: 'completed',
      reason: `${personResumes.length} 个简历版本`,
      detail: String(personResumes.length),
    }
  }

  return out
}
