/**
 * agent-golden-flow-smoke：L2-8a 真实 Agent 链路 Smoke（v0.2 集成信心最后一块证据）。
 *
 * 验证目标：agent/start → Agent 产出 proposal → done → Engine intake（§1.6 快照边界）
 * → Registration → waiting_gate → resolve → advance → Stage 3 的**真实串链**。
 * 单测是白盒直调函数；本脚本走真实 WS 端口 + 真实文件系统 + 直连 AgentRunner 事件流
 * （stageTasks 注册 / done 钩子分派 / error.engine 广播 / workflowChanged 广播）。
 *
 * 确定性：不真调模型——假 Anthropic 端点（fake-anthropic-server.ts）按脚本回 SSE 帧
 * （文本补全，默认 2s 延迟窗口），agent/start 直连该端点 → text_delta/done 事件 → 引擎钩子。
 * Agent 产出（proposal 文件）由脚本在 agent/start 之后、done 之前写入
 * （intake 快照已记录，done 只消费快照外新文件）。
 *
 * 覆盖（用户定稿，不扩矩阵）：
 *   成功路径：Stage 1 completed(Path B) → advance → Stage 2 agent/start → 3 proposal
 *             → done → 3×Registration → waiting_gate → confirm 2/reject 1 → advance → Stage 3
 *   失败路径 1：proposal 无依据 → EVIDENCE 拒绝 → error.engine → registered=0 → failed
 *   失败路径 2：全 reject → advance GATE_BLOCKED → restage → 新 intake boundary →
 *             旧 rejected proposal 不被第二次 done 重新消费（R8）
 *
 * 运行：node tests/agent-golden-flow-smoke.mjs（在测试区，需全权限——临时 workspace 写盘）
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { defaultConfig } from '../config.ts'
import { initWorkspace } from '../storage/workspace.ts'
import { createProjection } from '../storage/projection.ts'
import { scanDecisions } from '../storage/report-watcher.ts'
import { DecisionRuntime } from '../runtime/decision-runtime.ts'
import { startServer } from '../transport/websocket.ts'
import { METHODS, EVENTS } from '../transport/protocol.ts'
import { startFakeAnthropicServer, textTurn } from './agent/fake-anthropic-server.ts'

const FAKE_DELAY_MS = 2000 // done 前给写 proposal 留时间窗

const PORT = 5299
const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} }

const root = mkdtempSync(join(tmpdir(), 'cos-agent-golden-'))
const ws = initWorkspace(root)

// ─── 假直连端点（ADR-030 直连路径：每请求回文本补全，2s 延迟窗口）────────────
const fakeLlm = await startFakeAnthropicServer(() => textTurn('方向探索完成', FAKE_DELAY_MS))

const config = {
  ...defaultConfig(),
  server: { ...defaultConfig().server, host: '127.0.0.1', port: PORT },
  paths: { ...defaultConfig().paths, workspace: root, db: join(root, '.smoke.db') },
  agent: {
    ...defaultConfig().agent,
    providers: [
      {
        id: 'fake',
        apiKey: 'fake-key',
        baseUrl: `http://127.0.0.1:${fakeLlm.port}/anthropic`,
        enabled: true,
        models: ['fake-model'],
      },
    ],
  },
}

const projection = createProjection({ dbPath: config.paths.db, workspace: ws, logger: silentLogger })
projection.syncFromDecisions(scanDecisions(ws))

let failed = 0
function check(name, cond, detail) {
  const ok = Boolean(cond)
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failed++
}

const server = await startServer({ config, workspace: ws, logger: silentLogger, store: projection, runtime: new DecisionRuntime() })

// ─── WS 客户端 + 事件收集（RPC 与事件共存：有 id = 响应，无 id = 事件）──────
const client = new WebSocket(`ws://127.0.0.1:${PORT}`)
await new Promise((res, rej) => {
  client.on('open', res)
  client.on('error', rej)
})

const events = []
client.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.id === undefined) events.push(m)
})

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = `r${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 8000)
    const onMsg = (raw) => {
      const m = JSON.parse(String(raw))
      if (m.id !== id) return
      clearTimeout(timer)
      client.off('message', onMsg)
      resolve(m)
    }
    client.on('message', onMsg)
    client.send(JSON.stringify({ id, method, params }))
  })
}

async function waitEvent(event, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = events.find((e) => e.event === event && (pred ? pred(e) : true))
    if (hit) return hit
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** 轮询 workflow/get 直到 Stage 2 进入目标状态（done 钩子异步，事件/轮询双保险） */
async function waitStage2(workflowId, statuses, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const g = await rpc(METHODS.workflowGet, { workflowId })
    const st = g.result?.stages?.find((s) => s.id === 'direction_exploration')
    if (st && statuses.includes(st.status)) return g.result
    if (Date.now() > deadline) {
      console.log('── events dump（调试）──')
      console.log(JSON.stringify(events, null, 2))
      throw new Error(`waitStage2 超时：未到 ${statuses.join('/')}，当前 ${st?.status ?? '无 stage'}`)
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

// ─── 种子：person + Path B 前置（候选 + 三件快照）+ 证据素材 ────────────────
async function setupPerson(name) {
  const p = await rpc(METHODS.createPersonSession, { name, sourceMode: 'interview' })
  const personId = p.result?.personId
  if (typeof personId !== 'string') throw new Error(`person/session/create 失败：${JSON.stringify(p)}`)
  ws.write(`persons/${personId}/extraction/candidates.md`, [
    '# Extraction Candidates',
    '',
    '| id | status | category | content | source |',
    '|----|--------|----------|---------|--------|',
    '| c-001 | pending | 教育 | University-A 机械工程本科 2019-2023 | user_reported |',
    '| c-002 | pending | 经历 | 2年 IVD 结构设计经验 | user_reported |',
    '| c-003 | pending | 技能 | 机械结构设计 | user_reported |',
    '| c-004 | pending | 约束 | 期望城市苏州 | user_reported |',
    '| c-005 | pending | 兴趣 | 继续机械方向 | user_reported |',
    '',
  ].join('\n'))
  ws.write(`persons/${personId}/snapshot/current/identity.md`, '# 身份\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| location | 苏州 |\n')
  ws.write(`persons/${personId}/snapshot/current/skill_inventory.md`, '# 技能\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| skill_count | 1 |\n')
  ws.write(`persons/${personId}/snapshot/current/preference_constraints.md`, '# 偏好\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| city | 苏州 |\n')
  // 证据素材（proposal 依据引用目标；与真实采集产物同语义，synthetic fixture）
  ws.write(`persons/${personId}/facts/education.md`, '# 教育\n\nUniversity-A 机械工程本科。\n')
  ws.write(`persons/${personId}/facts/experience.md`, '# 经历\n\n2年 IVD 结构设计。\n')
  ws.write(`persons/${personId}/facts/skill.md`, '# 技能\n\n机械结构设计。\n')
  return personId
}

function proposal(personId, workflowId, file, claim, evidenceRef) {
  const body = [
    '---',
    `person_id: ${personId}`,
    `workflow_id: ${workflowId}`,
    'stage_id: direction_exploration',
    '---',
    '',
    '## 方向主张',
    '',
    claim,
  ]
  if (evidenceRef !== undefined) {
    body.push('', '## 事实依据', '', `- ${evidenceRef}：依据说明`)
  }
  ws.write(`persons/${personId}/directions/${file}`, body.join('\n'))
}

/** workflow/start（Path B）→ advance → Stage 2 running */
async function toStage2(personId) {
  const wf = await rpc(METHODS.workflowStart, { type: 'career_direction', personId, statement: '帮我确定职业方向' })
  return wf.result.workflow.id
}

async function runAgent(workflowId, personId, files) {
  const st = await rpc(METHODS.agentStart, {
    workflowId,
    stageId: 'direction_exploration',
    personId,
    task: '方向探索：产出方向候选提案',
    permissionMode: 'bypassPermissions',
    maxTurns: 1,
  })
  check('agent/start → taskId', typeof st.result?.taskId === 'string', JSON.stringify(st))
  for (const [file, claim, evidenceRef] of files) proposal(personId, workflowId, file, claim, evidenceRef)
}

try {
  // ═══ 场景 1：成功路径（3 proposal → 3 Registration → confirm 2/reject 1 → Stage 3）═══
  console.log('\n── 场景 1：成功路径 ──')
  const p1 = await setupPerson('甲')
  const wf1 = await rpc(METHODS.workflowStart, { type: 'career_direction', personId: p1, statement: '帮我确定职业方向' })
  check('workflow/start Path B（候选可用）', wf1.result?.path === 'B', JSON.stringify(wf1))
  const adv1 = await rpc(METHODS.workflowAdvance, { workflowId: wf1.result.workflow.id })
  check('advance → Stage 2 running', adv1.result?.ok === true && adv1.result?.workflow?.currentStage === 'direction_exploration' && adv1.result?.workflow?.stages?.find((s) => s.id === 'direction_exploration')?.status === 'running', JSON.stringify(adv1))

  events.length = 0
  await runAgent(wf1.result.workflow.id, p1, [
    ['20260814-方向甲.md', '方向甲值得考虑。', 'facts/education.md'],
    ['20260814-方向乙.md', '方向乙值得考虑。', 'facts/experience.md'],
    ['20260814-方向丙.md', '方向丙值得考虑。', 'facts/skill.md'],
  ])
  const w1 = await waitStage2(wf1.result.workflow.id, ['waiting_gate', 'failed'], 30000)
  check('done → intake → 3×Registration → waiting_gate', w1.stages?.find((s) => s.id === 'direction_exploration')?.status === 'waiting_gate', JSON.stringify(w1.stages?.find((s) => s.id === 'direction_exploration')))
  check('artifacts 列 = 3（方向池累积）', w1.stages?.find((s) => s.id === 'direction_exploration')?.artifacts?.length === 3, JSON.stringify(w1.stages?.find((s) => s.id === 'direction_exploration')?.artifacts))
  check('workflowChanged 已广播', events.some((e) => e.event === EVENTS.workflowChanged), JSON.stringify(events.map((e) => e.event)))

  const list1 = await rpc(METHODS.directionsList, { personId: p1 })
  check('directions/list → 3 条 registered', list1.result?.length === 3 && list1.result?.every((a) => a.state === 'registered'), JSON.stringify(list1))
  const ids = Object.fromEntries(list1.result.map((a) => [a.claim, a.artifact_id]))

  const c1 = await rpc(METHODS.directionsResolve, { personId: p1, directionId: ids['方向甲值得考虑。'], action: 'confirm' })
  check('resolve 甲 confirm → confirmed', c1.result?.ok === true && c1.result?.artifact?.state === 'confirmed', JSON.stringify(c1))
  const c2 = await rpc(METHODS.directionsResolve, { personId: p1, directionId: ids['方向乙值得考虑。'], action: 'confirm' })
  check('resolve 乙 confirm → confirmed', c2.result?.ok === true && c2.result?.artifact?.state === 'confirmed', JSON.stringify(c2))
  const r1 = await rpc(METHODS.directionsResolve, { personId: p1, directionId: ids['方向丙值得考虑。'], action: 'reject' })
  check('resolve 丙 reject → rejected', r1.result?.ok === true && r1.result?.artifact?.state === 'rejected', JSON.stringify(r1))

  const list1b = await rpc(METHODS.directionsList, { personId: p1 })
  check('方向池 confirmed 2 / rejected 1', list1b.result?.filter((a) => a.state === 'confirmed').length === 2 && list1b.result?.filter((a) => a.state === 'rejected').length === 1, JSON.stringify(list1b))

  const adv1b = await rpc(METHODS.workflowAdvance, { workflowId: wf1.result.workflow.id, gateId: 'confirm_directions' })
  check('advance(confirm_directions) → Stage 2 completed → Stage 3 running', adv1b.result?.ok === true && adv1b.result?.nextStage === 'direction_evaluation' && adv1b.result?.workflow?.stages?.find((s) => s.id === 'direction_evaluation')?.status === 'running', JSON.stringify(adv1b))

  // ═══ 场景 2：失败路径 1（proposal 无依据 → 拒绝 → error.engine → failed）═══
  console.log('\n── 场景 2：无依据 proposal ──')
  const p2 = await setupPerson('乙')
  const wf2 = await rpc(METHODS.workflowStart, { type: 'career_direction', personId: p2, statement: '帮我确定职业方向' })
  await rpc(METHODS.workflowAdvance, { workflowId: wf2.result.workflow.id })

  events.length = 0
  await runAgent(wf2.result.workflow.id, p2, [['20260814-无依据方向.md', '没有事实依据的方向。', undefined]])
  const w2 = await waitStage2(wf2.result.workflow.id, ['waiting_gate', 'failed'], 30000)
  check('无依据 proposal → rejected → registered=0 → failed', w2.stages?.find((s) => s.id === 'direction_exploration')?.status === 'failed', JSON.stringify(w2.stages?.find((s) => s.id === 'direction_exploration')))
  const err2 = await waitEvent(EVENTS.engineError, () => true, 3000)
  check('error.engine 已广播（管线错误用户可见）', err2 !== null && typeof err2.data?.message === 'string' && err2.data.message.includes('方向'), JSON.stringify(err2))
  const list2 = await rpc(METHODS.directionsList, { personId: p2 })
  check('拒绝不产生 artifact（directions/list = 0）', Array.isArray(list2.result) && list2.result.length === 0, JSON.stringify(list2))

  // ═══ 场景 3：失败路径 2（全 reject → GATE_BLOCKED → restage → 新 intake boundary）═══
  console.log('\n── 场景 3：全 reject → restage → 新 intake boundary ──')
  const p3 = await setupPerson('丙')
  const wf3 = await rpc(METHODS.workflowStart, { type: 'career_direction', personId: p3, statement: '帮我确定职业方向' })
  await rpc(METHODS.workflowAdvance, { workflowId: wf3.result.workflow.id })

  await runAgent(wf3.result.workflow.id, p3, [
    ['20260814-方向丁.md', '方向丁值得考虑。', 'facts/education.md'],
    ['20260814-方向戊.md', '方向戊值得考虑。', 'facts/skill.md'],
  ])
  const w3 = await waitStage2(wf3.result.workflow.id, ['waiting_gate', 'failed'], 30000)
  check('2 proposal → waiting_gate', w3.stages?.find((s) => s.id === 'direction_exploration')?.status === 'waiting_gate', JSON.stringify(w3.stages?.find((s) => s.id === 'direction_exploration')))

  const list3 = await rpc(METHODS.directionsList, { personId: p3 })
  const ids3 = Object.fromEntries(list3.result.map((a) => [a.claim, a.artifact_id]))
  await rpc(METHODS.directionsResolve, { personId: p3, directionId: ids3['方向丁值得考虑。'], action: 'reject' })
  await rpc(METHODS.directionsResolve, { personId: p3, directionId: ids3['方向戊值得考虑。'], action: 'reject' })

  const adv3 = await rpc(METHODS.workflowAdvance, { workflowId: wf3.result.workflow.id, gateId: 'confirm_directions' })
  check('全 reject → advance 拒绝（GATE_BLOCKED）', adv3.result?.ok === false && adv3.result?.code === 'GATE_BLOCKED', JSON.stringify(adv3))

  const restage3 = await rpc(METHODS.workflowRestage, { workflowId: wf3.result.workflow.id })
  const st3 = restage3.result?.stages?.find((s) => s.id === 'direction_exploration')
  check('restage → Stage 2 running + gate 清除', st3?.status === 'running' && st3?.gate === undefined, JSON.stringify(st3))

  // 第二次执行：intake 快照 = [丁, 戊]；写新 proposal 己 → done 只消费快照外新文件
  await runAgent(wf3.result.workflow.id, p3, [['20260814-方向己.md', '方向己值得考虑。', 'facts/experience.md']])
  const w3b = await waitStage2(wf3.result.workflow.id, ['waiting_gate', 'failed'], 30000)
  check('restage 后二次 done → waiting_gate（registered ≥ 1）', w3b.stages?.find((s) => s.id === 'direction_exploration')?.status === 'waiting_gate', JSON.stringify(w3b.stages?.find((s) => s.id === 'direction_exploration')))

  const list3b = await rpc(METHODS.directionsList, { personId: p3 })
  check('R8：旧 rejected 不被二次消费（2 rejected + 1 registered = 3）', list3b.result?.length === 3 && list3b.result?.filter((a) => a.state === 'rejected').length === 2 && list3b.result?.filter((a) => a.state === 'registered').length === 1, JSON.stringify((list3b.result ?? []).map((a) => [a.claim, a.state])))
  check('方向池累积不重置（artifacts 列 3 条）', w3b.stages?.find((s) => s.id === 'direction_exploration')?.artifacts?.length === 3, JSON.stringify(w3b.stages?.find((s) => s.id === 'direction_exploration')?.artifacts))

  const ids3b = Object.fromEntries(list3b.result.map((a) => [a.claim, a.artifact_id]))
  await rpc(METHODS.directionsResolve, { personId: p3, directionId: ids3b['方向己值得考虑。'], action: 'confirm' })
  const adv3b = await rpc(METHODS.workflowAdvance, { workflowId: wf3.result.workflow.id, gateId: 'confirm_directions' })
  check('confirm 新方向 → advance → Stage 3 running', adv3b.result?.ok === true && adv3b.result?.nextStage === 'direction_evaluation', JSON.stringify(adv3b))
} finally {
  client.close()
  server.broadcast({ event: 'smoke.done' })
  server.shutdown()
  projection.close()
  await fakeLlm.close()
}

console.log(failed === 0 ? '\n结果：全部通过' : `\n结果：${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
