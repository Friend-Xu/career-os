/**
 * Person Health Runtime（ADR-031 Person Projection Health Boundary——Accepted 冻结，2026-08-22）
 *
 * 单一计算源：UI/Agent/CI 一律经 personHealth()/`person/health` RPC 判定，
 * 禁止消费端各自发明健康逻辑（否则三个月后三套判断逻辑无法解释哪个是真的）。
 *
 * - 纯读派生，零写入：Health 永不自动修复（只诊断；修复动作必须走既有确认/登记通道）
 * - verdict 不代表数据正确性，仅代表系统一致性（类型契约见 ir/schema.ts）
 *
 * 四类检查（H1/H2/H3 → warn，H4 → error）：
 *   H1 孤儿数据/投影关系断裂：已确认事实存在但快照缺失（无投影消费者），
 *      或快照残留但事实源已无（投影器不删文件——缺件语义被掩盖）
 *   H2 缺关键投影：confirmed 偏好候选存在但 preference_constraints.md 无规范键
 *      （候选无结构化载荷 → 原文兜底，机器不可消费——画像「偏好/城市」不可读）
 *   H3 双写不一致：现文件与同源重投影（computePersonSnapshots）内容不一致
 *   H4 生命周期非法态：source=user 投影值无 confirmed 候选事实源（幽灵事实）
 */
import type { PersonHealth, PersonHealthCheck } from './types.ts'
import type { Workspace } from '../storage/workspace.ts'
import { listCandidates, scanPersons } from '../storage/person-watcher.ts'
import { computePersonSnapshots, parseConstraintPayload } from '../storage/person-snapshot-projection.ts'
import { parseCityCandidateId, scanPromotions } from '../storage/promotion-registry.ts'

/** 快照四件（投影器可生成的全部文件；缺件语义：有确认事实才生成） */
const SNAPSHOT_FILES = ['identity.md', 'preference_constraints.md', 'skill_inventory.md', 'career_profile.md'] as const

/** 单 person 健康判定（person 未登记 → undefined） */
export function personHealth(ws: Workspace, personId: string): PersonHealth | undefined {
  const snapshot = scanPersons(ws).find((s) => s.personId === personId)
  if (!snapshot) return undefined

  const checks: PersonHealthCheck[] = []
  const confirmed = listCandidates(ws, personId).filter((c) => c.status === 'confirmed')
  const current = (file: string): string =>
    ws.exists(`persons/${personId}/snapshot/current/${file}`) ? ws.read(`persons/${personId}/snapshot/current/${file}`) : ''
  const desired = new Map(computePersonSnapshots(ws, personId).map((c) => [c.file, c.content]))

  // H1 / H3：快照四件 期望（同源重投影）vs 实际
  for (const file of SNAPSHOT_FILES) {
    const want = desired.get(file)
    const have = current(file)
    if (want === undefined) {
      if (have !== '') {
        checks.push({
          id: `H1-${file}-stale`,
          type: 'H1',
          severity: 'warn',
          message: `快照 ${file} 残留但事实源已无确认事实（投影器不删文件——「未确认」被掩盖为「已建立」）`,
        })
      }
      continue
    }
    if (have === '') {
      checks.push({
        id: `H1-${file}-missing`,
        type: 'H1',
        severity: 'warn',
        message: `已确认事实存在但快照 ${file} 缺失（事实无投影消费者）`,
      })
    } else if (have !== want) {
      checks.push({
        id: `H3-${file}`,
        type: 'H3',
        severity: 'warn',
        message: `快照 ${file} 与同源重投影不一致（双写或手工改动——可重投影恢复；Health 不自动修复）`,
      })
    }
  }

  // H2：confirmed 偏好/约束候选存在，但规范键缺失——按维度独立检查（salary_range/city；
  // location 为可选维度（现居非必达事实），缺失不报警；promotion 可能补上 city 键，
  // 但不掩盖 salary 缺失（维度粒度，不是任一有值即健康））
  const prefConfirmed = confirmed.filter((c) => c.category === 'constraint' || c.category === 'interest')
  if (prefConfirmed.length > 0) {
    const pref = current('preference_constraints.md')
    const hasKey = (k: string): boolean => new RegExp(`^\\|\\s*${k}\\s*\\|`, 'm').test(pref)
    const missingKeys = ['salary_range', 'city'].filter((k) => !hasKey(k))
    if (missingKeys.length > 0) {
      checks.push({
        id: 'H2-pref-nokeys',
        type: 'H2',
        severity: 'warn',
        message: `confirmed 偏好/约束候选 ${prefConfirmed.length} 条但 preference_constraints.md 缺规范键（${missingKeys.join('/')}）——对应数据无结构化载荷或 promotion 未选定（原文兜底，机器不可消费），画像「偏好/城市」相应维度不可读`,
      })
    }
  }

  // H4：career_profile source=user 目标岗位无 confirmed 候选支撑（幽灵事实）
  const roles = snapshot.careerProfile?.targetRoles ?? []
  if (roles.length > 0) {
    const roleSet = new Set<string>()
    for (const c of prefConfirmed) {
      const jr = parseConstraintPayload(c.payload).jobRole
      if (jr) roleSet.add(jr)
    }
    for (const r of roles) {
      if (!roleSet.has(r)) {
        checks.push({
          id: `H4-role-${r}`,
          type: 'H4',
          severity: 'error',
          message: `career_profile source=user 目标「${r}」无 confirmed 候选事实源（幽灵事实——需人工裁决：补事实或撤销投影）`,
        })
      }
    }
  }

  // Promotion 联动（ADR-032 + ADR-031）：active promotion 存在但投影链断裂 → H2（联合信息）；
  // candidateId 非法（非引擎派生形态）→ H4
  const activePromos = scanPromotions(ws, personId).filter((p) => p.status === 'active')
  if (activePromos.length > 0) {
    const cityValues = new Set<string>()
    const prefDesired = desired.get('preference_constraints.md') ?? ''
    for (const line of prefDesired.split('\n')) {
      const m = line.match(/^\|\s*city\s*\|\s*([^|]*?)\s*\|$/)
      if (m) for (const c of m[1]!.trim().split('；')) cityValues.add(c)
    }
    for (const promo of activePromos) {
      const city = parseCityCandidateId(promo.candidateId)
      if (!city) {
        checks.push({
          id: `H4-promo-${promo.id}`,
          type: 'H4',
          severity: 'error',
          message: `Promotion ${promo.id} candidateId 非法（应为引擎派生形态 city:{城市名}）`,
          refs: [`promotion:${promo.id}`],
        })
      } else if (!cityValues.has(city)) {
        checks.push({
          id: `H2-promo-${promo.id}`,
          type: 'H2',
          severity: 'warn',
          message: `active promotion ${promo.id}（${city}）存在但投影 preference.city 缺失（投影链断裂）`,
          refs: [`promotion:${promo.id}`, 'projection:preference.city'],
        })
      }
    }
  }

  const warns = checks.filter((c) => c.severity === 'warn').length
  const errors = checks.length - warns
  const verdict: PersonHealth['verdict'] = errors > 0 ? 'error' : checks.length > 0 ? 'warning' : 'healthy'
  return {
    personId,
    name: snapshot.name,
    verdict,
    checks,
    summary:
      verdict === 'healthy'
        ? '事实-投影-事件链路自洽（一致性健康；不表示职业建议正确）'
        : `${checks.length} 项（warn ${warns} / error ${errors}）`,
  }
}

/** 全部已登记 person 的健康清单（persons/ 无 → 空数组） */
export function listPersonHealths(ws: Workspace): PersonHealth[] {
  return scanPersons(ws)
    .map((s) => personHealth(ws, s.personId))
    .filter((h): h is PersonHealth => h !== undefined)
    .sort((a, b) => a.personId.localeCompare(b.personId))
}
