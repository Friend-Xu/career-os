/**
 * M6.5 验证脚本（手动运行：node tests/check-persons.mjs）：
 * 连本地引擎 WS → persons/list（真实主体）+ evidence/list（owner 字段）。
 */
import WebSocket from 'ws'

const ws = new WebSocket('ws://127.0.0.1:5289')
let step = 0

ws.on('open', () => {
  console.log('open, readyState =', ws.readyState)
  ws.send(JSON.stringify({ id: 1, method: 'persons/list' }))
})

ws.on('message', (d) => {
  const msg = JSON.parse(d.toString())
  if (msg.id === 1) {
    console.log('=== persons/list ===')
    console.log(JSON.stringify(msg.result, null, 2))
    ws.send(JSON.stringify({ id: 2, method: 'evidence/list' }))
  } else if (msg.id === 2) {
    console.log('=== evidence/list (owner 字段) ===')
    const list = msg.result ?? []
    for (const e of list) {
      console.log(`${e.record?.id ?? e.id}: owner=${e.record?.owner ?? e.owner ?? '(无)'}`)
    }
    ws.close()
    process.exit(0)
  }
})

ws.on('error', (e) => {
  console.error('WS error:', e.message)
  process.exit(1)
})

ws.on('close', (code, reason) => {
  console.log('WS close:', code, reason.toString())
  process.exit(1)
})

setTimeout(() => {
  console.error('timeout')
  process.exit(1)
}, 8000)
