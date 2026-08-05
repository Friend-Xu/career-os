/**
 * Runner 测试（M3-3.3）：case008（merged claim detected——lineage erosion 结构性信号）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBenchmarkCase } from '../benchmark/runner.ts'

const DATASET = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dataset', 'cases')

test('case008：mergedClaims 检出被并入的 claim（子串包含）→ retention 0.5', () => {
  const claims = JSON.parse(readFileSync(join(DATASET, 'case008', 'claims.json'), 'utf8')) as { id: string }[]
  const c2 = claims[1].id // 治具設計に参加 之外的那个 claim（組立工程の改善に参加）
  const run = runBenchmarkCase(join(DATASET, 'case008'))
  assert.equal(run.parser.success, true)
  assert.ok(run.deterministicChecks.provenance.mergedClaims.includes(c2), `merged 应包含 ${c2}`)
  assert.ok(run.deterministicChecks.provenance.lostClaims.includes(c2))
  assert.equal(run.deterministicChecks.provenance.claimRetentionRate, 0.5)
  assert.equal(run.riskSignals.provenanceLoss, 1)
  assert.equal(run.riskSignals.invalidClaim, 0)
  assert.ok(run.parser.warnings.some((w) => w.includes('归属断裂')), '应含归属断裂 warning')
})

test('case008：被 change 自身命中的 claim 不计数（self 排除）', () => {
  const run = runBenchmarkCase(join(DATASET, 'case008'))
  const claims = JSON.parse(readFileSync(join(DATASET, 'case008', 'claims.json'), 'utf8')) as { id: string }[]
  assert.ok(!run.deterministicChecks.provenance.mergedClaims.includes(claims[0].id))
})
