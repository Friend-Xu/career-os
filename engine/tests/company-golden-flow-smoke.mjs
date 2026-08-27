/**
 * company-golden-flow-smoke：公司尽调持久化链 Golden Flow（ADR-035 修复验证）。
 *
 * 验证目标：JD 建档（公司占位）→ 公司尽调 Proposal 提交（submit_company_research 提案通道）
 * → Engine 校验 → 公司档案三件套落盘（摘要表 + 尽调详情 + 公司事实段）→ 引擎扫描读到完整档案
 * （companies/list 非 invalid、CompanyAssessment 可评估）。
 *
 * 确定性：不真调模型——直接直调 createSubmitCompanyResearchTool（白盒单测已覆盖工具层；
 * 本脚本走真实 WS 端口 + 真实文件系统 + 引擎扫描，验证「落盘 → 引擎感知 → 投影」串链）。
 *
 * 运行：node tests/company-golden-flow-smoke.mjs（在测试区，需全权限——临时 workspace 写盘）
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { defaultConfig } from '../config.ts'
import { initWorkspace } from '../storage/workspace.ts'
import { createProjection } from '../storage/projection.ts'
import { scanDecisions } from '../storage/report-watcher.ts'
import { DecisionRuntime } from '../runtime/decision-runtime.ts'
import { startServer } from '../transport/websocket.ts'
import { METHODS, EVENTS } from '../transport/protocol.ts'
import { createSubmitCompanyResearchTool } from '../agent/tools/company-research-proposal-tool.ts'
import { createSubmitJdAnalysisTool } from '../agent/tools/jd-proposal-tool.ts'
import { backfillRoleProposalsFromJobs, ensureRoleFromJob } from '../storage/role-derivation.ts'
import { createJobFile, ensureCompanyPlaceholder } from '../storage/job-watcher.ts'

const PORT = 5297
const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} }

const root = mkdtempSync(join(tmpdir(), 'cos-company-golden-'))
const ws = initWorkspace(root)

const config = {
  ...defaultConfig(),
  server: { ...defaultConfig().server, host: '127.0.0.1', port: PORT },
  paths: { ...defaultConfig().paths, workspace: root, db: join(root, '.smoke.db') },
}

const projection = createProjection({ dbPath: config.paths.db, workspace: ws, logger: silentLogger })
projection.syncFromDecisions(scanDecisions(ws))

let failed = 0
function check(name, cond, detail) {
  const ok = Boolean(cond)
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`)
  if (!ok) failed++
}

const server = await startServer({ config, workspace: ws, logger: silentLogger, store: projection, runtime: new DecisionRuntime() })

// ─── WS 客户端 ────────────────────────────────────────────────────────────
const client = new WebSocket(`ws://127.0.0.1:${PORT}`)
await new Promise((res, rej) => {
  client.once('open', res)
  client.once('error', rej)
})
let msgId = 0
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = `r${++msgId}`
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.id !== id) return
      client.off('message', onMsg)
      if (m.error) reject(new Error(m.error.message))
      else resolve(m.result)
    }
    client.on('message', onMsg)
    client.send(JSON.stringify({ id, method, params }))
  })

// ─── Step 1: JD 建档 → 公司占位档案 ──────────────────────────────────────
console.log('── Step 1: JD 建档（公司占位）──')
const jobId = '2026-08-27-Company-G-test-机械工程师'
ensureCompanyPlaceholder(ws, 'Company-G-test', 'City-Z')
createJobFile(
  ws,
  {
    company: 'Company-G-test',
    title: '机械工程师',
    location: 'City-Z',
    salary: '12-18K',
    requirements: '结构设计;SolidWorks;机械原理',
    jdText: '任职要求 1：机械工程本科。任职要求 2：3 年结构设计经验。',
  },
  new Date('2026-08-27T00:00:00Z'),
)
const placeholders = ws.listMarkdown('companies')
check('JD 建档自动带公司占位档案', placeholders.includes('Company-G-test.md'), placeholders.join(','))

// ─── Step 2: 公司尽调 Proposal 提交（提案通道）───────────────────────────
console.log('── Step 2: 公司尽调 Proposal 提交（submit_company_research）──')
const tool = createSubmitCompanyResearchTool(ws)
const out = await tool.execute(
  {
    companyId: 'Company-G-test',
    summary: {
      city: 'City-Z',
      industry: '医疗设备/精密仪器',
      matchScore: '76%',
      riskLevel: '中',
      source: '6 轮并行搜索（2026-08-27，company-research 尽调）',
      tags: '医疗器械, 精密仪器, 研发型',
      contacted: '否',
    },
    detail: '## 一、公司基本面\n\n| 项 | 内容 |\n|---|---|\n| 全称 | Company-G-test |\n| 成立 | 2020 年 |',
    facts: [
      { type: 'CERTIFICATION', value: '高新技术企业', source: '科技部火炬中心认定名单' },
      { type: 'OPPORTUNITY', value: '招聘活跃（近 3 个月有岗位发布）', source: 'BOSS直聘 / 猎聘' },
    ],
  },
  { toolCallId: 'test', messages: [], context: {} },
)
const parsed = JSON.parse(String(out))
check('尽调 Proposal 提交成功（written）', parsed.written === true, JSON.stringify(parsed))
check('尽调 Proposal 无 reject（skipped 空）', parsed.skipped.length === 0, JSON.stringify(parsed.skipped))

// ─── Step 3: 档案三件套落盘 ──────────────────────────────────────────────
console.log('── Step 3: 档案三件套落盘验证 ──')
const md = ws.read('companies/Company-G-test.md')
check('摘要表写入', md.includes('## 分析摘要'), '缺摘要表')
check('match_score 规范格式', md.includes('| match_score | 76% |'), 'match_score 未按契约格式')
check('尽调详情写入', md.includes('## 尽调详情'), '缺尽调详情')
check('公司事实段写入', md.includes('## 公司事实'), '缺公司事实段')
check('占位标记移除', !md.includes('占位档案'), '占位标记仍在')
check('公司事实行（枚举内）', md.includes('| CERTIFICATION | 高新技术企业 |'), '事实行缺失')

// ─── Step 4: 引擎扫描感知（companies/list 非 invalid）───────────────────
console.log('── Step 4: 引擎扫描感知（companies/list）──')
const companies = await rpc(METHODS.listCompanies)
const company = companies.find((c) => c.id === 'Company-G-test')
check('companies/list 返回公司', Boolean(company), '未找到 Company-G-test')
check('档案非 invalid（完整尽调）', company && company.validation === undefined, JSON.stringify(company?.validation))
check('字段齐全（city/industry/matchScore/riskLevel）', company && company.city && company.industry && company.matchScore && company.riskLevel, JSON.stringify(company))

// ─── Step 5: 幂等重写（再次尽调覆盖，无重复段）──────────────────────────
console.log('── Step 5: 幂等重写（再次尽调）──')
const out2 = await tool.execute(
  {
    companyId: 'Company-G-test',
    summary: {
      city: 'City-Z',
      industry: '医疗设备/精密仪器',
      matchScore: '80%',
      riskLevel: '中',
      source: '6 轮并行搜索（2026-08-27，company-research 尽调·更新）',
      tags: '医疗器械, 精密仪器, 研发型',
      contacted: '是',
    },
    detail: '## 一、公司基本面（更新版）\n\n已联系 HR。',
    facts: [],
  },
  { toolCallId: 'test2', messages: [], context: {} },
)
const md2 = ws.read('companies/Company-G-test.md')
check('重复尽调无重复摘要表段', (md2.match(/## 分析摘要/g) ?? []).length === 1, '摘要表重复')
check('再次尽调覆盖 match_score', md2.includes('| match_score | 80% |'), '未覆盖')
check('再次尽调 contacted=是', md2.includes('| contacted | 是 |'), '未更新 contacted')

// ─── Step 6: JD 分析 Proposal → 岗位自动入库（roles.md 投影 + 知识层可见）──
console.log('── Step 6: JD 分析落盘 → 岗位档案自动入库 ──')
const jdTool = createSubmitJdAnalysisTool(ws)
const jdOut = await jdTool.execute(
  {
    jobId,
    artifactVersion: 2,
    context: {
      workMode: [{ value: '产品结构设计', source: '岗位职责 1', confidence: 'high' }],
      careerPath: [{ value: '结构工程师 → 主管', source: '岗位职责 2', confidence: 'medium' }],
      industry: [{ value: '医疗器械', source: '企业简介', confidence: 'high' }],
    },
    constraints: {
      education: { values: ['本科'], source: '任职要求 1', confidence: 'high' },
      major: { values: ['机械'], source: '任职要求 1', confidence: 'high' },
    },
    capabilities: [
      {
        responsibility: '结构方案设计',
        priority: 'must',
        category: 'hard',
        capabilities: ['结构设计', 'SolidWorks'],
        evidencePatterns: ['method', 'validation'],
        questions: ['请举例结构设计案例'],
      },
      {
        responsibility: '跨部门协作',
        priority: 'nice',
        category: 'soft',
        capabilities: ['跨部门协作'],
        evidencePatterns: ['scope'],
        questions: ['你协作过的部门'],
      },
    ],
    generatedAt: '2026-08-27T12:00:00Z',
  },
  { toolCallId: 'jd1', messages: [], context: {} },
)
check('JD 分析提案提交成功', JSON.parse(String(jdOut)).written === true, String(jdOut))
check('岗位自动入库：role-proposals/ 出现提案', ws.listMarkdown('role-proposals').length === 1, ws.listMarkdown('role-proposals').join(','))
const rolesMd1 = ws.exists('knowledge/roles.md') ? ws.read('knowledge/roles.md') : ''
check('岗位自动入库：roles.md 含条目', rolesMd1.includes('机械工程师（Company-G-test）'), 'roles.md 缺条目')
check('岗位自动入库：来源可回溯', rolesMd1.includes('来源: JD-Company-G-test-2026-08-27'), rolesMd1)
check(
  '岗位自动入库：技能项（essential/nice-to-have）',
  rolesMd1.includes('- essential: SolidWorks') && rolesMd1.includes('- nice-to-have: 跨部门协作'),
  rolesMd1,
)

// ─── Step 7: 知识层可见（差距分析消费端 = knowledge/graph) ────────────────
console.log('── Step 7: 知识层可见（knowledge/graph）──')
const knowledge = await rpc(METHODS.knowledgeGraph)
const roleInGraph = (knowledge.roles ?? []).some((r) => r.name === '机械工程师' && r.company === 'Company-G-test')
check('knowledge/graph 含岗位条目', roleInGraph, JSON.stringify(knowledge.roles))

// ─── Step 8: 对账补登幂等（已有登记 → 跳过不重建）──────────────────────────
console.log('── Step 8: 对账补登幂等 ──')
const backfill1 = backfillRoleProposalsFromJobs(ws)
check('backfill 跳过已登记（derived=0）', backfill1.derived === 0, JSON.stringify(backfill1))
check('backfill skipped=1（已登记岗位）', backfill1.skipped === 1, JSON.stringify(backfill1))

// ─── 收尾 ────────────────────────────────────────────────────────────────
await client.close()
await server.shutdown()
projection.close()

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAIL`}`)
process.exit(failed === 0 ? 0 : 1)
