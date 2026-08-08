/**
 * 引擎进程管理（解决「启动后杀不干净」根因——npm 壳被杀、node 主进程成孤儿，端口残留）。
 * - start：spawn node main.ts（直接子进程，不经 npm 壳）→ 写 .local/engine.pid → 端口预检 fail fast
 * - stop：taskkill /PID <pid> /T /F（Windows 进程树——连壳带主进程全杀）→ 删 pid 文件 → 验证端口释放
 * - status：pid 存活 + 5289 端口监听检查
 *
 * 用法：node scripts/engine.mjs start|stop|status
 * 约定：启动/停止引擎一律走本脚本（UI 侧 TaskStop 只杀外层壳，会留孤儿——本脚本 stop 才是权威停止）
 */
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE_DIR = path.join(ROOT, 'engine')
const PID_FILE = path.join(ROOT, '.local', 'engine.pid')
const PORT = 5289

function portListening(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' })
    return out.includes('LISTENING')
  } catch {
    return false
  }
}

function readPid() {
  try {
    return existsSync(PID_FILE) ? Number(readFileSync(PID_FILE, 'utf8').trim()) : null
  } catch {
    return null
  }
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    execSync(`tasklist /FI "PID eq ${pid}" /FO CSV`, { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

function killTree(pid) {
  if (process.platform === 'win32') {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* 已退出 */
    }
  }
}

function start() {
  if (portListening(PORT)) {
    console.error(`[engine] 端口 ${PORT} 已被占用——先停止旧进程（node scripts/engine.mjs stop，或手动关闭占用进程）`)
    process.exit(1)
  }
  const pid = readPid()
  if (pid && pidAlive(pid)) {
    console.error(`[engine] 引擎已在运行（pid ${pid}）——先停止：node scripts/engine.mjs stop`)
    process.exit(1)
  }
  mkdirSync(path.join(ROOT, '.local'), { recursive: true })
  const child = spawn('node', ['main.ts'], { cwd: ENGINE_DIR, stdio: 'inherit' })
  writeFileSync(PID_FILE, String(child.pid), 'utf8')
  console.log(`[engine] 启动（pid ${child.pid}）→ ws://127.0.0.1:${PORT}`)
  child.on('exit', (code, signal) => {
    try {
      unlinkSync(PID_FILE)
    } catch {
      /* 已清理 */
    }
    console.log(`[engine] 退出（code=${code} signal=${signal ?? ''}）`)
    process.exit(code ?? 0)
  })
}

function stop() {
  const pid = readPid()
  if (pid && pidAlive(pid)) {
    killTree(pid)
    console.log(`[engine] 已终止进程树（pid ${pid}）`)
  } else if (portListening(PORT)) {
    console.error(`[engine] 5289 有监听但无 pid 文件——请手动关闭占用进程（netstat -ano | findstr :5289）`)
    process.exit(1)
  } else {
    console.log('[engine] 引擎未在运行')
  }
  try {
    unlinkSync(PID_FILE)
  } catch {
    /* 已清理 */
  }
  setTimeout(() => {
    console.log(portListening(PORT) ? '[engine] 警告：端口仍被占用（进程树未杀净）' : '[engine] 端口已释放')
  }, 800)
}

function status() {
  const pid = readPid()
  const listening = portListening(PORT)
  console.log(`[engine] pid=${pid ?? '无'} 存活=${pid ? pidAlive(pid) : false} 端口5289=${listening ? '监听中' : '空闲'}`)
}

const cmd = process.argv[2]
if (cmd === 'start') start()
else if (cmd === 'stop') stop()
else if (cmd === 'status') status()
else {
  console.error('用法：node scripts/engine.mjs start|stop|status')
  process.exit(1)
}
