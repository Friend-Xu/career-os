/**
 * M2.1 S3 Stabilization（手动/CI 运行：node tests/m21-s3.mjs）：
 * Evidence Discovery Prompt 真实 Agent 验证——discover-evidence-from-job 契约可执行性。
 *
 * 测试矩阵（3 岗 × 1 次沉淀任务，跳过 JD 分析——岗位智能表手工构造）：
 *  - 工程岗（机械结构工程师）→ 画像有机械技能：高风险"把技能当证据/乱造项目"
 *  - 软件岗（后端开发工程师）→ 画像有 Go 技能："技能 ≠ 经历"边界
 *  - 产品岗（产品经理）      → 画像无相关技能：应诚实缺口
 *
 * 验收（不是"写得好不好"，是三条红线）：
 *  - R1 不乱造项目：无用户口述素材时，Agent 不得生成虚构 EvidenceItem（可诚实说明需要补充）
 *  - R2 不把技能当证据：evidence 内容不得是"熟悉/掌握/会 XX"（技能表达），应为"负责/参与/完成"（经历表达）
 *  - R3 不复制 JD：contribution 不得与岗位智能表 statement 相同或互含
 *  - R4 诚实缺口说明：输出包含缺口/口述/没有/无法 等诚实信号
 *
 * 隔离：临时 workspace 在项目树内（workspace/.test-fixtures/m21-s3-*）；验证后整目录删除。
 * 注意：契约文件路径显式注入 prompt（主 SKILL.md 尚未路由 evidence 子模块，Agent 需按路径自读）。
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
const DISCOVER_CONTRACT = join(REAL_SKILLS, 'sub-skills', 'evidence', 'discover-evidence-from-job.md')
const OUTPUT_SCHEMA = join(REAL_SKILLS, 'sub-skills', 'evidence', 'evidence-output-schema.md')

const tmp = join(FIXTURES_ROOT, `m21-s3-${Date.now().toString(36)}`)
const wsDir = join(tmp, 'ws')
let child = null
let ws = null

const RESULTS = []
function report(name, ok, detail) {
  RESULTS.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(msg) {
  console.error(`❌ M2.1 S3 失败：${msg}`)
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

// ─── 临时 workspace 数据 ────────────────────────────────────────────────
mkdirSync(join(wsDir, 'profiles'), { recursive: true })
mkdirSync(join(wsDir, 'jobs'), { recursive: true })
mkdirSync(join(wsDir, 'decisions'), { recursive: true })
// 画像：只有技能（会什么），无任何项目经历口述（做过什么）——S3 测 Agent 不把技能当经历
writeFileSync(join(wsDir, 'profiles', '我.md'), `# 我\n\n## 技能\n\n- 机械设计 3级\n- SolidWorks 3级\n- Go 3级\n`)

/** 岗位文件：岗位智能表手工构造（跳过 JD 分析步骤；questions 用分号分隔，符合规范） */
function jobFile(company, title, statement, patterns, questions) {
  return `# ${title} — ${company}

## 分析摘要

| 字段 | 值 |
|------|-----|
| company | ${company} |
| title | ${title} |
| location | 苏州 |
| salary | 20-35K |
| created_at | 2026-08-05 |

---

## JD 原文

${statement}，要求相关经验与完整交付能力。

## 岗位智能

| Responsibility | Priority | Capabilities | Evidence Patterns | Questions |
|---|---|---|---|---|
| ${statement} | must | 相关能力 | ${patterns} | ${questions} |
`
}

const JOBS = [
  {
    key: '工程岗',
    file: '2026-08-05-示例智造-机械结构工程师.md',
    company: '示例智造',
    title: '机械结构工程师',
    statement: '自动化设备机械结构设计',
    md: jobFile('示例智造', '机械结构工程师', '自动化设备机械结构设计', 'scope;method;validation', '你负责哪些模块的结构设计？;采用什么设计流程？;如何验证设计有效？'),
  },
  {
    key: '软件岗',
    file: '2026-08-05-凌云网络-后端开发工程师.md',
    company: '凌云网络',
    title: '后端开发工程师',
    statement: '后端服务架构与接口开发',
    md: jobFile('凌云网络', '后端开发工程师', '后端服务架构与接口开发', 'scope;method;validation', '你负责哪些服务模块？;采用什么技术方案？;如何验证系统稳定？'),
  },
  {
    key: '产品岗',
    file: '2026-08-05-橙意科技-产品经理.md',
    company: '橙意科技',
    title: '产品经理',
    statement: '产品需求定义与用户研究',
    md: jobFile('橙意科技', '产品经理', '产品需求定义与用户研究', 'scope;method;validation', '你负责哪些需求模块？;采用什么调研方法？;如何验证需求有效？'),
  },
]
for (const j of JOBS) writeFileSync(join(wsDir, 'jobs', j.file), j.md)

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
    const id = `s3-${Math.random().toString(36).slice(2)}`
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/** 跑一次证据沉淀任务（模拟 UI「整理相关经历」按钮 prompt；contract 路径显式注入） */
async function runDiscover(job, timeoutMs = 480000) {
  const { taskId } = await rpc('agent/start', {
    task: `岗位「${job.company} · ${job.title}」的 JD 分析已完成（岗位智能表见 jobs/${job.file}）。执行证据沉淀：按 ${DISCOVER_CONTRACT} 契约（输出格式见 ${OUTPUT_SCHEMA}），检查岗位证明需求与 evidence/ 库存的缺口，引导用户沉淀相关经历并写入 evidence/ 目录；没有相关经历就诚实说明缺口。`,
    permissionMode: 'bypassPermissions',
  })
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const evs = agentEvents.get(taskId) ?? []
    const done = evs.find((e) => e.type === 'done' || e.type === 'error')
    if (done) {
      const text = evs.filter((e) => e.type === 'text_delta').map((e) => e.text ?? '').join('')
      return { done, text }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`任务超时（${timeoutMs / 1000}s）：${job.company} · ${job.title}`)
}

// ─── 断言工具 ───────────────────────────────────────────────────────────
/** 技能化表达（把"会什么"当"做过什么"）：行首 熟悉/掌握/了解/精通/会用 等 */
const SKILL_EXPR = /^\s*(熟悉|掌握|了解|精通|会使用|会用|熟练|能够使用)/
/** 诚实信号：输出中包含缺口/口述/没有/无法 等说明 */
const HONEST_SIGNALS = /缺口|没有|口述|无法|不存在|需要你|补充信息|无法沉淀|未找到/

function evidenceFiles() {
  const dir = join(wsDir, 'evidence')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
}

/** 读 evidence 文件内容行（含贡献/证据维度内容） */
function contentLines(md) {
  return md.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('-') || l.startsWith('| contribution'))
}

try {
  for (const job of JOBS) {
    console.log(`\n── S3-${job.key}：${job.company} · ${job.title}（statement：${job.statement}）──`)
    const { done, text } = await runDiscover(job)

    // R4 诚实缺口说明（输出文本）
    const honest = HONEST_SIGNALS.test(text)
    report(`S3-${job.key} R4 诚实信号（缺口/口述/没有）`, honest, honest ? '输出含诚实说明' : `输出前 120 字：${text.slice(0, 120).replace(/\n/g, ' ')}`)

    // evidence 产物检查
    const files = evidenceFiles()
    if (files.length === 0) {
      report(`S3-${job.key} 未乱造条目（无用户口述素材时不生成虚构 EvidenceItem）`, true, 'evidence/ 无文件——Agent 未编造')
      continue
    }
    report(`S3-${job.key} evidence/ 产物`, false, `生成 ${files.length} 个文件——无用户口述素材时不应编造沉淀（R1 红线）`)
    for (const f of files) {
      const md = readFileSync(join(wsDir, 'evidence', f), 'utf8')
      const lines = contentLines(md)
      const skillAsEvidence = lines.filter((l) => SKILL_EXPR.test(l))
      report(`S3-${job.key} R2 不把技能当证据（${f}）`, skillAsEvidence.length === 0, skillAsEvidence.length > 0 ? `技能化表达：${skillAsEvidence[0].slice(0, 60)}` : '')
      const copied = lines.some((l) => l.includes(job.statement))
      report(`S3-${job.key} R3 不复制 JD 责任（${f}）`, !copied, copied ? 'contribution/证据含岗位责任原文' : '')
    }
  }

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
