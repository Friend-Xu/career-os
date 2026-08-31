import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeCompanyAssessment, factIdOf, normalizeFacts } from '../runtime/company-assessment.ts'
import type { CompanyFact } from '../ir/schema.ts'

/**
 * Company Assessment 确定性核心回归（Company Intelligence Layer v0.1，契约 references/company-assessment-contract-v0.1.md）。
 * 断言：无事实 → INSUFFICIENT_DATA(null) / 单事实 → PARTIAL / ≥3 维 → EVALUATED /
 * 认证去重取最高级别 / 融资去重取最新最高轮 / 风险可叠加 / 缺 evidence 或枚举外 → degraded 不计分 / 纯函数确定性。
 */

const fact = (type: CompanyFact['type'], value: string, source = '来源'): CompanyFact => ({
  id: factIdOf('c_test', type, value),
  type,
  value,
  evidence: { source },
})

test('Case A：无事实 → INSUFFICIENT_DATA，qualityScore null（未知 ≠ 中等）', () => {
  const a = computeCompanyAssessment([], '2026-08-08T00:00:00Z')
  assert.equal(a.status, 'INSUFFICIENT_DATA')
  assert.equal(a.qualityScore, null)
  assert.equal(a.signals.length, 0)
  assert.deepEqual(a.dimensions, { credibility: 0, growth: 0, technology: 0, opportunity: 0, stability: 0 })
})

test('Case B：单事实 → PARTIAL，分数 = 50 + 贡献', () => {
  const a = computeCompanyAssessment([fact('CERTIFICATION', '高新技术企业')])
  assert.equal(a.status, 'PARTIAL')
  assert.equal(a.qualityScore, 55)
  assert.equal(a.dimensions.credibility, 5)
  assert.equal(a.signals.length, 1)
})

test('Case C：完整企业（4 维命中）→ EVALUATED', () => {
  const a = computeCompanyAssessment([
    fact('CERTIFICATION', '国家级专精特新小巨人'),
    fact('FINANCING', 'B 轮及以上（近 3 年）'),
    fact('OPPORTUNITY', '招聘活跃（近 3 个月有岗位发布）'),
    fact('PATENT', '核心专利（产品/工艺相关）'),
  ])
  assert.equal(a.status, 'EVALUATED')
  assert.equal(a.qualityScore, 80) // 50 + cred5 + growth15 + tech5 + opp5
  assert.deepEqual(a.dimensions, { credibility: 5, growth: 15, technology: 5, opportunity: 5, stability: 0 })
  assert.equal(a.signals.length, 4)
  assert.equal(a.version, 'v0.1')
  assert.equal(a.ruleVersion, '2026-08-company-quality-v2')
})

test('Case C2：GROWTH 营收增长（近 1 年）→ growth +5（契约 §3/§4 自洽——规则表补遗漏）', () => {
  const a = computeCompanyAssessment([fact('GROWTH', '营收增长（近 1 年）')])
  assert.equal(a.status, 'PARTIAL')
  assert.equal(a.qualityScore, 55) // 50 + growth 5
  assert.equal(a.dimensions.growth, 5)
  assert.equal(a.signals.length, 1)
})

test('Case D：认证去重——国家级覆盖高新技术企业（不叠加）', () => {
  const a = computeCompanyAssessment([
    fact('CERTIFICATION', '国家级专精特新小巨人'),
    fact('CERTIFICATION', '高新技术企业'),
  ])
  assert.equal(a.signals.length, 1)
  assert.equal(a.signals[0].value, '国家级专精特新小巨人')
  assert.equal(a.dimensions.credibility, 5)
  assert.equal(a.dimensions.growth, 5)
  assert.equal(a.qualityScore, 60) // 50 + 10，不是 50 + 15
})

test('Case E：融资去重——B 轮覆盖 A 轮（取最新最高轮）', () => {
  const a = computeCompanyAssessment([
    fact('FINANCING', 'A 轮（近 3 年）'),
    fact('FINANCING', 'B 轮及以上（近 3 年）'),
  ])
  assert.equal(a.signals.length, 1)
  assert.equal(a.signals[0].value, 'B 轮及以上（近 3 年）')
  assert.equal(a.dimensions.growth, 10)
  assert.equal(a.qualityScore, 60)
})

test('Case F：风险累加——经营异常 + 失信叠加（-20 + -30）', () => {
  const a = computeCompanyAssessment([
    fact('RISK', '经营异常'),
    fact('RISK', '失信 / 被执行人'),
  ])
  assert.equal(a.signals.length, 2)
  assert.equal(a.dimensions.stability, -50)
  assert.equal(a.qualityScore, 0) // clamp(50 - 50, 0, 100)
})

test('Case G：缺 evidence → degraded 不计分（NO_EVIDENCE）', () => {
  const a = computeCompanyAssessment([
    { id: factIdOf('c_test', 'CERTIFICATION', '国家级专精特新小巨人'), type: 'CERTIFICATION', value: '国家级专精特新小巨人', evidence: { source: '' } },
  ])
  assert.equal(a.status, 'INSUFFICIENT_DATA')
  assert.equal(a.qualityScore, null)
  assert.equal(a.signals.length, 0)
  assert.equal(a.degradedFacts.length, 1)
  assert.equal(a.degradedFacts[0].reason, 'NO_EVIDENCE')
})

test('枚举外 value → degraded 不计分（UNKNOWN_VALUE），不影响其他事实', () => {
  const a = computeCompanyAssessment([
    fact('CERTIFICATION', 'XX 神秘资质'),
    fact('OPPORTUNITY', '招聘活跃（近 3 个月有岗位发布）'),
  ])
  assert.equal(a.degradedFacts.length, 1)
  assert.equal(a.degradedFacts[0].reason, 'UNKNOWN_VALUE')
  assert.equal(a.status, 'PARTIAL')
  assert.equal(a.qualityScore, 55) // 只有招聘活跃计入
  assert.equal(a.signals.length, 1)
})

test('重复事实（同 type+value）去重', () => {
  const a = computeCompanyAssessment([
    fact('OPPORTUNITY', '招聘活跃（近 3 个月有岗位发布）'),
    fact('OPPORTUNITY', '招聘活跃（近 3 个月有岗位发布）'),
  ])
  assert.equal(a.signals.length, 1)
  assert.equal(a.degradedFacts.length, 0)
})

test('信号引用 factId 不复制事实（evidence 引用）', () => {
  const raw = [fact('FINANCING', 'B 轮及以上（近 3 年）', 'IT桔子')]
  const a = computeCompanyAssessment(raw)
  assert.match(a.signals[0].factId, /^fact:/)
  assert.equal(a.signals[0].evidence.source, 'IT桔子')
  // factId 确定性：同输入同 id
  const b = computeCompanyAssessment(raw)
  assert.equal(a.signals[0].factId, b.signals[0].factId)
})

test('纯函数确定性：同输入两次计算输出完全一致', () => {
  const raw = [
    fact('CERTIFICATION', '国家级专精特新小巨人'),
    fact('FINANCING', 'B 轮及以上（近 3 年）'),
    fact('RISK', '经营异常'),
  ]
  assert.deepEqual(computeCompanyAssessment(raw), computeCompanyAssessment(raw))
})

test('normalizeFacts：factId 稳定 + 排序稳定', () => {
  const n = normalizeFacts([fact('PATENT', '核心专利（产品/工艺相关）'), fact('RISK', '经营异常')])
  assert.equal(n.length, 2)
  assert.equal(n[0].degraded, false)
  assert.match(n[0].fact.id, /^fact:[0-9a-f]{8}$/)
  assert.equal(n[1].fact.id, factIdOf('c_test', 'RISK', '经营异常'))
})
