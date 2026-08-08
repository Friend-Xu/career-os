/**
 * Claim Proposal RPC 闭环验证（P1.1：真实引擎 + 真实 WS + 事件广播）。
 * 验证：① create → pending + provenanceSummary ② list 回读 ③ approve → claims/{id}.md 生成
 * ④ 事件广播（claimProposalsChanged + claimsChanged——登记即素材空间可见）
 * ⑤ 失败路径：create 后改 evidence → approve → invalid + 无 claim
 * ⑥ legacy evidence create 拒绝 ⑦ 无锚 statement 拒绝 ⑧ claims/list 回读新 claim
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import net from 'node:net'
import WebSocket from 'ws'

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(ENGINE_DIR, '..')
const FIXTURES_ROOT = join(REPO_ROOT, 'workspace', '.test-fixtures')

const tmp = join(FIXTURES_ROOT, `cp-rpc-${Date.now().toString(36)}`)
const wsDir = join(tmp, 'ws')
let child = null
let ws = null

const EVIDENCE_MD = (id, title, contribution) => `---
id: ${id}
created_at: 2026-08-08
lifecycle: active
---
# ${title}

## 分析摘要

| 字段 | 值 |
|------|-----|
| event | ${title} |
| role | 机械结构负责人 |
| contribution | ${contribution} |
| status | trusted |
| source_type | user_input |
| captured_at | 2026-08-08 |
| verification_type | user_confirmed |
| confirmed_at | 2026-08-08 |

## 证据

### impact

- 使装配效率提升 30%

### validation

- 通过样机实测验证
`

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
  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n结果：${RESULTS.length - failed.length}/${RESULTS.length} 通过`)
  process.exit(failed.length > 0 ? 1 : exitCode)
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

// ─── fixture workspace：两条 trusted evidence ──────────────────────────
mkdirSync(join(wsDir, 'evidence'), { recursive: true })
mkdirSync(join(wsDir, 'claims'), { recursive: true })
writeFileSync(join(wsDir, 'evidence/evidence_20260808_00001.md'), EVIDENCE_MD('evidence_20260808_00001', '气密性工装设计项目', '主导气密性工装设计，使装配泄漏率从 3% 降至 0.5%'))
writeFileSync(join(wsDir, 'evidence/evidence_20260808_00002.md'), EVIDENCE_MD('evidence_20260808_00002', '机器人维护项目', '负责机器人日常维护'))

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
const events = []
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.event !== undefined) {
    events.push(msg.event)
    return
  }
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

const EV = 'evidence_20260808_00001'

// ─── 验证序列 ─────────────────────────────────────────────────────────
try {
  // ① create → pending + provenanceSummary（high：user_confirmed）
  const created = await rpc('claim-proposals/create', {
    source: 'user_edit',
    evidenceRefs: [EV],
    proposedClaim: { statement: '主导气密性工装设计，使装配泄漏率降至 0.5%', section: 'experience' },
    explanation: '依据气密性工装设计项目实测数据',
  })
  report(
    '① create → pending + 系统 ID + provenanceSummary=high',
    created?.id?.startsWith('claim_proposal_') && created.status === 'pending' && created.provenanceSummary?.level === 'high',
    `${created?.id} / level=${created?.provenanceSummary?.level}`,
  )

  // ② list 回读
  const listed = await rpc('claim-proposals/list')
  report('② list 回读 1 条 pending', listed.length === 1 && listed[0].id === created.id && listed[0].status === 'pending')

  // ③ approve → claimId + claims/{id}.md 文件生成
  const { claimId } = await rpc('claim-proposals/approve', { id: created.id })
  const claimsDir = join(wsDir, 'claims')
  report('③ approve → claims/{id}.md 生成', Boolean(claimId?.startsWith('claim_')) && readdirSync(claimsDir).includes(`${claimId}.md`), claimId)

  // ④ 事件广播（approve 触发 claimProposalsChanged + claimsChanged）
  report('④ approve 后事件广播（claimProposalsChanged + claimsChanged）', events.includes('data.claim-proposals.changed') && events.includes('data.claims.changed'), events.filter((e) => e.includes('claim')).join(','))

  // ⑤ 失败路径：create 后证据 legacy → approve → invalid + 无 claim
  const failProposal = await rpc('claim-proposals/create', {
    source: 'star_reconstructor',
    evidenceRefs: [EV],
    proposedClaim: { statement: '主导气密性工装设计，使装配泄漏率降至 0.5%' },
    explanation: '失败路径测试',
  })
  const evPath = join(wsDir, 'evidence', `${EV}.md`)
  writeFileSync(evPath, readFileSync(evPath, 'utf8').replace('lifecycle: active', 'lifecycle: legacy'))
  let invalidOk = false
  let invalidMsg = ''
  try {
    await rpc('claim-proposals/approve', { id: failProposal.id })
  } catch (e) {
    invalidOk = true
    invalidMsg = e.message
  }
  const invalidProposal = (await rpc('claim-proposals/list')).find((p) => p.id === failProposal.id)
  const claimCount = readdirSync(claimsDir).filter((f) => f.startsWith('claim_')).length
  report('⑤ 证据变化 → approve 拒绝 + invalid + 无 claim', invalidOk && invalidProposal?.status === 'invalid' && claimCount === 1, invalidMsg)

  // ⑥ legacy evidence create 拒绝
  let legacyRejected = false
  try {
    await rpc('claim-proposals/create', {
      source: 'user_edit',
      evidenceRefs: [EV],
      proposedClaim: { statement: '任意表达' },
      explanation: '',
    })
  } catch {
    legacyRejected = true
  }
  report('⑥ legacy evidence create 拒绝', legacyRejected)

  // ⑦ 无锚 statement 拒绝
  let anchorRejected = false
  try {
    await rpc('claim-proposals/create', {
      source: 'user_edit',
      evidenceRefs: ['evidence_20260808_00002'],
      proposedClaim: { statement: '主导机器人控制算法优化，使效率提升 40%' },
      explanation: '',
    })
  } catch {
    anchorRejected = true
  }
  report('⑦ 无锚数字 statement 拒绝（Claim Strength ≤ Evidence Strength）', anchorRejected)

  // ⑧ claims/list 回读新 claim（可消费——CareerContext 链）
  const claims = await rpc('claims/list')
  const registered = claims.find((c) => c.id === claimId)
  report(
    '⑧ claims/list 回读新 claim + usable',
    Boolean(registered) && registered.statement === '主导气密性工装设计，使装配泄漏率降至 0.5%' && registered.usable === true,
    registered?.id,
  )

  await cleanup(0)
} catch (e) {
  fail(e.message)
}
