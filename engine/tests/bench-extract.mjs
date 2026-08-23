/**
 * 提取适配器 A/B benchmark（ADR-030 Step 3，手动运行：node tests/bench-extract.mjs）：
 * 合成 fixture（数据边界合规：Company-A/B/C、City-X/Y/Z，与 workspace 真实实体零关联）
 * → 双适配器提取（direct=StructuredExtractor/generateObject，cli=Claude CLI API 模式）
 * → 字段级比较（company/title/location/salary 精确；requirements 用 Jaccard 容忍表述差异）
 * → 控制台表格 + 报告写 ../.local/bench-extract-report.md
 * 门槛：direct 平均准确率 ≥ cli 才切换默认路径。
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, resolveAgentConnection, REPO_ROOT } from '../config.ts'
import { resolveLanguageModel } from '../agent/providers/model.ts'
import { extractJdFieldsDirect } from '../runtime/jd-extract.ts'
import { extractJdFields } from './cli-jd-extract.ts'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'agent', 'fixtures', 'synthetic', 'jd')
const REPORT_PATH = resolve(REPO_ROOT, '.local', 'bench-extract-report.md')

/** 手动运行场景的极简 logger（仅覆盖两条路径用到的 info/trace） */
function benchLogger(label) {
  return {
    info: (m) => console.log(`[${label}] ${m}`),
    warn: (m) => console.warn(`[${label}] ${m}`),
    error: (m) => console.error(`[${label}] ${m}`),
    trace: () => {},
  }
}

function fieldScore(got, expected, field) {
  if (field === 'requirements') {
    const g = new Set((got ?? []).map((r) => r.trim()))
    const e = new Set(expected)
    const inter = [...g].filter((x) => e.has(x)).length
    const union = new Set([...g, ...e]).size
    return union === 0 ? 1 : inter / union
  }
  const g = got === undefined ? undefined : String(got).trim()
  const e = expected === undefined ? undefined : String(expected).trim()
  if (g === undefined && e === undefined) return 1
  return g === e ? 1 : 0
}

function caseAccuracy(result, expected) {
  const fields = ['company', 'title', 'location', 'salary', 'requirements']
  const scores = fields.map((f) => fieldScore(result[f], expected[f], f))
  return scores.reduce((a, b) => a + b, 0) / fields.length
}

function percent(n) {
  return `${(n * 100).toFixed(0)}%`
}

async function main() {
  const { config } = loadConfig([])
  const conn = resolveAgentConnection(config)
  if (!conn) {
    console.error('❌ 未配置 enabled 服务商（career-os.config.json agent.providers）——benchmark 需要直连凭证')
    process.exit(1)
  }
  const { model } = resolveLanguageModel(conn)
  const fixtures = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')))

  const rows = []
  for (const fx of fixtures) {
    const direct = await extractJdFieldsDirect(fx.jdText, model, benchLogger('direct'))
    const cli = await extractJdFields(fx.jdText, {
      cwd: REPO_ROOT,
      model: conn.model,
      apiKey: conn.apiKey,
      baseUrl: conn.baseUrl,
      logger: benchLogger('cli'),
    })
    rows.push({
      id: fx.id,
      expected: fx.expected,
      direct,
      directScore: caseAccuracy(direct, fx.expected),
      cliScore: caseAccuracy(cli, fx.expected),
    })
    console.log(`✔ ${fx.id} direct=${percent(rows.at(-1).directScore)} cli=${percent(rows.at(-1).cliScore)}`)
  }

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length
  const directAvg = avg(rows.map((r) => r.directScore))
  const cliAvg = avg(rows.map((r) => r.cliScore))
  const verdict = directAvg >= cliAvg ? '✅ direct ≥ cli（可切换默认路径）' : '❌ direct < cli（继续用 CLI 路径，回查差异）'

  const lines = [
    `# 提取适配器 A/B benchmark（${new Date().toISOString()}）`,
    '',
    `模型：${conn.model}（${conn.baseUrl ?? '默认端点'}）`,
    '',
    '| fixture | direct | cli | 结论 |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${percent(r.directScore)} | ${percent(r.cliScore)} | ${r.directScore >= r.cliScore ? '≥' : '<'} |`),
    `| **平均** | **${percent(directAvg)}** | **${percent(cliAvg)}** | **${verdict}** |`,
    '',
  ]
  mkdirSync(dirname(REPORT_PATH), { recursive: true })
  writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8')
  console.log(`\n${verdict}`)
  console.log(`报告：${REPORT_PATH}`)
}

main().catch((err) => {
  console.error('❌ benchmark 失败：', err)
  process.exit(1)
})
