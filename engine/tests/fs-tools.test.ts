import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from 'ai'
import { initWorkspace } from '../storage/workspace.ts'
import { buildFsTools, safeRelPath } from '../agent/tools/fs-tools.ts'

function tmpWorkspace() {
  return initWorkspace(mkdtempSync(join(tmpdir(), 'cos-fstools-')))
}

function setup() {
  const ws = tmpWorkspace()
  const tools = buildFsTools(ws)
  return { ws, tools }
}

/** 直调工具 execute（测试助手：execute 恒存在——buildFsTools 全部经 tool() 注册） */
async function runTool(t: Tool<any, any>, input: unknown): Promise<string> {
  assert.ok(t.execute !== undefined, '工具未注册 execute')
  return (await t.execute(input, { toolCallId: 'test', messages: [], context: {} })) as string
}

test('safeRelPath：规范化相对路径；越界拒绝（系统边界校验）', () => {
  const { ws } = setup()
  assert.equal(safeRelPath(ws, './decisions/a.md'), 'decisions/a.md')
  assert.equal(safeRelPath(ws, 'decisions\\a.md'), 'decisions/a.md')
  assert.throws(() => safeRelPath(ws, '../escape.md'), /越界/)
  assert.throws(() => safeRelPath(ws, 'a/../../b.md'), /越界/)
  assert.throws(() => safeRelPath(ws, ''), /为空/)
})

test('Read：读取存在文件；不存在返回错误文本（不抛穿）', async () => {
  const { ws, tools } = setup()
  ws.write('decisions/x.md', '内容A')
  const ok = await runTool(tools.Read, { file_path: 'decisions/x.md' })
  assert.equal(ok, '内容A')
  const missing = await runTool(tools.Read, { file_path: 'nope.md' })
  assert.match(missing, /Read 失败/)
})

test('Write：自动建父目录 + 覆盖；越界拒绝', async () => {
  const { ws, tools } = setup()
  const r1 = await runTool(tools.Write, { file_path: 'a/b/c.md', content: 'hello' })
  assert.match(r1, /已写入/)
  assert.equal(readFileSync(join(ws.paths.root, 'a', 'b', 'c.md'), 'utf8'), 'hello')
  const escape = await runTool(tools.Write, { file_path: '../../etc.md', content: 'x' })
  assert.match(escape, /Write 失败/)
})

test('Edit：唯一匹配替换；缺失/多匹配不改动并报错', async () => {
  const { ws, tools } = setup()
  ws.write('e.md', 'alpha beta alpha')
  const r1 = await runTool(tools.Edit, { file_path: 'e.md', old_string: 'beta', new_string: 'gamma' })
  assert.match(r1, /已修改/)
  assert.equal(ws.read('e.md'), 'alpha gamma alpha')
  const missing = await runTool(tools.Edit, { file_path: 'e.md', old_string: 'none', new_string: 'x' })
  assert.match(missing, /未找到 old_string/)
  assert.equal(ws.read('e.md'), 'alpha gamma alpha')
  const multi = await runTool(tools.Edit, { file_path: 'e.md', old_string: 'alpha', new_string: 'x' })
  assert.match(multi, /出现 2 次/)
  assert.equal(ws.read('e.md'), 'alpha gamma alpha')
})

test('Grep：正则命中带 file:行号:内容；非法正则报错', async () => {
  const { ws, tools } = setup()
  ws.write('g1.md', '第一行\n需要找的关键词\n第三行')
  const hit = await runTool(tools.Grep, { pattern: '关键词' })
  assert.match(hit, /g1\.md:2:/)
  const miss = await runTool(tools.Grep, { pattern: '不存在词' })
  assert.equal(miss, '无匹配')
  const bad = await runTool(tools.Grep, { pattern: '[' })
  assert.match(bad, /非法正则/)
})

test('Glob：**/*.md 匹配相对路径列表', async () => {
  const { ws, tools } = setup()
  ws.write('d1/a.md', 'x')
  ws.write('d1/d2/b.md', 'x')
  ws.write('d1/c.txt', 'x')
  const hits = await runTool(tools.Glob, { pattern: '**/*.md' })
  assert.ok(hits.includes('d1/a.md'))
  assert.ok(hits.includes('d1/d2/b.md'))
  assert.ok(!hits.includes('d1/c.txt'))
})

test('工具执行永不抛穿（返回错误文本）——对齐 CLI 工具错误语义', async () => {
  const { ws, tools } = setup()
  const r = await runTool(tools.Read, { file_path: '..\\..\\x.md' })
  assert.match(r, /Read 失败：路径越界/)
  assert.equal(ws.exists('x.md'), false)
})
