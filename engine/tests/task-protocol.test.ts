import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateTaskBudget,
  buildTaskProtocol,
  COMPANY_RESEARCH_DIMENSIONS,
  COMPANY_RESEARCH_KEYS,
} from '../agent/context/task-protocol.ts'

test('buildTaskProtocol：job_analysis 注入任务协议（提交工具/jobId/提取纪律/中文）', () => {
  const p = buildTaskProtocol('job_analysis', { jobId: '2026-08-26-Company-B-机械工程师' })
  assert.ok(p.includes('submit_jd_analysis'), '协议须声明提交工具')
  assert.ok(p.includes('2026-08-26-Company-B-机械工程师'), '协议须携带 jobId')
  assert.ok(p.includes('任职要求'), '协议须含要求源边界纪律')
  assert.ok(p.includes('反幻觉'), '协议须含反幻觉纪律')
  assert.ok(p.includes('中文'), '协议须要求中文输出')
})

test('buildTaskProtocol：company_research 注入证据充分性协议（9 维/状态机/折叠/derive/输出结构）', () => {
  const p = buildTaskProtocol('company_research', { companyId: 'Company-B-电子科技' })
  // 公司档案读取步骤 + companyId 注入
  assert.ok(p.includes('companies/'), '协议须声明公司档案读取路径')
  assert.ok(p.includes('Company-B-电子科技'), '协议须携带 companyId')
  assert.ok(!p.includes('undefined'), '未解析时不得出现 literal undefined')
  // 9 维清单（单一事实源渲染，逐键断言）
  for (const key of COMPANY_RESEARCH_KEYS) {
    assert.ok(p.includes(`- ${key}`), `协议须包含维度 ${key}`)
  }
  // 双层级状态机
  for (const s of ['RESOLVED', 'UNCERTAIN', 'CONFLICTED', 'UNCOVERED', 'GAP', 'SUFFICIENT']) {
    assert.ok(p.includes(s), `协议须包含状态 ${s}`)
  }
  // 折叠规则 / derive 判定 / 有界再查 / 预算
  assert.ok(p.includes('确定性折叠'), '协议须含折叠规则')
  assert.ok(p.includes('finalize'), '协议须含 finalize 判定')
  assert.ok(p.includes('retries'), '协议须含有界再查（retries）')
  assert.ok(p.includes('预算'), '协议须含预算纪律')
  // 输出结构
  assert.ok(p.includes('## SUFFICIENCY_STATE'), '协议须要求输出 SUFFICIENCY_STATE')
  assert.ok(p.includes('nextAction'), '协议须含 nextAction')
  assert.ok(p.includes('budget_exhausted'), '协议须含预算事实记录类型')
  // limitation 类型语义（Phase 4 真机发现：uncertainty 仅用于 UNCERTAIN 维度；限定措辞进 note）
  assert.ok(p.includes('仅当存在状态为 UNCERTAIN 的维度'), '协议须明确 uncertainty limitation 的使用条件')
  assert.ok(p.includes('不写入 limitations'), '协议须明确限定措辞不进 limitations')
  // 语义边界：不输出公司评分；档案写入经 Proposal 通道（Producer Ownership，不直接写文件）
  assert.ok(p.includes('Company Assessment 由系统计算'), '协议须明确不做公司评分')
  assert.ok(p.includes('submit_company_research'), '协议须声明公司尽调提案提交工具')
  assert.ok(p.includes('禁止用 Edit/Write 直接改档案文件'), '协议须禁止 Agent 直接写公司档案')
  // 中文输出
  assert.ok(p.includes('中文'), '协议须要求中文输出')
})

test('COMPANY_RESEARCH_KEYS/DIMENSIONS：与契约 §B 一致（9 键、关键性 4 维、通道非空）', () => {
  assert.equal(COMPANY_RESEARCH_KEYS.length, 9)
  assert.equal(COMPANY_RESEARCH_DIMENSIONS.length, 9)
  const dimKeys = COMPANY_RESEARCH_DIMENSIONS.map((d) => d.key)
  assert.deepEqual([...dimKeys].sort(), [...COMPANY_RESEARCH_KEYS].sort(), 'KEYS 与 DIMENSIONS 键集合一致')
  const critical = COMPANY_RESEARCH_DIMENSIONS.filter((d) => d.critical).map((d) => d.key).sort()
  assert.deepEqual(critical, ['career_development', 'hiring', 'risk', 'salary'], '关键维度 = 契约 §B 4 维')
  for (const d of COMPANY_RESEARCH_DIMENSIONS) {
    assert.ok(d.channels.length > 0 && d.label.length > 0, `维度 ${d.key} 须有 label 与适用通道`)
  }
})

test('buildTaskProtocol：聚合纪律/空注入边界', () => {
  assert.ok(buildTaskProtocol('interview_preparation').includes('中文'))
  assert.equal(buildTaskProtocol('explanation'), '')
  assert.equal(buildTaskProtocol(undefined), '')
})

test('aggregateTaskBudget：聚合任务 16384 档；普通过话不注入（runner 8K 默认）', () => {
  assert.equal(aggregateTaskBudget('job_analysis'), 16384)
  assert.equal(aggregateTaskBudget('company_research'), 16384)
  assert.equal(aggregateTaskBudget('interview_preparation'), 16384)
  assert.equal(aggregateTaskBudget('explanation'), undefined)
  assert.equal(aggregateTaskBudget(undefined), undefined)
})
