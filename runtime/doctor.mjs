/**
 * doctor — 运行时诊断（node runtime/doctor.mjs）。
 *
 * 输出：Supervisor / 各进程 PID 存活 / 端口监听 / state 有效性。
 * 用户反馈"软件打不开"时第一步排查入口。
 */
import { findPortOccupier, isAlive, queryCommandLine } from './process-manager.mjs'
import { loadRuntimeState } from './runtime-store.mjs'
import { belongsToProject } from './recovery.mjs'

const state = loadRuntimeState()

console.log('Runtime Safety Check')
console.log('===================')
if (!state) {
  console.log('未运行（无 runtime.json —— 上次会话干净关闭或从未启动）')
  console.log('启动：StartWebTUI.bat')
  process.exit(0)
}

const ownerAlive = state.owner ? isAlive(state.owner.pid) : false
console.log('Supervisor')
console.log(`  PID:     ${state.owner?.pid ?? '-'}`)
console.log(`  Status:  ${ownerAlive ? state.status : 'DEAD（上次会话异常残留）'}`)
console.log(`  Session: ${state.session ?? '-'}`)

for (const p of state.processes ?? []) {
  const alive = p.pid ? isAlive(p.pid) : false
  const cmd = p.pid ? queryCommandLine(p.pid) : null
  const owned = belongsToProject(cmd)
  console.log(`${p.name[0].toUpperCase()}${p.name.slice(1)}`)
  console.log(`  PID:     ${p.pid ?? '-'}`)
  console.log(`  Alive:   ${alive ? 'yes' : 'no'}`)
  console.log(`  Command: ${p.cmd}`)
  if (alive && !owned) console.log('  WARN:    存活但命令行不属于本项目（PID 复用或项目迁移）——勿手动杀')
}

for (const port of state.ports ?? []) {
  const pid = findPortOccupier(port)
  if (pid == null) {
    console.log(`Port ${port}: free`)
    continue
  }
  const owned = belongsToProject(queryCommandLine(pid))
  console.log(
    `Port ${port}: LISTEN (pid ${pid}${owned ? ', project-owned' : ' — Owner unknown, not project process'})`,
  )
}

console.log('State')
console.log(`  runtime.json: valid (${state.status})`)
