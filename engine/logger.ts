/**
 * 日志调试系统（两层）：
 * - 应用日志：level（debug/info/warn/error）+ logs/engine.log 持久化 + 按大小轮转（10MB × 3 份）
 * - Agent 轨迹：logs/traces/{sessionId}-{ts}.jsonl（骨架建好接口，第 2 步填完整轨迹）
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const MAX_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_BACKUPS = 3 // engine.log.1/.2/.3

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
  /** Agent 轨迹：logs/traces/{sessionId}-{ts}.jsonl（每次 query 追加；第 2 步填完整实现） */
  trace(sessionId: string, entry: Record<string, unknown>): void
}

export function createLogger(opts: { logsDir: string; level?: LogLevel }): Logger {
  const { logsDir, level = 'info' } = opts
  const threshold = LEVEL_ORDER[level]
  const logFile = join(logsDir, 'engine.log')
  const tracesDir = join(logsDir, 'traces')
  mkdirSync(logsDir, { recursive: true })
  mkdirSync(tracesDir, { recursive: true })

  function rotateIfNeeded(): void {
    if (!existsSync(logFile)) return
    let size = 0
    try {
      size = statSync(logFile).size
    } catch {
      return
    }
    if (size < MAX_SIZE) return
    for (let i = MAX_BACKUPS; i >= 1; i--) {
      const backup = `${logFile}.${i}`
      if (i === MAX_BACKUPS) {
        if (existsSync(backup)) unlinkSync(backup)
      } else {
        const next = `${logFile}.${i + 1}`
        if (existsSync(backup)) renameSync(backup, next)
      }
    }
    renameSync(logFile, `${logFile}.1`)
  }

  function write(levelName: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[levelName] < threshold) return
    const line = JSON.stringify({ time: new Date().toISOString(), level: levelName, msg, ...meta })
    console.log(`${new Date().toISOString()} [${levelName}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`)
    rotateIfNeeded()
    appendFileSync(logFile, line + '\n', 'utf8')
  }

  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    trace(sessionId, entry) {
      const file = join(tracesDir, `${sessionId}-${Date.now()}.jsonl`)
      appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n', 'utf8')
    },
  }
}
