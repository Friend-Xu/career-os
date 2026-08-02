import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decisionFileName, initWorkspace, WorkspaceError } from '../storage/workspace.ts'

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'cos-ws-'))
}

test('initWorkspace：创建目录树 + INDEX.md + protocol.json', () => {
  const root = tempWorkspace()
  const ws = initWorkspace(root)
  for (const sub of ['profiles', 'decisions', 'companies', 'metadata']) {
    assert.ok(existsSync(join(root, sub)), `${sub} 应存在`)
  }
  assert.ok(existsSync(ws.paths.indexFile))
  const protocol = JSON.parse(readFileSync(ws.paths.protocolFile, 'utf8'))
  assert.equal(protocol.protocol, 'career-os')
  assert.equal(protocol.version, '2.1')
  assert.ok(typeof protocol.created === 'string')
  rmSync(root, { recursive: true, force: true })
})

test('重复 init：不覆盖已有 INDEX.md / protocol.json', () => {
  const root = tempWorkspace()
  const ws = initWorkspace(root)
  ws.write('INDEX.md', '自定义索引内容')
  ws.write('metadata/protocol.json', '{"自定义": true}')
  const again = initWorkspace(root)
  assert.equal(again.read('INDEX.md'), '自定义索引内容')
  assert.equal(again.read('metadata/protocol.json'), '{"自定义": true}')
  rmSync(root, { recursive: true, force: true })
})

test('read/write/exists/listMarkdown 闭环', () => {
  const root = tempWorkspace()
  const ws = initWorkspace(root)
  ws.write('decisions/2026-08-01-测试.md', '# 测试')
  ws.write('decisions/2026-08-02-测试2.md', '# 测试2')
  assert.equal(ws.exists('decisions/2026-08-01-测试.md'), true)
  assert.equal(ws.exists('decisions/不存在的.md'), false)
  assert.equal(ws.read('decisions/2026-08-01-测试.md'), '# 测试')
  const files = ws.listMarkdown('decisions').sort()
  assert.deepEqual(files, ['2026-08-01-测试.md', '2026-08-02-测试2.md'])
  rmSync(root, { recursive: true, force: true })
})

test('read 不存在文件 → WorkspaceError', () => {
  const root = tempWorkspace()
  const ws = initWorkspace(root)
  assert.throws(() => ws.read('decisions/不存在.md'), WorkspaceError)
  rmSync(root, { recursive: true, force: true })
})

test('listMarkdown 不存在的目录 → WorkspaceError', () => {
  const root = tempWorkspace()
  const ws = initWorkspace(root)
  assert.throws(() => ws.listMarkdown('不存在目录'), WorkspaceError)
  rmSync(root, { recursive: true, force: true })
})

test('write 自动创建嵌套父目录', () => {
  const root = tempWorkspace()
  const ws = initWorkspace(root)
  ws.write('sub/deep/file.md', 'x')
  assert.ok(existsSync(join(root, 'sub', 'deep', 'file.md')))
  rmSync(root, { recursive: true, force: true })
})

test('decisionFileName：{日期}-{主题}.md', () => {
  assert.equal(decisionFileName('2026-08-01', '转行分析'), '2026-08-01-转行分析.md')
})
