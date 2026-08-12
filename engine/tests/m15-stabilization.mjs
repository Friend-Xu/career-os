/**
 * M1.5 Stabilization 冒烟（手动/CI 运行：node tests/m15-stabilization.mjs）：
 * 验证 Evidence Pattern Registry + 岗位智能表抽象是否脱离机械领域泛化。
 *
 * 测试矩阵：
 *  - T1-A 软件岗（后端开发工程师）→ Registry 能否自然承载（impact/method/validation/scope）
 *  - T1-B 非技术岗（产品经理）   → 是否避免机械语言污染
 *  - T3 弱 JD（"招聘机械工程师"）  → Anti-Hallucination：不生成幻觉责任
 *  - T2 重复分析（T1-A 二次）     → decisions 追加不覆盖 + 岗位智能更新
 *
 * 验收指标：Q1 领域污染 / Q2 空泛责任 / Q3 证据期望仍是"候选人要证明什么"
 *
 * 隔离：临时 workspace 在项目树内（workspace/.test-fixtures/m15-*）——Agent cwd 必须
 * 在项目树内才能访问 skills/ 加载 jd-analysis 双输出指令；验证后整目录删除。
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

const tmp = join(FIXTURES_ROOT, `m15-${Date.now().toString(36)}`)
const wsDir = join(tmp, 'ws')
let child = null
let ws = null

const RESULTS = []
function report(name, ok, detail) {
  RESULTS.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(msg) {
  console.error(`❌ M1.5 失败：${msg}`)
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

/** 岗位智能段提取（独立断言层，不复用引擎解析器——验证真相源格式） */
function extractJobIntelligence(md) {
  const m = md.match(/##\s*岗位智能\s*\n((?:\|[^\n]*\|\n)+)/)
  if (!m) return null
  return m[1].split('\n').filter((l) => l.trim().startsWith('|') && !/^\|[\s\-|]+\|$/.test(l) && !l.includes('Responsibility'))
}

// ─── 临时 workspace 数据 ────────────────────────────────────────────────
mkdirSync(join(wsDir, 'profiles'), { recursive: true })
mkdirSync(join(wsDir, 'jobs'), { recursive: true })
mkdirSync(join(wsDir, 'decisions'), { recursive: true })
writeFileSync(join(wsDir, 'profiles', '我.md'), `# 我\n\n## 技能\n\n- 机械设计 3级\n- SolidWorks 3级\n- Go 3级\n`)

const JD_T1A = `# 后端开发工程师 — 凌云网络

## 分析摘要

| 字段 | 值 |
|------|-----|
| company | 凌云网络 |
| title | 后端开发工程师 |
| location | City-Z |
| salary | 25-40K |
| requirements | Go;分布式系统;Redis |
| created_at | 2026-08-05 |

---

## JD 原文

负责服务端架构设计与核心服务开发，优化系统性能与稳定性，主导技术方案评审；要求 3 年以上后端经验，熟悉分布式系统与高并发场景。
`
const JD_T1B = `# 产品经理 — 橙意科技

## 分析摘要

| 字段 | 值 |
|------|-----|
| company | 橙意科技 |
| title | 产品经理 |
| location | City-Y |
| salary | 20-35K |
| requirements | 产品规划;需求分析;数据分析 |
| created_at | 2026-08-05 |

---

## JD 原文

负责产品规划与路线图制定，推动需求落地与迭代交付，协调研发与运营资源；要求具备用户调研与数据分析能力，对增长指标负责。
`
const JD_T3 = `# 机械工程师 — 某企业

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
`
writeFileSync(join(wsDir, 'jobs', '2026-08-05-凌云网络-后端开发工程师.md'), JD_T1A)
writeFileSync(join(wsDir, 'jobs', '2026-08-05-橙意科技-产品经理.md'), JD_T1B)
writeFileSync(join(wsDir, 'jobs', '2026-08-05-某企业-机械工程师.md'), JD_T3)

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
const agentEvents = new Map() // taskId → AgentRuntimeEvent[]
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
    const id = `m15-${Math.random().toString(36).slice(2)}`
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/** 跑一次完整分析（模拟 UI「分析 JD」按钮 prompt，不额外提示岗位智能表——验证 skill 双输出指令可达性） */
async function runAnalysis(company, title, timeoutMs = 480000) {
  const { taskId } = await rpc('agent/start', {
    task: `请分析岗位「${company} · ${title}」的 JD：拆解核心要求（必须/加分/隐含），评估与画像的匹配度与差距，输出决策摘要表`,
    permissionMode: 'bypassPermissions',
  })
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const evs = agentEvents.get(taskId) ?? []
    const done = evs.find((e) => e.type === 'done' || e.type === 'error')
    if (done) return done
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`任务超时（${timeoutMs / 1000}s）：${company} · ${title}`)
}

// ─── 机械语言污染词表（Q1 断言用）───
const MECH_TERMS = ['结构设计', 'SolidWorks', '公差', '模具', '机械设计', '设计模块', '验证设计', 'CAD', '加工']

try {
  // ─── T1-A：软件岗（跑两次 = T2 重复分析）───
  console.log('\n── T1-A 软件岗（含 T2 重复分析）──')
  await runAnalysis('凌云网络', '后端开发工程师')
  await runAnalysis('凌云网络', '后端开发工程师')
  const t1aMd = readFileSync(join(wsDir, 'jobs', '2026-08-05-凌云网络-后端开发工程师.md'), 'utf8')
  const t1aRows = extractJobIntelligence(t1aMd)
  if (!t1aRows) {
    report('T1-A 岗位智能段生成', false, 'Agent 未写出 `## 岗位智能` 段——skill 双输出指令未生效')
  } else {
    report('T1-A 岗位智能段生成', true, `${t1aRows.length} 行责任单元`)
    const joined = t1aRows.join('\n')
    const mech = MECH_TERMS.filter((t) => joined.includes(t))
    report('T1-A Q1 无机械语言污染', mech.length === 0, mech.length > 0 ? `污染词：${mech.join('/')}` : '')
    const dims = joined.match(/\b(scope|method|validation|impact|adoption)\b/g) ?? []
    const need = ['impact', 'method', 'validation']
    const missing = need.filter((d) => !dims.includes(d))
    report('T1-A Registry 泛化（impact/method/validation 覆盖）', missing.length === 0, missing.length > 0 ? `缺：${missing.join('/')}` : `含 ${dims.join(',')}`)
    const empty = t1aRows.filter((r) => /负责相关工作|完成领导安排|其他事务|日常支持/.test(r))
    report('T1-A Q2 无空泛责任', empty.length === 0)
  }
  const decs = readdirSync(join(wsDir, 'decisions')).filter((f) => f.endsWith('.md'))
  report('T2 decisions 追加不覆盖（两次分析 ≥ 2 条决策）', decs.length >= 2, `${decs.length} 条`)

  // ─── T1-B：产品岗 ───
  console.log('\n── T1-B 非技术岗（产品经理）──')
  await runAnalysis('橙意科技', '产品经理')
  const t1bMd = readFileSync(join(wsDir, 'jobs', '2026-08-05-橙意科技-产品经理.md'), 'utf8')
  const t1bRows = extractJobIntelligence(t1bMd)
  if (!t1bRows) {
    report('T1-B 岗位智能段生成', false, 'Agent 未写出岗位智能段')
  } else {
    report('T1-B 岗位智能段生成', true, `${t1bRows.length} 行责任单元`)
    const joined = t1bRows.join('\n')
    const mech = MECH_TERMS.filter((t) => joined.includes(t))
    report('T1-B Q1 无机械语言污染', mech.length === 0, mech.length > 0 ? `污染词：${mech.join('/')}` : '')
    const dims = joined.match(/\b(scope|method|validation|impact|adoption)\b/g) ?? []
    report('T1-B Q3 证据期望是"候选人证明什么"', /(你|负责|如何|什么|用户|指标|结果)/.test(joined) && dims.length > 0, dims.length > 0 ? `含 ${dims.join(',')}` : '无 pattern')
    const empty = t1bRows.filter((r) => /负责相关工作|完成领导安排|其他事务|日常支持/.test(r))
    report('T1-B Q2 无空泛责任', empty.length === 0)
  }

  // ─── T3：弱 JD（Anti-Hallucination）───
  console.log('\n── T3 弱 JD（招聘机械工程师）──')
  await runAnalysis('某企业', '机械工程师')
  const t3Md = readFileSync(join(wsDir, 'jobs', '2026-08-05-某企业-机械工程师.md'), 'utf8')
  const t3Rows = extractJobIntelligence(t3Md)
  if (!t3Rows) {
    report('T3 弱 JD 不生成幻觉责任', true, '无岗位智能段（信息不足，正确放弃）')
  } else {
    const joined = t3Rows.join('\n')
    const hallucinated = t3Rows.filter((r) => /自动化设备|负责.{2,8}设计|验证设计/.test(r))
    report('T3 弱 JD 不生成幻觉责任', hallucinated.length === 0, hallucinated.length > 0 ? `幻觉责任：${hallucinated.join(' / ')}` : `${t3Rows.length} 行（弱 JD 产出需人工复核）`)
  }

  // ─── 汇总 ───
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`M1.5 结果：${RESULTS.length - failed.length}/${RESULTS.length} 通过${failed.length > 0 ? `，失败 ${failed.length} 项` : ''}`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  }
  await cleanup(failed.length > 0 ? 1 : 0)
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
