/**
 * Tool Assembly Layer（Tool Runtime 第二阶段 P0）装配测试：
 * 三级交集（Stage 声明 ∩ 全局白名单 ∩ 已注册）、注册不变量、治理元数据保真。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { tool } from 'ai'
import { assembleTools, KNOWN_TOOL_NAMES, type ToolRuntimeMeta, type ToolSourceDef } from '../agent/tools/tool-assembly.ts'

function fakeTool(name: string) {
  return tool({
    description: `fake ${name}`,
    inputSchema: z.object({ q: z.string() }),
    execute: async () => 'ok',
  })
}

function src(names: string[], meta: Partial<ToolRuntimeMeta> = {}): ToolSourceDef {
  const tools: Record<string, unknown> = {}
  const m: Record<string, ToolRuntimeMeta> = {}
  for (const n of names) {
    tools[n] = fakeTool(n)
    m[n] = { source: 'builtin', egress: 'local', traceScope: 'test', ...meta }
  }
  return { tools: tools as ToolSourceDef['tools'], meta: m }
}

const BUILTIN = src(['Read', 'Write'])
const HOSTED = src(['WebSearch'], { source: 'hosted', egress: 'external', budget: 8, traceScope: 'web_search' })

test('三级交集：Stage 声明 ∩ 全局白名单 ∩ 已注册；未注册名与未声明名均排除', () => {
  const out = assembleTools({
    sources: [BUILTIN, HOSTED],
    allowedTools: ['Read', 'WebSearch', 'Ghost'],
    stageTools: ['WebSearch'],
  })
  assert.deepEqual(Object.keys(out.tools), ['WebSearch'], '只剩 Stage 声明的 WebSearch')
  assert.deepEqual(Object.keys(out.meta), ['WebSearch'])
})

test('Stage 缺省 = 继承全局白名单；白名单未注册名（Ghost）静默排除', () => {
  const out = assembleTools({ sources: [BUILTIN, HOSTED], allowedTools: ['Read', 'WebSearch', 'Ghost'] })
  assert.deepEqual(Object.keys(out.tools), ['Read', 'WebSearch'])
})

test('Stage 声明已知但当前未注册（外部工具未启用）→ 交集排除，不 throw（fail-safe）', () => {
  // stageTools 是收窄集：声明里不含 Read 会把 Read 也收掉——此用例声明 Read+WebSearch，
  // 验证"已知但未注册"只被交集排除、不影响其余声明工具
  const out = assembleTools({
    sources: [BUILTIN],
    allowedTools: ['Read', 'WebSearch'],
    stageTools: ['Read', 'WebSearch'],
  })
  assert.deepEqual(Object.keys(out.tools), ['Read'], 'WebSearch 未注册被排除，Read 照常')
})

test('Stage 声明引擎未知工具名 → fail fast（StageSpec 契约错误）', () => {
  assert.throws(
    () => assembleTools({ sources: [BUILTIN], allowedTools: ['Read'], stageTools: ['query_salary'] }),
    /引擎未知的工具：query_salary/,
  )
})

test('同名工具多 source 注册 → fail fast（注册不变量）', () => {
  assert.throws(
    () => assembleTools({ sources: [BUILTIN, src(['Read'])], allowedTools: ['Read'] }),
    /工具注册冲突：Read/,
  )
})

test('工具缺治理元数据 → fail fast（注册不变量）', () => {
  const broken = { tools: { Read: fakeTool('Read') }, meta: {} } as ToolSourceDef
  assert.throws(() => assembleTools({ sources: [broken], allowedTools: ['Read'] }), /缺少治理元数据/)
})

test('治理元数据保真：source/egress/budget/traceScope 原样透传（不进 tool schema）', () => {
  const out = assembleTools({ sources: [BUILTIN, HOSTED], allowedTools: ['Read', 'WebSearch'] })
  assert.deepEqual(out.meta.Read, { source: 'builtin', egress: 'local', traceScope: 'test' })
  assert.deepEqual(out.meta.WebSearch, { source: 'hosted', egress: 'external', budget: 8, traceScope: 'web_search' })
  // 认知面与审计面隔离：工具描述不含供应商标识（fake 描述即 name），meta 才是治理面
  assert.ok(!String(out.tools.WebSearch.description).includes('provider'))
})

test('KNOWN_TOOL_NAMES = 引擎注册表事实源（Phase 1 = 文件工具 5 + WebSearch）', () => {
  assert.deepEqual([...KNOWN_TOOL_NAMES], ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebSearch'])
})
