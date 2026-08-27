/**
 * role-derivation：岗位入库自动派生（roles-contract.md v0.2 自动链）。
 * - JD 分析落盘后（jd-analysis-writer 挂载）自动从「岗位智能」段派生角色提案 → role-proposals/ + roles.md 投影。
 * - 存量对账（backfillRoleProposalsFromJobs）：引擎启动时扫描 jobs/ 已分析岗位，缺登记 → 派生补登。
 * - Producer Boundary：技能需求源自 Agent 已提交并经 Validator 校验的 JD 分析（AI 推理结果），
 *   Engine 只做登记与投影（Registration Owner）；无智能段 / 无公司档案 → 不派生（岗位实例库要求技能可回溯）。
 * - 幂等：roleId = {name}-{company} 已登记 → 覆盖更新（对齐 submitRoleProposal 语义）；补登跳过已登记。
 */
import type { JobRecord } from '../ir/schema.ts'
import type { Workspace } from './workspace.ts'
import { scanJobs } from './job-watcher.ts'
import {
  submitRoleProposal,
  scanRoleProposals,
  type RoleProposal,
  type RoleProposalInput,
} from './role-proposal-registry.ts'

/** company canonical 解析（双向子串容错——对齐 hasCompanyFile 语义；未登记档案 → null） */
export function resolveCompanyCanonical(ws: Workspace, company: string): string | null {
  const name = company.trim()
  if (!name) return null
  const hit = ws.listMarkdown('companies').find((f) => {
    const n = f.replace(/\.md$/, '')
    return n.includes(name) || name.includes(n)
  })
  return hit ? hit.replace(/\.md$/, '') : null
}

/** JD 智能段 → 角色提案输入（skills = ai 责任单元能力词，essential = priority must；去重；不可派生 → null） */
export function deriveRoleInputFromJob(ws: Workspace, job: JobRecord): RoleProposalInput | null {
  const canonical = resolveCompanyCanonical(ws, job.company)
  if (!canonical) return null
  const date = job.id.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? job.createdAt
  if (!date) return null
  const seen = new Set<string>()
  const skills: { name: string; essential: boolean }[] = []
  for (const r of job.responsibilities) {
    if (r.source !== 'ai') continue // 只认引擎校验过的岗位智能段（建档 user 责任段不是技能提取）
    for (const cap of r.capabilities) {
      const n = cap.trim()
      if (!n || seen.has(n)) continue
      seen.add(n)
      skills.push({ name: n, essential: r.priority === 'must' })
    }
  }
  if (skills.length === 0) return null
  return { company: canonical, name: job.title.trim(), source: `JD-${canonical}-${date}`, skills }
}

/** 自动链入口：岗位已分析且可派生 → 幂等登记投影（覆盖更新）；不可派生/岗位不存在 → null */
export function ensureRoleFromJob(ws: Workspace, jobId: string, now: Date = new Date()): RoleProposal | null {
  const job = scanJobs(ws).find((j) => j.record.id === jobId)?.record
  if (!job) return null
  const input = deriveRoleInputFromJob(ws, job)
  if (!input) return null
  return submitRoleProposal(ws, input, now)
}

/** 存量对账补登：已分析岗位（有智能段）未登记 → 派生登记；已登记（同 roleId）跳过。 */
export function backfillRoleProposalsFromJobs(ws: Workspace): { derived: number; skipped: number } {
  const registered = new Set(scanRoleProposals(ws).map((p) => p.roleId))
  let derived = 0
  let skipped = 0
  for (const { record } of scanJobs(ws)) {
    const input = deriveRoleInputFromJob(ws, record)
    if (!input) continue
    const roleId = `${input.name}-${input.company}`
    if (registered.has(roleId)) {
      skipped++
      continue
    }
    submitRoleProposal(ws, input)
    registered.add(roleId)
    derived++
  }
  return { derived, skipped }
}
