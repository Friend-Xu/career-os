/**
 * decision-registry 单测：系统 ID 生成（当日递增/跨日重置）、登记闭环（重命名 + frontmatter）、
 * 边界（非决策格式跳过、已登记幂等）、T2 同主题重复登记不覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextDecisionId, registerDecisionIdentity, splitFrontmatter } from '../storage/decision-registry.ts'
import { initWorkspace } from '../storage/workspace.ts'

const DECISION_MD = `# 测试决策

## 分析摘要

| 字段 | 值 |
|------|-----|
| title | 测试 |
| status | complete |
`

function tempWs(): ReturnType<typeof initWorkspace> {
  const root = mkdtempSync(join(tmpdir(), 'cos-reg-'))
  return initWorkspace(root)
}

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

test('nextDecisionId：当日递增；跨日重置', () => {
  const ws = tempWs()
  const d1 = new Date('2026-08-05T10:00:00Z')
  ws.write('decisions/decision_20260805_00001.md', DECISION_MD)
  ws.write('decisions/decision_20260805_00002.md', DECISION_MD)
  assert.equal(nextDecisionId(ws, d1), 'decision_20260805_00003')
  // 旧协议文件名不占序号（只按 decision_ 前缀计数）
  ws.write('decisions/2026-08-05-旧协议-未登记.md', DECISION_MD)
  assert.equal(nextDecisionId(ws, d1), 'decision_20260805_00003')
  const d2 = new Date('2026-08-06T10:00:00Z')
  assert.equal(nextDecisionId(ws, d2), 'decision_20260806_00001')
  rmSync(ws.paths.root, { recursive: true, force: true })
})

test('registerDecisionIdentity：登记闭环（重命名 + frontmatter 注入 + 旧文件删除）', () => {
  const ws = tempWs()
  const now = new Date('2026-08-05T10:00:00Z')
  ws.write('decisions/2026-08-05-测试决策.md', DECISION_MD)
  const { registered } = registerDecisionIdentity(ws, now)
  assert.equal(registered, 1)
  const files = ws.listMarkdown('decisions')
  assert.deepEqual(files, ['decision_20260805_00001.md'])
  const md = ws.read('decisions/decision_20260805_00001.md')
  assert.ok(md.startsWith('---\nid: decision_20260805_00001\ncreated_at: 2026-08-05\nsource_file: 2026-08-05-测试决策\n---\n'))
  assert.ok(md.includes('## 分析摘要'), '正文保留')
  rmSync(ws.paths.root, { recursive: true, force: true })
})

test('registerDecisionIdentity：写入方声明的 type/subject_id/person_id 透传保留', () => {
  const ws = tempWs()
  const now = new Date('2026-08-05T10:00:00Z')
  const md = `---\ntype: jd-analysis\nsubject_id: 2026-08-05-某公司-工程师\nperson_id: person_001\n---\n${DECISION_MD}`
  ws.write('decisions/2026-08-05-JD分析-某公司.md', md)
  registerDecisionIdentity(ws, now)
  const registered = ws.read('decisions/decision_20260805_00001.md')
  assert.ok(registered.includes('type: jd-analysis'))
  assert.ok(registered.includes('subject_id: 2026-08-05-某公司-工程师'))
  assert.ok(registered.includes('person_id: person_001'), 'person_id 是系统身份字段，登记不得丢弃（ADR-013/014）')
  assert.ok(!registered.includes('type: jd-analysis\ntype:'), '不重复声明')
  rmSync(ws.paths.root, { recursive: true, force: true })
})

test('registerDecisionIdentity：非决策格式（无分析摘要）跳过，不赋予决策身份', () => {
  const ws = tempWs()
  ws.write('decisions/2026-08-05-随手笔记.md', '# 笔记\n\n不是决策格式\n')
  const { registered } = registerDecisionIdentity(ws, new Date('2026-08-05T10:00:00Z'))
  assert.equal(registered, 0)
  assert.ok(ws.exists('decisions/2026-08-05-随手笔记.md'))
  rmSync(ws.paths.root, { recursive: true, force: true })
})

test('registerDecisionIdentity：已登记文件幂等跳过；重复调用不重复登记', () => {
  const ws = tempWs()
  const now = new Date('2026-08-05T10:00:00Z')
  ws.write('decisions/2026-08-05-测试决策.md', DECISION_MD)
  registerDecisionIdentity(ws, now)
  assert.equal(registerDecisionIdentity(ws, now).registered, 0)
  assert.deepEqual(ws.listMarkdown('decisions'), ['decision_20260805_00001.md'])
  rmSync(ws.paths.root, { recursive: true, force: true })
})

test('T2 修复：同主题两次写入 → 两次登记生成不同 ID（不覆盖）', () => {
  const ws = tempWs()
  const now = new Date('2026-08-05T10:00:00Z')
  ws.write('decisions/2026-08-05-JD分析-某岗位.md', DECISION_MD)
  registerDecisionIdentity(ws, now)
  // 第二次分析：写入方写同名暂存文件（暂存名已消失，可重复写）
  ws.write('decisions/2026-08-05-JD分析-某岗位.md', DECISION_MD)
  registerDecisionIdentity(ws, now)
  const files = ws.listMarkdown('decisions').sort()
  assert.deepEqual(files, ['decision_20260805_00001.md', 'decision_20260805_00002.md'])
  rmSync(ws.paths.root, { recursive: true, force: true })
})
