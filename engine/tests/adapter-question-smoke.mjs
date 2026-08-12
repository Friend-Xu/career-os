// Phase 0 研究脚本：AskUserQuestion 形状与权限行为实测（真实 CLI）。
// 直接 import SDK（不经 adapter 归一化），观察原始消息形状。
// 运行：node engine/tests/adapter-question-smoke.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'

const cwd = mkdtempSync(join(tmpdir(), 'career-os-q-smoke-'))
console.log(`[研究] cwd=${cwd}`)

let answered = false
// 全局超时保护：CLI 可能挂着等回答，90s 强制退出
setTimeout(() => {
  console.log(`[研究] 90s 超时退出 answered=${answered}`)
  process.exit(answered ? 0 : 1)
}, 90000)
const sdk = sdkQuery({
  prompt:
    '用 AskUserQuestion 向用户提一个选择题：最看重哪个城市？选项：City-W / City-Y / 北京。' +
    '得到答案后回复「已收到：<答案>」，不要做其他事。',
  options: {
    cwd,
    permissionMode: 'default',
    maxTurns: 6,
    canUseTool: (tool) => {
      console.log(`[研究] canUseTool 被调用: tool=${tool}`)
      if (tool === 'AskUserQuestion') return Promise.resolve({ behavior: 'allow' }) // 必须 allow，否则 CLI 静默挂起
      return Promise.resolve(null)
    },
  },
})

// 回答通道：持续打开的输入流，回答时 yield user 消息
const answers = []
const inputStream = (async function* () {
  for (;;) {
    if (answers.length > 0) {
      yield answers.shift()
    }
    await new Promise((r) => setTimeout(r, 100))
  }
})()
void sdk.streamInput(inputStream)

try {
  for await (const msg of sdk) {
    if (msg.type === 'user') {
      const qs = msg.tool_use_result?.questions
      console.log(`[研究] user 消息: questions=${qs ? qs.length : 0} session_id=${msg.session_id ?? '-'}`)
      if (qs && qs.length > 0 && !answered) {
        console.log('[研究] → streamInput 回答「City-W」')
        answers.push({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'City-W' }] },
          parent_tool_use_id: null,
        })
        answered = true
      }
    } else if (msg.type === 'result') {
      console.log(`[研究] result: subtype=${msg.subtype} result=${JSON.stringify(msg.result).slice(0, 200)}`)
    } else {
      console.log(`[研究] msg.type=${msg.type} subtype=${msg.subtype ?? '-'}`)
    }
  }
} catch (err) {
  console.error(`[研究] 异常：${err instanceof Error ? err.stack : String(err)}`)
  process.exitCode = 1
}
console.log(`[研究] 完成 answered=${answered}`)
