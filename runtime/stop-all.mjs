/**
 * stop-all — 显式停止入口（stop-all.bat 调用）。
 *
 * 按 runtime.json 记录的所有权（owner + processes PID 树）终止，绝不按端口/镜像名杀。
 * 杀完后删除 runtime.json = 干净关闭标记（下次启动直接 clean，无 recovery 开销）。
 * 进程已死（taskkill 幂等）或状态文件缺失（未运行）都正常退出。
 */
import { killTree } from './process-manager.mjs'
import { loadRuntimeState, removeRuntimeState } from './runtime-store.mjs'

const state = loadRuntimeState()
if (!state) {
  console.log('[runtime] 未在运行（无 runtime.json）')
  process.exit(0)
}

const targets = [state.owner?.pid, ...(state.processes ?? []).map((p) => p.pid)].filter(Boolean)
for (const pid of targets) killTree(pid)

removeRuntimeState()
console.log(`[runtime] 已停止（session ${state.session ?? 'unknown'} · ${targets.length} 个进程树终止）`)
