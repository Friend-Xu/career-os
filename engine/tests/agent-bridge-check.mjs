// 临时验证：权限往返（Bash 触发 permission_request → agent/permission allow）。
// 运行：node engine/tests/agent-bridge-check.mjs <port> permission
import { WebSocket } from 'ws'

const port = process.argv[2] ?? '5290'
const mode = process.argv[3] ?? 'permission'
const ws = new WebSocket(`ws://127.0.0.1:${port}`)
const t = setTimeout(() => {
  console.log('[check] 90s 超时')
  process.exit(1)
}, 90000)

let taskId = null
let answered = false

ws.on('open', () => {
  if (mode === 'permission') {
    ws.send(JSON.stringify({
      id: 's1', method: 'agent/start',
      // ask 模式：所有工具走 canUseTool → 触发 permission_request（acceptEdits 下 SDK 0.3.220
      // 把 PowerShell/Task 也自动放行了，实测无事件）
      params: { task: '用 Bash 工具运行 echo hello 并把输出原样回复给我，不要做其他事', permissionMode: 'ask', maxTurns: 2 },
    }))
  } else {
    ws.send(JSON.stringify({
      id: 's1', method: 'agent/start',
      params: { task: '用 AskUserQuestion 问用户：选哪个城市？选项：City-W/City-Y/北京。得到答案后回复「已收到：<答案>」', maxTurns: 4 },
    }))
  }
})

ws.on('message', (d) => {
  const m = JSON.parse(String(d))
  if (m.id === 's1') {
    taskId = m.result.taskId
    console.log('[check] start:', m.result.taskId)
    return
  }
  if (m.event === 'agent.event') {
    const ev = m.data
    console.log('[check] event:', JSON.stringify(ev))
    if (ev.type === 'permission_request') {
      console.log('[check] → 放行', ev.requestId)
      ws.send(JSON.stringify({ id: 'perm1', method: 'agent/permission', params: { taskId: m.taskId, requestId: ev.requestId, allow: true } }))
    }
    if (ev.type === 'question_request' && !answered) {
      answered = true
      console.log('[check] → 回答「City-W」')
      ws.send(JSON.stringify({ id: 'ans1', method: 'agent/answer', params: { taskId: m.taskId, text: 'City-W' } }))
    }
    if (ev.type === 'done' || ev.type === 'error') {
      clearTimeout(t)
      const ok = ev.type === 'done'
      console.log(ok ? '[check] 结果：OK' : '[check] 结果：ERROR')
      ws.close()
      process.exit(ok ? 0 : 1)
    }
  }
})
ws.on('error', (e) => {
  console.log('[check] WS 错误:', e.message)
  clearTimeout(t)
  process.exit(1)
})
