/**
 * Application RPC 闭环验证（ADR-019 Step 3：真实引擎 + 真实 WS）。
 * 验证：① create（createdBy='user'）→ PREPARING ② create createdBy='agent' 拒绝
 * ③ list 回读 ④ update-status SUBMITTED → submittedAt + displayFallback
 * ⑤ 状态跃迁校验（跳变拒绝）⑥ link-decision ⑦ delete 语义（仅 PREPARING 可删）
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import net from 'node:net'
import WebSocket from 'ws'

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(ENGINE_DIR, '..')
const FIXTURES_ROOT = join(REPO_ROOT, 'workspace', '.test-fixtures')

const tmp = join(FIXTURES_ROOT, `app-rpc-${Date.now().toString(36)}`)
const wsDir = join(tmp, 'ws')
let child = null
let ws = null

const JOB_ID = '2026-08-08-示例智造-机械设计工程师'
const RESULTS = []
function report(name, ok, detail) {
  RESULTS.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}
function fail(msg) {
  console.error(`❌ 验证失败：${msg}`)
  void cleanup(1)
}

function killChild() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve()
    const t = setTimeout(resolve, 2000)
    child.once('exit', () => { clearTimeout(t); resolve() })
    child.kill()
  })
}

async function cleanup(exitCode) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.close() } catch { /* 忽略 */ }
  await killChild()
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  catch (err) { console.error(`⚠️ 临时目录清理失败（可手动删除 ${tmp}）：${err.message}`) }
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

function realNode() {
  for (const dir of (process.env.Path ?? process.env.PATH ?? '').split(';').filter(Boolean)) {
    const exe = join(dir, 'node.exe')
    if (existsSync(exe)) return exe
  }
  return process.execPath
}

// ─── fixture workspace：person_001 + 一个 JD ───────────────────────────
mkdirSync(join(wsDir, 'persons/person_001'), { recursive: true })
mkdirSync(join(wsDir, 'jobs'), { recursive: true })
writeFileSync(join(wsDir, 'persons/person_001/manifest.md'), `---
id: person_001
name: 我
status: active
created_at: 2026-08-08
---

# Person 001 — 我
`)
writeFileSync(join(wsDir, 'jobs', `${JOB_ID}.md`), `# 机械设计工程师 — 示例智造

## 分析摘要

| 字段 | 值 |
|------|-----|
| company | 示例智造 |
| title | 机械设计工程师 |
| location | 杭州 |
| created_at | 2026-08-08 |
`)

// ─── 引擎子进程 ────────────────────────────────────────────────────────
const port = await freePort()
const configPath = join(tmp, 'config.json')
writeFileSync(
  configPath,
  JSON.stringify({
    server: { host: '127.0.0.1', port },
    paths: { workspace: wsDir, db: join(tmp, 'career.db'), skills: join(REPO_ROOT, 'skills'), logs: join(tmp, 'logs') },
    watcher: { enabled: true },
  }, null, 2),
)

child = spawn(realNode(), ['main.ts', '--config', configPath], { cwd: ENGINE_DIR })
const out = []
child.stdout.on('data', (d) => out.push(String(d)))
child.stderr.on('data', (d) => out.push(String(d)))
child.on('exit', (code) => { if (child.exitCode !== null && child.exitCode !== 0) fail(`引擎提前退出（code=${code}）\n${out.join('')}`) })

let ready = false
const deadline = Date.now() + 15000
while (!ready && Date.now() < deadline) {
  if (out.join('').includes('桥接服务就绪')) ready = true
  else await new Promise((r) => setTimeout(r, 100))
}
if (!ready) fail(`15s 内未就绪\n${out.join('')}`)
await new Promise((r) => setTimeout(r, 800))
console.log('--- 引擎就绪 ---')

ws = new WebSocket(`ws://127.0.0.1:${port}`)
const pending = new Map()
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.event !== undefined) return
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}

// ─── 验证序列 ─────────────────────────────────────────────────────────
try {
  const empty = await rpc('applications/list')
  report('① applications/list 初始为空', Array.isArray(empty) && empty.length === 0)

  const created = await rpc('applications/create', { jobId: JOB_ID, personId: 'person_001', createdBy: 'user' })
  report(
    '② applications/create（user）→ PREPARING + 系统 ID',
    created?.id?.startsWith('application_') && created.status === 'PREPARING' && created.jobId === JOB_ID,
    `${created?.id} / ${created?.status}`,
  )

  let agentRejected = false
  try {
    await rpc('applications/create', { jobId: JOB_ID, personId: 'person_001', createdBy: 'agent' })
  } catch {
    agentRejected = true
  }
  report('③ createdBy=agent 拒绝（Agent 禁止创建）', agentRejected)

  const listed = await rpc('applications/list')
  report('④ applications/list 回读 1 条', listed.length === 1 && listed[0].id === created.id)

  const submitted = await rpc('applications/update-status', { id: created.id, status: 'SUBMITTED' })
  report(
    '⑤ update-status SUBMITTED → submittedAt + displayFallback',
    submitted.status === 'SUBMITTED' && typeof submitted.submittedAt === 'string'
      && submitted.displayFallback?.company === '示例智造' && submitted.displayFallback?.position === '机械设计工程师',
    `displayFallback=${submitted.displayFallback?.company}·${submitted.displayFallback?.position}`,
  )

  let transitionRejected = false
  try {
    await rpc('applications/update-status', { id: created.id, status: 'OFFERED' })
  } catch {
    transitionRejected = true
  }
  report('⑥ 状态跃迁校验（SUBMITTED→OFFERED 跳变拒绝）', transitionRejected)

  const linked = await rpc('applications/link-decision', { id: created.id, decisionId: 'decision_20260808_00001' })
  report('⑦ link-decision 登记', linked.decisionId === 'decision_20260808_00001')

  let deleteRejected = false
  try {
    await rpc('applications/delete', { id: created.id })
  } catch {
    deleteRejected = true
  }
  report('⑧ delete 非 PREPARING 拒绝（行动历史不可删除）', deleteRejected)

  const still = await rpc('applications/list')
  report('⑨ 记录仍存在（历史保留）', still.length === 1 && still[0].id === created.id)

  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n${RESULTS.length - failed.length}/${RESULTS.length} 通过`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`  未通过：${f.name}`)
    void cleanup(1)
  }
  void cleanup(0)
} catch (err) {
  fail(err.message)
}
