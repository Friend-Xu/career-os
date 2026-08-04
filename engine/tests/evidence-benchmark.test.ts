/**
 * Coverage Benchmark（M2.1 S2）：5 个固定案例，纯引擎断言，不用 LLM。
 * 案例矩阵：机械 covered / 机械 partial / 软件 missing / 产品 covered / 弱 JD empty。
 * 目的：冻结 coverage 三态语义，防未来算法改动悄悄改变判定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EvidenceItem, JobRecord } from '../ir/schema.ts'
import { computeEvidenceCoverage } from '../runtime/evidence-coverage.ts'

function item(id: string, contribution: string, evidence: EvidenceItem['evidence'], status: EvidenceItem['status'] = 'candidate'): EvidenceItem {
  return {
    id,
    event: { title: id },
    role: '工程师',
    contribution,
    evidence,
    source: { type: 'user_input', capturedAt: '2026-08-05T00:00:00Z' },
    status,
  }
}

/** 岗位构造：statement + expectations（scope/method/validation 三模式） */
function job(id: string, statement: string, patterns: string[] = ['engineering_scope', 'engineering_method', 'engineering_validation']): JobRecord {
  return {
    id,
    company: '基准公司',
    title: '基准岗位',
    responsibilities: [{
      id: 'ai-1',
      statement,
      priority: 'must',
      capabilities: [],
      evidenceExpectations: patterns.map((patternId) => ({ patternId, questions: [] })),
      source: 'ai',
    }],
    createdAt: '2026-08-05',
  }
}

test('B1 机械设计 × 结构设计项目 → covered（结构/方法/验证全齐）', () => {
  const j = job('j1', '机械结构设计')
  const items = [item('e1', '负责机械结构设计，机架与传动模块', {
    scope: [{ content: '机架与传动模块' }],
    method: [{ content: 'SolidWorks 三维建模' }],
    validation: [{ content: '完成样机测试' }],
  })]
  const out = computeEvidenceCoverage(j, items)
  assert.ok(out[0].expectations.every((e) => e.status === 'covered'))
})

test('B2 机械设计 × 只有画图经历 → partial（有关联但缺验证证明）', () => {
  const j = job('j2', '机械结构设计')
  const items = [item('e1', '负责机械结构设计的图纸绘制', { scope: [{ content: '出图范围' }] })]
  const out = computeEvidenceCoverage(j, items)
  const e = out[0].expectations
  assert.equal(e[0].status, 'covered') // scope 有值
  assert.equal(e[1].status, 'partial') // method 缺
  assert.equal(e[2].status, 'partial') // validation 缺
  assert.equal(e[2].reason, 'missing_dimension')
})

test('B3 软件开发 × 无相关经历 → missing（全部 no_evidence）', () => {
  const j = job('j3', '后端服务开发', ['engineering_scope', 'engineering_validation'])
  const items = [item('e1', '机械结构设计经历', { scope: [{ content: '机架' }] })]
  const out = computeEvidenceCoverage(j, items)
  assert.ok(out[0].expectations.every((e) => e.status === 'missing'))
  assert.ok(out[0].expectations.every((e) => e.reason === 'no_evidence'))
})

test('B4 产品经理 × 用户调研经历 → covered（维度在工程词表内仍可承载产品证据）', () => {
  const j = job('j4', '产品需求定义', ['engineering_scope', 'engineering_method'])
  const items = [item('e1', '负责产品需求定义与用户调研', {
    scope: [{ content: '需求范围与优先级' }],
    method: [{ content: '用户访谈与问卷' }],
  })]
  const out = computeEvidenceCoverage(j, items)
  assert.ok(out[0].expectations.every((e) => e.status === 'covered'))
})

test('B5 弱 JD（无证据期待责任）→ empty（无覆盖输出）', () => {
  const j: JobRecord = {
    id: 'j5',
    company: '基准公司',
    title: '弱 JD',
    responsibilities: [
      { id: 'user-1', statement: '招聘机械工程师', priority: 'must', capabilities: [], evidenceExpectations: [], source: 'user' },
    ],
    createdAt: '2026-08-05',
  }
  const out = computeEvidenceCoverage(j, [item('e1', '机械结构设计', { scope: [{ content: '机架' }] })])
  assert.deepEqual(out, [])
})
