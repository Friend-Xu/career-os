/**
 * Runner 测试（M3-3.3）：case001（provenance OK / positive control）。
 * 读取冻结数据集（dataset/cases/case001），断言确定性输出。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBenchmarkCase } from '../benchmark/runner.ts'

const DATASET = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dataset', 'cases')

test('case001：provenance OK——引用合法、old 匹配、retention 100%、零风险信号', () => {
  const run = runBenchmarkCase(join(DATASET, 'case001'))
  assert.equal(run.caseId, 'case001')
  assert.equal(run.parser.success, true)
  assert.equal(run.parser.warnings.length, 0)
  assert.equal(run.deterministicChecks.references.invalidClaimRefs.length, 0)
  assert.equal(run.deterministicChecks.references.invalidExpectationRefs.length, 0)
  assert.equal(run.deterministicChecks.provenance.oldSentenceMismatch.length, 0)
  assert.equal(run.deterministicChecks.provenance.mergedClaims.length, 0)
  assert.equal(run.deterministicChecks.provenance.claimRetentionRate, 1)
  assert.deepEqual(run.riskSignals, { invalidClaim: 0, sourceMismatch: 0, provenanceLoss: 0 })
})

test('case001：重放一致（纯函数）——同 case 两次运行输出相等', () => {
  const a = runBenchmarkCase(join(DATASET, 'case001'))
  const b = runBenchmarkCase(join(DATASET, 'case001'))
  assert.deepEqual(a, b)
})
