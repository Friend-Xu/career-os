/**
 * Runtime Dependency Audit（ADR-030 验收 H）：静态审计引擎生产运行时的 CLI 痕迹。
 * 目标：production runtime dependency 中 Claude CLI 相关计数全为 0；benchmark/legacy 保留位不受限。
 * 运行：node tests/runtime-dependency-audit.mjs（不用真实运行时，静态扫描）
 *
 * 审计规则（排除清单 = 明确保留的回归基准位）：
 *   允许：agent/adapter/claude.ts（benchmark/legacy-adapter 保留）、tests/bench-extract.mjs、
 *        tests/fixtures（无）、engine/tests/**（测试资产）
 *   禁止：其余任何 runtime 文件出现 claude-agent-sdk import / ANTHROPIC_ env 读取 / claude spawn
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXCLUDED = [
  'agent/adapter/claude.ts', // benchmark/legacy-adapter 保留位（ADR-030 决策 5）
  'tests/bench-extract.mjs', // A/B benchmark 回归基准
  'tests/', // 测试资产（fixtures/helper 任意）
]

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else if (e.name.endsWith('.ts') || e.name.endsWith('.mjs') || e.name.endsWith('.js')) out.push(full)
  }
  return out
}

const SIGNS = [
  { name: 'claude-agent-sdk import', re: /@anthropic-ai\/claude-agent-sdk/g },
  { name: 'claude CLI spawn/调用', re: /pathToClaudeCodeExecutable|spawn\([^)]*claude|claude\.exe/g },
  { name: 'ANTHROPIC env 读取', re: /process\.env\.ANTHROPIC|ANTHROPIC_BASE_URL\s*=|ANTHROPIC_AUTH_TOKEN\s*=/g },
  { name: '~/.claude settings 读取', re: /\.claude[\\/]settings\.json|USERPROFILE[^)'"]*claude/g },
]

const excluded = (rel) => EXCLUDED.some((e) => rel.startsWith(e))
const findings = []
let scanned = 0
for (const f of walk(ENGINE)) {
  const rel = f.slice(ENGINE.length + 1).replace(/\\/g, '/')
  if (excluded(rel)) continue
  const text = readFileSync(f, 'utf8')
  scanned++
  for (const s of SIGNS) {
    if (s.re.test(text)) {
      s.re.lastIndex = 0
      findings.push({ file: rel, sign: s.name })
    }
  }
}

console.log('┌─ Runtime Dependency Audit（ADR-030 H）──────────────────┐')
console.log(`扫描 runtime 文件：${scanned} 个（排除保留位：claude.ts / bench-extract / tests/）`)
console.log('')
if (findings.length === 0) {
  console.log('✅ 生产运行时 CLI 依赖 = 0（claude-agent-sdk / spawn / ANTHROPIC_* / ~/.claude 全部清零）')
  console.log('✅ 保留位正常：agent/adapter/claude.ts（benchmark 基准）不受本审计约束')
  process.exit(0)
} else {
  console.log('❌ 发现运行时残留：')
  for (const f of findings) console.log(`   ${f.file} → ${f.sign}`)
  process.exit(1)
}
