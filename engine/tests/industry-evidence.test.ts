/**
 * 行业证据模板工具（Phase 3D）测试：
 * 模板构造（确定性配方）/ 隐私 / 预算（独立会话不挤占 WebResearch）/ 缓存 /
 * 证据分桶（QueryIndustryEvidence 独立标签，不串 WebResearch）/ T1 认知面隔离 / 元数据。
 * 测试注入：fake MCP client（对齐 exa.test.ts 范式）——不真连。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { tool } from 'ai'
import type { MCPClient } from '@ai-sdk/mcp'
import type { Logger } from '../logger.ts'
import {
  buildIndustryEvidenceTool,
  buildIndustrySearchQuery,
  createExaSession,
  EXA_SESSION_BUDGET,
  INDUSTRY_EVIDENCE_TOOL_META,
  ExaConnector,
} from '../agent/tools/exa.ts'
import { KNOWN_TOOL_NAMES } from '../agent/tools/tool-assembly.ts'

const fakeLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} }

/** fake MCP client（最小面：web_search_exa 返回带 URL 文本；记录调用） */
function fakeClient(searchResult: string) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const baseTools = {
    web_search_exa: tool({
      description: 'Search the web with Exa',
      inputSchema: z.object({ query: z.string() }),
      execute: async (args: unknown): Promise<unknown> => {
        calls.push({ name: 'web_search_exa', args: (args ?? {}) as Record<string, unknown> })
        return { content: [{ type: 'text', text: searchResult }] }
      },
    }),
    web_fetch_exa: tool({
      description: 'Read webpage via Exa',
      inputSchema: z.object({ urls: z.array(z.string()) }),
      execute: async (): Promise<unknown> => ({ content: [{ type: 'text', text: '页面正文' }] }),
    }),
  }
  const client = {
    serverInfo: { name: 'exa-search-server', version: '3.2.1' },
    listTools: async () => ({
      tools: Object.entries(baseTools).map(([n, t]) => ({ name: n, description: t.description, inputSchema: t.inputSchema })),
    }),
    toolsFromDefinitions: () => baseTools,
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      const exec = (baseTools as unknown as Record<string, { execute?: (i: unknown) => Promise<unknown> }>)[name]
      if (exec === undefined || exec.execute === undefined) throw new Error(`tool not found: ${name}`)
      return exec.execute(args)
    },
    close: async () => {},
  }
  return { client: client as unknown as MCPClient, calls }
}

async function makeIndustrySession(searchResult = '检索结论 https://industry.example.com/集群', extra: Record<string, unknown> = {}) {
  const fake = fakeClient(searchResult)
  const connector = new ExaConnector({ clientFactory: async () => fake.client, logger: fakeLogger })
  await connector.connect()
  const session = createExaSession({
    connector,
    budget: 5,
    cacheTtlMs: 0,
    logger: fakeLogger,
    evidenceLabels: { web_search_exa: 'QueryIndustryEvidence', web_fetch_exa: 'WebFetch' },
    ...extra,
  } as never)
  return { connector, session, calls: fake.calls }
}

// ─── 模板（确定性配方）─────────────────────────────────────────────────────

test('buildIndustrySearchQuery：region+industry → 固定配方；空输入 → 空串（工具层转错误文本）', () => {
  const q = buildIndustrySearchQuery(' 苏州 ', ' 医疗器械 ')
  assert.ok(q.startsWith('苏州 医疗器械'), '模板含受控输入')
  assert.ok(q.includes('产业集群') && q.includes('龙头企业') && q.includes('政策文件') && q.includes('园区规划') && q.includes('就业环境'))
  assert.equal(buildIndustrySearchQuery('', '医疗器械'), '', '空区域 → 空串')
  assert.equal(buildIndustrySearchQuery('苏州', '  '), '', '空行业 → 空串')
})

// ─── 执行与证据分桶 ───────────────────────────────────────────────────────

test('执行：模板查询打到 Exa + 证据按 QueryIndustryEvidence 标签分桶（不串 WebResearch）；取即清', async () => {
  const { session, calls } = await makeIndustrySession()
  const t = buildIndustryEvidenceTool(session).QueryIndustryEvidence
  const exec = t.execute
  assert.ok(exec !== undefined)
  const out = await exec({ region: '苏州', industry: '医疗器械' }, { toolCallId: 'x', messages: [] } as never)
  assert.ok(typeof out === 'string' && out.includes('检索结论'))
  assert.ok((calls[0].args.query as string).startsWith('苏州 医疗器械'), '查询词 = 模板配方（非 Agent 自由发挥）')
  const evs = session.takeEvidence('QueryIndustryEvidence')
  assert.equal(evs.length, 1)
  assert.equal(evs[0].source, 'mcp')
  assert.equal(evs[0].provider, 'exa')
  assert.ok(evs[0].citation.includes('https://industry.example.com/集群'))
  assert.deepEqual(session.takeEvidence('WebResearch'), [], '取证不串 WebResearch 桶')
})

test('隐私红线：行业词含手机号 → 拒绝文本（不外发）', async () => {
  const { session, calls } = await makeIndustrySession()
  const t = buildIndustryEvidenceTool(session).QueryIndustryEvidence
  const phone = '13' + '812345678'
  const out = await t.execute!({ region: '苏州', industry: `器械${phone}` }, { toolCallId: 'x', messages: [] } as never)
  assert.ok(typeof out === 'string' && out.includes('隐私红线'))
  assert.equal(calls.length, 0)
})

test('空输入 → 错误文本；预算用尽 → 策略文本（不抛穿）', async () => {
  const { session } = await makeIndustrySession()
  const t = buildIndustryEvidenceTool(session).QueryIndustryEvidence
  const empty = await t.execute!({ region: ' ', industry: '医疗器械' }, { toolCallId: 'x', messages: [] } as never)
  assert.ok(typeof empty === 'string' && empty.includes('不能为空'))
  // 独立会话预算：行业会话 budget=1 → 首次消耗后第二次策略拒绝（与 WebResearch 会话互不挤占）
  const { session: tight } = await makeIndustrySession('检索结论 URL1 https://a.example.com/x', { budget: 1 } as never)
  const tightTool = buildIndustryEvidenceTool(tight).QueryIndustryEvidence
  const first = await tightTool.execute!({ region: '苏州', industry: '医疗器械' }, { toolCallId: 'x', messages: [] } as never)
  assert.ok(typeof first === 'string' && first.includes('检索结论'))
  const second = await tightTool.execute!({ region: '苏州', industry: '新能源' }, { toolCallId: 'x', messages: [] } as never)
  assert.ok(typeof second === 'string' && second.includes('已停用'), '预算用尽 → 策略文本（不抛穿循环）')
})

test('缓存：同参数命中不重复外发 + 提示', async () => {
  const { session, calls } = await makeIndustrySession('检索结论 URL1 https://a.example.com/x', { cacheTtlMs: 60_000 } as never)
  const t = buildIndustryEvidenceTool(session).QueryIndustryEvidence
  await t.execute!({ region: '苏州', industry: '医疗器械' }, { toolCallId: 'x', messages: [] } as never)
  const hit = await t.execute!({ region: '苏州', industry: '医疗器械' }, { toolCallId: 'x', messages: [] } as never)
  assert.ok(typeof hit === 'string' && hit.includes('检索缓存'))
  assert.equal(calls.length, 1, '缓存命中不再外发')
})

// ─── T1 / 元数据 / 装配 ───────────────────────────────────────────────────

test('T1 认知面隔离：QueryIndustryEvidence 描述无 Exa/MCP 标识，有权威/诚实边界', () => {
  const session = createExaSession({
    connector: new ExaConnector({ clientFactory: async () => fakeClient('x').client }),
    budget: 5,
    cacheTtlMs: 0,
    evidenceLabels: { web_search_exa: 'QueryIndustryEvidence' },
  })
  const desc = String(buildIndustryEvidenceTool(session).QueryIndustryEvidence.description)
  assert.ok(!/exa|mcp/i.test(desc), '无供应商标识（T1）')
  assert.ok(desc.includes('权威统计工具'), '诚实边界：统计口径值指引')
})

test('治理元数据保真：INDUSTRY_EVIDENCE_TOOL_META = mcp 源 / external / 预算 5 / trace exa_industry / provider exa', () => {
  assert.deepEqual(INDUSTRY_EVIDENCE_TOOL_META.QueryIndustryEvidence, {
    source: 'mcp',
    egress: 'external',
    budget: EXA_SESSION_BUDGET,
    traceScope: 'exa_industry',
    provider: 'exa',
  })
})

test('KNOWN_TOOL_NAMES 含 QueryIndustryEvidence（注册表同步，11 名）', () => {
  assert.ok(KNOWN_TOOL_NAMES.includes('QueryIndustryEvidence'))
  assert.equal(KNOWN_TOOL_NAMES.length, 11)
})
