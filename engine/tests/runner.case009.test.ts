/**
 * Runner 测试（M3-3.3）：case009（oldSentence 与源版本不匹配——provenance break 被捕获）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBenchmarkCase } from '../benchmark/runner.ts'

const DATASET = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dataset', 'cases')

test('case009：sourceMismatch 检出——old 引用旧版本句子，与 resume_v1 不匹配', () => {
  const run = runBenchmarkCase(join(DATASET, 'case009'))
  assert.equal(run.parser.success, true)
  assert.equal(run.deterministicChecks.provenance.oldSentenceMismatch.length, 1)
  assert.equal(run.deterministicChecks.provenance.oldSentenceMismatch[0].changeId, 'change001')
  assert.equal(run.riskSignals.sourceMismatch, 1)
})
