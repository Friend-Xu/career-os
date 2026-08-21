import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import { submitRoleProposal, registerPendingRoleProposals, scanRoleProposals, hasCompanyFile, isValidRoleSource, upsertRoleToRolesMd } from '../storage/role-proposal-registry.ts'
import { parseRolesMarkdown } from '../storage/knowledge-watcher.ts'

let wsSeq = 0
function testWorkspace(): Workspace {
  wsSeq++
  return initWorkspace(`.local/ws-role-proposal-test-${Date.now()}-${wsSeq}`)
}

function seedCompany(ws: Workspace, name: string): void {
  ws.write(`companies/${name}.md`, `# ${name}\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| city | 苏州 |\n| industry | - |\n`)
}

test('submitRoleProposal：合法提案 → 提案落盘 registered + roles.md 投影含条目（id 派生 + source 透传）', () => {
  const ws = testWorkspace()
  seedCompany(ws, 'Company-C 自动化')
  const p = submitRoleProposal(ws, {
    company: 'Company-C 自动化',
    name: '机器人结构工程师',
    source: 'JD-Company-C 自动化-2026-08-02',
    skills: [
      { name: '机械设计', essential: true },
      { name: '减速器设计', essential: false },
    ],
  }, new Date('2026-08-02T00:00:00Z'))
  assert.equal(p.status, 'registered')
  assert.equal(p.roleId, '机器人结构工程师-Company-C 自动化')
  assert.match(p.id, /^role_proposal_20260802_\d{5}$/)

  // 提案文件审计
  const proposals = scanRoleProposals(ws)
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0]!.company, 'Company-C 自动化')

  // roles.md 投影（Engine Registration 产物，契约格式英文冒号）
  const { value } = parseRolesMarkdown(ws.read('knowledge/roles.md'), 'roles.md')
  assert.equal(value.length, 1)
  const role = value[0]!
  assert.equal(role.id, '机器人结构工程师-Company-C 自动化')
  assert.deepEqual(role.skills, [
    { name: '机械设计', essential: true, source: 'JD-Company-C 自动化-2026-08-02' },
    { name: '减速器设计', essential: false, source: 'JD-Company-C 自动化-2026-08-02' },
  ])
  // 投影序列化可回读（round-trip：英文冒号产出 → 解析器兼容）
  assert.equal(parseRolesMarkdown(ws.read('knowledge/roles.md'), 'roles.md').validation, undefined)
})

test('submitRoleProposal：company 未登记档案 → 拒绝（throw，不落盘）', () => {
  const ws = testWorkspace()
  assert.throws(
    () => submitRoleProposal(ws, {
      company: '未登记公司',
      name: '机械工程师',
      source: 'JD-未登记公司-2026-08-02',
      skills: [{ name: '机械设计', essential: true }],
    }),
    /company 未登记档案/,
  )
  assert.throws(() => ws.read('knowledge/roles.md')) // 无投影
})

test('submitRoleProposal：source 缺失/非法 → 拒绝；skills 空 → 拒绝', () => {
  const ws = testWorkspace()
  seedCompany(ws, 'Company-C 自动化')
  assert.throws(
    () => submitRoleProposal(ws, {
      company: 'Company-C 自动化',
      name: '岗位X',
      source: '',
      skills: [{ name: '机械设计', essential: true }],
    }),
    /source 非法/,
  )
  assert.throws(
    () => submitRoleProposal(ws, {
      company: 'Company-C 自动化',
      name: '岗位X',
      source: '泛化市场知识', // 非 JD-/公司档案- 前缀
      skills: [{ name: '机械设计', essential: true }],
    }),
    /source 非法/,
  )
  assert.throws(
    () => submitRoleProposal(ws, {
      company: 'Company-C 自动化',
      name: '岗位X',
      source: 'JD-Company-C 自动化-2026-08-02',
      skills: [],
    }),
    /skills 必填且非空/,
  )
})

test('submitRoleProposal：同 roleId 重复登记 → 覆盖更新不重复建条目', () => {
  const ws = testWorkspace()
  seedCompany(ws, 'Company-C 自动化')
  submitRoleProposal(ws, {
    company: 'Company-C 自动化',
    name: '机器人结构工程师',
    source: 'JD-Company-C 自动化-2026-08-02',
    skills: [{ name: '机械设计', essential: true }],
  }, new Date('2026-08-02T00:00:00Z'))
  submitRoleProposal(ws, {
    company: 'Company-C 自动化',
    name: '机器人结构工程师',
    source: 'JD-Company-C 自动化-2026-08-10',
    skills: [
      { name: '机械设计', essential: true },
      { name: '减速器设计', essential: true },
    ],
  }, new Date('2026-08-10T00:00:00Z'))

  const { value } = parseRolesMarkdown(ws.read('knowledge/roles.md'), 'roles.md')
  assert.equal(value.length, 1) // 不重复
  assert.equal(value[0]!.skills.length, 2) // 更新后技能集
  assert.equal(value[0]!.skills[1]!.source, 'JD-Company-C 自动化-2026-08-10')
})

test('company 简称/全称容错：hasCompanyFile 双向子串判定', () => {
  const ws = testWorkspace()
  seedCompany(ws, '示例智造科技有限公司')
  assert.equal(hasCompanyFile(ws, '示例智造科技'), true)
  assert.equal(hasCompanyFile(ws, '示例智造科技有限公司'), true)
  assert.equal(hasCompanyFile(ws, '示例智造'), true)
  assert.equal(hasCompanyFile(ws, '完全无关'), false)
})

test('isValidRoleSource：JD-/公司档案- 前缀合法；其余非法', () => {
  assert.equal(isValidRoleSource('JD-Company-C 自动化-2026-08-02'), true)
  assert.equal(isValidRoleSource('公司档案-Company-C 自动化'), true)
  assert.equal(isValidRoleSource('  JD-x  '), true)
  assert.equal(isValidRoleSource(''), false)
  assert.equal(isValidRoleSource('泛化知识'), false)
  assert.equal(isValidRoleSource('公司'), false)
})

test('registerPendingRoleProposals：引擎离线期间手工写入的 registered 提案 → 启动补登投影（幂等）', () => {
  const ws = testWorkspace()
  seedCompany(ws, 'Company-C 自动化')
  // 模拟引擎离线：Agent 直接写提案文件（registered 状态）
  ws.write('role-proposals/role_proposal_20260801_00001.md', [
    '---',
    'id: role_proposal_20260801_00001',
    'role_id: 机械工程师-Company-C 自动化',
    'company: Company-C 自动化',
    'name: 机械工程师',
    'source: JD-Company-C 自动化-2026-08-01',
    'status: registered',
    'created_at: 2026-08-01T00:00:00.000Z',
    '---',
    '# 岗位提案',
    '',
    '## 技能需求',
    '',
    '- essential: 机械设计',
    '',
  ].join('\n'))
  const r1 = registerPendingRoleProposals(ws)
  assert.equal(r1.registered, 1)
  const { value } = parseRolesMarkdown(ws.read('knowledge/roles.md'), 'roles.md')
  assert.equal(value[0]!.id, '机械工程师-Company-C 自动化')
  // 幂等：重复补登不重复
  const r2 = registerPendingRoleProposals(ws)
  assert.equal(r2.registered, 1)
  assert.equal(parseRolesMarkdown(ws.read('knowledge/roles.md'), 'roles.md').value.length, 1)
})

test('upsertRoleToRolesMd：存量 roles.md（Agent 直写历史条目）保留 + 新登记追加，不丢存量', () => {
  const ws = testWorkspace()
  seedCompany(ws, 'Company-C 自动化')
  // 存量 roles.md（一次性兼容层：历史 Agent 直写条目）
  ws.write('knowledge/roles.md', [
    '# 岗位清单',
    '',
    '## 存量岗位（Company-C 自动化）',
    '',
    '- essential: 旧技能（来源: JD-Company-C 自动化-2026-07-01）',
    '',
  ].join('\n'))
  upsertRoleToRolesMd(ws, {
    id: '新岗位-Company-C 自动化',
    name: '新岗位',
    company: 'Company-C 自动化',
    skills: [{ name: '新技能', essential: true, source: 'JD-Company-C 自动化-2026-08-02' }],
  })
  const { value } = parseRolesMarkdown(ws.read('knowledge/roles.md'), 'roles.md')
  assert.equal(value.length, 2)
  assert.ok(value.some((r) => r.name === '存量岗位'))
  assert.ok(value.some((r) => r.name === '新岗位'))
})
