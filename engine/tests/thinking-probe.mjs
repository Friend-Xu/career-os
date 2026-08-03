// Phase 0 研究脚本：思考（thinking）事件形状实测（真实 CLI）。
// 目的：确认管道模式（非 TTY）下 SDK 0.3.220 会产出哪些思考信号——
//   a) stream_event 里 content_block_start/delta 是否有 thinking 块（含文本？）
//   b) system subtype=thinking_tokens 是否到达（estimated_tokens 进度）
//   c) thinking: {type:'adaptive', display:'summarized'} 是否让思考文本可读
// 运行：node engine/tests/thinking-probe.mjs [summarized|omitted|none]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'

const display = process.argv[2] ?? 'summarized'
const cwd = mkdtempSync(join(tmpdir(), 'career-os-thinking-'))
console.log(`[研究] cwd=${cwd} display=${display}`)

const options = {
  cwd,
  permissionMode: 'default',
  maxTurns: 3,
  canUseTool: () => Promise.resolve(null),
}
if (display !== 'none') {
  options.thinking = { type: 'adaptive', display }
}

setTimeout(() => {
  console.log('[研究] 120s 超时退出')
  process.exit(1)
}, 120000)

const sdk = sdkQuery({
  prompt: '请仔细思考后用一句话回答：二进制数 110101 转十进制是多少？只输出答案。',
  options,
})

let sawThinkingBlock = false
let sawThinkingDelta = false
let sawThinkingTokens = false
let thinkingTextLen = 0
let estimatedTokens = 0

for await (const msg of sdk) {
  if (msg.type === 'system') {
    console.log(`[研究] system: subtype=${msg.subtype ?? '-'}`)
    if (msg.subtype === 'thinking_tokens') {
      sawThinkingTokens = true
      estimatedTokens = msg.estimated_tokens
      console.log(`[研究]   thinking_tokens: estimated=${msg.estimated_tokens} delta=${msg.estimated_tokens_delta}`)
    }
  } else if (msg.type === 'stream_event') {
    const ev = msg.event
    if (ev.type === 'content_block_start') {
      const cb = ev.content_block
      console.log(`[研究] stream_event content_block_start: type=${cb.type}`)
      if (cb.type === 'thinking') {
        sawThinkingBlock = true
        console.log(`[研究]   thinking block: thinking=${JSON.stringify(cb.thinking).slice(0, 120)} signature_len=${cb.signature?.length ?? 0}`)
      }
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta
      console.log(`[研究] stream_event content_block_delta: delta.type=${d.type}`)
      if (d.type === 'thinking_delta') {
        sawThinkingDelta = true
        thinkingTextLen += d.thinking?.length ?? 0
        console.log(`[研究]   thinking_delta: text_len=${d.thinking?.length ?? 0} estimated=${d.estimated_tokens ?? '-'} signature_len=${d.signature?.length ?? 0}`)
      }
    }
  } else if (msg.type === 'assistant') {
    for (const block of msg.message.content) {
      if (block.type === 'thinking') {
        console.log(`[研究] assistant thinking block: text_len=${block.thinking?.length ?? 0}`)
      }
    }
  } else if (msg.type === 'result') {
    console.log(`[研究] result: subtype=${msg.subtype}`)
  } else if (msg.type === 'user' && msg.message.role === 'user') {
    // 工具结果等，跳过
  }
}
console.log(
  `[研究] 汇总: thinkingBlock=${sawThinkingBlock} thinkingDelta=${sawThinkingDelta} thinkingTextChars=${thinkingTextLen} ` +
    `thinkingTokensMsg=${sawThinkingTokens} lastEstimated=${estimatedTokens}`
)
