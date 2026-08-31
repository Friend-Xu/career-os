import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { ensureCompanyPlaceholder } from '../storage/job-watcher.ts'
import { createSubmitCompanyResearchTool } from '../agent/tools/company-research-proposal-tool.ts'
import { COMPANY_FACT_VALUES } from '../runtime/company-research-validator.ts'

const companyId = 'Company-B 电子科技'

function setup() {
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), 'cos-crtool-')))
  return ws
}

function validProposal() {
  return {
    companyId,
    summary: {
      city: 'City-Y',
      industry: '工业自动化',
      matchScore: '74%',
      riskLevel: '中',
      source: '6 轮并行搜索（2026-08-07，company-research 尽调）',
      tags: 'design house, 外企, 项目制',
      contacted: '否',
      aliases: 'Company-B 科技',
    },
    detail: '## 一、公司基本面\n\n| 项 | 内容 |\n|---|---|\n| 全称 | Company-B 电子科技 |',
    facts: [
      { type: 'CERTIFICATION', value: '高新技术企业', source: '科技部火炬中心认定名单', url: 'https://example.com' },
      { type: 'OPPORTUNITY', value: '招聘活跃（近 3 个月有岗位发布）', source: 'BOSS直聘 / 猎聘' },
    ],
  }
}

test('submit_company_research：合法 Proposal → 三件套写入 + written 回执', async () => {
  const ws = setup()
  const t = createSubmitCompanyResearchTool(ws)
  const out = await t.execute!(validProposal(), { toolCallId: 'test', messages: [], context: {} })
  const parsed = JSON.parse(String(out)) as { written: boolean; skipped: string[]; issueCount: number }
  assert.equal(parsed.written, true)
  assert.equal(parsed.skipped.length, 0)
  assert.equal(parsed.issueCount, 0)
  const md = ws.read(`companies/${companyId}.md`)
  assert.ok(md.includes('## 分析摘要'), '摘要表段应写入')
  assert.ok(md.includes('| match_score | 74% |'), 'match_score 应写入')
  assert.ok(md.includes('## 尽调详情'), '尽调详情段应写入')
  assert.ok(md.includes('## 公司事实'), '公司事实段应写入')
  assert.ok(md.includes('| CERTIFICATION | 高新技术企业 |'), '事实行应写入')
})

test('submit_company_research：占位档案 → 升级同一文件名（不新建第二份）', async () => {
  const ws = setup()
  ensureCompanyPlaceholder(ws, companyId, 'City-Y')
  const before = ws.listMarkdown('companies')
  const t = createSubmitCompanyResearchTool(ws)
  await t.execute!(validProposal(), { toolCallId: 'test', messages: [], context: {} })
  const after = ws.listMarkdown('companies')
  assert.equal(before.length, 1, '占位创建 + 无新建')
  assert.equal(after.length, 1, '升级不新建（同文件名）')
  const md = ws.read(`companies/${companyId}.md`)
  assert.ok(md.includes('## 尽调详情'), '占位被升级为完整档案')
  assert.ok(!md.includes('占位档案：JD 建档自动创建'), '占位标记已移除')
})

test('submit_company_research：match_score 带注释 → reject（不写入）', async () => {
  const ws = setup()
  const t = createSubmitCompanyResearchTool(ws)
  const p = validProposal()
  p.summary.matchScore = '中（方向相关：非标自动化；年限不达标）'
  const out = await t.execute!(p, { toolCallId: 'test', messages: [], context: {} })
  const parsed = JSON.parse(String(out)) as { skipped: string[]; issueCount: number }
  assert.ok(parsed.skipped.includes('summary.matchScore'), '非法 matchScore 应 skip')
  assert.ok(parsed.issueCount >= 1)
  const md = ws.read(`companies/${companyId}.md`)
  assert.ok(!md.includes('中（方向相关'), '非法值不应写入档案')
})

test('submit_company_research：contacted 非法值 → reject', async () => {
  const ws = setup()
  const t = createSubmitCompanyResearchTool(ws)
  const p = validProposal()
  p.summary.contacted = 'HR 主动来询，待回复' as never
  const out = await t.execute!(p, { toolCallId: 'test', messages: [], context: {} })
  const parsed = JSON.parse(String(out)) as { skipped: string[] }
  assert.ok(parsed.skipped.includes('summary.contacted'), '非法 contacted 应 skip')
})

test('submit_company_research：事实段枚举外值 → warn（记录不拒写，计分侧不计分）', async () => {
  const ws = setup()
  const t = createSubmitCompanyResearchTool(ws)
  const p = validProposal()
  p.facts!.push({ type: 'RISK', value: '老板很抠（非枚举）', source: '员工评价' } as never)
  const out = await t.execute!(p, { toolCallId: 'test', messages: [], context: {} })
  const parsed = JSON.parse(String(out)) as { skipped: string[]; issueCount: number; issues: { severity: string; reason: string }[] }
  assert.ok(parsed.issueCount >= 1)
  assert.ok(parsed.issues.some((i) => i.severity === 'warn'), '枚举外 = warn 非 reject')
  assert.equal(parsed.skipped.includes('facts[1].value'), false, 'warn 不 skip（写入但计分侧忽略）')
})

test('validateCompanyResearchProposal：枚举表与契约 §4 对齐（规则表派生，13 个 value）', () => {
  assert.equal(COMPANY_FACT_VALUES.length, 13, '§4 规则表 13 行（v2 补 GROWTH）')
  assert.ok(COMPANY_FACT_VALUES.includes('国家级专精特新小巨人'))
  assert.ok(COMPANY_FACT_VALUES.includes('大额诉讼 / 劳动纠纷频繁'))
  assert.ok(COMPANY_FACT_VALUES.includes('营收增长（近 1 年）'), 'GROWTH 枚举必须从 ASSESSMENT_RULES 派生')
})

test('submit_company_research：重复尽调 → 同段替换（无重复段落）', async () => {
  const ws = setup()
  const t = createSubmitCompanyResearchTool(ws)
  await t.execute!(validProposal(), { toolCallId: 'test', messages: [], context: {} })
  const p2 = validProposal()
  p2.summary.matchScore = '78%'
  await t.execute!(p2, { toolCallId: 'test', messages: [], context: {} })
  const md = ws.read(`companies/${companyId}.md`)
  assert.equal((md.match(/## 分析摘要/g) ?? []).length, 1, '摘要表只一段（替换不追加）')
  assert.ok(md.includes('| match_score | 78% |'), '第二次覆盖第一次')
})
