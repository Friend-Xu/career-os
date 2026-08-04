/**
 * T3 弱 JD 重验（Anti-Hallucination 修复后）：临时 workspace + 弱 JD + 1 次真实分析。
 * 预期：Agent 不输出岗位智能段（信息不足，正确放弃）。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import net from 'node:net'
import WebSocket from 'ws'

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(ENGINE_DIR, '..')
const tmp = join(REPO_ROOT, 'workspace', '.test-fixtures', `t3-${Date.now().toString(36)}`)
const wsDir = join(tmp, 'ws')
const REAL_SKILLS = join(REPO_ROOT, 'skills', 'career-advisor')
let child = null
let ws = null

function fail(msg) {
  console.error(`❌ T3 重验失败：${msg}`)
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
async function cleanup(code) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.close() } catch { /* 忽略 */ }
  await killChild()
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  catch (err) { console.error(`⚠️ 清理失败（可手动删 ${tmp}）：${err.message}`) }
  process.exit(code)
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
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

mkdirSync(join(wsDir, 'profiles'), { recursive: true })
mkdirSync(join(wsDir, 'jobs'), { recursive: true })
mkdirSync(join(wsDir, 'decisions'), { recursive: true })
writeFileSync(join(wsDir, 'profiles', '我.md'), `# 我\n\n## 技能\n\n- 机械设计 3级\n- SolidWorks 3级\n`)
writeFileSync(join(wsDir, 'jobs', '2026-08-05-某企业-机械工程师.md'), `# 机械工程师 — 某企业

## 分析摘要

| 字段 | 值 |
|------|-----|
| company | 某企业 |
| title | 机械工程师 |
| requirements | 机械 |
| created_at | 2026-08-05 |

---

## JD 原文

招聘机械工程师
`)

const port = await freePort()
const configPath = join(tmp, 'config.json')
writeFileSync(configPath, JSON.stringify({
  server: { host: '127.0.0.1', port },
  paths: { workspace: wsDir, db: join(tmp, 'career.db'), skills: REAL_SKILLS, logs: join(tmp, 'logs') },
  watcher: { enabled: true },
}, null, 2))

child = spawn(realNode(), ['main.ts', '--config', configPath], { cwd: ENGINE_DIR })
const out = []
child.stdout.on('data', (d) => out.push(String(d)))
child.stderr.on('data', (d) => out.push(String(d)))

let ready = false
const deadline = Date.now() + 15000
while (!ready && Date.now() < deadline) {
  if (out.join('').includes('桥接服务就绪')) ready = true
  else await new Promise((r) => setTimeout(r, 100))
}
if (!ready) fail(`15s 未就绪\n${out.join('')}`)
await new Promise((r) => setTimeout(r, 800))

ws = new WebSocket(`ws://127.0.0.1:${port}`)
const pending = new Map()
const agentEvents = []
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.event !== undefined) {
    if (msg.event === 'agent.event' && msg.taskId) agentEvents.push(msg.data)
  } else if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = `t3-${Math.random().toString(36).slice(2)}`
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}

try {
  const { taskId } = await rpc('agent/start', {
    task: '请分析岗位「某企业 · 机械工程师」的 JD：拆解核心要求（必须/加分/隐含），评估与画像的匹配度与差距，输出决策摘要表',
    permissionMode: 'bypassPermissions',
  })
  const start = Date.now()
  let done = null
  while (Date.now() - start < 480000 && !done) {
    done = agentEvents.find((e) => e.type === 'done' || e.type === 'error')
    if (!done) await new Promise((r) => setTimeout(r, 2000))
  }
  if (!done) {
    fail('任务超时')
  } else if (done.type === 'error') {
    fail(`Agent 错误：${done.error?.message ?? ''}`)
  } else {
    const md = readFileSync(join(wsDir, 'jobs', '2026-08-05-某企业-机械工程师.md'), 'utf8')
    const hasIntel = /##\s*岗位智能/.test(md)
    if (!hasIntel) {
      console.log('✅ T3 重验通过：弱 JD 未生成岗位智能段（Anti-Hallucination 生效）')
      await cleanup(0)
    } else {
      const m = md.match(/##\s*岗位智能\s*\n((?:\|[^\n]*\|\n)+)/)
      console.log(`❌ T3 重验失败：仍生成了岗位智能段：\n${m ? m[1] : '（无法解析）'}`)
      await cleanup(1)
    }
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
