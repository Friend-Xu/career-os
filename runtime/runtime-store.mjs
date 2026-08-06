/**
 * Runtime state store — runtime.json 原子读写。
 *
 * 原子性：writeFileSync 到 .tmp + renameSync 原子替换（同目录 rename 是原子的）。
 * runtime.json 存在 = 上次会话未干净关闭（recovery 判据）；删除 = clean shutdown 标记。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const STATE_PATH = resolve(import.meta.dirname, 'state/runtime.json')

export function loadRuntimeState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return null // 不存在或损坏 → 视为无状态（损坏时宁可不杀，也不误杀）
  }
}

export function writeRuntimeState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  const tmp = `${STATE_PATH}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, STATE_PATH)
}

export function removeRuntimeState() {
  try {
    rmSync(STATE_PATH, { force: true })
  } catch {
    // 删除失败不阻塞关闭流程——下次启动 recovery 会兜底
  }
}
