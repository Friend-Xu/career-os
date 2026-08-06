/**
 * Process manager — spawn / PID 跟踪 / 进程树终止。
 *
 * - spawn 后立即返回真实 child.pid（由调用方落盘 runtime.json，防记录错误 PID）
 * - taskkill 固定用法 /PID <pid> /T /F（进程树），绝不 /IM（会误伤同名进程）
 * - killTree 幂等：进程已死时 taskkill 返回非零码，吞掉无副作用
 * - isAlive 仅以 ESRCH 判定"不存在"；EPERM 等错误保守按"存活"处理
 */
import { execFileSync, spawn } from 'node:child_process'

export function spawnTracked(def) {
  return spawn(def.command.executable, def.command.args, {
    cwd: def.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

export function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // 进程已消失/权限不足——终止目标已不在，幂等
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code !== 'ESRCH'
  }
}

/** 进程命令行查询（recovery 所有权验证用）。查询失败返回 null（调用方按"不匹配"处理，宁可不杀） */
export function queryCommandLine(pid) {
  try {
    const out = execFileSync(
      'wmic',
      ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine'],
      { encoding: 'utf8', timeout: 5000 },
    )
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    return lines.slice(1).join(' ') || null // 跳过表头行
  } catch {
    return null
  }
}

/** 端口占用者 PID 查询（netstat 监听表，IPv4/IPv6 双栈）。空闲返回 null */
export function findPortOccupier(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(`:${port}`) || !line.includes('LISTENING')) continue
      const pid = line.trim().split(/\s+/).pop()
      if (pid && /^\d+$/.test(pid)) return Number(pid)
    }
  } catch {
    // netstat 失败 → 按"无占用者"处理（后续 spawn 失败会显式报错，不静默）
  }
  return null
}
