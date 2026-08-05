/**
 * 真实 JD 重分析触发（M1 改造效果验证）：连真实引擎（5289）→ agent/start
 * （模拟 UI「分析 JD」按钮 prompt，bypassPermissions）→ 等 done → 汇报。
 * 写回：decisions/ 追加 jd-analysis 记录 + jobs/{id}.md 岗位智能段（Agent 按 skill 双输出）。
 */
import WebSocket from 'ws'

const URL = 'ws://127.0.0.1:5289'
const TASK = '请分析岗位「南京新拓尼克科技 · 机械结构工程师」的 JD：拆解核心要求（必须/加分/隐含），评估与画像的匹配度与差距，输出决策摘要表'
const TIMEOUT_MS = 600000

const ws = new WebSocket(URL)
const pending = new Map()
const events = []
let taskId = null

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.event !== undefined) {
    if (msg.event === 'agent.event' && msg.taskId) {
      events.push(msg.data)
      if (msg.data.type === 'done' || msg.data.type === 'error') {
        console.log(`\n═══ Agent 任务结束：${msg.data.type} ═══`)
        if (msg.data.type === 'done') console.log(`结果摘要：${String(msg.data.result).slice(0, 300)}`)
        if (msg.data.type === 'error') console.log(`错误：${msg.data.error?.message ?? '未知'}`)
        console.log(`事件计数：${events.length}（含 tool ${events.filter((e) => e.type === 'tool_done').length} 次工具完成）`)
        ws.close()
        process.exit(msg.data.type === 'done' ? 0 : 1)
      }
    }
  } else if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = `jd-${Math.random().toString(36).slice(2)}`
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}

ws.on('open', async () => {
  console.log('已连接引擎')
  try {
    const r = await rpc('agent/start', { task: TASK, permissionMode: 'bypassPermissions' })
    taskId = r.taskId
    console.log(`任务已启动：${taskId}（超时 ${TIMEOUT_MS / 60000} 分钟）`)
    setTimeout(() => {
      console.log('⏰ 任务超时退出')
      ws.close()
      process.exit(2)
    }, TIMEOUT_MS)
  } catch (err) {
    console.error(`❌ 启动失败：${err.message}`)
    ws.close()
    process.exit(1)
  }
})

ws.on('error', (err) => {
  console.error(`❌ WS 错误：${err.message}`)
  process.exit(1)
})
