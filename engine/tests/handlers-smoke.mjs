/**
 * handlers-smoke：真实 WS 端口跑全部 METHOD 的处理器冒烟（回归防线——
 * 联调曾抓到的处理器级 bug：METHOD 未注册、参数未解构、invalid 实体缺字段。
 * 本脚本断言每个 RPC 的真实返回，防止此类问题复发。
 *
 * 隔离：临时 workspace + 临时 db（不碰真实 .career-os.db/工作区），
 * 直接 import startServer（不 spawn main.ts），端口 5299。
 *
 * 运行：node tests/handlers-smoke.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { defaultConfig } from '../config.ts'
import { initWorkspace } from '../storage/workspace.ts'
import { createProjection } from '../storage/projection.ts'
import { scanDecisions } from '../storage/report-watcher.ts'
import { DecisionRuntime } from '../runtime/decision-runtime.ts'
import { startServer } from '../transport/websocket.ts'
import { METHODS } from '../transport/protocol.ts'

const PORT = 5299
const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} }

// ─── 临时 workspace + 样本（合法 + invalid 各一份，覆盖降级路径）──────────────

const root = mkdtempSync(join(tmpdir(), 'cos-handlers-smoke-'))
const ws = initWorkspace(root)
const file = (rel, content) => writeFileSync(join(root, rel), content)

file('profiles/我.md', `# 我

## 目标方向

| 方向 |
|------|
| 机器人 |
`)

file(
  'decisions/2026-08-03-方向探索.md',
  `# 我 — 方向探索：机器人方向可行性

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill | career-path |
| direction | 机器人 |
| direction_match | 85% |
| direction_confidence | 高 |
| city | City-X |
| city_score | 8.2/10 |
| salary_feasible | true |
| risk_level | 低 |
| key_risk | 转型周期长 |
| status | complete |
| protocol_version | 2.1 |
| profile | 我 |
`,
)

file(
  'decisions/2026-08-03-坏决策.md',
  `# 我 — 坏决策（缺必填）

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill | career-path |
| status | complete |
| protocol_version | 2.1 |
| profile | 我 |
`,
)

file(
  'companies/测试公司.md',
  `# 测试公司

## 分析摘要

| 字段 | 值 |
|------|-----|
| city | City-X |
| industry | 工业自动化/机器人 |
| match_score | 85% |
| risk_level | 低 |
| source | 产业园名录 |
| tags | 机器人, 自动化 |
| contacted | 否 |
| park_id | 1 |
`,
)

file(
  'companies/坏公司.md',
  `# 坏公司

无分析摘要表格，解析为 invalid。
`,
)

file(
  'decision-contexts/测试问题.md',
  `# 测试问题

## 分析摘要

| 字段 | 值 |
|------|-----|
| person | 我 |
| status | 评估中 |
| related_decisions | 2026-08-03-方向探索 |
| created_at | 2026-08-03 |

## 考虑因素

- 行业前景：机器人行业增长确定

## 结论

- 机器人（置信度：高）

## 复盘

- 结论：方向决策正确，继续推进
- 复盘日期：2026-08-03
`,
)

// ─── 启动真实桥（临时 db）────────────────────────────────────────────────

const config = {
  ...defaultConfig(),
  server: { ...defaultConfig().server, host: '127.0.0.1', port: PORT },
  paths: { ...defaultConfig().paths, workspace: root, db: join(root, '.smoke.db') },
}

const projection = createProjection({ dbPath: config.paths.db, workspace: ws, logger: silentLogger })
projection.syncFromDecisions(scanDecisions(ws))

let failed = 0
function check(name, cond, detail) {
  const ok = Boolean(cond)
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failed++
}

const server = await startServer({ config, workspace: ws, logger: silentLogger, store: projection, runtime: new DecisionRuntime() })

// ─── WS 全 METHOD 断言 ────────────────────────────────────────────────────

function rpc(ws, method) {
  return new Promise((resolve, reject) => {
    const id = `r${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 5000)
    const onMsg = (raw) => {
      const m = JSON.parse(String(raw))
      if (m.id !== id) return
      clearTimeout(timer)
      ws.off('message', onMsg)
      resolve(m)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method }))
  })
}

const client = new WebSocket(`ws://127.0.0.1:${PORT}`)
await new Promise((res, rej) => {
  client.on('open', res)
  client.on('error', rej)
})

try {
  const init = await rpc(client, METHODS.init)
  check('system/init', init.result?.protocol === 'career-os', JSON.stringify(init))

  const decisions = await rpc(client, METHODS.listDecisions)
  const badDecision = decisions.result?.find((d) => d.id === '2026-08-03-坏决策')
  check('decisions/list 2 条', decisions.result?.length === 2, `len=${decisions.result?.length}`)
  check('decisions/list invalid 标记', badDecision?.validation?.status === 'invalid', JSON.stringify(badDecision?.validation))

  const rescan = await rpc(client, METHODS.rescan)
  check('decisions/rescan', rescan.result?.count === 2, JSON.stringify(rescan))

  const history = await rpc(client, METHODS.decisionHistory)
  check('decision/history 1 人', history.result?.length === 1, `len=${history.result?.length}`)
  check('decision/history direction 组', history.result?.[0]?.groups?.find((g) => g.type === 'direction')?.decisionIds?.length === 1, JSON.stringify(history.result?.[0]?.groups))

  const contexts = await rpc(client, METHODS.contexts)
  check('contexts/list 1 聚合', contexts.result?.length === 1, `len=${contexts.result?.length}`)
  check('contexts 关联合法决策', contexts.result?.[0]?.records?.length === 1, JSON.stringify(contexts.result?.[0]?.records?.map((r) => r.id)))
  check('contexts 排除 invalid 决策', contexts.result?.[0]?.records?.every((r) => r.id !== '2026-08-03-坏决策'))
  check('contexts 段落透传', contexts.result?.[0]?.conclusion?.selected === '机器人', JSON.stringify(contexts.result?.[0]?.conclusion))
  check('contexts 复盘透传', contexts.result?.[0]?.review?.date === '2026-08-03', JSON.stringify(contexts.result?.[0]?.review))

  const companies = await rpc(client, METHODS.listCompanies)
  const badCompany = companies.result?.find((c) => c.id === '坏公司')
  check('companies/list 2 条', companies.result?.length === 2, `len=${companies.result?.length}`)
  check('companies invalid 标记', badCompany?.validation?.status === 'invalid', JSON.stringify(badCompany?.validation))
  check('companies 合法档案字段', companies.result?.find((c) => c.id === '测试公司')?.industry === '工业自动化/机器人')

  const persons = await rpc(client, METHODS.listPersons)
  check('persons/list ≥1', (persons.result?.length ?? 0) >= 1, `len=${persons.result?.length}`)

  const graph = await rpc(client, METHODS.poolGraph)
  const nodeIds = graph.result?.nodes?.map((n) => n.id) ?? []
  check('pool/graph 排除 invalid 实体', !nodeIds.includes('decision:2026-08-03-坏决策') && !nodeIds.includes('company:坏公司'), nodeIds.join(','))

  const unknown = await rpc(client, 'no/such')
  check('未知方法 method_not_found', unknown.error?.code === 'method_not_found', JSON.stringify(unknown))
} finally {
  client.close()
  server.broadcast({ event: 'smoke.done' })
  projection.close()
}

console.log(failed === 0 ? '\n结果：全部通过' : `\n结果：${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
