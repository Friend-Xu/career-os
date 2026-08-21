/**
 * role-proposal-registry：岗位提案登记（roles-contract.md v0.2 —— Producer Boundary 落地）。
 * - Agent 经 CLI 桥提交（--role-submit {json}）→ Engine 校验（company 已登记 / source 必填 /
 *   技能需求非空 / id 派生）→ 提案落盘（role-proposals/，审计）→ 登记投影 knowledge/roles.md
 * - roles.md 从「LLM 直写 + 引擎宽容解析」升级为「Engine Registration 投影落盘」：
 *   Agent 不再直写 roles.md（契约 v0.2 禁止）；全部登记走本通道（幂等：同 id 更新不重复）
 * - 岗位是外部事实（来源 JD/尽调文档），校验通过即登记——不需要用户确认（与
 *   strength-proposal 的差异：优势亮点是用户画像资产，需 User Confirmation；岗位来源文档可回溯）
 * - watcher：role-proposals/ 变更 → 补登（Agent 手工写文件兜底）+ 广播 poolChanged
 *   （roles.md 投影变化 → UI 差距分析/图谱按需重拉）
 */
import { watch } from 'chokidar'
import type { Role } from '../ir/schema.ts'
import type { Workspace } from './workspace.ts'
import { parseRolesMarkdown, serializeRolesMarkdown } from './knowledge-watcher.ts'

export const ROLE_PROPOSAL_SPEC = {
  type: 'role_proposal',
  dir: 'role-proposals',
  idPrefix: 'role_proposal_',
} as const

export type RoleProposalStatus = 'registered' | 'invalid'

export interface RoleProposalInput {
  company: string // canonical 公司名（须已登记 companies/ 档案；简称/全称容错同占位建档）
  name: string // 岗位名（JD/尽调中的正式岗位名）
  source: string // 来源标识：JD-{公司}-{日期} / 公司档案-{公司}（证据锚点，必填）
  skills: { name: string; essential: boolean }[] // 技能需求（从 JD/尽调提取；非空）
}

export interface RoleProposal extends RoleProposalInput {
  id: string // role_proposal_{YYYYMMDD}_{NNNNN}（Engine 派生）
  roleId: string // {name}-{company}（对齐 roles.md 条目 id，Engine 派生）
  status: RoleProposalStatus
  createdAt: string
}

/** company 档案存在性（含简称/全称双向子串容错——对齐 ensureCompanyPlaceholder 的容错语义） */
export function hasCompanyFile(ws: Workspace, company: string): boolean {
  const existing = ws.listMarkdown('companies')
  return existing.some((f) => {
    const name = f.replace(/\.md$/, '')
    return name.includes(company) || company.includes(name)
  })
}

/** 来源标识校验：JD-{公司}-{日期} / 公司档案-{公司}（宽松前缀 + 非空）；非法 → 拒绝登记 */
export function isValidRoleSource(source: string): boolean {
  return /^(JD-|公司档案-)/.test(source.trim())
}

function nextProposalId(ws: Workspace, now: Date): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `${ROLE_PROPOSAL_SPEC.idPrefix}${day}_`
  let max = 0
  for (const f of ws.listMarkdown(ROLE_PROPOSAL_SPEC.dir)) {
    if (!f.startsWith(prefix)) continue
    const n = parseInt(f.slice(prefix.length, -3), 10)
    if (!Number.isNaN(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(5, '0')}`
}

function serializeProposal(p: RoleProposal): string {
  return [
    '---',
    `id: ${p.id}`,
    `role_id: ${p.roleId}`,
    `company: ${p.company}`,
    `name: ${p.name}`,
    `source: ${p.source}`,
    `status: ${p.status}`,
    `created_at: ${p.createdAt}`,
    '---',
    '# 岗位提案',
    '',
    '## 技能需求',
    '',
    ...p.skills.map((s) => `- ${s.essential ? 'essential' : 'nice-to-have'}: ${s.name}`),
    '',
  ].join('\n')
}

/** 登记校验（fail fast）：company 已登记 / source 合法 / 技能需求非空。失败 throw（错误给 Agent 看拦截原因） */
function validateRoleInput(ws: Workspace, input: RoleProposalInput): void {
  if (!input.company?.trim()) throw new Error('company 必填（canonical 公司名）')
  if (!input.name?.trim()) throw new Error('name 必填（岗位名）')
  if (!hasCompanyFile(ws, input.company)) {
    throw new Error(`company 未登记档案：${input.company}（先建档 companies/{公司}.md 或经 JD 建档自动占位）`)
  }
  if (!isValidRoleSource(input.source)) {
    throw new Error(`source 非法：${JSON.stringify(input.source)}（合法：JD-{公司}-{日期} / 公司档案-{公司}）`)
  }
  if (!Array.isArray(input.skills) || input.skills.length === 0) {
    throw new Error('skills 必填且非空（技能需求从 JD/尽调提取，至少 1 项）')
  }
  for (const s of input.skills) {
    if (!s.name?.trim()) throw new Error('skills 项缺技能名')
  }
}

/**
 * Agent 提交（CLI 桥 --role-submit {json}）：校验 → 提案落盘（审计）→ 登记投影 roles.md。
 * 幂等语义：同 roleId（{name}-{company}）已存在 → 覆盖更新（对齐契约「同公司同名岗位已登记则更新不重复建」）。
 */
export function submitRoleProposal(ws: Workspace, input: RoleProposalInput, now: Date = new Date()): RoleProposal {
  validateRoleInput(ws, input)
  const id = nextProposalId(ws, now)
  const roleId = `${input.name.trim()}-${input.company.trim()}`
  const proposal: RoleProposal = {
    id,
    roleId,
    company: input.company.trim(),
    name: input.name.trim(),
    source: input.source.trim(),
    skills: input.skills.map((s) => ({ name: s.name.trim(), essential: s.essential })),
    status: 'registered',
    createdAt: now.toISOString(),
  }
  ws.write(`${ROLE_PROPOSAL_SPEC.dir}/${id}.md`, serializeProposal(proposal))
  upsertRoleToRolesMd(ws, {
    id: roleId,
    name: proposal.name,
    company: proposal.company,
    skills: proposal.skills.map((s) => ({ name: s.name, essential: s.essential, source: proposal.source })),
  })
  return proposal
}

/** roles.md 投影 upsert（Engine Registration Owner——Agent 禁止直写 roles.md，契约 v0.2）：
 *  同 id 覆盖更新；条目按 id 排序保持稳定；追加到现有条目之后（存量 Agent 直写条目保留，一次性兼容） */
export function upsertRoleToRolesMd(ws: Workspace, role: Role): void {
  const rel = 'knowledge/roles.md'
  const existing: Role[] = ws.exists(rel) ? parseRolesMarkdown(ws.read(rel), 'roles.md').value : []
  const merged = [...existing.filter((r) => r.id !== role.id), role].sort((a, b) => a.id.localeCompare(b.id))
  ws.write(rel, serializeRolesMarkdown(merged))
}

export function parseRoleProposalMarkdown(md: string): RoleProposal | null {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  if (!meta.id || !meta.company || !meta.name) return null
  const skills: { name: string; essential: boolean }[] = []
  for (const line of m[0] ? md.slice(m[0].length).split('\n') : []) {
    const t = line.trim()
    const sm = t.match(/^-\s*(essential|nice-to-have)[：:]\s*(.+)$/)
    if (sm) skills.push({ name: sm[2]!.trim(), essential: sm[1] === 'essential' })
  }
  return {
    id: meta.id,
    roleId: meta.role_id ?? `${meta.name}-${meta.company}`,
    company: meta.company,
    name: meta.name,
    source: meta.source ?? '',
    skills,
    status: meta.status === 'invalid' ? 'invalid' : 'registered',
    createdAt: meta.created_at ?? '',
  }
}

/** role-proposals/ 扫描（审计/补登输入） */
export function scanRoleProposals(ws: Workspace): RoleProposal[] {
  let files: string[]
  try {
    files = ws.listMarkdown(ROLE_PROPOSAL_SPEC.dir)
  } catch {
    return []
  }
  return files
    .sort()
    .map((f) => parseRoleProposalMarkdown(ws.read(`${ROLE_PROPOSAL_SPEC.dir}/${f}`)))
    .filter((p): p is RoleProposal => p !== null)
}

/** 补登（引擎离线期间 Agent 手工写入的提案文件兜底）：registered 提案重新投影（幂等）；invalid 跳过 */
export function registerPendingRoleProposals(ws: Workspace): { registered: number } {
  let registered = 0
  for (const p of scanRoleProposals(ws)) {
    if (p.status !== 'registered') continue
    upsertRoleToRolesMd(ws, {
      id: p.roleId,
      name: p.name,
      company: p.company,
      skills: p.skills.map((s) => ({ name: s.name, essential: s.essential, source: p.source })),
    })
    registered++
  }
  return { registered }
}

/** role-proposals/ 目录监听：变更 → 补登 + 广播 poolChanged（roles.md 投影变化 → UI 图谱/差距分析重拉） */
export function watchRoleProposals(ws: Workspace, onChanged: (parsed: RoleProposal[]) => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.roleProposals, { ignoreInitial: true })
  const rescan = (): void => {
    registerPendingRoleProposals(ws)
    onChanged(scanRoleProposals(ws))
  }
  watcher.on('add', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  watcher.on('change', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  watcher.on('unlink', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  return { close: () => watcher.close() }
}
