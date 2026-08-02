// Agent 适配层冒烟测试：真实调用 query() 一次，打印归一化事件流。
// 运行：node engine/tests/adapter-smoke.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from '../agent/adapter/claude.ts'

const cwd = mkdtempSync(join(tmpdir(), 'career-os-smoke-'))

console.log(`[smoke] cwd=${cwd}`)

let sessionId
const events = []
try {
  for await (const ev of query(
    {
      task: '只回复 OK 两个字母，不要任何其他内容',
      cwd,
      permissionMode: 'acceptEdits',
      maxTurns: 1,
      onPermissionRequest: async (tool) => {
        console.log(`[smoke] permission_request 决策源被调用: tool=${tool} → 自动放行`)
        return true
      },
    },
    (id) => {
      sessionId = id
      console.log(`[smoke] onSessionId: ${id}`)
    },
  )) {
    events.push(ev)
    console.log(`[smoke] event: ${JSON.stringify(ev)}`)
  }
} catch (err) {
  console.error(`[smoke] 迭代异常：${err instanceof Error ? err.stack : String(err)}`)
  process.exitCode = 1
}

const done = events.find((e) => e.type === 'done')
const error = events.find((e) => e.type === 'error')
console.log(`[smoke] 事件数=${events.length} sessionId=${sessionId ?? '(未捕获)'}`)
if (done) console.log(`[smoke] done.result=${JSON.stringify(done.result)}`)
if (error) console.log(`[smoke] error=${JSON.stringify(error.error)}`)
console.log(error ? '[smoke] 结果：ERROR' : '[smoke] 结果：OK')
