import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { JobRecord, PersonSnapshot } from '../ir/schema.ts'
import { analyzeJob } from '../runtime/jd-intelligence.ts'

function job(partial: Partial<JobRecord> = {}): JobRecord {
  return {
    id: partial.id ?? 'job_001',
    company: partial.company ?? '苏舟智机器人',
    title: partial.title ?? '机器人结构工程师',
    location: partial.location,
    salary: partial.salary,
    responsibilities: partial.responsibilities ?? [
      { id: 'user-1', statement: '机器人结构设计', priority: 'must', capabilities: ['机械设计'], evidenceExpectations: [], source: 'user' },
      { id: 'user-2', statement: '减速器选型', priority: 'nice', capabilities: ['减速器设计'], evidenceExpectations: [], source: 'user' },
    ],
    createdAt: partial.createdAt ?? '2026-08-02',
  }
}

function person(partial: Partial<PersonSnapshot> = {}): PersonSnapshot {
  return {
    personId: partial.personId ?? 'person_001',
    name: partial.name ?? '我',
    status: partial.status ?? 'active',
    manifestPath: partial.manifestPath ?? 'persons/person_001/manifest.md',
    skills: partial.skills ?? [
      { skillId: 'skill_a', name: '机械设计', level: 4 },
      { skillId: 'skill_b', name: '减速器设计', level: 2 },
    ],
    skillInventoryVersion: partial.skillInventoryVersion ?? 'v2',
    preference: 'preference' in partial ? partial.preference : { salaryRange: '11-13K/月', city: '沪苏通勤圈' },
    eventCount: partial.eventCount ?? 1,
  }
}

/** knowledge 词表（Skill 结构：name + aliases；别名归一化：机械设计 ↔ 结构设计） */
const skills = [
  { name: '机械设计', aliases: ['结构设计', '非标设计'] },
  { name: '减速器设计', aliases: ['谐波减速器选型', 'RV减速器'] },
  { name: 'CAE 仿真', aliases: [] },
]

test('Compatibility 五段式 → Contract：support/gap/risk/unknowns 映射完整', () => {
  const result = analyzeJob({ job: job({ location: '苏州' }), person: person(), skills })

  assert.equal(result.type, 'jd')
  assert.equal(result.options.length, 1)
  const opt = result.options[0]!
  assert.equal(opt.candidate, '苏舟智机器人 · 机器人结构工程师')
  assert.equal(opt.status, 'candidate')
  // support：satisfied（机械设计 4 级声明）
  assert.deepEqual(opt.support, ['机械设计（声明 4 级）'])
  // gap：transferable（减速器设计有基础）+ missing（无）
  assert.deepEqual(opt.gap, ['减速器设计（有基础 2 级，需补强）'])
  // risk：苏州在沪苏通勤圈内 → 无
  assert.deepEqual(opt.risk, [])
  // unknowns：salary 未声明
  assert.deepEqual(result.unknowns, ['JD 未声明薪资（实际薪资以 offer 为准）'])
  assert.deepEqual(result.analysis, { method: '技能矩阵 vs 岗位责任 + 约束比对' })
})

test('约束比对：location 圈外 → risk；location/salary 缺失 → unknowns', () => {
  const outside = analyzeJob({ job: job({ location: '深圳' }), person: person(), skills })
  assert.deepEqual(outside.options[0]!.risk, ['工作地点 深圳 不在沪苏通勤圈（偏好：沪苏通勤圈）'])
  assert.equal(outside.unknowns.length, 1) // 仅薪资

  const bare = analyzeJob({ job: job({ location: undefined, salary: undefined }), person: person(), skills })
  assert.deepEqual(bare.options[0]!.risk, [])
  assert.deepEqual(bare.unknowns, [
    'JD 未声明工作地点（实际以录用通知为准）',
    'JD 未声明薪资（实际薪资以 offer 为准）',
  ])
})

test('不产生 user_decision：结果只有可能性空间（options/unknowns），无 selected/推荐', () => {
  const result = analyzeJob({ job: job({ location: '苏州', salary: '11-15K' }), person: person(), skills })
  assert.equal('userDecision' in result, false)
  assert.equal('conclusion' in result, false)
  assert.equal(result.options[0]!.status, 'candidate') // 恒候选——selected 只来自人
})

test('JD Decision Provenance：inputs 可反查 Person Aggregate（skill_id + version + constraint + knowledge）', () => {
  const result = analyzeJob({ job: job({ location: '苏州' }), person: person(), skills })
  assert.deepEqual(result.inputs, {
    evidenceRefs: [],
    skillRefs: [
      { id: 'skill_a', version: 'v2' },
      { id: 'skill_b', version: 'v2' },
    ],
    constraintRefs: [{ id: 'preference_constraints' }],
    knowledgeRefs: [{ id: 'job_001' }],
  })
})

test('无技能/无偏好 person：support 空 + gap 全量 + 无 constraint 引用', () => {
  const bare = person({ skills: [], preference: undefined, skillInventoryVersion: undefined })
  const result = analyzeJob({ job: job({ location: '苏州' }), person: bare, skills })
  assert.deepEqual(result.options[0]!.support, [])
  assert.deepEqual(result.options[0]!.gap, ['机械设计', '减速器设计'])
  assert.deepEqual(result.inputs.skillRefs, [])
  assert.deepEqual(result.inputs.constraintRefs, [])
})
