/**
 * 真机质量门禁 v3（ADR-030 防退化回归）：fixture 驱动——新增用例 = 加 JSON 文件，零代码改动。
 *
 * JD Gate v2（四指标，分层防误杀不放松底线）：
 *   Schema 100% | Required field coverage ≥95% | Semantic coverage ≥80% | Critical omission = 0
 *   （critical = fixture 声明的关键要求项（如"PLC（西门子/三菱）编程调试"），漏掉直接失败——
 *    防止"语义相似但丢了关键限定"的通过）
 * Person Gate（对抗用例，fixture 声明 gate）：
 *   完整 Artifact ≥ minFiles | 事实引用 100% 有效 | 幻觉（无引用断言）= 0 | Decision Trace 100%
 *   | forbidden 断言（如"具备图像处理能力"）不得出现 | requiredMarkers（如"信息不足/冲突"）必须出现
 *
 * 凭据契约：env > config 由 resolveAgentConnection 统一解析。
 * 报告：.local/quality-report.md；effective prompt 存档 .local/quality-effective-prompt-*.md
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { loadConfig, resolveAgentConnection, REPO_ROOT } from '../config.ts'
import { resolveLanguageModel } from '../agent/providers/model.ts'
import { extractJdFieldsDirect } from '../runtime/jd-extract.ts'
import { createAgentRunner } from '../agent/capability/agent-runner.ts'
import { initWorkspace } from '../storage/workspace.ts'
import { createLogger } from '../logger.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'agent', 'fixtures', 'synthetic')
const LOCAL_DIR = resolve(REPO_ROOT, '.local')
const REPORT_PATH = join(LOCAL_DIR, 'quality-report.md')

const logger = createLogger({ logsDir: join(REPO_ROOT, 'logs') })

function normalize(s) {
  return String(s ?? '').toLowerCase().replace(/[\s（）()【】[\]：:、，,。.··「」'"]/g, '')
}
/** 同义归一（岗位语义近义；有限集合，fixture 演进时补充） */
const SYNONYMS = [
  ['程序编写', '编程'],
  ['编码', '编程'],
  ['制图', '绘图'],
  ['开发设计', '设计开发'],
  ['研发设计', '设计开发'],
]
function canonSyn(s) {
  for (const [from, to] of SYNONYMS) s = s.replaceAll(from, to)
  return s
}
/** 去常见填充词（熟练使用/熟悉/优先/至少/经验等 + 连词）——它们在语义上不改变要求主体 */
function stripFiller(s) {
  return String(s ?? '').replace(/熟练使用|熟练掌握|熟悉|了解|掌握|会使用|至少|优先|相关|专业|要求|经验|能力|具备|以上|与|和|及/g, '')
}
function semMatch(a, b) {
  // "或"分解：任一侧含"或"时按备选拆开，任一对备选匹配即视为整体匹配
  // （模型可能把"A或B"拆成两条（A 与 B），也可能保留一条——跨条/单条都要认）
  const expand = (s) => canonSyn(normalize(s)).split(/或/g)
  const la = expand(a)
  const lb = expand(b)
  if (la.length > 1 || lb.length > 1) {
    for (const x of la) for (const y of lb) if (semMatchPart(x, y)) return true
    return false
  }
  return semMatchPart(la[0], lb[0])
}
function semMatchPart(na, nb) {
  if (na === nb) return true
  const fa = stripFiller(na)
  const fb = stripFiller(nb)
  if (fa !== '' && fb !== '' && (fa.includes(fb) || fb.includes(fa))) return true
  const ta = new Set(na.split(/[+＋/·]/).filter(Boolean))
  const tb = new Set(nb.split(/[+＋/·]/).filter(Boolean))
  const inter = [...ta].filter((x) => tb.has(x)).length
  return ta.size + tb.size > 0 && inter / Math.max(ta.size + tb.size - inter, 1) > 0.5
}

async function runJdGate(model, rows, promptDumps) {
  console.log('\n── Part 1：JD Gate v2（schema/coverage/semantic/critical-omission）──')
  for (const f of readdirSync(join(FIXTURES, 'jd')).filter((x) => x.endsWith('.json'))) {
    const fx = JSON.parse(readFileSync(join(FIXTURES, 'jd', f), 'utf8'))
    let r
    try {
      r = await extractJdFieldsDirect(fx.jdText, model, logger)
    } catch (err) {
      // 单例失败不中止整轮：记为 FAIL（门禁记录真实失败，防"跑得通"掩盖闪断）
      const msg = err instanceof Error ? err.message : String(err)
      rows.push({ part: 'JD', id: fx.id, detail: `提取失败：${msg.slice(0, 80)}`, score: 0 })
      console.log(`✘ ${fx.id} 提取失败：${msg.slice(0, 80)}`)
      continue
    }
    const exp = fx.expected
    // Schema correctness：字段齐全 + 类型正确
    const schemaOk =
      typeof r.company === 'string' &&
      typeof r.title === 'string' &&
      Array.isArray(r.requirements) &&
      (r.location === undefined || typeof r.location === 'string') &&
      (r.salary === undefined || typeof r.salary === 'string')
    // Required field coverage：核心字段（公司/岗位 + 期望出现的地点/薪资）
    const core = [
      ['company', exp.company],
      ['title', exp.title],
      ...(exp.location ? [['location', exp.location]] : []),
      ...(exp.salary ? [['salary', exp.salary]] : []),
    ]
    const coreHit = core.filter(([k, e]) => semMatch(r[k], e)).length
    const coverage = coreHit / core.length
    // Semantic coverage：核心字段 + 全部要求项（不逐字）
    const reqMiss = exp.requirements.filter((req) => !(r.requirements ?? []).some((x) => semMatch(x, req)))
    const semantic = (coreHit + (exp.requirements.length - reqMiss.length)) / (core.length + exp.requirements.length)
    // Critical omission：fixture 声明的关键要求项，漏掉 → gate 失败
    const criticalMiss = (exp.critical ?? []).filter((c) => !(r.requirements ?? []).some((x) => semMatch(x, c)))
    const pass = schemaOk && coverage >= 0.95 && semantic >= 0.8 && criticalMiss.length === 0
    rows.push({
      part: 'JD',
      id: fx.id,
      detail: `schema=${schemaOk ? '✔' : '✘'} cov=${(coverage * 100).toFixed(0)}% sem=${(semantic * 100).toFixed(0)}% critical=${criticalMiss.length}`,
      score: pass ? 1 : 0,
    })
    console.log(`${pass ? '✔' : '✘'} ${fx.id} cov=${(coverage * 100).toFixed(0)}% sem=${(semantic * 100).toFixed(0)}% critical=${criticalMiss.length}${criticalMiss.length > 0 ? `（漏：${criticalMiss.join('；')}）` : ''}`)
    // 提取明细转储（人工审阅：critical 漏项归因用）
    writeFileSync(
      join(LOCAL_DIR, `quality-jd-${fx.id}.md`),
      [`# JD 提取明细（${fx.id}）`, '', '## 实际提取', '', '```json', JSON.stringify(r, null, 2), '```', '', '## 期望（critical 加粗标注）', '', ...exp.requirements.map((req) => `- ${(exp.critical ?? []).includes(req) ? '**[critical]** ' : ''}${req}`), ''].join('\n'),
      'utf8',
    )
  }
}

async function runPersonGate(model, rows, promptDumps) {
  console.log('\n── Part 2：Person 对抗门禁（引用有效/幻觉/trace/forbidden/required）──')
  const files = readdirSync(join(FIXTURES, 'person')).filter((x) => x.endsWith('.json')).sort()
  for (const f of files) {
    const person = JSON.parse(readFileSync(join(FIXTURES, 'person', f), 'utf8'))
    const gate = person.gate ?? { minFiles: 1, forbidden: [], requiredMarkers: [] }
    const ws = initWorkspace(mkdtempSync(join(tmpdir(), `cos-q-${person.id}-`)))
    for (const [rel, content] of Object.entries(person.facts)) ws.write(rel, content)
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 180_000)
    const handle = createAgentRunner({
      task: person.task,
      model,
      workspace: ws,
      allowedTools: ['Read', 'Write'],
      permissionMode: 'bypassPermissions',
      abortController: abort,
      logger,
    })
    let doneText = ''
    for await (const ev of handle.events) {
      if (ev.type === 'question_request') handle.answer('素材已就绪，请勿提问，直接基于 facts/ 素材继续执行')
      if (ev.type === 'done') doneText = ev.result
    }
    clearTimeout(timeout)
    const proposals = ws.listFiles('.').filter((x) => x.startsWith('persons/') && x.endsWith('.md'))
    const facts = Object.keys(person.facts)
    let claims = 0
    let traceable = 0
    let citationsTotal = 0
    let citationsValid = 0
    let hallucination = 0
    const allText = proposals.map((p) => ws.read(p)).join('\n') + '\n' + doneText
    for (const p of proposals) {
      const text = ws.read(p)
      const claimLines = (text.match(/^- .+$/gm) ?? []).filter((l) => l.includes('：') && !/facts\//.test(l))
      const evidenceLines = (text.match(/^- .*facts\//gm) ?? [])
      const refs = text.match(/facts\/[a-z]+\.md/g) ?? []
      claims += claimLines.length
      citationsTotal += refs.length
      citationsValid += refs.filter((m) => facts.includes(m)).length
      if (claimLines.length > 0 && evidenceLines.length > 0) traceable += claimLines.length
      if (claimLines.length > 0 && refs.length === 0) hallucination++
    }
    const structureOk = proposals.length >= (gate.minFiles ?? 1) && proposals.every((p) => /## 方向主张/.test(ws.read(p)) && /## 事实依据/.test(ws.read(p)))
    const traceRate = claims > 0 ? traceable / claims : 0
    // forbidden 只扫产物 + 否定上下文感知（"未记录图像处理能力"/"不具备…"是正确表达，不判幻觉）
    const proposalText = proposals.map((p) => ws.read(p)).join('\n')
    const forbiddenHits = gate.forbidden.filter((re) => {
      const rx = new RegExp(re, 'g')
      let hit = false
      for (const m of proposalText.matchAll(rx)) {
        const ctx = proposalText.slice(Math.max(0, m.index - 14), m.index)
        if (/(未|不|无|缺乏|无法|未含|未记录|没有|未曾|不具备|未具备)[^，。；\n]{0,6}$/.test(ctx)) continue
        hit = true
        break
      }
      return hit
    })
    // requiredAny：OR 语义——至少命中一个标记即视为表达了该行为（如"信息不足"有多种措辞）
    const markerHit = gate.requiredMarkers.some((re) => new RegExp(re).test(proposalText + '\n' + doneText))
    const markerMiss = gate.requiredMarkers.length > 0 && !markerHit ? gate.requiredMarkers : []
    const pass = structureOk && citationsValid === citationsTotal && hallucination === 0 && traceRate === 1 && forbiddenHits.length === 0 && markerMiss.length === 0
    rows.push({
      part: 'Person',
      id: person.id,
      detail: `file=${proposals.length} 引用=${citationsValid}/${citationsTotal} 幻觉=${hallucination} trace=${traceRate.toFixed(2)} forbidden=${forbiddenHits.length}${markerMiss.length > 0 ? ` 缺标记:${markerMiss.join('|')}` : ''}`,
      score: pass ? 1 : 0,
    })
    console.log(`${pass ? '✔' : '✘'} ${person.id} 引用=${citationsValid}/${citationsTotal} 幻觉=${hallucination} trace=${traceRate.toFixed(2)} forbidden=${forbiddenHits.length}${markerMiss.length > 0 ? ` 缺标记:${markerMiss.join('|')}` : ''}`)
    if (forbiddenHits.length > 0) console.log(`   ⚠ forbidden 命中：${forbiddenHits.join('；')}`)
    promptDumps.push({
      file: `quality-effective-prompt-${person.id}.md`,
      content: [
        `# effective prompt（${person.id}，${new Date().toISOString()}）`,
        '',
        `model: ${model.modelId ?? '-'}`,
        '',
        '```',
        person.task,
        '```',
        '',
        '## 事实素材（ws 内可 Read）',
        '',
        ...Object.entries(person.facts).map(([rel, content]) => `### ${rel}\n\n${content}\n`),
        '',
      ].join('\n'),
    })
    // 产物转储（人工审阅：确定标尺/复现问题用）
    writeFileSync(
      join(LOCAL_DIR, `quality-proposals-${person.id}.md`),
      [`# 提案产物转储（${person.id}）`, '', ...proposals.map((p) => `## ${p}\n\n${ws.read(p)}\n`), '', `## done 文本\n\n${doneText}`, ''].join('\n'),
      'utf8',
    )
  }
}

async function main() {
  const { config } = loadConfig([])
  const conn = resolveAgentConnection(config)
  if (!conn || !conn.apiKey) {
    console.error('❌ 未配置服务商/无凭据。凭据契约：COS_LLM_API_KEY=xxx 覆盖 config（env > config）')
    process.exitCode = 1
    return
  }
  const { model } = resolveLanguageModel(conn)
  console.log(`模型：${conn.model}（${conn.baseUrl ?? '默认端点'}）凭据来源：${conn.credentialSource}`)

  const rows = []
  const promptDumps = []
  await runJdGate(model, rows, promptDumps)
  await runPersonGate(model, rows, promptDumps)

  const lines = [
    `# 真机质量门禁报告 v3（${new Date().toISOString()}）`,
    '',
    `模型：${conn.model}（${conn.baseUrl ?? '默认端点'}）凭据来源：${conn.credentialSource}`,
    '',
    `| 部分 | 用例 | 结果 | 明细 |`,
    `|---|---|---|---|`,
    ...rows.map((r) => `| ${r.part} | ${r.id} | ${r.score === 1 ? '✅' : '❌'} | ${r.detail} |`),
    '',
    `**通过线**：JD = schema 100% + coverage ≥95% + semantic ≥80% + critical omission 0；`,
    `Person = 文件达标 + 引用 100% + 幻觉 0 + trace 100% + forbidden 0 + required 标记命中。`,
    '',
  ]
  mkdirSync(LOCAL_DIR, { recursive: true })
  writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8')
  for (const d of promptDumps) writeFileSync(join(LOCAL_DIR, d.file), d.content, 'utf8')
  console.log(`\n报告：${REPORT_PATH}`)
  process.exitCode = rows.every((r) => r.score === 1) ? 0 : 1
}

main().catch((err) => {
  console.error('❌ 质量门禁失败：', err.message ?? err)
  console.error('提示：401 → COS_LLM_API_KEY=有效key 重跑（凭据契约 env > config）')
  process.exitCode = 1
})
