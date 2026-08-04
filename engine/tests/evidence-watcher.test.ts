/**
 * evidence-watcher 单测：markdown 契约解析（摘要表 + 证据维度段 + frontmatter）、
 * 词表外维度过滤、枚举/必填校验、扫描闭环、登记接线。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEvidenceMarkdown, scanEvidence } from '../storage/evidence-watcher.ts'
import { registerArtifacts } from '../storage/artifact-registry.ts'
import { EVIDENCE_SPEC } from '../storage/evidence-watcher.ts'
import { initWorkspace } from '../storage/workspace.ts'

const SAMPLE_MD = `# 减速机壳体结构设计项目

## 分析摘要

| 字段 | 值 |
|------|-----|
| role | 机械结构负责人 |
| contribution | 负责机架和传动模块设计 |
| period | 2024-2025 |
| source_type | user_input |
| captured_at | 2026-08-05T10:00:00Z |
| confidence | high |
| status | candidate |

## 事件

公司新机型平台开发项目，整机重量目标比上一代降低 15%。

## 证据

### scope
- 负责机架和传动模块设计
- 负责外壳结构

### validation
- 完成样机测试
- 通过 EMC 测试

## 来源

用户口述整理
`

test('parseEvidenceMarkdown：摘要表 + 证据维度段 → EvidenceItem（多条证明数组化）', () => {
  const { value, validation } = parseEvidenceMarkdown(SAMPLE_MD, '2026-08-05-减速机项目.md')
  assert.equal(validation, undefined)
  assert.equal(value.id, '2026-08-05-减速机项目')
  assert.equal(value.event.title, '减速机壳体结构设计项目')
  assert.equal(value.event.period, '2024-2025')
  assert.ok(value.event.context!.includes('整机重量目标'))
  assert.equal(value.role, '机械结构负责人')
  assert.equal(value.contribution, '负责机架和传动模块设计')
  assert.deepEqual(value.evidence.scope, [{ content: '负责机架和传动模块设计' }, { content: '负责外壳结构' }])
  assert.deepEqual(value.evidence.validation, [{ content: '完成样机测试' }, { content: '通过 EMC 测试' }])
  assert.equal(value.source.type, 'user_input')
  assert.equal(value.source.capturedAt, '2026-08-05T10:00:00Z')
  assert.equal(value.confidence, 'high')
  assert.equal(value.status, 'candidate')
})

test('parseEvidenceMarkdown：trusted + verification 成对解析；verification 半写忽略', () => {
  const md = SAMPLE_MD.replace('| status | candidate |', '| status | trusted |\n| verification_type | user_confirmed |\n| confirmed_at | 2026-08-05 |')
  const { value } = parseEvidenceMarkdown(md, 'x.md')
  assert.deepEqual(value.verification, { type: 'user_confirmed', confirmedAt: '2026-08-05' })
  // verification_type 缺失 → 不产生 verification（不报错，可选字段）
  const half = SAMPLE_MD.replace('| status | candidate |', '| status | trusted |\n| confirmed_at | 2026-08-05 |')
  const halfParsed = parseEvidenceMarkdown(half, 'x.md')
  assert.equal(halfParsed.value.verification, undefined)
})

test('parseEvidenceMarkdown：必填缺失（role/contribution/status）→ invalid', () => {
  const md = SAMPLE_MD.replace('| role | 机械结构负责人 |', '| role | - |')
  const { validation } = parseEvidenceMarkdown(md, 'x.md')
  assert.equal(validation?.status, 'invalid')
  assert.ok(validation!.issues.some((i) => i.path === 'role' && i.severity === 'error'))
})

test('parseEvidenceMarkdown：枚举非法 → degraded（值保留标记）', () => {
  const md = SAMPLE_MD.replace('| status | candidate |', '| status | pending |')
  const { value, validation } = parseEvidenceMarkdown(md, 'x.md')
  assert.equal(validation?.status, 'degraded')
  assert.ok(validation!.issues.some((i) => i.path === 'status'))
  assert.equal(value.status, 'raw') // 非法枚举回退默认（trusted 语义不可被污染）
})

test('parseEvidenceMarkdown：词表外维度过滤（不进入 IR）', () => {
  const md = SAMPLE_MD + '\n### leadership\n- 带领团队\n'
  const { value } = parseEvidenceMarkdown(md, 'x.md')
  assert.equal(value.evidence.leadership, undefined)
  assert.ok(value.evidence.scope)
})

test('parseEvidenceMarkdown：无证据段 → 空 evidence（raw 未结构化合法）', () => {
  const md = SAMPLE_MD.split('## 证据')[0].trim()
  const { value, validation } = parseEvidenceMarkdown(md, 'x.md')
  assert.deepEqual(value.evidence, {})
  assert.equal(validation, undefined)
})

test('parseEvidenceMarkdown：登记后 frontmatter → id/created_at 取系统值', () => {
  const md = `---
id: evidence_20260805_00001
created_at: 2026-08-05
source_file: 2026-08-05-减速机项目
---

${SAMPLE_MD}`
  const { value } = parseEvidenceMarkdown(md, 'evidence_20260805_00001.md')
  assert.equal(value.id, 'evidence_20260805_00001')
  assert.equal(value.source.capturedAt, '2026-08-05T10:00:00Z')
})

test('scanEvidence + 登记接线：写暂存名 → 登记系统 ID → 扫描读回', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-ev-'))
  const ws = initWorkspace(root)
  ws.write('evidence/2026-08-05-减速机项目.md', SAMPLE_MD)
  registerArtifacts(ws, EVIDENCE_SPEC, new Date('2026-08-05T10:00:00Z'))
  assert.deepEqual(ws.listMarkdown('evidence'), ['evidence_20260805_00001.md'])
  const parsed = scanEvidence(ws)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].record.id, 'evidence_20260805_00001')
  assert.equal(parsed[0].record.event.title, '减速机壳体结构设计项目')
  assert.equal(parsed[0].validation, undefined)
  rmSync(root, { recursive: true, force: true })
})
