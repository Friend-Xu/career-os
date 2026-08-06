/**
 * Shutdown manager — 统一关闭序列（SIGINT / SIGBREAK / SIGHUP / 子进程退出共用）。
 *
 * 状态迁移（约束：干净关闭标记 = runtime.json 删除，中间态必须可区分）：
 *   running → stopping（落盘）→ kill 子进程树 → 轻量复核 → 删除 runtime.json → exit
 *
 * 同步执行、不等待：Windows console close 的清理窗口约 5 秒，任何 await/sleep
 * 都会把进程拖入 libuv SIGHUP 的 Sleep(INFINITE) 挂死（nodejs/node#10165）。
 * taskkill 返回时进程树已强制终止；复核一次，仍存活则交给下次启动 recovery 兜底。
 */
import { isAlive, killTree } from './process-manager.mjs'

export function createShutdown(state, { writeState, removeState }) {
  let stopping = false
  return function shutdown(reason, exitCode = 0) {
    if (stopping) return
    stopping = true

    state.status = 'stopping'
    state.shutdownReason = reason
    writeState(state)

    const leaked = []
    for (const p of state.processes) {
      if (!p.pid) continue
      killTree(p.pid)
      if (isAlive(p.pid)) leaked.push(p.name)
    }
    if (leaked.length > 0) {
      console.warn(`[runtime] ${leaked.join(', ')} 未立即终止——由下次启动 recovery 兜底`)
    }

    removeState()
    process.exit(exitCode)
  }
}
