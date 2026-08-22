/**
 * 真机工作流探针（D/E 的开发区进程内版）：startServer（真实引擎）+ 真实 DeepSeek + 临时 workspace。
 * - 复用 golden-flow 的 WS 驱动骨架；provider 取自开发区 career-os.config.json（有效 key）
 * - D：方向探索 stage（真实 AgentRunner 工具循环）→ 登记 → 产物质量（引用有效/幻觉/trace）
 * - E：评估 stage → 推荐 stage（无会话续接，纯 Artifact 重放）→ 跨阶段方向一致性
 * - 合成数据（University-A 等，数据边界合规，与真实用户零关联）
 * 运行：node tests/agent-real-flow.mjs（约 3-8 分钟，30 分钟左右超时保护）
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { loadConfig, REPO_ROOT, defaultConfig } from '../config.ts'
import { initWorkspace } from '../storage/workspace.ts'
import { createProjection } from '../storage/projection.ts'
import { scanDecisions } from '../storage/report-watcher.ts'
import { DecisionRuntime } from '../runtime/decision-runtime.ts'
import { startServer } from '../transport/websocket.ts'
import { METHODS } from '../transport/protocol.ts'
import { createLogger } from '../logger.ts'
import { join as pjoin } from 'node:path'

const PORT = 5297
const logger = createLogger({ logsDir: pjoin(REPO_ROOT, 'logs') })

const { config: devConfig } = loadConfig([])
const root = mkdtempSync(join(tmpdir(), 'cos-realflow-'))
const ws = initWorkspace(root)

const config = {
  ...defaultConfig(),
  server: { ...defaultConfig().server, host: '127.0.0.1', port: PORT },
  paths: { ...defaultConfig().paths, workspace: root, db: join(root, '.realflow.db') },
  agent: {
    ...devConfig.agent,
    model: devConfig.agent.model,
    providers: devConfig.agent.providers,
  },
}
console.log(`provider=${config.agent.providers[0]?.id} model=${config.agent.model} → ${config.agent.providers[0]?.baseUrl}`)

const projection = createProjection({ dbPath: config.paths.db, workspace: ws, logger })
projection.syncFromDecisions(scanDecisions(ws))

let failed = 0
function check(name, cond, detail) {
  const ok = Boolean(cond)
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failed++
}

const server = await startServer({ config, workspace: ws, logger, store: projection, runtime: new DecisionRuntime() })
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
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 20_000)
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
async function waitStage(workflowId, stageId, statuses, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const g = await rpc(METHODS.workflowGet, { workflowId })
    const st = g.result?.stages?.find((s) => s.id === stageId)
    if (st && statuses.includes(st.status)) return g.result
    if (Date.now() > deadline) throw new Error(`waitStage ${stageId} 超时，当前 ${st?.status ?? '无'}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

// ─── 合成人员种子（数据边界合规）──────────────────────────────────────────────
const p = await rpc(METHODS.createPersonSession, { name: '合成甲', sourceMode: 'interview' })
const personId = p.result?.personId
if (typeof personId !== 'string') throw new Error(`createPersonSession 失败：${JSON.stringify(p)}`)
ws.write(`persons/${personId}/extraction/candidates.md`, [
  '# Extraction Candidates',
  '',
  '| id | status | category | content | source |',
  '|----|--------|----------|---------|--------|',
  '| c-001 | pending | 教育 | University-A 机械工程本科 2019-2023 | user_reported |',
  '| c-002 | pending | 经历 | 2年 IVD 医疗器械结构设计，真空密封设备 | user_reported |',
  '| c-003 | pending | 技能 | SolidWorks、Creo，熟悉 GMP | user_reported |',
  '| c-004 | pending | 约束 | 期望城市苏州 | user_reported |',
  '| c-005 | pending | 兴趣 | 机器人结构方向 | user_reported |',
  '',
].join('\n'))
ws.write(`persons/${personId}/snapshot/current/identity.md`, '# 身份\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| location | 苏州 |\n')
ws.write(`persons/${personId}/snapshot/current/skill_inventory.md`, '# 技能\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| skill_count | 3 |\n')
ws.write(`persons/${personId}/snapshot/current/preference_constraints.md`, '# 偏好\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| city | 苏州 |\n')
ws.write(`persons/${personId}/facts/education.md`, '# 教育\n\nUniversity-A 机械工程本科 2019-2023。\n')
ws.write(`persons/${personId}/facts/experience.md`, '# 经历\n\n毕业后 2 年 IVD 医疗器械结构设计：非标真空密封设备设计，熟悉 GMP 法规流程。\n')
ws.write(`persons/${personId}/facts/skill.md`, '# 技能\n\n熟练 SolidWorks、Creo；有谐波减速器选型学习经历（未在岗位使用过）。\n')

const DIR_EXPLORE_TASK = [
  `你是 CareerOS 的方向探索 Agent。对用户画像与事实素材做方向探索，产出方向候选提案。`,
  `要求：`,
  `1. 用 Read 读取：persons/${personId}/facts/education.md、persons/${personId}/facts/experience.md、persons/${personId}/facts/skill.md`,
  `2. 为每个方向写 persons/${personId}/directions/20260822-{方向名}.md，格式：`,
  `   ## 方向主张`,
  `   - {方向名称}：{一句主张}`,
  `   ## 事实依据`,
  `   - {引用来源 persons/${personId}/facts/xxx.md}：依据说明`,
  `3. 事实依据必须引用真实存在素材；无素材支撑的断言禁止写入；素材不足时明确标注信息不足`,
  `4. 每方向一个文件，产出 2-3 个方向；不要向用户提问`,
].join('\n')
const EVAL_TASK = [
  `你是 CareerOS 的方向评估 Agent。基于以下已登记方向候选与用户事实素材，对方向做评估。`,
  `要求：`,
  `1. 用 Read 读取 persons/${personId}/directions/ 下的方向产物与 persons/${personId}/facts/ 下素材`,
  `2. 为每个方向写 persons/${personId}/evaluations/20260822-{方向名}.md：`,
  `   ## 方向评估`,
  `   - {方向名称}：匹配度评估（一句话）`,
  `   ## 事实依据`,
  `   - {引用来源}：依据说明`,
  `3. 结论要有素材依据；无据断言禁止写入；不要向用户提问`,
].join('\n')
const REC_TASK = [
  `你是 CareerOS 的推荐 Agent。基于方向探索与评估产物，形成综合推荐结论。`,
  `要求：`,
  `1. 用 Read 读取 persons/${personId}/directions/、persons/${personId}/evaluations/ 与 persons/${personId}/facts/ 下产物`,
  `2. 写 decisions/20260822-综合推荐.md：`,
  `   ## 分析摘要`,
  `   | 字段 | 值 |`,
  `   |------|-----|`,
  `   | direction | {推荐方向} |`,
  `   | match | {匹配度}% |`,
  `   ## 推荐理由`,
  `   - {结论}：依据说明（引用 sources/ 物证）`,
  `3. 推荐方向必须来自探索/评估产物之一；不要向用户提问`,
].join('\n')

function evaluateFiles(prefix, facts) {
  const files = ws.listFiles('.').filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
  const factsList = Object.keys(facts)
  let citations = 0
  let valid = 0
  let hallucination = 0
  for (const f of files) {
    const text = ws.read(f)
    const refs = text.match(/facts\/[a-z]+\.md/g) ?? []
    citations += refs.length
    valid += refs.filter((m) => factsList.includes(m)).length
    if (/## 方向主张|## 方向评估/.test(text) && refs.length === 0) hallucination++
  }
  return { files, citations, valid, hallucination }
}

try {
  // ═══ D：方向探索（单阶段，真实模型）═══
  console.log('\n── D：方向探索（真实 DeepSeek × AgentRunner 工具循环）──')
  const wf = await rpc(METHODS.workflowStart, { type: 'career_direction', personId, statement: '帮我确定职业方向' })
  check('workflow/start Path B（候选可用）', wf.result?.path === 'B', JSON.stringify(wf.result))
  const wfId = wf.result.workflow.id
  const adv = await rpc(METHODS.workflowAdvance, { workflowId: wfId })
  check('advance → Stage 2 running', adv.result?.ok === true, JSON.stringify(adv))
  const st = await rpc(METHODS.agentStart, {
    workflowId: wfId,
    stageId: 'direction_exploration',
    personId,
    task: DIR_EXPLORE_TASK,
    permissionMode: 'bypassPermissions',
  })
  check('agent/start → taskId', typeof st.result?.taskId === 'string', JSON.stringify(st))
  const w1 = await waitStage(wfId, 'direction_exploration', ['waiting_gate', 'failed'], 420_000)
  check('done → 登记 → waiting_gate（无 failed）', w1.stages?.find((s) => s.id === 'direction_exploration')?.status === 'waiting_gate', JSON.stringify(w1.stages?.find((s) => s.id === 'direction_exploration')?.status))
  // 证据输出：Agent 完整事件序列 + done 文本 + 落盘文件 + 引擎错误
  const agentEvs = events.filter((e) => e.event === 'agent.event')
  const fullTool = agentEvs.map((e) => `${e.data?.type ?? '?'}${e.data?.name ? `:${e.data.name}` : ''}`)
  const traceCompact = fullTool.length <= 80 ? fullTool.join(' ') : `${fullTool.slice(0, 40).join(' ')} …(+${fullTool.length - 80})`
  console.log(`  [trace] 事件序列(${fullTool.length})：${traceCompact}`)
  const doneText = agentEvs.filter((e) => e.data?.type === 'done').map((e) => String(e.data.result).slice(0, 300)).join(' | ')
  const engErr = events.filter((e) => e.event === 'engine.error').map((e) => JSON.stringify(e.data?.message ?? '').slice(0, 200))
  console.log(`  [trace] done 文本：${doneText || '（无）'}`)
  if (engErr.length) console.log(`  [trace] engine.error：${engErr.join(' || ')}`)
  const filesAfter = ws.listFiles('.').filter((f) => f.startsWith('persons/'))
  console.log(`  [trace] persons/ 下文件：${filesAfter.join('、') || '（无）'}`)
  const dirs = await rpc(METHODS.directionsList, { personId })
  const registered = (dirs.result ?? []).filter((a) => a.state === 'registered')
  check('方向产物已登记 ≥1', registered.length >= 1, JSON.stringify((dirs.result ?? []).map((a) => [a.claim, a.state])))
  const f1 = evaluateFiles(`persons/${personId}/directions`, { 'facts/education.md': 1, 'facts/experience.md': 1, 'facts/skill.md': 1 })
  check('D：事实引用 100% 有效', f1.citations === 0 || f1.valid === f1.citations, `${f1.valid}/${f1.citations}`)
  check('D：幻觉 = 0', f1.hallucination === 0, `${f1.hallucination}`)
  const directionNames = registered.map((a) => a.claim ?? '').join('；')

  // ═══ E：多阶段（评估 → 推荐，无会话续接）═══
  console.log('\n── E：评估 stage（Artifact 重放，无会话）──')
  const confirmId = (dirs.result ?? []).find((a) => a.state === 'registered')?.artifact_id
  if (confirmId) await rpc(METHODS.directionsResolve, { personId, directionId: confirmId, action: 'confirm' })
  const adv2 = await rpc(METHODS.workflowAdvance, { workflowId: wfId, gateId: 'confirm_directions' })
  check('advance → Stage 3（评估）running', adv2.result?.ok === true && adv2.result?.nextStage === 'direction_evaluation', JSON.stringify(adv2.result))
  const st2 = await rpc(METHODS.agentStart, {
    workflowId: wfId,
    stageId: 'direction_evaluation',
    personId,
    task: EVAL_TASK,
    permissionMode: 'bypassPermissions',
  })
  check('评估 agent/start → taskId', typeof st2.result?.taskId === 'string', JSON.stringify(st2))
  let w2 = await waitStage(wfId, 'direction_evaluation', ['waiting_gate', 'failed', 'completed'], 420_000)
  const evalStatus1 = w2.stages?.find((s) => s.id === 'direction_evaluation')?.status
  check('评估 stage 完成/进入 gate（无 failed）', evalStatus1 !== 'failed', String(evalStatus1))
  const f2 = evaluateFiles(`persons/${personId}/evaluations`, { 'facts/education.md': 1, 'facts/experience.md': 1, 'facts/skill.md': 1 })
  check('E：评估产物 ≥1 且引用有效', f2.files.length >= 1 && (f2.citations === 0 || f2.valid === f2.citations), `${f2.files.length} 项 ${f2.valid}/${f2.citations}`)

  console.log('\n── E：推荐 stage（Artifact 重放）──')
  // 方向评估 stage 无 gate：产物登记后由 evaluator 完成 → advance（无 gateId）推进推荐
  if (evalStatus1 !== 'completed') {
    const tr1 = await rpc(METHODS.workflowAdvance, { workflowId: wfId })
    w2 = await waitStage(wfId, 'direction_evaluation', ['completed', 'failed'], 60_000)
  }
  const adv3 = await rpc(METHODS.workflowAdvance, { workflowId: wfId })
  const adv3Ok = (adv3.result?.ok === true && adv3.result?.nextStage === 'recommendation') ||
    (adv3.result?.ok === false && adv3.result?.code === 'ILLEGAL_STATE' && /recommendation 状态 running/.test(JSON.stringify(adv3.result?.missing ?? '')))
  check('advance → 推荐 stage running', adv3Ok, JSON.stringify(adv3.result))
  const st3 = await rpc(METHODS.agentStart, {
    workflowId: wfId,
    stageId: 'recommendation',
    personId,
    task: REC_TASK,
    permissionMode: 'bypassPermissions',
  })
  check('推荐 agent/start → taskId', typeof st3.result?.taskId === 'string', JSON.stringify(st3))
  const w3 = await waitStage(wfId, 'recommendation', ['completed', 'failed', 'waiting_gate'], 420_000)
  const recStatus = w3.stages?.find((s) => s.id === 'recommendation')?.status
  check('推荐 stage 完成（无 failed）', recStatus !== 'failed', String(recStatus))
  const decisions = ws.listFiles('decisions').filter((f) => f.endsWith('.md'))
  check('推荐决策产物 ≥1', decisions.length >= 1, `找到 ${decisions.length} 个`)
  try {
    let recText = ''
    for (const d of decisions) recText += ws.read(d) + '\n'
    // 跨阶段一致性：推荐文本必须提到探索/评估产物的方向关键词（任一）
    const names = directionNames.split('；').filter(Boolean)
    const overlap = names.filter((n) => n.length >= 2 && recText.replace(/\s/g, '').includes(n.replace(/[\s：:]/g, '')))
    check('E：推荐与探索方向一致（跨阶段 Artifact 重放成立）', overlap.length >= 1, `候选=${names.join('/')} 命中=${overlap.join('/')}`)
  } catch (err) {
    console.log(`[trace] 一致性检查异常：${err instanceof Error ? err.message : String(err)}`)
    failed++
  }
} finally {
  client.close()
  server.broadcast({ event: 'smoke.done' })
  server.shutdown()
  projection.close()
}

console.log(failed === 0 ? '\n结果：全部通过' : `\n结果：${failed} 项失败`)
process.exitCode = failed === 0 ? 0 : 1
