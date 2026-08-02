/**
 * 桥接冒烟（第 3 步验收，手动运行：node tests/bridge-smoke.mjs）：
 * 临时工作区 + 临时配置 → 启动引擎 → WS 依次调用 system/init、decisions/list、pool/graph；
 * 写入决策 md → 断言收到 data.decisions.changed 事件且 decisions/list 返回该记录；
 * 再写入缺失 profile 的 2.1 决策 → 断言 list 含 invalid 标记、图谱跳过该实体；
 * 最后直接查 SQLite 投影验证 timeline 行。
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import net from 'node:net'
import Database from 'better-sqlite3'
import WebSocket from 'ws'

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..') // engine/ 根（测试文件在 tests/ 下）
const tmp = mkdtempSync(join(tmpdir(), 'career-os-bridge-'))
const wsDir = join(tmp, 'ws')
let child = null
let ws = null
let db = null

function fail(msg) {
  console.error(`❌ 冒烟失败：${msg}`)
  void cleanup(1)
}

function killChild() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve()
    const t = setTimeout(resolve, 2000)
    child.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
    child.kill()
  })
}

/** 统一收尾：关 WS → 关投影 db → 杀引擎 → 清临时目录 */
async function cleanup(exitCode) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close()
  } catch { /* 忽略 */ }
  try {
    if (db) db.close()
  } catch { /* 忽略 */ }
  await killChild()
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (err) {
    console.error(`⚠️ 临时目录清理失败（可手动删除 ${tmp}）：${err.message}`)
  }
  process.exit(exitCode)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

const port = await freePort()
const configPath = join(tmp, 'config.json')
writeFileSync(
  configPath,
  JSON.stringify(
    {
      server: { host: '127.0.0.1', port },
      paths: { workspace: wsDir, db: join(tmp, 'career.db'), skills: join(tmp, 'skills'), logs: join(tmp, 'logs') },
      watcher: { enabled: true },
    },
    null,
    2
  )
)

// ─── 启动引擎 ─────────────────────────────────────────────────────────
// process.execPath 可能是 PATH 里的 shim（无 node.exe），spawn 会 ENOENT；取 PATH 中真实 node.exe
function realNode() {
  for (const dir of (process.env.Path ?? process.env.PATH ?? '').split(';').filter(Boolean)) {
    const exe = join(dir, 'node.exe')
    if (existsSync(exe)) return exe
  }
  return process.execPath
}

child = spawn(realNode(), ['main.ts', '--config', configPath], { cwd: ENGINE_DIR })
const out = []
child.stdout.on('data', (d) => out.push(String(d)))
child.stderr.on('data', (d) => out.push(String(d)))
child.on('exit', (code) => {
  if (!ready) fail(`引擎提前退出（code=${code}）\n${out.join('')}`)
})

let ready = false
const deadline = Date.now() + 15000
while (!ready && Date.now() < deadline) {
  if (out.join('').includes('桥接服务就绪')) ready = true
  else await new Promise((r) => setTimeout(r, 100))
}
if (!ready) fail(`15s 内未就绪\n${out.join('')}`)
await new Promise((r) => setTimeout(r, 800)) // 等 chokidar 完成初始扫描（ignoreInitial），避免首写被当初始态吞掉
console.log('--- 引擎就绪 ---')

// ─── WS 客户端 ────────────────────────────────────────────────────────
ws = new WebSocket(`ws://127.0.0.1:${port}`)
const pending = new Map()
const events = []
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.event !== undefined) events.push(msg)
  else if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
await new Promise((res, rej) => {
  ws.on('open', res)
  ws.on('error', rej)
})

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = `r${Date.now()}-${Math.random().toString(36).slice(2)}`
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.code} ${m.error.message}`)) : resolve(m.result)))
    ws.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }))
  })
}

/** 等待并消费事件（避免同一事件被二次匹配） */
const waitEvent = (name, timeout = 8000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      const idx = events.findIndex((e) => e.event === name)
      if (idx >= 0) return resolve(events.splice(idx, 1)[0])
      if (Date.now() - t0 > timeout) {
        return reject(new Error(
          `超时未收到 ${name}；已收事件：${JSON.stringify(events)}` +
          `\n引擎 exitCode=${child?.exitCode} 决策文件存在=${existsSync(decisionPath)}` +
          `\n引擎日志：\n${out.join('')}`
        ))
      }
      setTimeout(tick, 100)
    }
    tick()
  })

try {
  // ─── RPC 三连 ─────────────────────────────────────────────────────────
  const init = await rpc('system/init')
  console.log('system/init →', JSON.stringify(init))
  const list1 = await rpc('decisions/list')
  console.log('decisions/list →', list1.length, '条（初始）')
  const graph1 = await rpc('pool/graph')
  console.log('pool/graph →', graph1.nodes.length, '节点 /', graph1.edges.length, '边（初始）')

// ─── 写入合法决策（v2.1 含 profile）→ 应触发 data.decisions.changed ─────
const decisionMd = `# 李明 — 转行可行性分析：非标自动化 → 机器人结构设计

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill | career-transition |
| direction | 机器人结构设计 |
| direction_match | 75% |
| direction_confidence | 中 |
| city | 苏州 |
| city_score | 8.2/10 |
| salary_feasible | true |
| risk_level | 中 |
| key_risk | 机器人传动/减速器经验为零，需3-6个月补强 |
| status | complete |
| protocol_version | 2.1 |
| profile | 李明 |

---

## 转行决策摘要

从非标自动化机械设计转向机器人本体结构设计是可行但有代价的转行路径。机械设计核心能力可直接迁移，主要差距在机器人专用知识，建议在职补强 3-6 个月后投递。
`
const decisionPath = join(wsDir, 'decisions', '2026-08-01-转行分析.md')
const profilePath = join(wsDir, 'profiles', '李明.md')
const companyPath = join(wsDir, 'companies', '苏舟智机器人.md')
writeFileSync(join(wsDir, 'decisions', 'README.txt'), 'note', 'utf8') // 非 md 文件不应触发重扫
writeFileSync(decisionPath, decisionMd, 'utf8')
writeFileSync(profilePath, '# 李明\n\n## 目标方向\n| 方向 | 匹配度 |\n|------|:--:|\n| 机器人结构设计 | 75% |\n', 'utf8')
writeFileSync(companyPath, `# 苏舟智机器人科技有限公司

## 分析摘要

| 字段 | 值 |
|------|-----|
| city | 苏州 |
| industry | 机器人 |
| match_score | 75% |
| risk_level | 中 |
| source | 产业园名录 |
| tags | 工业机器人, 精密传动 |
| contacted | 否 |
| park_id | 2 |

---

## 基本信息
- 公司名称: 苏舟智机器人科技有限公司（化名）
- 地点: 苏州工业园区
`, 'utf8')

const evt = await waitEvent('data.decisions.changed')
console.log('事件 →', evt.event)

const list2 = await rpc('decisions/list')
const rec = list2.find((d) => d.id === '2026-08-01-转行分析')
if (!rec) fail('decisions/list 未返回新写入的决策')
if (rec.validation) fail(`合法决策不应带 validation：${JSON.stringify(rec.validation)}`)
if (rec.directionMatch !== 75 || rec.cityScore !== 82) fail(`投影字段异常：${JSON.stringify(rec)}`)
console.log('decisions/list → 新记录：', JSON.stringify({ id: rec.id, title: rec.title, direction: rec.direction, city: rec.city, directionMatch: rec.directionMatch, cityScore: rec.cityScore, riskLevel: rec.riskLevel }))

// ─── decisions/chain：按人分组派生决策链 ─────────────────────────────────
const chain1 = await rpc('decisions/chain')
console.log('decisions/chain →', JSON.stringify(chain1))
if (chain1.length !== 1 || chain1[0].person !== '李明') fail('chain 应返回 1 条（李明）')
// 线性链语义：单条 career-transition 只 backfill 转行评估 completed，current 停在链首方向探索
if (chain1[0].currentStage !== '方向探索') fail(`chain currentStage 异常：${chain1[0].currentStage}`)
if (chain1[0].progressedAt !== '2026-08-01') fail(`chain progressedAt 异常：${chain1[0].progressedAt}`)
if (chain1[0].stages.length !== 6) fail('chain 应为 6 阶段')
const stage1 = chain1[0].stages.find((s) => s.stage === '转行评估')
if (!stage1 || stage1.status !== 'completed') fail('转行评估应 backfill completed')
console.log('decisions/chain → 李明：转行评估 completed、方向探索 current（进度 2026-08-01）')

// ─── companies/list：完整 CompanyRecord + 无 validation（摘要表齐全）────
const companies1 = await rpc('companies/list')
console.log('companies/list →', JSON.stringify(companies1))
const company = companies1.find((c) => c.id === '苏舟智机器人')
if (!company) fail('companies/list 未返回公司档案')
if (company.validation) fail(`合法公司不应带 validation：${JSON.stringify(company.validation)}`)
if (company.matchScore !== 75 || company.city !== '苏州' || company.contacted !== false) fail(`公司字段解析异常：${JSON.stringify(company)}`)
if (!Array.isArray(company.tags) || company.tags.length !== 2) fail(`公司 tags 解析异常：${JSON.stringify(company.tags)}`)
console.log('companies/list → 新记录：', JSON.stringify({ id: company.id, name: company.name, city: company.city, matchScore: company.matchScore, riskLevel: company.riskLevel, tags: company.tags }))

const graph2 = await rpc('pool/graph')
const byType = {}
for (const n of graph2.nodes) byType[n.type] = (byType[n.type] ?? 0) + 1
const edgeRels = {}
for (const e of graph2.edges) edgeRels[e.relation] = (edgeRels[e.relation] ?? 0) + 1
console.log('pool/graph →', graph2.nodes.length, '节点', JSON.stringify(byType), '/', graph2.edges.length, '边', JSON.stringify(edgeRels))
for (const want of ['person:李明', 'decision:2026-08-01-转行分析', 'direction:机器人结构设计', 'city:苏州', 'company:苏舟智机器人']) {
  if (!graph2.nodes.some((n) => n.id === want)) fail(`图谱缺节点 ${want}`)
}
const companyNode = graph2.nodes.find((n) => n.id === 'company:苏舟智机器人')
if (companyNode.matchScore !== 75 || companyNode.riskLevel !== 'medium') fail(`company 节点 score/risk 异常：${JSON.stringify(companyNode)}`)
const dirNode = graph2.nodes.find((n) => n.id === 'direction:机器人结构设计')
if (dirNode.matchScore !== 75) fail(`direction 节点 matchScore 异常：${JSON.stringify(dirNode)}`)
if (!graph2.edges.some((e) => e.source === 'decision:2026-08-01-转行分析' && e.target === 'city:苏州' && e.strength === 'high')) fail('city 边 strength 应为 high（cityScore=82）')
if (!graph2.edges.some((e) => e.source === 'decision:2026-08-01-转行分析' && e.target === 'direction:机器人结构设计' && e.strength === 'medium')) fail('direction 边 strength 应为 medium（directionMatch=75）')

// ─── 写入 invalid 决策（v2.1 缺 profile）→ 列表带标记、图谱跳过 ─────────
writeFileSync(join(wsDir, 'decisions', '2026-08-02-缺画像分析.md'), decisionMd.replace('| profile | 李明 |\n', '').replace('李明 — ', ''), 'utf8')
await waitEvent('data.decisions.changed')
const list3 = await rpc('decisions/list')
const bad = list3.find((d) => d.id === '2026-08-02-缺画像分析')
if (!bad) fail('invalid 决策未出现在列表（契约：decisions/list 返回全部含 validation）')
if (bad.validation?.status !== 'invalid') fail(`invalid 决策应带 validation.status=invalid：${JSON.stringify(bad.validation)}`)
const graph3 = await rpc('pool/graph')
if (graph3.nodes.some((n) => n.id === 'decision:2026-08-02-缺画像分析')) fail('invalid 决策不应出现在图谱')
console.log('invalid 决策 → list 带 invalid 标记，图谱已排除')

// ─── 写入 invalid 公司（无摘要表）→ 列表带标记、图谱跳过；chain 不受影响 ──
writeFileSync(join(wsDir, 'companies', '无摘要公司.md'), '# 无摘要公司\n\n没有摘要表\n', 'utf8')
const companies2 = await rpc('companies/list')
const badCompany = companies2.find((c) => c.id === '无摘要公司')
if (!badCompany) fail('companies/list 应返回全部公司（含 invalid）')
if (badCompany.validation?.status !== 'invalid') fail(`无摘要表公司应带 invalid 标记：${JSON.stringify(badCompany.validation)}`)
const graph4 = await rpc('pool/graph')
if (graph4.nodes.some((n) => n.id === 'company:无摘要公司')) fail('invalid 公司不应出现在图谱')
const chain2 = await rpc('decisions/chain')
if (chain2.length !== 1) fail('invalid 决策不应产生新链')
console.log('invalid 公司 → list 带 invalid 标记，图谱已排除；chain 仍 1 条')

// ─── 直接查 SQLite 投影验证 ────────────────────────────────────────────
db = new Database(join(tmp, 'career.db'))
const tl = db.prepare('SELECT id, date, type, title FROM timeline_projection ORDER BY id').all()
const vs = db.prepare('SELECT id, validation_status FROM decisions_projection ORDER BY id').all()
const persons = db.prepare('SELECT name, target_roles FROM persons_projection').all()
console.log('timeline_projection →', tl.length, '行：', JSON.stringify(tl))
console.log('decisions_projection validation_status →', JSON.stringify(vs))
console.log('persons_projection →', JSON.stringify(persons))
if (tl.length !== 2) fail('timeline 应有 2 行')
if (vs.find((v) => v.id === '2026-08-02-缺画像分析')?.validation_status !== 'invalid') fail('投影未记录 invalid 标记')
if (persons.length !== 1 || JSON.parse(persons[0].target_roles).length !== 1) fail('persons_projection 扫描异常')

// ─── 收尾 ─────────────────────────────────────────────────────────────
  console.log('\n✅ 桥接冒烟通过')
  cleanup(0)
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
