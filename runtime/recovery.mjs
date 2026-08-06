/**
 * Recovery — 启动自愈（Runtime Safety Layer 兜底层）。
 *
 * 判据链（约束：runtime.json → PID 存活 → 命令行所有权验证，才允许 kill）：
 *   runtime.json 不存在                          → clean（干净启动）
 *   owner PID 存活                              → already-running（拒绝双实例）
 *   process PID 不存在（ESRCH）                 → 跳过（不查命令、无残留）
 *   process PID 存活 + 命令行含项目路径          → killTree
 *   process PID 存活 + 命令行不匹配             → warning + refuse（防 PID 复用误杀他人进程）
 *
 * 任何"存活但查不到命令行 / 查询失败"都按不匹配处理——宁可不杀，不可误杀。
 */
import { resolve } from 'node:path'
import { isAlive, killTree, queryCommandLine } from './process-manager.mjs'
import { loadRuntimeState } from './runtime-store.mjs'

export const PROJECT_ROOT = resolve(import.meta.dirname, '..')

/**
 * 所有权判定。注意：wmic 输出为 GBK（ANSI），中文路径经 UTF-8 解码会乱码——
 * 因此不匹配项目根路径，只匹配 ASCII 特征：便携 node 可执行文件路径（强）+ 入口参数（中）。
 */
export function belongsToProject(cmd) {
  if (!cmd) return false
  return (
    cmd.includes('.local\\node\\node.exe') ||
    cmd.includes('main.ts') ||
    cmd.includes('vite/bin/vite.js') ||
    cmd.includes('vite.js')
  )
}

export function recover() {
  const state = loadRuntimeState()
  if (!state) return { result: 'clean', warnings: [], killed: 0 }

  if (state.owner && isAlive(state.owner.pid)) {
    return { result: 'already-running', state }
  }

  const warnings = []
  let killed = 0
  for (const p of state.processes ?? []) {
    if (!p.pid || !isAlive(p.pid)) continue // ESRCH → 记录已死，不进入命令查询
    const cmd = queryCommandLine(p.pid)
    if (belongsToProject(cmd)) {
      killTree(p.pid)
      killed += 1
    } else {
      warnings.push(
        `${p.name} pid ${p.pid} 存活但命令行不属于本项目（${cmd ? 'PID 复用或迁移' : '查询失败'}）——拒绝清理`,
      )
    }
  }
  if (state.status === 'stopping') {
    warnings.push('上次会话在 stopping 中途被终止（STALE_STOPPING）——本次已按残留清理')
  }
  return { result: killed > 0 ? 'cleaned' : 'stale', killed, warnings, state }
}
