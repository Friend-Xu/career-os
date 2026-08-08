/**
 * Agent TaskRequest 边界校验闭环验证（ADR-020 Commit A：RPC 参数形状校验）。
 * 验证：非法 taskType / 非法 contextRefs.type（file）/ contextRefs 缺 id / 非法
 * outputTarget（application）/ 非法 trigger 被 agent/start 边界拒绝。
 * 合法路径（存在性校验 + Bundle）由 Commit B/C 验证——本脚本不触发 LLM。
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import net from 'node:net'
import WebSocket from 'ws'

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(ENGINE_DIR, '..')
const FIXTURES_ROOT = join(REPO_ROOT, 'workspace', '.test-fixtures')

const tmp = join(FIXTURES_ROOT, `agent-task-${Date.now().toString(36)}`)
const wsDir = join(tmp, 'ws')
let child = null
let ws = null

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
  const failed = RESULTS.filter((r) => !r.ok).length
  console.log(`\n${RESULTS.length - failed}/${RESULTS.length} 通过`)
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

// ─── fixture workspace：最小（person + 空 jobs）────────────────────────
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

// ─── 引擎子进程 ────────────────────────────────────────────────────────
const port = await freePort()
const configPath = join(tmp, 'config.json')
writeFileSync(configPath, JSON.stringify({
  server: { host: '127.0.0.1', port },
  paths: { workspace: wsDir, db: join(tmp, 'career.db'), skills: join(REPO_ROOT, 'skills'), logs: join(tmp, 'logs') },
  watcher: { enabled: true },
  agent: { enabled: false },
}, null, 2))

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

// ─── 验证序列（全部为边界拒绝——不触发 LLM）────────────────────────────
async function expectRejected(name, params, re) {
  try {
    await rpc('agent/start', params)
    report(name, false, '未被拒绝')
  } catch (err) {
    report(name, re.test(err.message), `拒绝：${err.message}`)
  }
}

try {
  await expectRejected(
    '① 非法 taskType 拒绝',
    { task: '分析岗位', taskType: 'write_resume_directly' },
    /taskType 非法/,
  )
  await expectRejected(
    '② 非法 contextRefs.type（file）拒绝',
    { task: '分析岗位', taskType: 'job_analysis', contextRefs: [{ type: 'file', id: 'a.md' }] },
    /contextRefs\.type 非法/,
  )
  await expectRejected(
    '③ contextRefs 缺 id 拒绝',
    { task: '分析岗位', taskType: 'job_analysis', contextRefs: [{ type: 'job' }] },
    /contextRefs\.id/,
  )
  await expectRejected(
    '④ 非法 outputTarget（application——ADR-019 禁止）拒绝',
    { task: '分析岗位', taskType: 'job_analysis', outputTarget: 'application' },
    /outputTarget 非法/,
  )
  await expectRejected(
    '⑤ 非法 trigger 拒绝',
    { task: '分析岗位', taskType: 'job_analysis', trigger: 'scheduled' },
    /trigger 应为 user_action/,
  )
} catch (err) {
  fail(`验证序列异常：${err.message}`)
}

void cleanup(0)
