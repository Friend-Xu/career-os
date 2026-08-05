/**
 * Proposal Layer 端到端冒烟（M3.5.6 验收，手动运行：npm run smoke:proposal）：
 * 临时工作区 + 临时配置 → 启动引擎 → 写入 claim/evidence/resume 资产 →
 * AI 写提案文件 → 断言 watcher 登记（proposalsChanged + pending）→
 * accept → 断言新版本（ai_revision lineage + apply_proposal 审计 + Proposal 回填）→
 * reject → 断言 rejected；坏提案（old 不匹配）→ 断言不登记 + validation invalid。
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import net from 'node:net'
import WebSocket from 'ws'

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'career-os-proposal-'))
const wsDir = join(tmp, 'ws')
let child = null
let ws = null

const CLAIM_ID = 'claim_20260805_00001'
const EVIDENCE_ID = 'evidence_20260805_00001'
const RESUME_ID = 'resume_20260805_00001'
const OLD = '负责自动化设备机械结构设计，完成机架及传动机构优化'
const NEW = '主导自动化设备机架结构设计，传动精度由 0.1mm 提升至 0.05mm'

function fail(msg) {
  console.error(`❌ 冒烟失败：${msg}`)
  void cleanup(1)
}

// 未处理拒绝（事件超时等）也要走清理，避免引擎子进程泄漏
process.on('unhandledRejection', (e) => fail(e instanceof Error ? e.message : String(e)))

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

async function cleanup(exitCode) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close()
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

function realNode() {
  for (const dir of (process.env.Path ?? process.env.PATH ?? '').split(';').filter(Boolean)) {
    const exe = join(dir, 'node.exe')
    if (existsSync(exe)) return exe
  }
  return process.execPath
}

function writeFixture(root, rel, content) {
  writeFileSync(join(root, rel), content, 'utf8')
}

const port = await freePort()
const configPath = join(tmp, 'config.json')
writeFileSync(
  configPath,
  JSON.stringify({
    server: { host: '127.0.0.1', port },
    paths: { workspace: wsDir, db: join(tmp, 'career.db'), skills: join(tmp, 'skills'), logs: join(tmp, 'logs') },
    watcher: { enabled: true },
  }, null, 2),
)

child = spawn(realNode(), ['main.ts', '--config', configPath], { cwd: ENGINE_DIR })
const out = []
child.stdout.on('data', (d) => out.push(String(d)))
child.stderr.on('data', (d) => out.push(String(d)))
let ready = false
child.on('exit', (code) => {
  if (!ready) fail(`引擎提前退出（code=${code}）\n${out.join('')}`)
})
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

const waitEvent = (name, timeout = 8000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now()
    const poll = setInterval(() => {
      const idx = events.findIndex((e) => e.event === name)
      if (idx >= 0) {
        clearInterval(poll)
        resolve(events.splice(idx, 1)[0])
      } else if (Date.now() - t0 > timeout) {
        clearInterval(poll)
        reject(new Error(`事件 ${name} 超时`))
      }
    }, 50)
  })

const waitProposal = async (id, timeout = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const list = await rpc('proposals/list')
    const p = list.find((x) => x.id === id)
    if (p) return p
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`proposals/list 未出现 ${id}`)
}

// ─── 资产 fixture（claim/evidence/resume 落盘 → watcher 登记）───────────

writeFixture(wsDir, `claims/${CLAIM_ID}.md`, `---
id: ${CLAIM_ID}
---

# 机械结构设计

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | ${OLD} |
| claim_type | fact |
| source | agent_generated |
| captured_at | 2026-08-05 |

## 证据来源

- ${EVIDENCE_ID}
`)

writeFixture(wsDir, `evidence/${EVIDENCE_ID}.md`, `---
id: ${EVIDENCE_ID}
---

# 新机型平台开发项目

## 分析摘要

| 字段 | 值 |
|------|-----|
| role | 机械结构负责人 |
| contribution | 负责机架和传动模块设计 |
| source_type | user_input |
| captured_at | 2026-08-05 |
| status | trusted |

## 事件

公司新机型平台开发项目。

## 证据

### scope
- 负责机架和传动模块设计

## 来源

用户口述整理
`)

writeFixture(wsDir, `resumes/documents/${RESUME_ID}.md`, `# ${RESUME_ID}

## 分析摘要

| 字段 | 值 |
|------|-----|
| status | draft |
| person | 我 |
| template_id | mechanical |
| template_version | 1.2 |
| generated_at | 2026-08-05T10:00:00Z |
| derivation_type | jd_generate |
| created_by | ai |

## 章节

### experience | 工作经历

- ${OLD}（claim: ${CLAIM_ID}）

### skills | 技能

- SolidWorks（asset）

## 操作记录

- operation_001 | ai | create | 2026-08-05T10:00:00Z
`)

await new Promise((r) => setTimeout(r, 500)) // 等资产 watcher 登记
const resumes0 = await rpc('resumes/list')
if (!resumes0.some((r) => r.id === RESUME_ID)) fail('resume 资产未登记')
console.log('--- 资产就绪（claim/evidence/resume）---')

// ─── ① AI 写提案 → watcher 登记（pending）──────────────────────────────

const proposalBody = `# 改进建议

## 分析摘要

| 字段 | 值 |
|------|-----|
| type | resume_proposal |
| source_resume_id | ${RESUME_ID} |
| proposal_type | improve |

## 变更建议

- ${CLAIM_ID}（section: experience；old: "${OLD}"；new: "${NEW}"；reason: "岗位强调量化结果，期望有可度量输出"）
`

writeFixture(wsDir, 'proposals/ai-改进.md', proposalBody)
const ev = await waitEvent('data.proposals.changed')
if (!ev) fail('proposalsChanged 事件未到达')
const registered = await waitProposal('proposal_20260805_00001')
if (registered.status !== 'pending') fail(`提案登记后应 pending，实际 ${registered.status}`)
if (registered.validation?.status !== 'valid') fail(`提案应 valid，实际 ${JSON.stringify(registered.validation)}`)
if (!registered.sourceChecksum) fail('提案缺少 source_checksum')
console.log('① 登记 ✓（pending + checksum + validation valid）')

// ─── ② accept（带 reason）→ 确定性应用 → 新版本（不覆盖源）─────────────────

const doc = await rpc('proposals/accept', { id: 'proposal_20260805_00001', reason: '表达更契合岗位语言' })
const v4 = await rpc('resumes/get', { id: doc.id })
if (v4.lineage?.parentResumeId !== RESUME_ID || v4.lineage?.derivationType !== 'ai_revision') fail(`lineage 错误：${JSON.stringify(v4.lineage)}`)
if (v4.sections[0].bullets[0].sentence !== NEW) fail('新版本应包含建议句')
if (v4.sections[1].assetRefs?.[0] !== 'SolidWorks') fail('skills assetRefs 未保留')
const applyOp = v4.operations?.find((o) => o.action === 'apply_proposal')
if (!applyOp || applyOp.note !== 'proposal_20260805_00001') fail('apply_proposal 审计缺失')
const srcAfter = await rpc('resumes/get', { id: RESUME_ID })
if (srcAfter.sections[0].bullets[0].sentence !== OLD) fail('源版本被覆盖（violate 永不覆盖纪律）')
const p1 = await waitProposal('proposal_20260805_00001')
if (p1.status !== 'accepted' || p1.resultResumeId !== doc.id) fail('Proposal 未回填 accepted/resultResumeId')
if (p1.acceptReason !== '表达更契合岗位语言') fail('acceptReason 未写回')
console.log(`② accept ✓（v4=${doc.id}，源版本未动，apply_proposal 审计在案，acceptReason 写回）`)

// ─── ②.5 M3.5.7 决策反馈投影（ai/context）───────────────────────────────

const ctx = await rpc('ai/context')
const hist = ctx.proposalHistory ?? []
if (hist.length !== 1 || hist[0].action !== 'accepted' || hist[0].reason !== '表达更契合岗位语言') fail(`proposalHistory 投影错误：${JSON.stringify(hist)}`)
const st = ctx.proposalInsights?.stats
if (!st || st.total !== 1 || st.accepted !== 1 || st.acceptRate !== 1) fail(`proposalInsights.stats 错误：${JSON.stringify(st)}`)
if (ctx.proposalInsights.byType?.improve?.accepted !== 1) fail('byType 投影错误')
if (ctx.proposalInsights.acceptedReasons?.[0] !== '表达更契合岗位语言') fail('acceptedReasons 原样缺失')
console.log('②.5 决策反馈投影 ✓（history + stats + byType + reasons 原样）')

// ─── ③ 二次 accept 拒绝（状态机单向）───────────────────────────────────

try {
  await rpc('proposals/accept', { id: 'proposal_20260805_00001' })
  fail('accepted 后二次 accept 应拒绝')
} catch (e) {
  if (!String(e.message).includes('只能接受 pending')) fail(`拒绝原因不符：${e.message}`)
}
console.log('③ 状态机单向 ✓（accepted 不可重复应用）')

// ─── ④ reject（新提案，带原因）────────────────────────────────────────

const rejectBody = proposalBody.replace('proposal_type | improve', 'proposal_type | replace_sentence')
writeFixture(wsDir, 'proposals/ai-拒绝示例.md', rejectBody)
const p2 = await waitProposal('proposal_20260805_00002')
if (p2.status !== 'pending') fail('第二个提案应 pending')
const rejected = await rpc('proposals/reject', { id: 'proposal_20260805_00002', reason: '与当前方向不符' })
if (rejected.status !== 'rejected' || rejected.rejectReason !== '与当前方向不符') fail('reject 结果不符')
const p2Check = await waitProposal('proposal_20260805_00002')
if (p2Check.status !== 'rejected') fail('reject 未持久化')
try {
  await rpc('proposals/reject', { id: 'proposal_20260805_00002' })
  fail('rejected 后再次 reject 应拒绝')
} catch { /* 预期拒绝 */ }
console.log('④ reject ✓（单向 + 原因审计 + 持久化）')

// ─── ⑤ 坏提案（old 不匹配）→ 不登记 + validation invalid ───────────────

const badBody = proposalBody.replace(OLD, '不存在的原文句子')
writeFixture(wsDir, 'proposals/ai-坏提案.md', badBody)
await new Promise((r) => setTimeout(r, 500))
const list = await rpc('proposals/list')
const bad = list.find((x) => x.sourceFile?.includes?.('ai-坏提案') || x.id.includes('ai-坏提案'))
if (!bad) fail('坏提案应在 proposals/list 可见（未登记态）')
if (bad.validation?.status !== 'invalid') fail(`坏提案应 invalid，实际 ${bad.validation?.status}`)
if (!bad.validation?.issues.some((i) => i.code === 'OLD_SENTENCE_MISMATCH')) fail('坏提案应标 OLD_SENTENCE_MISMATCH')
if (list.some((x) => x.id === 'proposal_20260805_00003')) fail('坏提案不应分配系统 ID')
console.log('⑤ 坏提案 ✓（不登记 + invalid + OLD_SENTENCE_MISMATCH）')

console.log('\n✅ Proposal Layer E2E 全链通过')
await cleanup(0)
