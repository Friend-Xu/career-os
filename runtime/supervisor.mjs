/**
 * Runtime supervisor — Career OS 应用生命周期守护（Runtime Safety Layer v1）。
 *
 * 职责：recovery（启动自愈）→ 写 runtime.json → spawn 并跟踪真实 PID → 统一信号关闭。
 * 进程定义抽象 command/health（约束 3）——CodeNarrator / Translate-video-WebUI 可直接复用。
 *
 * 关闭语义：
 *   SIGINT（Ctrl+C）/ SIGBREAK（Ctrl+Break）→ shutdown(reason)
 *   SIGHUP（Windows 控制台窗口关闭 CTRL_CLOSE，libuv 映射）→ shutdown(reason)——增强而非保障
 *   任一子进程退出 → shutdown（自动重启留 v2）
 *   强杀/崩溃无信号 → runtime.json 残留 → 下次启动 recovery 清理
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { findPortOccupier, killTree, queryCommandLine, spawnTracked } from './process-manager.mjs'
import { createShutdown } from './shutdown-manager.mjs'
import { belongsToProject, recover, PROJECT_ROOT } from './recovery.mjs'
import { removeRuntimeState, writeRuntimeState } from './runtime-store.mjs'

/**
 * spawn 子进程用真实 node：内置便携版优先。
 * fallback 必须用 'node' 字面量走 PATH+PATHEXT 搜索，不能用 process.execPath——
 * git-bash 下 execPath 可能是无 .exe 扩展名的二进制（如 C:\Users\...\bin\node），
 * CreateProcess 对无扩展名路径自动补 .exe 后缀（找不到即失败，ENOENT）。
 */
function nodeForSpawn() {
  const portable = resolve(PROJECT_ROOT, '.local/node', process.platform === 'win32' ? 'node.exe' : 'node')
  return existsSync(portable) ? portable : 'node'
}

const NODE_EXE = nodeForSpawn()

const PROCESSES = [
  {
    name: 'engine',
    cwd: resolve(PROJECT_ROOT, 'engine'),
    command: { executable: NODE_EXE, args: ['main.ts'] },
    health: { ports: [5289] },
  },
  {
    name: 'frontend',
    cwd: resolve(PROJECT_ROOT, 'UI'),
    command: { executable: NODE_EXE, args: ['node_modules/vite/bin/vite.js'] },
    health: { ports: [5288] },
  },
]

const UI_URL = 'http://localhost:5288'

/** 打开默认浏览器（detached 独立进程，不随 supervisor 退出而关闭） */
function openBrowser(url) {
  if (process.platform !== 'win32') return
  spawn('cmd', ['/c', 'start', '', url], { detached: true, windowsHide: true, stdio: 'ignore' }).unref()
}

/** 轮询端口就绪——前端冷启动需要时间，过早打开浏览器会命中 404 */
function waitForPort(port, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (findPortOccupier(port) != null) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() > deadline) {
        clearInterval(timer)
        resolve(false)
      }
    }, 500)
  })
}

/**
 * 端口预检：recovery 覆盖"state 记录的孤儿"，这里覆盖"无 state 但端口被占"——
 * stop-all 半失败（杀了但没删干净）、外部程序占用 5288/5289。
 * 占用者归属项目 → 清理（孤儿兜底）；外部程序 → 明确报错拒绝启动（不 EADDRINUSE 崩溃）。
 */
function preflightPorts() {
  for (const def of PROCESSES) {
    for (const port of def.health.ports) {
      const pid = findPortOccupier(port)
      if (pid == null) continue
      const cmd = queryCommandLine(pid)
      if (belongsToProject(cmd)) {
        killTree(pid)
        console.log(`[runtime] 端口 ${port} 被本项目的孤儿进程（PID ${pid}）占用——已清理`)
        if (findPortOccupier(port) != null) {
          console.error(`[runtime] 端口 ${port} 清理后仍被占用——请手动处理 PID ${pid}`)
          process.exit(1)
        }
      } else {
        console.error(
          `[runtime] 端口 ${port} 被外部进程占用（PID ${pid}${cmd ? `，命令行：${cmd}` : ''}）——非 Career OS 进程，请处理后再启动`,
        )
        process.exit(1)
      }
    }
  }
}

/**
 * 依赖预检：clone 后 node_modules 不存在（gitignored 不入库）——自动执行安装引导。
 * 首次安装需网络，打印明确日志；失败 fail fast 指向 install-deps 手动入口。
 */
function preflightDeps() {
  const missing = PROCESSES.map((p) => resolve(p.cwd, 'node_modules/.package-lock.json')).filter((f) => !existsSync(f))
  if (missing.length === 0) return
  console.log('[runtime] 依赖未安装——首次运行正在安装（npm ci 按 package-lock.json 精确复现，需网络，约 1-3 分钟）...')
  const r = spawnSync(NODE_EXE, [resolve(PROJECT_ROOT, 'scripts/install-deps.mjs')], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error('[runtime] 依赖安装失败——请手动执行 node scripts/install-deps.mjs 查看详细错误后重试')
    process.exit(1)
  }
}

function main() {
  const rec = recover()
  if (rec.result === 'already-running') {
    openBrowser(UI_URL)
    console.error(`[runtime] 已有实例运行中（PID ${rec.state.owner.pid}）。已打开浏览器；关闭请运行 stop-all.bat`)
    process.exit(1)
  }
  if (rec.result === 'cleaned') console.log(`[runtime] 上次会话残留：已清理 ${rec.killed} 个进程`)
  if (rec.warnings.length > 0) for (const w of rec.warnings) console.warn(`[runtime] ${w}`)

  preflightDeps()
  preflightPorts()

  const state = {
    version: 1,
    session: new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14),
    owner: { pid: process.pid, startedAt: new Date().toISOString() },
    processes: PROCESSES.map((p) => ({ name: p.name, pid: null, cmd: p.command.args.join(' ') })),
    ports: PROCESSES.flatMap((p) => p.health.ports),
    status: 'running',
  }
  writeRuntimeState(state)

  const shutdown = createShutdown(state, { writeState: writeRuntimeState, removeState: removeRuntimeState })
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGBREAK', () => shutdown('SIGBREAK'))
  process.on('SIGHUP', () => shutdown('SIGHUP')) // Windows 点 X 关窗口（libuv 把 CTRL_CLOSE 映射为 SIGHUP）

  // 控制台关闭兜底：部分宿主（Windows Terminal 变体等）只销毁 stdin 不送 CTRL_CLOSE——
  // TTY 下 resume 使其收到 EOF 触发关闭。非 TTY（后台任务/重定向）跳过，避免启动即 EOF 误关。
  if (process.stdin.isTTY) {
    process.stdin.resume()
    process.stdin.on('end', () => shutdown('console-closed'))
    process.stdin.on('error', () => shutdown('console-closed'))
  }

  for (const def of PROCESSES) {
    const child = spawnTracked(def)
    // 约束 4：spawn 后立即落盘真实 PID——vite 崩溃后 recovery 仍能找到正确的树
    state.processes.find((p) => p.name === def.name).pid = child.pid
    writeRuntimeState(state)

    child.stdout.on('data', (d) => process.stdout.write(`[${def.name}] ${d}`))
    child.stderr.on('data', (d) => process.stderr.write(`[${def.name}] ${d}`))
    child.on('error', (err) => {
      console.error(`[runtime] ${def.name} spawn 失败：${err.message}`)
      shutdown(`spawn-error:${def.name}`, 1)
    })
    child.on('exit', (code) => {
      console.log(`[runtime] ${def.name} exited (${code})`)
      shutdown(`child-exit:${def.name}`, code ?? 1)
    })
  }

  console.log('[runtime] Career OS 运行中：引擎 ws://127.0.0.1:5289 · 前端 http://localhost:5288')
  console.log('[runtime] 关闭请运行 stop-all.bat（直接关窗口可能残留，下次启动自动清理）')
  console.log(`[runtime] session ${state.session} · PID ${process.pid}`)

  waitForPort(5288).then((ready) => {
    if (ready) {
      openBrowser(UI_URL)
      console.log(`[runtime] 前端就绪——已打开浏览器 ${UI_URL}`)
    } else {
      console.log(`[runtime] 前端 20s 内未就绪——请手动访问 ${UI_URL}`)
    }
  })
}

main()
