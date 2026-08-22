/**
 * 假 Anthropic 端点（测试助手）：本地 http server，按脚本队列回 SSE 帧。
 * - 供 agent-runner 单测与 agent-golden-flow-smoke 使用（直连路径无需真实模型）
 * - 每个 POST 请求消费一个脚本（FakeTurn）→ 延迟 → 依次发 SSE 事件
 * - 请求体记录在 requests[]（断言用：工具调用回合的 messages 形状）
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeSseEvent {
  event: string
  data: unknown
}

export interface FakeTurn {
  delayMs?: number
  /** 非流式（generateText）模式的文本内容 */
  text?: string
  /** 流式（streamText）模式的 SSE 帧 */
  sseEvents: FakeSseEvent[]
}

export interface FakeAnthropicServer {
  url: string
  port: number
  requests: unknown[]
  close: () => Promise<void>
}

/** 完整消息 → 文本补全回合（含 message_start / deltas / message_delta / message_stop） */
export function textTurn(text: string, delayMs = 0): FakeTurn {
  return {
    delayMs,
    text,
    sseEvents: [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_fake',
            type: 'message',
            role: 'assistant',
            model: 'fake-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        },
      },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ],
  }
}

/** 工具调用回合（tool_use：content_block_start + input_json_delta 拼出完整 JSON 入参） */
export function toolUseTurn(toolName: string, input: Record<string, unknown>, toolUseId = 'toolu_fake', delayMs = 0): FakeTurn {
  const partials = JSON.stringify(input)
    .match(/.{1,40}/g)!
    .map((p, i, arr) => ({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: i < arr.length - 1 ? p : p },
      },
    }))
  return {
    delayMs,
    sseEvents: [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_fake',
            type: 'message',
            role: 'assistant',
            model: 'fake-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        },
      },
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name: toolName, input: {} } },
      },
      ...partials,
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ],
  }
}

export function startFakeAnthropicServer(scripts: FakeTurn[] | ((requestIndex: number) => FakeTurn)): Promise<FakeAnthropicServer> {
  const queue = Array.isArray(scripts) ? [...scripts] : undefined
  const requests: unknown[] = []
  let count = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = body
      }
      requests.push(parsed)
      const turn = queue !== undefined ? queue.shift() : (scripts as (n: number) => FakeTurn)(count++)
      if (!turn) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: '脚本耗尽：无更多回合' }))
        return
      }
      const send = (): void => {
        const body = parsed as { stream?: boolean }
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          for (const ev of turn.sseEvents) {
            res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`)
          }
          res.end()
        } else {
          // 非流式（generateText 等）：单条完整消息 JSON
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'msg_fake',
              type: 'message',
              role: 'assistant',
              model: 'fake-model',
              content: [{ type: 'text', text: turn.text ?? '' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
          )
        }
      }
      if (turn.delayMs !== undefined && turn.delayMs > 0) setTimeout(send, turn.delayMs)
      else send()
    })
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}
