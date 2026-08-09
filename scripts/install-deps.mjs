#!/usr/bin/env node
/**
 * Career OS 依赖安装引导——clone 后的安装故事（Node 世界没有 requirements.txt：
 * package.json 是依赖声明，package-lock.json 是精确锁定，npm ci 按 lock 精确复现，失败即报错不漂移）。
 *
 * 用法：
 *   node scripts/install-deps.mjs           安装 engine/ + UI/ 依赖（已装则跳过）
 *   node scripts/install-deps.mjs --force   强制重装（npm ci 删 node_modules 重装）
 *   node scripts/install-deps.mjs --check   只检查，缺依赖 exit 1（supervisor preflight 用）
 *
 * 运行时策略：
 *   node 优先内置便携版（.local/node/node.exe，项目内）→ 系统 node（需 ≥24，type-stripping 依赖）
 *   npm 走 PATH（内置便携 node 精简版不带 npm；缺失时给出明确指引）
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIN_NODE = 24
const PROJECTS = [
  { name: 'engine', path: resolve(ROOT, 'engine') },
  { name: 'UI', path: resolve(ROOT, 'UI') },
]
const isWin = process.platform === 'win32'

/** node 可执行：内置便携版优先（项目内运行时，符合环境隔离原则）→ 系统 node */
function resolveNode() {
  const portable = isWin
    ? resolve(ROOT, '.local/node/node.exe')
    : resolve(ROOT, '.local/node/node')
  return existsSync(portable) ? portable : 'node'
}

function run(cmd, args, opts = {}) {
  // Windows 下 npm 是 npm.cmd——直接按名调用，无需 shell 展开（避免 DEP0190）
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  return r.status ?? 1
}

function nodeVersion(node) {
  const r = spawnSync(node, ['--version'], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const m = /^v(\d+)\./.exec(r.stdout.trim())
  return m ? Number(m[1]) : null
}

/**
 * npm-cli.js 入口：win 下 `where npm` 定位 npm.cmd，推导 node_modules/npm/bin/npm-cli.js。
 * 不直接 spawn .cmd（git-bash 下 EINVAL），统一用内置 node 执行 cli——跨环境一致。
 * unix 下用系统 npm 命令。
 */
function resolveNpmCli() {
  if (isWin) {
    const w = spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', 'where', 'npm'], { encoding: 'utf8' })
    if (w.status === 0) {
      const line = w.stdout.split(/\r?\n/).find((l) => /npm\.cmd$/i.test(l.trim()))
      if (line) {
        const cli = resolve(dirname(line.trim()), 'node_modules/npm/bin/npm-cli.js')
        if (existsSync(cli)) return cli
      }
    }
    return null
  }
  return 'npm'
}

function npmVersion(npmCli) {
  const args = isWin ? [npmCli, '--version'] : ['--version']
  const r = spawnSync(isWin ? resolveNode() : npmCli, args, { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

function depsInstalled(projectPath) {
  // npm install/ci 后必然生成 .package-lock.json（lockfile 的安装快照）
  return existsSync(resolve(projectPath, 'node_modules/.package-lock.json'))
}

const args = process.argv.slice(2)
const force = args.includes('--force')
const checkOnly = args.includes('--check')

// 1. node 版本校验（type-stripping 要求 Node ≥24）
const node = resolveNode()
const major = nodeVersion(node)
if (major == null) {
  console.error(`[install] 无法运行 node：${node} 不可执行`)
  process.exit(1)
}
if (major < MIN_NODE) {
  console.error(
    `[install] Node 版本过低：v${major}.x（需要 ≥${MIN_NODE}，type-stripping 依赖）。\n` +
      `  安装 Node ${MIN_NODE}+：https://nodejs.org/ 或 nvm，或将便携版放到 ${resolve(ROOT, '.local/node/')}`,
  )
  process.exit(1)
}
console.log(`[install] node: v${major}.x（${node === 'node' ? '系统' : '内置便携'}）`)

// 2. npm 可用性
const npmCli = resolveNpmCli()
const npmVer = npmVersion(npmCli)
if (!npmVer) {
  console.error(
    '[install] 找不到 npm。\n' +
      '  安装 Node.js 24+（自带 npm）：https://nodejs.org/\n' +
      '  或放置完整便携 Node（含 npm）到 ' + resolve(ROOT, '.local/node/'),
  )
  process.exit(1)
}
console.log(`[install] npm: ${npmVer}`)

// 3. 逐项目安装
let anyMissing = false
for (const p of PROJECTS) {
  if (depsInstalled(p.path) && !force) {
    console.log(`[install] ${p.name}: 依赖已就绪（--force 重装）`)
    continue
  }
  anyMissing = true
  if (checkOnly) {
    console.log(`[install] ${p.name}: 依赖缺失`)
    continue
  }
  console.log(`[install] ${p.name}: 安装依赖（npm ci，按 package-lock.json 精确复现）...`)
  const status = isWin ? run(node, [npmCli, 'ci'], { cwd: p.path }) : run(npmCli, ['ci'], { cwd: p.path })
  if (status !== 0) {
    console.error(`[install] ${p.name}: npm ci 失败（exit ${status}）。检查网络，或 --force 重试。`)
    process.exit(status)
  }
}

if (checkOnly && anyMissing) process.exit(1)
console.log('[install] 完成。')
