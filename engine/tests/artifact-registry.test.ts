/**
 * artifact-registry 单测：通用登记机制参数化验证（decision/evidence 共用——不复制代码）。
 * 决策语义测试见 decision-registry.test.ts；本文件验证 spec 参数化（目录/前缀/透传字段/marker）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextArtifactId, registerArtifacts, splitFrontmatter, type ArtifactSpec } from '../storage/artifact-registry.ts'
import { initWorkspace } from '../storage/workspace.ts'

/** evidence spec 模拟（Step 2 正式接入；marker 暂用摘要表——evidence 文件头部复用摘要表协议） */
const EVIDENCE_SPEC: ArtifactSpec = {
  type: 'evidence',
  dir: 'evidence',
  idPrefix: 'evidence_',
  marker: /##\s*分析摘要/,
  passthroughFields: [],
}

const EVIDENCE_MD = `# 减速机壳体设计项目

## 分析摘要

| 字段 | 值 |
|------|-----|
| event | 减速机壳体设计项目 |
| role | 机械结构负责人 |
| contribution | 负责机架和传动模块设计 |
| status | candidate |
`

test('splitFrontmatter：无 frontmatter → meta 空 + body 原样', () => {
  const { meta, body } = splitFrontmatter('# 无头\n\n正文')
  assert.deepEqual(meta, {})
  assert.equal(body, '# 无头\n\n正文')
})

test('splitFrontmatter：有 frontmatter → meta 解析 + body 剥离', () => {
  const md = '---\ntype: jd-analysis\nsubject_id: 2026-08-05-某公司-工程师\n---\n# 决策\n\n正文'
  const { meta, body } = splitFrontmatter(md)
  assert.deepEqual(meta, { type: 'jd-analysis', subject_id: '2026-08-05-某公司-工程师' })
  assert.equal(body, '# 决策\n\n正文')
})

test('evidence spec：登记到独立目录 + 独立 ID 前缀 + 无透传字段', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-art-'))
  const ws = initWorkspace(root)
  const now = new Date('2026-08-05T10:00:00Z')
  ws.write('evidence/2026-08-05-减速机项目.md', EVIDENCE_MD)
  const { registered } = registerArtifacts(ws, EVIDENCE_SPEC, now)
  assert.equal(registered, 1)
  assert.deepEqual(ws.listMarkdown('evidence'), ['evidence_20260805_00001.md'])
  const md = ws.read('evidence/evidence_20260805_00001.md')
  assert.ok(md.startsWith('---\nid: evidence_20260805_00001\ncreated_at: 2026-08-05\nsource_file: 2026-08-05-减速机项目\n---\n'))
  assert.ok(md.includes('## 分析摘要'), '正文保留')
  assert.ok(!md.includes('type:'), 'evidence 无透传字段（passthroughFields=[]）')
  rmSync(root, { recursive: true, force: true })
})

test('evidence spec：与 decision 同目录前缀互不干扰（各自独立计数）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-art-'))
  const ws = initWorkspace(root)
  const now = new Date('2026-08-05T10:00:00Z')
  ws.write('decisions/decision_20260805_00001.md', '# d')
  ws.write('decisions/2026-08-05-决策.md', EVIDENCE_MD)
  ws.write('evidence/2026-08-05-项目.md', EVIDENCE_MD)
  // decision 计数只数 decisions/ 下 decision_ 前缀
  assert.equal(nextArtifactId(ws, { ...EVIDENCE_SPEC, type: 'decision', dir: 'decisions', idPrefix: 'decision_' }, now), 'decision_20260805_00002')
  // evidence 计数只数 evidence/ 下 evidence_ 前缀
  assert.equal(nextArtifactId(ws, EVIDENCE_SPEC, now), 'evidence_20260805_00001')
  rmSync(root, { recursive: true, force: true })
})

test('evidence spec：marker 不匹配（无摘要表）→ 跳过不登记', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-art-'))
  const ws = initWorkspace(root)
  ws.write('evidence/2026-08-05-随手笔记.md', '# 笔记\n\n不是资产格式\n')
  const { registered } = registerArtifacts(ws, EVIDENCE_SPEC, new Date('2026-08-05T10:00:00Z'))
  assert.equal(registered, 0)
  assert.ok(ws.exists('evidence/2026-08-05-随手笔记.md'))
  rmSync(root, { recursive: true, force: true })
})

test('evidence spec：同主题两次写入 → 两次登记不同 ID（不覆盖）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-art-'))
  const ws = initWorkspace(root)
  const now = new Date('2026-08-05T10:00:00Z')
  ws.write('evidence/2026-08-05-减速机项目.md', EVIDENCE_MD)
  registerArtifacts(ws, EVIDENCE_SPEC, now)
  ws.write('evidence/2026-08-05-减速机项目.md', EVIDENCE_MD)
  registerArtifacts(ws, EVIDENCE_SPEC, now)
  assert.deepEqual(ws.listMarkdown('evidence').sort(), ['evidence_20260805_00001.md', 'evidence_20260805_00002.md'])
  rmSync(root, { recursive: true, force: true })
})

test('M5.2 G7：删除空洞后 ID 按最大序号 +1（不复用不覆盖）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cos-art-'))
  const ws = initWorkspace(root)
  const now = new Date('2026-08-05T10:00:00Z')
  ws.write('evidence/evidence_20260805_00001.md', EVIDENCE_MD)
  ws.write('evidence/evidence_20260805_00003.md', EVIDENCE_MD) // 00002 被删（空洞）
  // 旧语义（数量+1=2）会复用 00002 并覆盖；新语义（最大序号+1）返回 00004
  assert.equal(nextArtifactId(ws, EVIDENCE_SPEC, now), 'evidence_20260805_00004')
  rmSync(root, { recursive: true, force: true })
})
