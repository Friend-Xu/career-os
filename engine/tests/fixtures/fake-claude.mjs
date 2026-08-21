/**
 * fake-claude：受控假 Claude CLI（Agent 链路 Smoke 的确定性替身）。
 *
 * 用途：agent-golden-flow-smoke.mjs 通过 CLAUDE_CODE_ENTRYPOINT 环境变量让
 * claude-agent-sdk 以 `node <本脚本> <prompt> ...` 方式 spawn 本脚本——
 * 不真调模型，固定输出最小 stream-json 帧序列（system init → assistant →
 * result success）后退出，从而以 100% 确定性触发引擎的 done 事件钩子。
 *
 * SDK 侧行为（已验证）：CLAUDE_CODE_ENTRYPOINT 已设置则不覆盖（sdk.mjs
 * `if(!c.CLAUDE_CODE_ENTRYPOINT) c.CLAUDE_CODE_ENTRYPOINT="sdk-ts"`）。
 * 假 CLI 忽略全部 CLI 参数与 stdin 输入（SDK 用 argv prompt 模式）。
 *
 * 环境变量：
 * - FAKE_CLAUDE_DELAY_MS：输出前延迟（默认 2000）——给 smoke 留出
 *   agent/start 之后写 proposal 文件的时间窗（模拟 Agent 产出早于 done）。
 *
 * 运行：由 SDK 直接 spawn（不手动运行）。
 */
process.stdin.resume()
process.stdin.on('data', () => {
  /* 消费 stdin 防 EPIPE 背压（SDK 可能保持输入流打开） */
})

const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 2000)

setTimeout(() => {
  const session = `fake-${Date.now()}`
  const frames = [
    {
      type: 'system',
      subtype: 'init',
      session_id: session,
      cwd: process.cwd(),
      tools: [],
      model: 'claude-sonnet-4-0',
      permissionMode: 'bypassPermissions',
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'smoke' }],
      },
      session_id: session,
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'smoke done',
      session_id: session,
    },
  ]
  for (const f of frames) process.stdout.write(JSON.stringify(f) + '\n')
  process.exit(0)
}, delay)
