/**
 * claim-watcher 单测：markdown 契约解析（摘要表 + 证据来源段 + frontmatter）、
 * 必填/枚举校验、provenance 半成品降级、登记接线。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseClaimMarkdown, scanClaims, CLAIM_SPEC } from '../storage/claim-watcher.ts'
import { registerArtifacts } from '../storage/artifact-registry.ts'
import { initWorkspace } from '../storage/workspace.ts'

const SAMPLE_MD = `# 设计能力声明

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | 负责自动化设备机械结构设计，完成机架及传动机构优化 |
| claim_type | fact |
| source | agent_generated |
| captured_at | 2026-08-05T10:00:00Z |

## 证据来源

- evidence_20260805_00001
- evidence_20260805_00002
`

test('parseClaimMarkdown：摘要表 + 证据来源段 → CareerClaim（provenance 数组化）', () => {
  const { value, validation } = parseClaimMarkdown(SAMPLE_MD, '2026-08-05-设计能力声明.md')
  assert.equal(validation, undefined)
  assert.equal(value.id, '2026-08-05-设计能力声明')
  assert.equal(value.created_at, '2026-08-05T10:00:00Z')
  assert.equal(value.statement, '负责自动化设备机械结构设计，完成机架及传动机构优化')
  assert.equal(value.claimType, 'fact')
  assert.equal(value.source, 'agent_generated')
  assert.deepEqual(value.provenance, [{ evidenceId: 'evidence_20260805_00001' }, { evidenceId: 'evidence_20260805_00002' }])
})

test('parseClaimMarkdown：claimType/source 全枚举合法', () => {
  for (const t of ['fact', 'interpretation']) {
    const md = SAMPLE_MD.replace('| claim_type | fact |', `| claim_type | ${t} |`)
    const { value, validation } = parseClaimMarkdown(md, 'x.md')
    assert.equal(value.claimType, t)
    assert.equal(validation, undefined)
  }
  for (const s of ['user_written', 'agent_generated']) {
    const md = SAMPLE_MD.replace('| source | agent_generated |', `| source | ${s} |`)
    const { value, validation } = parseClaimMarkdown(md, 'x.md')
    assert.equal(value.source, s)
    assert.equal(validation, undefined)
  }
})

test('parseClaimMarkdown：必填缺失（statement/claim_type/source）→ invalid', () => {
  const md = SAMPLE_MD.replace('| statement | 负责自动化设备机械结构设计，完成机架及传动机构优化 |', '| statement | - |')
  const { validation } = parseClaimMarkdown(md, 'x.md')
  assert.equal(validation?.status, 'invalid')
  assert.ok(validation!.issues.some((i) => i.path === 'statement' && i.severity === 'error'))
})

test('parseClaimMarkdown：枚举非法 → degraded（回退默认值）', () => {
  const md = SAMPLE_MD.replace('| claim_type | fact |', '| claim_type | strong |')
  const { value, validation } = parseClaimMarkdown(md, 'x.md')
  assert.equal(validation?.status, 'degraded')
  assert.ok(validation!.issues.some((i) => i.path === 'claim_type'))
  assert.equal(value.claimType, 'fact') // 非法枚举回退默认
})

test('parseClaimMarkdown：无证据来源 → degraded（半成品合法，canUseClaim 消费层保护）', () => {
  const md = SAMPLE_MD.split('## 证据来源')[0].trim()
  const { value, validation } = parseClaimMarkdown(md, 'x.md')
  assert.equal(validation?.status, 'degraded')
  assert.ok(validation!.issues.some((i) => i.path === 'provenance' && i.severity === 'warn'))
  assert.deepEqual(value.provenance, [])
})

test('parseClaimMarkdown：证据来源段非 evidence 行过滤（词表外不进入 IR）', () => {
  const md = SAMPLE_MD + '- 自由文本\n- evidence_20260805_00003\n'
  const { value } = parseClaimMarkdown(md, 'x.md')
  assert.deepEqual(value.provenance.map((p) => p.evidenceId), ['evidence_20260805_00001', 'evidence_20260805_00002', 'evidence_20260805_00003'])
})

test('parseClaimMarkdown：登记后 frontmatter → id/created_at 取系统值', () => {
  const md = `---
id: claim_20260805_00001
created_at: 2026-08-05
source_file: 2026-08-05-设计能力声明
---

${SAMPLE_MD}`
  const { value } = parseClaimMarkdown(md, 'claim_20260805_00001.md')
  assert.equal(value.id, 'claim_20260805_00001')
  assert.equal(value.created_at, '2026-08-05T10:00:00Z')
})

test('scanClaims + 登记接线：写暂存名 → 登记系统 ID → 扫描读回', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-claim-'))
  const ws = initWorkspace(root)
  ws.write('claims/2026-08-05-设计能力声明.md', SAMPLE_MD)
  registerArtifacts(ws, CLAIM_SPEC, new Date('2026-08-05T10:00:00Z'))
  assert.deepEqual(ws.listMarkdown('claims'), ['claim_20260805_00001.md'])
  const parsed = scanClaims(ws)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].record.id, 'claim_20260805_00001')
  assert.equal(parsed[0].record.statement, '负责自动化设备机械结构设计，完成机架及传动机构优化')
  assert.equal(parsed[0].validation, undefined)
  rmSync(root, { recursive: true, force: true })
})
