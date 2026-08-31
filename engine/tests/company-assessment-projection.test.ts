import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { parseCompanyMarkdown } from '../storage/projection.ts'
import { attachCompanyAssessments } from '../transport/websocket.ts'

/**
 * Company Assessment Projection 回归（Company Intelligence Layer v0.1，契约 §8）。
 * 断言：无事实段旧档案 → assessment null（未评估 ≠ 0 分）/ 有事实段 → 计分 /
 * matchScore 与 assessment 两字段独立并存 / assessment 不污染 markdown（纯派生，无写入）。
 */

function setup(extra?: string): ReturnType<typeof initWorkspace> {
  const root = mkdtempSync(join(tmpdir(), 'cos-ca-'))
  const ws = initWorkspace(root)
  ws.write('companies/示例公司.md', `# 示例公司

## 分析摘要

| 字段 | 值 |
|------|-----|
| city | City-Z |
| industry | 工业自动化 |
| match_score | 52% |
| risk_level | 中 |
| source | 搜索（2026-08-08） |
| tags | 专精特新 |
| contacted | 否 |

---

## 尽调详情

正文正文正文

${extra ?? ''}`)
  return ws
}

function viewOf(ws: ReturnType<typeof initWorkspace>): ReturnType<typeof parseCompanyMarkdown>['value'] {
  return parseCompanyMarkdown(ws.read('companies/示例公司.md'), '示例公司.md').value
}

test('Case A：无事实段旧档案 → assessment null（未评估 ≠ 0 分）', () => {
  const ws = setup()
  const [v] = attachCompanyAssessments(ws, [viewOf(ws)])
  assert.equal(v.assessment, null)
})

test('Case B：有事实段 → assessment 计分（EVALUATED + qualityScore）', () => {
  const ws = setup(`## 公司事实

| 类型 | 内容 | 来源 |
|------|------|------|
| CERTIFICATION | 国家级专精特新小巨人 | 工信部 |
| FINANCING | B 轮及以上（近 3 年） | IT桔子 |
| OPPORTUNITY | 招聘活跃（近 3 个月有岗位发布） | BOSS直聘 |
`)
  const [v] = attachCompanyAssessments(ws, [viewOf(ws)])
  assert.ok(v.assessment)
  assert.equal(v.assessment.status, 'EVALUATED')
  assert.equal(v.assessment.qualityScore, 75) // 50 + 专精特新10 + B轮10 + 招聘5
  assert.equal(v.assessment.signals.length, 3)
  assert.equal(v.assessment.ruleVersion, '2026-08-company-quality-v2')
})

test('Case C：matchScore 与 assessment 独立并存（两字段互不影响）', () => {
  const ws = setup(`## 公司事实

| 类型 | 内容 | 来源 |
|------|------|------|
| CERTIFICATION | 国家级专精特新小巨人 | 工信部 |
`)
  const [v] = attachCompanyAssessments(ws, [viewOf(ws)])
  assert.equal(v.matchScore, 52) // 摘要表原值不动
  assert.equal(v.assessment?.qualityScore, 60)
  assert.equal(v.assessment?.dimensions.credibility, 5)
})

test('Case D：assessment 不污染 markdown（纯派生无写入）', () => {
  const ws = setup(`## 公司事实

| 类型 | 内容 | 来源 |
|------|------|------|
| RISK | 经营异常 | 公示系统 |
`)
  const before = ws.read('companies/示例公司.md')
  const [v] = attachCompanyAssessments(ws, [viewOf(ws)])
  assert.equal(v.assessment?.dimensions.stability, -20)
  const after = ws.read('companies/示例公司.md')
  assert.equal(after, before)
})

test('事实段存在但全部无效 → INSUFFICIENT_DATA 对象（非 null，degraded 信息保留）', () => {
  const ws = setup(`## 公司事实

| 类型 | 内容 | 来源 |
|------|------|------|
| CERTIFICATION | XX 神秘资质 | 官网 |
`)
  const [v] = attachCompanyAssessments(ws, [viewOf(ws)])
  assert.ok(v.assessment)
  assert.equal(v.assessment.status, 'INSUFFICIENT_DATA')
  assert.equal(v.assessment.qualityScore, null)
  assert.equal(v.assessment.degradedFacts.length, 1)
})

test('invalid 档案（摘要表缺失）也安全评估——无事实段 → null 不 crash', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-ca2-'))
  const ws = initWorkspace(root)
  ws.write('companies/占位公司.md', '# 占位公司\n')
  const view = parseCompanyMarkdown(ws.read('companies/占位公司.md'), '占位公司.md').value
  const [v] = attachCompanyAssessments(ws, [view])
  assert.equal(v.assessment, null)
  rmSync(root, { recursive: true, force: true })
})
