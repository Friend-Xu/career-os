/**
 * Runner 测试（M3-3.3）：case010（invalid claim detected + 格式 warning——adversarial case）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBenchmarkCase } from '../benchmark/runner.ts'

const DATASET = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dataset', 'cases')

test('case010：invalidClaim 检出——claim_99999999 不在 claims.json，且格式行保留为 warning', () => {
  const run = runBenchmarkCase(join(DATASET, 'case010'))
  assert.ok(run.deterministicChecks.references.invalidClaimRefs.includes('claim_99999999'))
  assert.equal(run.riskSignals.invalidClaim, 1)
  assert.ok(run.parser.warnings.some((w) => w.includes('claim_99999999')), '应含未解析 claim 的 warning')
  // 语义风险（幻觉/量化）不属于确定性检查——Runner 不判
  assert.equal(run.riskSignals.sourceMismatch, 0)
})
