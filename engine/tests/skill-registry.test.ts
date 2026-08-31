import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import {
  resolveSkillProposal,
  searchSkills,
  isCanonicalShape,
  hasBracketTools,
  isSoftSkill,
  SKILL_PROPOSAL_SPEC,
} from '../storage/skill-registry.ts'
import { parseSkillsMarkdown, parseRolesMarkdown } from '../storage/knowledge-watcher.ts'
import { deriveRoleInputFromJob } from '../storage/role-derivation.ts'
import type { JobRecord } from '../ir/schema.ts'

/**
 * Skill Registry v0.3 契约测试（skill-registry-contract-v0.3.md / ADR-031）：
 * 四态判定（EXISTING / NEW_PROPOSAL→REGISTERED / REJECTED）、形态规则、soft 域分类、
 * substring 不自动绑定、Proposal ≠ Registration（provenance）、skills.md 投影 v2 闭环。
 */

function newWs(): Workspace {
  return initWorkspace(mkdtempSync(join(tmpdir(), 'cos-skr-')))
}

function seedSkills(ws: Workspace): void {
  ws.write(
    'knowledge/skills.md',
    [
      '# 技能词表',
      '',
      '## 机械结构设计',
      '- id: skill_00001',
      '- 状态: active',
      '- 提议: user',
      '- 登记: engine',
      '- 来源: 用户',
      '- 别名: 结构设计、机械结构设计方法',
      '- 3级: 独立完成结构方案',
      '',
      '## 机械工程理论',
      '- id: skill_00002',
      '- 别名: 理论力学',
      '',
    ].join('\n'),
  )
}

test('形态规则：括号工具堆叠 / 句标点 / 超 12 字 → 不合格', () => {
  assert.equal(isCanonicalShape('机械结构设计'), true)
  assert.equal(isCanonicalShape('三维 CAD'), true)
  assert.equal(hasBracketTools('三维 CAD 软件(CATIA/UG/SolidWorks/Pro/E)'), true)
  assert.equal(isCanonicalShape('三维 CAD 软件(CATIA/UG/SolidWorks/Pro/E)'), false)
  assert.equal(isCanonicalShape('设计改进落地执行'), true) // 无标点/括号 → 形态合格（语义提炼为 Agent 职责）
  assert.equal(isCanonicalShape('精通机械设计原理与理论知识'), false) // >12 字
})

test('soft 域分类：词表兜底命中 → 拒绝', () => {
  assert.equal(isSoftSkill('抗压能力'), true)
  assert.equal(isSoftSkill('主动性'), true)
  assert.equal(isSoftSkill('机械结构设计'), false)
  const ws = newWs()
  const r = resolveSkillProposal(ws, {
    source_phrase: '具备抗压能力',
    proposed_name: '抗压能力',
    evidence_source: 'JD-测试-2026-08-31',
  })
  assert.equal(r.outcome, 'rejected')
  assert.match(r.reason, /soft/)
})

test('EXISTING：band_to_id 显式绑定（存在且 active）→ existing；不存在 → rejected', () => {
  const ws = newWs()
  seedSkills(ws)
  const ok = resolveSkillProposal(ws, {
    source_phrase: '机械结构设计方法',
    proposed_name: '机械结构设计',
    binds_to_id: 'skill_00001',
    evidence_source: 'JD-测试-2026-08-31',
  })
  assert.deepEqual(ok, { outcome: 'existing', skillId: 'skill_00001', match: 'explicit-bind' })
  const bad = resolveSkillProposal(ws, {
    source_phrase: '机械结构设计方法',
    proposed_name: '机械结构设计',
    binds_to_id: 'skill_99999',
    evidence_source: 'JD-测试-2026-08-31',
  })
  assert.equal(bad.outcome, 'rejected')
  assert.match(bad.reason, /不存/)
})

test('EXISTING：exact 命中（规范名/别名）→ existing；legacy 条目（无 id）自动升级分配 id', () => {
  const ws = newWs()
  seedSkills(ws)
  const byName = resolveSkillProposal(ws, {
    source_phrase: '机械结构设计',
    proposed_name: '机械结构设计',
    evidence_source: 'JD-测试-2026-08-31',
  })
  assert.equal(byName.outcome, 'existing')
  assert.equal(byName.skillId, 'skill_00001')
  const byAlias = resolveSkillProposal(ws, {
    source_phrase: '机械结构设计方法',
    proposed_name: '机械结构设计方法',
    evidence_source: 'JD-测试-2026-08-31',
  })
  // 别名精确命中 → 无 id 时自动升级?——注意:别名命中也是 existing(exact-alias);seed 文件里别名挂在 skill_00001 上
  assert.equal(byAlias.outcome, 'existing')
  // legacy 条目(无 id)升级:重建无 id 的文件再提案
  const ws2 = newWs()
  ws2.write('knowledge/skills.md', '# 技能词表\n\n## 焊接切割工艺\n- 别名: 焊接\n')
  const up = resolveSkillProposal(ws2, {
    source_phrase: '焊接切割工艺',
    proposed_name: '焊接切割工艺',
    evidence_source: 'JD-测试-2026-08-31',
  })
  assert.equal(up.outcome, 'existing')
  assert.match(up.skillId!, /^skill_\d+$/)
  const skill = parseSkillsMarkdown(ws2.read('knowledge/skills.md'), 'skills.md').value.find((s) => s.name === '焊接切割工艺')!
  assert.equal(skill.id, up.skillId) // 升级写回投影
  assert.equal(skill.registeredBy, 'engine')
})

test('REGISTERED：词表外 + 形态合格 + 来源可溯 → 登记授权（proposed_by/registered_by 分离 + 投影出现 id）', () => {
  const ws = newWs()
  seedSkills(ws)
  const r = resolveSkillProposal(ws, {
    source_phrase: '精密装配工艺',
    proposed_name: '精密装配',
    evidence_source: 'JD-测试-2026-08-31',
    aliases: ['精密装配工艺'],
  })
  assert.equal(r.outcome, 'registered')
  assert.match(r.skillId!, /^skill_0000[3-9]$/)
  const skill = parseSkillsMarkdown(ws.read('knowledge/skills.md'), 'skills.md').value.find((s) => s.id === r.skillId)!
  assert.equal(skill.name, '精密装配')
  assert.equal(skill.proposedBy, 'agent_proposal') // Proposal 不是 Registration
  assert.equal(skill.registeredBy, 'engine')
  assert.equal(skill.source, 'JD-测试-2026-08-31')
  // 提案审计落盘（status=registered + skill_id）
  const files = ws.listMarkdown(SKILL_PROPOSAL_SPEC.dir)
  assert.equal(files.length, 1)
  assert.match(ws.read(`${SKILL_PROPOSAL_SPEC.dir}/${files[0]}`), /status: registered/)
  assert.match(ws.read(`${SKILL_PROPOSAL_SPEC.dir}/${files[0]}`), new RegExp(`skill_id: ${r.skillId}`))
})

test('REJECTED：形态不合格（括号堆叠/超长）→ 拒绝且原因含提炼要求；幂等不注册', () => {
  const ws = newWs()
  seedSkills(ws)
  const r = resolveSkillProposal(ws, {
    source_phrase: '三维 CAD 软件(CATIA/UG/SolidWorks/Pro/E)',
    proposed_name: '三维 CAD 软件(CATIA/UG/SolidWorks/Pro/E)',
    evidence_source: 'JD-测试-2026-08-31',
  })
  assert.equal(r.outcome, 'rejected')
  assert.match(r.reason, /形态不合格/)
  assert.equal(parseSkillsMarkdown(ws.read('knowledge/skills.md'), 'skills.md').value.length, 2) // 未新增条目
})

test('searchSkills：match 分级——exact-canonical / exact-alias / substring；不自动绑定由 resolve 保证', () => {
  const ws = newWs()
  seedSkills(ws)
  assert.deepEqual(searchSkills(ws, '机械结构设计'), [
    { skill_id: 'skill_00001', canonical_name: '机械结构设计', match: 'exact-canonical' },
  ])
  assert.equal(searchSkills(ws, '机械结构设计方法')[0]!.match, 'exact-alias')
  assert.equal(searchSkills(ws, '结构')[0]!.match, 'substring')
  assert.equal(searchSkills(ws, '结构')[0]!.canonical_name, '机械结构设计') // substring 候选仅展示
})

test('单通道：deriveRoleInputFromJob 编排——soft category 过滤 + 能力词登记引用 + 形态不合格跳过', () => {
  const ws = newWs()
  seedSkills(ws)
  const job: JobRecord = {
    id: '2026-08-31-测试-结构工程师',
    company: '测试公司',
    title: '结构工程师',
    location: '苏州',
    responsibilities: [
      {
        id: 'ai-1',
        statement: '结构设计',
        priority: 'must',
        capabilities: ['机械结构设计', '精密装配'],
        evidenceExpectations: [],
        source: 'ai',
        category: 'hard',
      },
      {
        id: 'ai-2',
        statement: '团队协作',
        priority: 'must',
        capabilities: ['主动性'],
        evidenceExpectations: [],
        source: 'ai',
        category: 'soft', // 域分类：不进技能矩阵
      },
    ],
    createdAt: '2026-08-31T00:00:00.000Z',
  }
  // 公司建档前置
  ws.write('companies/测试公司.md', '# 测试公司\n\n## 摘要\n\n| 字段 | 值 |\n|------|-----|\n| city | 苏州 |\n| industry | 机械 |\n')
  const input = deriveRoleInputFromJob(ws, job)!
  assert.ok(input)
  assert.equal(input.skills.length, 2) // soft 责任单元(ai-2)整组过滤
  assert.equal(input.skills[0]!.name, '机械结构设计')
  assert.equal(input.skills[0]!.skill_id, 'skill_00001') // exact 命中绑定
  assert.equal(input.skills[1]!.name, '精密装配')
  assert.match(input.skills[1]!.skill_id!, /^skill_/)
})

test('roles.md 投影 v2 + 解析闭环：skill_id｜canonical（来源；原文）', () => {
  const ws = newWs()
  ws.write(
    'knowledge/roles.md',
    '# 岗位清单（Roles）\n\n## 结构工程师（测试公司）\n\n- essential: skill_00001｜机械结构设计（来源: JD-测试-2026-08-31；原文: 机械结构设计方法）\n- nice-to-have: 精密装配（来源: JD-测试-2026-08-31）\n',
  )
  const roles = parseRolesMarkdown(ws.read('knowledge/roles.md'), 'roles.md').value
  assert.equal(roles.length, 1)
  const s = roles[0]!.skills
  assert.equal(s[0]!.skill_id, 'skill_00001')
  assert.equal(s[0]!.name, '机械结构设计')
  assert.equal(s[0]!.source_phrase, '机械结构设计方法')
  assert.equal(s[0]!.essential, true)
  assert.equal(s[1]!.skill_id, undefined) // legacy 行兼容
  assert.equal(s[1]!.name, '精密装配')
})

test('多提案幂等：同词表外名称二次提案 → 第二次 exact 命中 existing（不重复注册）', () => {
  const ws = newWs()
  seedSkills(ws)
  const r1 = resolveSkillProposal(ws, {
    source_phrase: '液压回路设计',
    proposed_name: '液压回路',
    evidence_source: 'JD-测试-2026-08-31',
  })
  assert.equal(r1.outcome, 'registered')
  const r2 = resolveSkillProposal(ws, {
    source_phrase: '液压回路设计',
    proposed_name: '液压回路',
    evidence_source: 'JD-测试-2026-08-31',
  })
  assert.equal(r2.outcome, 'existing') // 幂等绑定
  assert.equal(r2.skillId, r1.skillId)
  const count = parseSkillsMarkdown(ws.read('knowledge/skills.md'), 'skills.md').value.filter((s) => s.name === '液压回路').length
  assert.equal(count, 1)
})
