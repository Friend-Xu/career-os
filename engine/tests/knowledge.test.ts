import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Role, Skill } from '../ir/schema.ts'
import {
  buildSkillIndex,
  canonicalSkillName,
  extractPersonSkills,
  parseRolesMarkdown,
  parseSkillsMarkdown,
  scanKnowledge,
} from '../storage/knowledge-watcher.ts'
import { computeGap, missingAction, transferableAction } from '../runtime/gap-calculator.ts'
import { buildGraph } from '../storage/graph-builder.ts'
import { initWorkspace } from '../storage/workspace.ts'
import { scanProfiles } from '../storage/projection.ts'
import { computeKnowledgeGap } from '../transport/websocket.ts'

const skillsMd = `# 技能词表

## 机械设计

- 别名：结构设计, 非标设计
- 3级：能独立完成常规结构件设计
- 4级：能根据工况定制方案并做校核

## 减速器设计

- 别名：谐波减速器选型, RV减速器
- 3级：能完成标准减速器选型
`

const rolesMd = `# 岗位清单

## 机器人结构工程师（汇川技术）

- essential：机械设计（来源：JD-汇川技术-2026-08-02）
- nice-to-have：减速器设计（来源：JD-汇川技术-2026-08-02）
`

const personMd = `# 我

## 目标方向

| 方向 | 匹配度 | 说明 |
|------|:--:|------|
| 机器人结构设计 | 82% | 机械结构 + 仿真背景契合 |

## 基本信息

- 教育: 机械工程本科

## 技能

- 机械设计：4
- 减速器设计：2
- CAE 仿真：3
`

// ─── skills.md 解析 ────────────────────────────────────────────────────────

test('skills.md 合法解析：技能名/别名拆分/锚点级别索引，无 validation', () => {
  const { value, validation } = parseSkillsMarkdown(skillsMd, 'skills.md')
  assert.equal(validation, undefined)
  assert.equal(value.length, 2)
  const mech = value.find((s) => s.name === '机械设计')!
  assert.deepEqual(mech.aliases, ['结构设计', '非标设计']) // 逗号分隔拆分
  const mechAnchor: (string | undefined)[] = [] // 稀疏数组：索引 = 级别-1（3级 → anchor[2]）
  mechAnchor[2] = '能独立完成常规结构件设计'
  mechAnchor[3] = '能根据工况定制方案并做校核'
  assert.deepEqual(mech.anchor, mechAnchor)
  const reducer = value.find((s) => s.name === '减速器设计')!
  assert.deepEqual(reducer.aliases, ['谐波减速器选型', 'RV减速器'])
  const reducerAnchor: (string | undefined)[] = []
  reducerAnchor[2] = '能完成标准减速器选型'
  assert.deepEqual(reducer.anchor, reducerAnchor)
})

test('skills.md 缺列表项/重复技能名/锚点级别越界/无法识别项 → degraded 保留', () => {
  const md = `${skillsMd}
## 空技能

## 机械设计

- 别名：重复

## 越界

- 6级：超出范围
- 备注：自由文本
`
  const { value, validation } = parseSkillsMarkdown(md, 'skills.md')
  assert.equal(validation?.status, 'degraded')
  assert.ok(validation!.issues.every((i) => i.severity === 'warn'))
  assert.equal(value.length, 4) // 重复名跳过（首个保留）
  assert.equal(value.find((s) => s.name === '机械设计')!.aliases.length, 2) // 首个条目未被覆盖
  const empty = value.find((s) => s.name === '空技能')!
  assert.deepEqual(empty.aliases, []) // 缺列表项 → 保留空条目 + warn
  assert.equal(value.find((s) => s.name === '越界')!.anchor, undefined) // 越界/无法识别项不产出锚点
})

test('skills.md 无 `## 技能名` 条目 → invalid', () => {
  const { value, validation } = parseSkillsMarkdown('# 技能词表\n\n（空文件）', 'skills.md')
  assert.equal(validation?.status, 'invalid')
  assert.equal(validation?.issues[0]?.severity, 'error')
  assert.deepEqual(value, [])
})

// ─── roles.md 解析 ─────────────────────────────────────────────────────────

test('roles.md 合法解析：岗位名/公司名/id/essential/source/nice-to-have，无 validation', () => {
  const { value, validation } = parseRolesMarkdown(rolesMd, 'roles.md')
  assert.equal(validation, undefined)
  assert.equal(value.length, 1)
  const role = value[0]!
  assert.equal(role.name, '机器人结构工程师')
  assert.equal(role.company, '汇川技术')
  assert.equal(role.id, '机器人结构工程师-汇川技术') // id = 岗位名-公司名
  assert.deepEqual(role.skills, [
    { name: '机械设计', essential: true, source: 'JD-汇川技术-2026-08-02' },
    { name: '减速器设计', essential: false, source: 'JD-汇川技术-2026-08-02' },
  ])
})

test('roles.md 缺公司名/缺需求项/无法识别项 → degraded；无 `## 岗位名` → invalid', () => {
  const md = `${rolesMd}
## 无公司岗位

- essential：机械设计（来源：JD-x）

## 空岗位（某公司）

## 坏项（某公司）

- 备注：自由文本
`
  const { value, validation } = parseRolesMarkdown(md, 'roles.md')
  assert.equal(validation?.status, 'degraded')
  const noCompany = value.find((r) => r.name === '无公司岗位')!
  assert.equal(noCompany.company, '')
  assert.equal(noCompany.id, '无公司岗位')
  assert.equal(value.find((r) => r.name === '空岗位')!.skills.length, 0) // 缺需求项 → 保留空岗位 + warn
  assert.equal(value.find((r) => r.name === '坏项')!.skills.length, 0) // 无法识别项不产出需求

  const empty = parseRolesMarkdown('# 岗位清单\n\n（空文件）', 'roles.md')
  assert.equal(empty.validation?.status, 'invalid')
  assert.deepEqual(empty.value, [])
})

// ─── 画像技能声明 ─────────────────────────────────────────────────────────

test('extractPersonSkills：`## 技能` 段落 → PersonSkill[]；无段落 → 空数组；非法级别丢弃', () => {
  assert.deepEqual(extractPersonSkills(personMd), [
    { name: '机械设计', level: 4 },
    { name: '减速器设计', level: 2 },
    { name: 'CAE 仿真', level: 3 },
  ])
  assert.deepEqual(extractPersonSkills('# 我\n\n## 基本信息\n\n- 教育: 本科'), []) // 无技能段落 → 空数组合法
  const bad = personMd.replace('- 机械设计：4', '- 机械设计：6').replace('- 减速器设计：2', '- 减速器设计：abc')
  assert.deepEqual(extractPersonSkills(bad), [{ name: 'CAE 仿真', level: 3 }]) // 6/abc 丢弃
})

// ─── 别名归一化 ───────────────────────────────────────────────────────────

test('buildSkillIndex/canonicalSkillName：词表名与别名 → 规范名；词表外原样', () => {
  const { value: skills } = parseSkillsMarkdown(skillsMd, 'skills.md')
  const index = buildSkillIndex(skills)
  assert.equal(canonicalSkillName('机械设计', index), '机械设计')
  assert.equal(canonicalSkillName('结构设计', index), '机械设计') // 别名 → 规范名
  assert.equal(canonicalSkillName('RV减速器', index), '减速器设计')
  assert.equal(canonicalSkillName('自由技能', index), '自由技能') // 词表外原样
})

// ─── 差距分析 ─────────────────────────────────────────────────────────────

function roleOf(partial: Partial<Role> = {}): Role {
  return {
    id: 'r-1',
    name: '机器人结构工程师',
    company: '汇川技术',
    skills: [
      { name: '机械设计', essential: true, source: 'JD-x' },
      { name: '减速器设计', essential: false, source: 'JD-x' },
    ],
    ...partial,
  }
}

test('computeGap：satisfied(≥3)/transferable(1-2)/missing 分档 + action 模板', () => {
  const skills = [{ name: '机械设计', aliases: [] }, { name: '减速器设计', aliases: [] }] as Skill[]
  const gap = computeGap({
    role: roleOf(),
    person: '我',
    personSkills: [
      { name: '机械设计', level: 4 },
      { name: '减速器设计', level: 2 },
    ],
    skills,
  })
  assert.equal(gap.person, '我')
  assert.equal(gap.role.id, 'r-1')
  assert.deepEqual(gap.satisfied, [{ name: '机械设计', level: 4 }]) // ≥3 可独立产出
  assert.deepEqual(gap.transferable, [{ name: '减速器设计', level: 2 }]) // 1-2 有基础需补强
  assert.equal(gap.missing.length, 0)
})

test('computeGap：别名归一化双向命中——声明别名命中需求名 / 声明名命中需求别名', () => {
  const skills = [
    { name: '机械设计', aliases: ['结构设计', '非标设计'] },
    { name: '减速器设计', aliases: ['谐波减速器选型'] },
  ] as Skill[]
  // 声明"非标设计"（别名）命中需求"机械设计"；需求"谐波减速器选型"（别名）命中声明"减速器设计"
  const gap = computeGap({
    role: roleOf(),
    person: '我',
    personSkills: [
      { name: '非标设计', level: 4 },
      { name: '减速器设计', level: 2 },
    ],
    skills,
  })
  assert.deepEqual(gap.satisfied, [{ name: '非标设计', level: 4 }]) // 条目名 = 声明名
  assert.deepEqual(gap.transferable, [{ name: '减速器设计', level: 2 }])
  assert.equal(gap.missing.length, 0)
})

test('computeGap：同义词声明取级别最高者；同一声明命中多个需求只列一次', () => {
  const skills = [{ name: '机械设计', aliases: ['结构设计'] }] as Skill[]
  const gap = computeGap({
    role: roleOf({ skills: [
      { name: '机械设计', essential: true, source: 'JD-x' },
      { name: '结构设计', essential: false, source: 'JD-y' }, // 同规范名，重复命中
    ] }),
    person: '我',
    personSkills: [
      { name: '结构设计', level: 2 },
      { name: '机械设计', level: 4 },
    ],
    skills,
  })
  assert.deepEqual(gap.satisfied, [{ name: '机械设计', level: 4 }]) // 取级别最高声明，且只列一次
  assert.deepEqual(gap.transferable, [])
})

test('computeGap：未声明 → missing（essential/source 透传 + 模板化 action）；无词表 → 精确名匹配', () => {
  const gap = computeGap({
    role: roleOf(),
    person: '我',
    personSkills: [], // 画像无技能声明 → 全 missing
    skills: [],
  })
  assert.deepEqual(gap.satisfied, [])
  assert.deepEqual(gap.transferable, [])
  assert.deepEqual(gap.missing, [
    { name: '机械设计', essential: true, source: 'JD-x', action: '学习 机械设计 基础（目标 2 级）' },
    { name: '减速器设计', essential: false, source: 'JD-x', action: '学习 减速器设计 基础（目标 2 级）' },
  ])
  assert.equal(missingAction('机械设计'), '学习 机械设计 基础（目标 2 级）')
  assert.equal(transferableAction('减速器设计'), '补强 减速器设计 至 3 级（案例练习）')
})

test('computeGap：词表外自由技能按名精确匹配', () => {
  const gap = computeGap({
    role: roleOf({ skills: [{ name: '焊接切割工艺', essential: false, source: 'JD-y' }] }),
    person: '我',
    personSkills: [{ name: '焊接切割工艺', level: 3 }],
    skills: [],
  })
  assert.deepEqual(gap.satisfied, [{ name: '焊接切割工艺', level: 3 }])
})

// ─── 目录扫描 / 图谱 / RPC 接线 ───────────────────────────────────────────

test('scanKnowledge：缺文件 → 空列表；skills.md/roles.md → 解析产物', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-knw-'))
  const ws = initWorkspace(root)
  try {
    assert.deepEqual(scanKnowledge(ws), { skills: [], roles: [] }) // 目录存在但无文件
    ws.write('knowledge/skills.md', skillsMd)
    ws.write('knowledge/roles.md', rolesMd)
    const scan = scanKnowledge(ws)
    assert.equal(scan.skills.length, 2)
    assert.equal(scan.roles.length, 1)
    assert.equal(scan.roles[0]!.id, '机器人结构工程师-汇川技术')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('graph：role/skill 节点 + company→role 雇佣 / role→skill 需求（essential → high）+ 别名归一化连线', () => {
  const { value: skills } = parseSkillsMarkdown(skillsMd, 'skills.md')
  const { value: roles } = parseRolesMarkdown(`${rolesMd}
## 结构工程师（无档案公司）

- essential：结构设计（来源：JD-y）
`, 'roles.md')
  const graph = buildGraph({
    decisions: [],
    companies: [
      { id: '汇川技术', name: '汇川技术' },
      { id: '无摘要公司', name: '无摘要公司', validation: { status: 'invalid', issues: [] } },
    ],
    profileNames: [],
    skills,
    roles,
  })
  // 节点
  assert.ok(graph.nodes.some((n) => n.id === 'skill:机械设计' && n.label === '机械设计' && n.type === 'skill'))
  assert.ok(graph.nodes.some((n) => n.id === 'role:机器人结构工程师-汇川技术' && n.label === '机器人结构工程师' && n.type === 'role'))
  assert.ok(graph.nodes.some((n) => n.id === 'role:结构工程师-无档案公司')) // 无公司档案的岗位节点仍在
  // 边：雇佣（medium）+ 需求（essential high / nice-to-have medium）+ 别名归一化（结构设计 → skill:机械设计）
  assert.ok(graph.edges.some((e) => e.source === 'company:汇川技术' && e.target === 'role:机器人结构工程师-汇川技术' && e.relation === '雇佣' && e.strength === 'medium'))
  assert.ok(graph.edges.some((e) => e.source === 'role:机器人结构工程师-汇川技术' && e.target === 'skill:机械设计' && e.relation === '需求' && e.strength === 'high'))
  assert.ok(graph.edges.some((e) => e.source === 'role:机器人结构工程师-汇川技术' && e.target === 'skill:减速器设计' && e.relation === '需求' && e.strength === 'medium'))
  assert.ok(graph.edges.some((e) => e.source === 'role:结构工程师-无档案公司' && e.target === 'skill:机械设计' && e.relation === '需求')) // 别名归一化连线
  assert.ok(!graph.edges.some((e) => e.source === 'company:无摘要公司'), 'invalid 公司不产生雇佣边')
  assert.ok(!graph.nodes.some((n) => n.id === 'skill:未入表技能'), '词表外技能不产生节点')
})

test('scanProfiles 带技能声明；computeKnowledgeGap 端到端（workspace → GapResult）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-gap-'))
  const ws = initWorkspace(root)
  try {
    ws.write('knowledge/skills.md', skillsMd)
    ws.write('knowledge/roles.md', rolesMd)
    ws.write('profiles/我.md', personMd)
    ws.write('profiles/无技能.md', '# 无技能\n\n## 基本信息\n\n- 教育: 本科')

    const profiles = scanProfiles(ws)
    assert.deepEqual(profiles.find((p) => p.name === '我')!.skills, [
      { name: '机械设计', level: 4 },
      { name: '减速器设计', level: 2 },
      { name: 'CAE 仿真', level: 3 },
    ])
    assert.deepEqual(profiles.find((p) => p.name === '无技能')!.skills, []) // 无段落 → 空数组

    const gap = computeKnowledgeGap(ws, { person: '我', roleId: '机器人结构工程师-汇川技术' })
    assert.deepEqual(gap.satisfied, [{ name: '机械设计', level: 4 }])
    assert.deepEqual(gap.transferable, [{ name: '减速器设计', level: 2 }])
    assert.deepEqual(gap.missing, []) // CAE 仿真不在岗位需求矩阵中，不产出

    assert.throws(() => computeKnowledgeGap(ws, { person: '我', roleId: '不存在' }), /角色不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
