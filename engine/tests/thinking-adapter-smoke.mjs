// 思考归一化 smoke：createAgent 直连真实 CLI，验证 thinking_start/delta/stop 输出形状。
// 运行：node engine/tests/thinking-adapter-smoke.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgent } from '../agent/adapter/claude.ts'

const cwd = mkdtempSync(join(tmpdir(), 'career-os-thinking-adapter-'))
setTimeout(() => {
  console.log('[smoke] 120s 超时退出')
  process.exit(1)
}, 120000)

const handle = createAgent(
  {
    task: '请仔细思考后用一句话回答：二进制数 110101 转十进制是多少？只输出答案。',
    cwd,
    permissionMode: 'ask',
  },
  (sid) => console.log(`[smoke] session_id=${sid}`),
)

let sawStart = false
let sawDelta = false
let sawStop = false
let deltaChars = 0
let textChars = 0
let ok = false
for await (const ev of handle.events) {
  if (ev.type === 'thinking_start') {
    sawStart = true
    console.log('[smoke] thinking_start')
  } else if (ev.type === 'thinking_delta') {
    sawDelta = true
    deltaChars += ev.text.length
    console.log(`[smoke] thinking_delta +${ev.text.length} chars (cum=${deltaChars})`)
  } else if (ev.type === 'thinking_stop') {
    sawStop = true
    console.log('[smoke] thinking_stop')
  } else if (ev.type === 'text_delta') {
    textChars += ev.text.length
    console.log(`[smoke] text_delta +${ev.text.length} chars (cum=${textChars})`)
  } else if (ev.type === 'done') {
    ok = true
    console.log(`[smoke] done result_len=${ev.result.length}`)
  } else if (ev.type === 'error') {
    console.log(`[smoke] error: ${ev.error.code} ${ev.error.message}`)
  }
}
console.log(
  `[smoke] 汇总: start=${sawStart} delta=${sawDelta} stop=${sawStop} thinkingChars=${deltaChars} textChars=${textChars} ok=${ok}`,
)
const pass = ok && sawStart && sawDelta && sawStop && deltaChars > 0 && textChars > 0
console.log(pass ? '[smoke] PASS' : '[smoke] FAIL')
process.exit(pass ? 0 : 1)
