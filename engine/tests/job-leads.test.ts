import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { parseJobLeadsMarkdown, scanJobLeads, upsertJobLeads } from '../storage/job-leads.ts'

function setup(): ReturnType<typeof initWorkspace> {
  return initWorkspace(mkdtempSync(join(tmpdir(), 'cos-leads-')))
}

const LEADS_MD = `# 候选公司A

## 岗位线索

| 岗位 | 薪资 | 城市 | 来源 | 链接 | 抓取日期 | 诈骗信号 |
|------|------|------|------|------|---------|---------|
| 结构工程师 | 15-35w | 城市X | 官网 | https://careers.example/1 | 2026-08-16 | - |
| 工艺工程师 | - | 城市X | 招聘平台 | https://jobs.example/2 | 2026-08-16 | 收费内推,保offer |
`

test('解析线索表：行 → JobLead（id/expiresAt 派生，14 天过期）+ 诈骗信号拆分', () => {
  const { leads, validation } = parseJobLeadsMarkdown(LEADS_MD, '候选公司A.md')
  assert.equal(validation, undefined)
  assert.equal(leads.length, 2)
  assert.equal(leads[0]!.id, 'lead_20260816_001')
  assert.equal(leads[0]!.company, '候选公司A')
  assert.equal(leads[0]!.title, '结构工程师')
  assert.equal(leads[0]!.salary, '15-35w')
  assert.equal(leads[0]!.source, '官网')
  assert.equal(leads[0]!.capturedAt, '2026-08-16')
  assert.equal(leads[0]!.expiresAt, '2026-08-30') // +14 天
  assert.deepEqual(leads[0]!.fraudFlags, [])
  assert.equal(leads[1]!.salary, undefined) // '-' → 缺省
  assert.deepEqual(leads[1]!.fraudFlags, ['收费内推', '保offer'])
})

test('必填缺失行 → 跳过 + degraded warn；source 非法 → 按「其他」+ warn', () => {
  const md = LEADS_MD.replace('| 工艺工程师 | - | 城市X | 招聘平台 | https://jobs.example/2 | 2026-08-16 | 收费内推,保offer |\n', '| 坏行 | - | - | - | - | - | - |\n')
    .replace('| 结构工程师 | 15-35w | 城市X | 官网 | https://careers.example/1 | 2026-08-16 | - |', '| 结构工程师 | 15-35w | 城市X | 内推渠道 | https://careers.example/1 | 2026-08-16 | - |')
  const { leads, validation } = parseJobLeadsMarkdown(md, '候选公司A.md')
  assert.equal(validation?.status, 'degraded')
  assert.equal(leads.length, 1) // 坏行跳过
  assert.equal(leads[0]!.source, '其他') // 非法 source → 其他 + warn
})

test('upsertJobLeads：全量覆盖该公司文件；id/expiresAt 派生；非法输入 fail fast', () => {
  const ws = setup()
  try {
    const out = upsertJobLeads(ws, '候选公司A', [
      { title: '结构工程师', salary: '15-35w', city: '城市X', url: 'https://careers.example/1', source: '官网' },
      { title: '工艺工程师', url: 'https://jobs.example/2', source: '招聘平台', fraudFlags: ['收费内推'] },
    ])
    assert.equal(out.length, 2)
    assert.match(out[0]!.id, /^lead_\d{8}_\d{3}$/)
    assert.ok(ws.exists('job-leads/候选公司A.md'))

    // 全量覆盖（刷新语义）：第二次只写 1 条 → 文件只剩 1 条
    const again = upsertJobLeads(ws, '候选公司A', [{ title: '结构工程师', url: 'https://careers.example/1', source: '官网' }])
    assert.equal(again.length, 1)
    assert.equal(scanJobLeads(ws).filter((l) => l.company === '候选公司A').length, 1)

    assert.throws(() => upsertJobLeads(ws, '', [{ title: 'x', url: 'https://a', source: '官网' }]), /company 非空/)
    assert.throws(() => upsertJobLeads(ws, '候选公司A', [{ title: '', url: 'https://a', source: '官网' }]), /title 非空/)
    assert.throws(() => upsertJobLeads(ws, '候选公司A', [{ title: 'x', url: 'https://a', source: '内推' as never }]), /合法值/)
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('scanJobLeads：跨公司聚合 + 稳定排序；无目录 → 空数组', () => {
  const ws = setup()
  try {
    assert.deepEqual(scanJobLeads(ws), [])
    upsertJobLeads(ws, '候选公司B', [{ title: '岗位B', url: 'https://b', source: '官网' }])
    upsertJobLeads(ws, '候选公司A', [{ title: '岗位A', url: 'https://a', source: '官网' }])
    const leads = scanJobLeads(ws)
    assert.deepEqual(leads.map((l) => l.title), ['岗位A', '岗位B']) // 按文件名排序
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})
