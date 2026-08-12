import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCompanyFacts } from '../runtime/company-fact-parser.ts'
import { computeCompanyAssessment, factIdOf } from '../runtime/company-assessment.ts'

/**
 * CompanyFact Parser 回归（Company Intelligence Layer v0.1，契约 §7.2）。
 * 断言：`## 公司事实` 表格 → CompanyFact[]（id 稳定）/ 缺来源 → NO_EVIDENCE / 枚举外或类型非法 →
 * degraded 不丢 / 无事实段 → [] 不 crash / 段落边界（--- / 下一个 ## / EOF）截断正确。
 */

const MD = `# Company-B 技术有限公司

## 分析摘要

| 字段 | 值 |
|------|-----|
| city | City-Z |

---

## 尽调详情

正文正文正文

---

## 公司事实

| 类型 | 内容 | 来源 | 链接 |
|------|------|------|------|
| CERTIFICATION | 国家级专精特新小巨人 | 工信部公示 | https://example.com |
| FINANCING | B 轮及以上（近 3 年） | IT桔子 | |
`

test('Case A：正常事实 → CompanyFact[]（列映射 + id 稳定）', () => {
  const p = parseCompanyFacts(MD, 'company_001')
  assert.equal(p.facts.length, 2)
  assert.equal(p.unknownRows.length, 0)
  assert.deepEqual(p.facts[0], {
    id: factIdOf('company_001', 'CERTIFICATION', '国家级专精特新小巨人'),
    type: 'CERTIFICATION',
    value: '国家级专精特新小巨人',
    evidence: { source: '工信部公示', url: 'https://example.com' },
  })
  assert.equal(p.facts[1].type, 'FINANCING')
  assert.equal(p.facts[1].evidence.source, 'IT桔子')
  assert.equal(p.facts[1].evidence.url, undefined)
})

test('Case B：缺来源 → fact 产出但评估降级 NO_EVIDENCE 不计分', () => {
  const md = MD.replace('| FINANCING | B 轮及以上（近 3 年） | IT桔子 | |', '| FINANCING | B 轮及以上（近 3 年） | | |')
  const p = parseCompanyFacts(md, 'company_001')
  assert.equal(p.facts.length, 2)
  const a = computeCompanyAssessment(p.facts)
  assert.equal(a.degradedFacts.length, 1)
  assert.equal(a.degradedFacts[0].reason, 'NO_EVIDENCE')
  assert.equal(a.signals.length, 1) // 只有专精特新计入
})

test('Case C：类型合法但内容枚举外 → UNKNOWN_VALUE 不计分（不丢）', () => {
  const md = MD.replace('| CERTIFICATION | 国家级专精特新小巨人', '| CERTIFICATION | 行业领先企业')
  const p = parseCompanyFacts(md, 'company_001')
  assert.equal(p.facts.length, 2)
  const a = computeCompanyAssessment(p.facts)
  assert.equal(a.degradedFacts.length, 1)
  assert.equal(a.degradedFacts[0].reason, 'UNKNOWN_VALUE')
  assert.equal(a.degradedFacts[0].value, '行业领先企业')
})

test('Case D：无 `## 公司事实` 段 → 空数组不 crash（旧档案兼容）', () => {
  const p = parseCompanyFacts('# 老档案\n\n## 分析摘要\n\n| 字段 | 值 |\n|---|---|\n| city | City-Z |\n', 'company_001')
  assert.deepEqual(p, { facts: [], unknownRows: [] })
})

test('类型列不在枚举 → unknownRows 保留（不静默丢），不产出 fact', () => {
  const md = MD.replace('| CERTIFICATION | 国家级专精特新小巨人', '| 评价 | 公司很好')
  const p = parseCompanyFacts(md, 'company_001')
  assert.equal(p.unknownRows.length, 1)
  assert.deepEqual(p.unknownRows[0], { type: '评价', value: '公司很好' })
  assert.equal(p.facts.length, 1) // 只有 FINANCING 行
})

test('id 稳定性：同档案两次解析同 id；不同公司 id 不同（companyId 隔离）', () => {
  const a = parseCompanyFacts(MD, 'company_001')
  const b = parseCompanyFacts(MD, 'company_001')
  assert.equal(a.facts[0].id, b.facts[0].id)
  const c = parseCompanyFacts(MD, 'company_002')
  assert.notEqual(a.facts[0].id, c.facts[0].id)
})

test('段落边界：事实段后接下一个 ## 正确截断（不吞后续段落）', () => {
  const md = MD + '\n## 尽调补充\n\n| 字段 | 值 |\n|---|---|\n| 备注 | 无 |\n'
  const p = parseCompanyFacts(md, 'company_001')
  assert.equal(p.facts.length, 2)
})

test('集成：parse → compute 全链路（含 Group 去重与评分）', () => {
  const md = `## 公司事实

| 类型 | 内容 | 来源 |
|------|------|------|
| CERTIFICATION | 国家级专精特新小巨人 | 工信部 |
| CERTIFICATION | 高新技术企业 | 官网 |
| OPPORTUNITY | 招聘活跃（近 3 个月有岗位发布） | BOSS直聘 |
`
  const p = parseCompanyFacts(md, 'company_001')
  const a = computeCompanyAssessment(p.facts)
  assert.equal(a.status, 'EVALUATED') // credibility + growth + opportunity = 3 维
  assert.equal(a.qualityScore, 65) // 50 + 专精特新10（高新被去重）+ 招聘5
  assert.equal(a.signals.length, 2)
})
