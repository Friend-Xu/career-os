/**
 * 一键启动（零依赖）：引擎（engine/main.ts，WS 5289）+ Vite dev（UI，5288）。
 * 任一进程退出 → 关闭另一个；Ctrl+C → 全部退出。Node 24 原生运行：node start-all.mjs
 *
 * 关闭语义（对齐 Playwright processLauncher 模式）：
 * - Windows：taskkill /pid <pid> /T /F 进程树强杀（p.kill() 只杀 npm 壳，node 子进程残留占端口）
 * - POSIX：负 pid 杀进程组
 */
import { spawn, execSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const children = []

function run(name, cwd, cmd, args) {
  const p = spawn(cmd, args, { cwd, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const tag = `[${name}]`
  p.stdout.on('data', (d) => process.stdout.write(`${tag} ${d}`))
  p.stderr.on('data', (d) => process.stderr.write(`${tag} ${d}`))
  p.on('exit', (code) => {
    console.log(`${tag} exited (${code})`)
    shutdown(code ?? 1)
  })
  children.push(p)
  return p
}

/** 进程树强杀：npm 壳下的 node 子进程（vite/main.ts）及其孙进程一并终止 */
function killTree(p) {
  if (p.exitCode != null) return
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: 'ignore' })
    } catch {
      p.kill() // taskkill 失败（进程已消失）→ 直接杀
    }
  } else {
    try {
      process.kill(-p.pid, 'SIGTERM')
    } catch {
      p.kill()
    }
  }
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const p of children) killTree(p)
  setTimeout(() => process.exit(code), 500)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log('Career OS 一键启动：引擎 (ws://127.0.0.1:5289) + 前端 (http://localhost:5288)')
console.log('日志：logs/engine.log · 按 Ctrl+C 全部退出')
run('engine', resolve(root, 'engine'), 'node', ['main.ts'])
run('ui', resolve(root, 'UI'), npm, ['run', 'dev'])
