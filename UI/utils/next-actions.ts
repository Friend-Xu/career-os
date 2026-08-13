import { useAppStore } from '../store/app-store'
import { belongsToPerson } from './ownership'
import { hasPersonDirection } from './direction-state'
import type { NextAction } from '../types'

/**
 * Next Action Resolver（规则派生：系统告诉用户什么重要，Agent 帮助深入）。
 * 单一事实源——工作台 TodaySection 与 Agent Panel「建议·下一步」消费同一派生；
 * 禁独立 mock（NEXT_ACTION 静态数据已废弃）。
 */
export function useNextActions(): NextAction[] {
  const decisions = useAppStore((s) => s.decisions)
  const jobs = useAppStore((s) => s.jobs)
  const applications = useAppStore((s) => s.applications)
  const person = useAppStore((s) => s.currentPerson())

  const personApps = applications.filter((a) => a.personId === (person.personId ?? ''))
  const personDecisions = decisions.filter((d) => belongsToPerson(d, person))

  const actions: NextAction[] = []
  // 方向探索：档案可用（非初始化中；undefined = 存量档案默认可用）但尚未产出方向决策
  // （摘要 direction 或方向评估明细任一非空即视为已探索，后续决策不覆盖）→ 第一个推理引导
  if (!hasPersonDirection(decisions, person) && person.initStatus !== 'pending') {
    actions.push({
      label: '探索职业方向',
      page: 'agent',
      prompt: `请基于「${person.name}」的职业档案，探索适合的发展方向：结合经历、技能与自报意向，给出 2-3 个候选方向及理由。`,
    })
  }
  // 已分析判定：该公司的 jd-analysis 决策（公司名匹配，title 匹配过宽会误判）
  const toAnalyze = jobs.filter(
    (j) => !personDecisions.some((d) => d.skill === 'jd-analysis' && d.title.includes(j.company)),
  )
  if (toAnalyze.length > 0) actions.push({ label: `${toAnalyze.length} 个 JD 等待分析`, page: 'jobs', jobId: toAnalyze[0].id })
  // FollowUpState 规则未启用（ADR-019 Decision 9：不冻结业务阈值）——待跟进统计不造假
  const toApply = personApps.filter((a) => a.status === 'PREPARING' || a.status === 'READY')
  if (toApply.length > 0) actions.push({ label: `${toApply.length} 个岗位待投递`, page: 'applications' })

  return actions
}
