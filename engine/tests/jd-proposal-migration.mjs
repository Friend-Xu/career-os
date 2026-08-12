/**
 * JD Proposal Channel 迁移验证（2026-08-08，Skill Representation Freeze 后首验）：
 * 新会话（不 resume）→ 真实 Agent 分析 fixture JD（UI「分析 JD」同款 prompt）→ 断言：
 * ① 回复含「岗位分析提交：{JSON}」（Proposal 文本行，非代码块——UI 解析层同格式）
 * ② Agent 未直写 jobs 文件（Proposal 提交前 jobs 快照无岗位智能/门槛段——确定性验证）
 * ③ jd/analyze-result RPC 写入成功（无 reject）
 * ④ jobs 三段式（岗位理解 3 列 / 岗位门槛 5 列含模式 / 岗位智能 6 列含 Category）——Writer 覆盖正确区域
 * ⑤ decisions/ 双输出照旧 + jobs/list 回读（ai capabilities + category）
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

const tmp = join(FIXTURES_ROOT, `jd-mig-${Date.now().toString(36)}`)
const wsDir = join(tmp, 'ws')
let child = null
let ws = null

const JOB_ID = '2026-08-08-示例流体科技-流体机械工程师'
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

// ─── fixture workspace（person 画像含括号工具词 + Company-B式 JD 原文）────────
mkdirSync(join(wsDir, 'persons/person_001/snapshot/current'), { recursive: true })
mkdirSync(join(wsDir, 'jobs'), { recursive: true })
mkdirSync(join(wsDir, 'decisions'), { recursive: true })
mkdirSync(join(wsDir, 'knowledge'), { recursive: true })
writeFileSync(join(wsDir, 'persons/person_001/manifest.md'), `---
id: person_001
name: 我
status: active
created_at: 2026-08-08
---

# Person 001 — 我
`)
writeFileSync(join(wsDir, 'persons/person_001/snapshot/current/skill_inventory.md'), `---
id: person_001
status: v1
---

## A. 技能清单

| skill_id | 技能 | level | usage_context |
|----------|------|-------|---------------|
| skill_001 | 机械制图与三维建模（SolidWorks/Creo/AutoCAD） | applied-professional | 结构设计 |
| skill_002 | 机械原理与材料力学 | applied-intermediate | 设计基础 |
| skill_003 | 尺寸链与公差分析 | applied-professional | 结构校核 |
| skill_004 | 方案设计与样机调试 | applied-professional | 整机开发全流程 |
| skill_005 | 装配干涉处理与故障诊断 | applied-professional | 现场问题解决 |
`)
writeFileSync(join(wsDir, 'persons/person_001/snapshot/current/identity.md'), `## 分析摘要

| 字段 | 值 |
|------|-----|
| education | University-A机械工程本科（2019-2023） |
`)
writeFileSync(join(wsDir, 'persons/person_001/snapshot/current/career_profile.md'), `## 分析摘要

| 字段 | 值 |
|------|-----|
| current_role | 机械结构工程师 |
| industry | 医疗器械 |
`)

const JD = `# 流体机械工程师 — 示例流体科技

## 分析摘要

| 字段 | 值 |
|------|-----|
| company | 示例流体科技 |
| title | 流体机械工程师 |
| location | City-Z |
| salary | 9-13K·13薪 |
| requirements | 本科以上学历优先考虑，机械设计、流体机械、过程装备与控制工程等相关专业优先考虑;熟练掌握Inventor、SolidWorks等至少一款三维设计软件，能独立完成建模、施工图绘制;熟悉容器、管道、法兰等相关标准，具备泵、阀、传感器等设备的独立选型能力;了解电气基础、上位机软件相关知识，具备一定的项目方案设计及优化能力，能快速对接客户需求并转化为技术方案;具备较强的现场技术指导能力、问题解决能力，沟通协调能力良好，工作认真负责、严谨细致，能适应偶尔现场出差;有流体系统集成、非标流体设备设计经验者优先;熟悉相关行业安全规范、具备设备调试经验者优先 |
| created_at | 2026-08-08 |

---

## JD 原文

公司名称：示例流体科技
流体机械工程师 9-13K·13薪
City-Z 经验不限 学历不限
职位描述
泵测试系统
团队管理经验
仪器仪表经验
SolidWorks
有机械工程师经验
流体设备
岗位职责
1.熟练掌握常用的三维设计软件(inventor或sw等)
能进行建模出方案图、项目实施阶段绘制详细施工图;指导现场工人施
工
2.熟悉容器、管道、法兰等相关标准，熟悉泵、阀等设备，熟悉流量计、压力、温度等传感器，可以正确选型;
3.了解电气、上位机软件相关知识，可以进行项目前期洽谈，完善项目方案;4.参与流体设备及系统的优化升级、故障排查与维护指导，整理技术文档、施工记录及选型手册，完善技术资料归档;5.配合团队完成其他相关技术工作，跟进行业新技术、新设备，提升自身及团队技术能力。任职要求。
1.学历要求:本科以上学历优先考虑，机械设计、流体机械、过程装备与控制工程等相关专业优先考虑。
2.技能要求:熟练掌握Inventor、SolidWorks等至少一款三维设计软件，能独立完成建模、施工图绘制;熟悉容器、管道、法
兰等相关标准，具备泵、阀、传感器等设备的独立选型能力。
3.知识储备:了解电气基础、上位机软件相关知识，具备一定的项目方案设计及优化能力，能快速对接客户需求并转化为技
术方案。
4.能力素质:具备较强的现场技术指导能力、问题解决能力，沟通协调能力良好，工作认真负责、严谨细致，能适应偶尔现
场出差。
5.有流体系统集成、非标流体设备设计经验者优先;熟悉相关行业安全规范、具备设备调试经验者优先。
工作时间:上班8:00-9:00,下班17:00-18:00,周末双休
`
writeFileSync(join(wsDir, 'jobs', `${JOB_ID}.md`), JD)

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
    const id = `jdmig-${Math.random().toString(36).slice(2)}`
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const UI_PROMPT = `请分析岗位「示例流体科技 · 流体机械工程师」的 JD：拆解核心要求（必须/加分/隐含），评估与画像的匹配度与差距，输出决策摘要表`

async function runAgent(timeoutMs = 600000) {
  const { taskId } = await rpc('agent/start', { task: UI_PROMPT, permissionMode: 'bypassPermissions' })
  console.log(`Agent 任务已启动：${taskId}（新会话，不 resume）`)
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const evs = agentEvents.get(taskId) ?? []
    const done = evs.find((e) => e.type === 'done' || e.type === 'error')
    if (done) return { taskId, events: evs, done }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`任务超时（${timeoutMs / 1000}s）`)
}

// 回复全文 = text_delta 拼接 + done.result（Proposal JSON 可能在任意位置）
function fullReply(events) {
  let text = ''
  for (const e of events) {
    if (e.type === 'text_delta') text += e.text
  }
  const done = events.find((e) => e.type === 'done')
  if (done && typeof done.result === 'string' && done.result.length > text.length) text = done.result
  return text
}

// UI 解析层同款（逐行贪婪：\s*$ 捕获整行 JSON）
function extractProposal(content) {
  for (const line of content.split('\n')) {
    const m = line.match(/岗位分析提交：(\{.*\})/)
    if (!m) continue
    try {
      const p = JSON.parse(m[1])
      return p?.jobId ? p : undefined
    } catch { /* 跳过坏行 */ }
  }
  return undefined
}

try {
  const { events, done } = await runAgent()
  const tools = events.filter((e) => e.type === 'tool_start').map((e) => e.name)
  const reply = fullReply(events)
  console.log(`工具调用序列：${tools.join(' → ') || '（无）'}`)

  // ① Proposal 文本
  const proposal = extractProposal(reply)
  report('① 回复含「岗位分析提交」JSON（Proposal 通道文本）', proposal !== undefined, proposal ? `jobId=${proposal.jobId}` : '未找到，Agent 可能仍走直写路径')
  if (!proposal) fail('Agent 未输出 Proposal JSON——迁移未生效')

  // ② Agent 未直写 jobs（提交前快照必须是原始 JD：无岗位智能/门槛段）
  const snapshot = readFileSync(join(wsDir, 'jobs', `${JOB_ID}.md`), 'utf8')
  const directWrite = snapshot.includes('## 岗位智能') || snapshot.includes('## 岗位门槛')
  report('② Agent 未直写 jobs 文件（快照仅 JD 原文）', !directWrite, directWrite ? 'jobs 已被 Agent 写入分析段' : 'jobs 保持建档原文')

  // ③ jd/analyze-result RPC
  let writeResult
  try {
    writeResult = await rpc('jd/analyze-result', proposal)
    report('③ jd/analyze-result RPC 写入成功', true, `issues=${writeResult?.issues?.length ?? 0}`)
  } catch (err) {
    report('③ jd/analyze-result RPC 写入成功', false, String(err.message))
    fail(`RPC 失败：${err.message}`)
  }

  // ④ 三段式结构（Writer 投影指纹）
  const md = readFileSync(join(wsDir, 'jobs', `${JOB_ID}.md`), 'utf8')
  const hasUnderstand = md.includes('## 岗位理解')
  const hasThreshold = md.includes('| 维度 | 值 | 来源 | 置信度 | 模式 |')
  const hasIntelligence6 = /## 岗位智能\n\n\| Responsibility \| Priority \| Category \| Capabilities \| Evidence Patterns \| Questions \|/.test(md)
  report('④ 三段式（岗位理解/门槛 5 列含模式/智能 6 列含 Category）', hasUnderstand && hasThreshold && hasIntelligence6, `${hasUnderstand ? '理解✓' : '理解✗'} ${hasThreshold ? '门槛✓' : '门槛✗'} ${hasIntelligence6 ? '智能6列✓' : '智能6列✗'}`)

  // ⑤ 双输出 + 回读
  const decs = readdirSync(join(wsDir, 'decisions')).filter((f) => f.endsWith('.md'))
  report('⑤a 决策摘要表照旧写 decisions/', decs.length >= 1, `${decs.length} 条`)
  const jobs = await rpc('jobs/list')
  const job = jobs.find((j) => j.id === JOB_ID)
  const aiCaps = job?.responsibilities?.filter((r) => r.source === 'ai')
  const capCount = aiCaps?.reduce((n, r) => n + (r.capabilities?.length ?? 0), 0) ?? 0
  const hasCategory = aiCaps?.some((r) => r.category !== undefined)
  report('⑤b jobs/list 回读（ai capabilities + category）', (aiCaps?.length ?? 0) >= 3 && capCount > 0 && hasCategory, `${aiCaps?.length ?? 0} 个责任单元 / ${capCount} 个能力词 / category=${hasCategory ? '有' : '无'}`)

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`JD Proposal Channel 迁移验证：${RESULTS.length - failed.length}/${RESULTS.length} 通过${failed.length > 0 ? `，失败 ${failed.length} 项` : ''}`)
  if (failed.length > 0) for (const f of failed) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  await cleanup(failed.length > 0 ? 1 : 0)
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
