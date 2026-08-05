/**
 * Report Projection 测试（M3-3.4）：聚合确定性 / 二维保留 / 象限阈值 / 无总分。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBenchmarkCase } from '../benchmark/runner.ts'
import { projectCaseReport, aggregateReport, alignmentQuadrant, renderReportMarkdown, type HumanLabel } from '../benchmark/report.ts'

const DATASET = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dataset', 'cases')

const case001Label: HumanLabel = {
  changes: [
    { validity: 0.5, drift: 'minor' },
    { validity: 1, drift: 'none' },
  ],
  alignment: { usefulness: 4, riskControl: 5 },
}

test('projectCaseReport：deterministic 来自 Runner，human 聚合 deterministic', () => {
  const run = runBenchmarkCase(join(DATASET, 'case001'))
  const report = projectCaseReport(run, case001Label)
  assert.deepEqual(report.deterministic, run.riskSignals)
  assert.equal(report.human.validity.average, 0.75)
  assert.deepEqual(report.human.validity.distribution, { '1': 1, '0.5': 1, '0': 0 })
  assert.deepEqual(report.human.drift.distribution, { none: 1, minor: 1, moderate: 0, severe: 0 })
  assert.deepEqual(report.human.alignment, { usefulness: 4, riskControl: 5 })
})

test('projectCaseReport：确定性（same labels → same output）', () => {
  const a = projectCaseReport(runBenchmarkCase(join(DATASET, 'case001')), case001Label)
  const b = projectCaseReport(runBenchmarkCase(join(DATASET, 'case001')), case001Label)
  assert.deepEqual(a, b)
})

test('alignmentQuadrant：阈值冻结（≥4 高 / ≤2 低）', () => {
  assert.equal(alignmentQuadrant(5, 5), 'excellent')
  assert.equal(alignmentQuadrant(5, 1), 'dangerous')
  assert.equal(alignmentQuadrant(1, 5), 'conservative')
  assert.equal(alignmentQuadrant(1, 1), 'lowValue')
  assert.equal(alignmentQuadrant(3, 3), 'neutral')
  assert.equal(alignmentQuadrant(4, 3), 'neutral')
})

test('aggregateReport：summary 跨 case 聚合 + 无总分字段', () => {
  const c1 = projectCaseReport(runBenchmarkCase(join(DATASET, 'case008')), {
    changes: [{ validity: 0.5, drift: 'moderate' }],
    alignment: { usefulness: 4, riskControl: 2 },
  })
  const c2 = projectCaseReport(runBenchmarkCase(join(DATASET, 'case010')), {
    changes: [{ validity: 0, drift: 'severe' }],
    alignment: { usefulness: 5, riskControl: 1 },
  })
  const report = aggregateReport({
    benchmarkVersion: '0.1',
    datasetVersion: '0.1',
    runMetadata: { date: '2026-08-05' },
    cases: [c1, c2],
  })
  assert.equal(report.summary.riskSignals.invalidClaimCount, 1) // case010
  assert.equal(report.summary.riskSignals.provenanceLossCount, 1) // case008
  assert.deepEqual(report.summary.validityDistribution, { '1': 0, '0.5': 1, '0': 1 })
  assert.deepEqual(report.summary.driftDistribution, { none: 0, minor: 0, moderate: 1, severe: 1 })
  assert.deepEqual(report.summary.alignmentDistribution, { excellent: 0, dangerous: 2, conservative: 0, lowValue: 0, neutral: 0 })
  // 禁止综合分/排名
  const json = JSON.stringify(report)
  for (const banned of ['overallScore', 'qualityScore', 'rank', 'score']) {
    assert.ok(!json.includes(banned), `不应包含 ${banned}`)
  }
})

test('renderReportMarkdown：渲染含风险信号与象限', () => {
  const c1 = projectCaseReport(runBenchmarkCase(join(DATASET, 'case001')), case001Label)
  const md = renderReportMarkdown(aggregateReport({ benchmarkVersion: '0.1', datasetVersion: '0.1', runMetadata: { date: '2026-08-05' }, cases: [c1] }))
  assert.ok(md.includes('Artifact Evolution Report'))
  assert.ok(md.includes('确定性风险信号'))
  assert.ok(md.includes('优秀（高价值 + 低风险）'))
  assert.ok(md.includes('case001'))
})
