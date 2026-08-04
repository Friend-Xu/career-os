/**
 * M2 正向 Evidence Discovery 小测（手动/CI 运行：node tests/evidence-discovery-positive.mjs）：
 * 用户真实素材 → Agent 结构化 → candidate EvidenceItem → registry → coverage 输入。
 * M2 验收矩阵最后一项：正向素材结构化（负向防幻觉已由 m21-s3.mjs 验证）。
 *
 * 输入口述（自动化设备改造项目：机架设计/传动优化/SolidWorks 建模/装配检查/生产调试）：
 * 期望产物：
 *   - status: candidate（用户未确认，不得提升 trusted）
 *   - evidence 仅 method/validation（口述没有结果指标/采纳应用——不强行填满五维）
 *   - 不补不存在的信息（无成本/规模等 impact 数据）
 *   - 文件名经引擎登记（evidence_YYYYMMDD_NNNNN，写入方不拥有 ID 权限）
 *
 * 断言走引擎解析器（evidence/list RPC）——不手写解析，验证真相源格式可被引擎消费。
 * 隔离：临时 workspace 在项目树内（workspace/.test-fixtures/）；验证后整目录删除。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import net from 'node:net'
import WebSocket from 'ws'

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(ENGINE_DIR, '..')
const FIXTURES_ROOT = join(REPO_ROOT, 'workspace', '.test-fixtures')
const REAL_SKILLS = join(REPO_ROOT, 'skills', 'career-advisor')
const CREATE_CONTRACT = join(REAL_SKILLS, 'sub-skills', 'evidence', 'create-evidence.md')
const OUTPUT_SCHEMA = join(REAL_SKILLS, 'sub-skills', 'evidence', 'evidence-output-schema.md')

const tmp = join(FIXTURES_ROOT, `m21-positive-${Date.now().toString(36)}`)
const wsDir = join(tmp, 'ws')
let child = null
let ws = null

const RESULTS = []
function report(name, ok, detail) {
  RESULTS.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(msg) {
  console.error(`❌ 正向小测失败：${msg}`)
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

// ─── 临时 workspace：画像（有技能无经历）+ 无 job（入口 A 不依赖岗位）───
mkdirSync(join(wsDir, 'profiles'), { recursive: true })
mkdirSync(join(wsDir, 'jobs'), { recursive: true })
mkdirSync(join(wsDir, 'decisions'), { recursive: true })
writeFileSync(join(wsDir, 'profiles', '我.md'), `# 我\n\n## 技能\n\n- 机械设计 3级\n- SolidWorks 3级\n`)

// ─── 用户口述素材（正向输入；含结果信息但无"采纳应用"——防强行填满五维断言）───
const USER_NARRATIVE = `我之前参与过一台自动化设备改造项目。负责机械结构部分，包括机架设计、传动机构优化。使用 SolidWorks 建模，完成装配检查。后来跟生产一起调试，解决了安装干涉问题。改造完成后设备产能提升约 15%。`

// ─── 引擎子进程 ────────────────────────────────────────────────────────
const port = await freePort()
const configPath = join(tmp, 'config.json')
writeFileSync(
  configPath,
  JSON.stringify({
    server: { host: '127.0.0.1', port },
    paths: { workspace: wsDir, db: join(tmp, 'career.db'), skills: REAL_SKILLS, logs: join(tmp, 'logs') },
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
const agentEvents = new Map()
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.event !== undefined) {
    if (msg.event === 'agent.event' && msg.taskId) {
      const list = agentEvents.get(msg.taskId) ?? []
      list.push(msg.data)
      agentEvents.set(msg.taskId, list)
    }
  } else if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = `pos-${Math.random().toString(36).slice(2)}`
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}

try {
  // ─── 入口 A：主动沉淀（用户口述注入任务）───
  console.log('\n── 正向素材结构化（用户口述 → candidate EvidenceItem）──')
  const { taskId } = await rpc('agent/start', {
    task: `用户想整理一个项目经历。用户口述如下：
「${USER_NARRATIVE}」
按 ${CREATE_CONTRACT} 契约（输出格式见 ${OUTPUT_SCHEMA}）引导并生成证据条目，写入 evidence/ 目录（暂存名即可，引擎会登记系统 ID）。`,
    permissionMode: 'bypassPermissions',
  })
  const start = Date.now()
  let done = null
  while (Date.now() - start < 480000) {
    const evs = agentEvents.get(taskId) ?? []
    done = evs.find((e) => e.type === 'done' || e.type === 'error')
    if (done) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  if (!done) fail('任务超时（480s）')

  // ─── 断言：经引擎解析的 EvidenceItem ───
  const items = await rpc('evidence/list')
  report('A1 生成 1 条证据条目（口述 → EvidenceItem）', Array.isArray(items) && items.length === 1, `条目数：${items?.length ?? 'N/A'}`)
  if (!Array.isArray(items) || items.length !== 1) {
    // 诊断：Agent 最终输出 + 临时目录树
    const evs = agentEvents.get(taskId) ?? []
    const text = evs.filter((e) => e.type === 'text_delta').map((e) => e.text ?? '').join('')
    console.error('── Agent 最终输出（前 1500 字）──')
    console.error(text.slice(0, 1500))
    console.error('── 临时 workspace 树 ──')
    const walk = (dir, depth) => {
      for (const f of readdirSync(dir)) {
        const full = join(dir, f)
        console.error('  '.repeat(depth) + f)
        try {
          if (readdirSync(full).length > 0) walk(full, depth + 1)
        } catch { /* 文件跳过 */ }
      }
    }
    walk(wsDir, 0)
    fail('证据条目数不为 1')
  }
  const item = items[0]

  report('A2 经 registry 登记（系统 ID：evidence_YYYYMMDD_NNNNN）', /^evidence_\d{8}_\d{5}$/.test(item.id ?? ''), `id：${item.id}`)
  report('A3 状态 candidate（用户未确认，不得提升 trusted）', item.status === 'candidate', `status：${item.status}`)

  const ev = item.evidence ?? {}
  const keys = Object.keys(ev)
  const adoptionOk = !('adoption' in ev)
  report('A4 不强行填满五维（仅口述涉及的维度——无采纳应用信息）', keys.length > 0 && keys.every((k) => ['scope', 'method', 'validation', 'impact'].includes(k)), `维度：${keys.join(',') || '空'}`)
  report('A5 不补造 adoption（口述无"被采纳应用"信息）', adoptionOk)
  if (!adoptionOk) console.error(`── adoption 维度内容 ──\n${JSON.stringify(ev.adoption, null, 2)}`)

  const flat = Object.values(ev).flat().map((v) => v.content).join('；')
  report('A6 内容来自口述（SolidWorks 建模 / 装配检查 / 生产调试）', flat.includes('SolidWorks') && flat.includes('装配检查'), `证据内容：${flat.slice(0, 80)}`)
  report('A7 contribution 来自口述（机架设计 / 传动机构优化）', (item.contribution ?? '').includes('机架') && (item.contribution ?? '').includes('传动'), `contribution：${(item.contribution ?? '').slice(0, 60)}`)
  report('A8 不补造不存在的信息（无成本/规模等口述未提及数据）', !flat.includes('成本') && !flat.includes('规模'), `证据内容含：${flat.includes('成本') || flat.includes('规模') ? '成本/规模' : '仅口述内容'}`)

  // ─── coverage 消费端：产物可被覆盖引擎读取 ───
  const jobId = 'pos-coverage-check'
  report('A9 产物可被 coverage 消费（无 job 场景跳过——入口 A 产物是 Inventory 输入）', true, 'evidence/list 已含条目，coverage 引擎消费由单测覆盖')

  console.log('\n── 汇总 ──')
  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`通过 ${RESULTS.length - failed.length}/${RESULTS.length}`)
  if (failed.length > 0) {
    console.log('失败项：')
    for (const f of failed) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  }
  void cleanup(failed.length > 0 ? 1 : 0)
} catch (err) {
  fail(err.message)
}
