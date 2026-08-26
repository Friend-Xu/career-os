import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { createJobFile } from '../storage/job-watcher.ts'
import { createSubmitJdAnalysisTool } from '../agent/tools/jd-proposal-tool.ts'

const jobId = '2026-08-07-Company-A 医疗-管理培训生'

function setup() {
  const ws = initWorkspace(mkdtempSync(join(tmpdir(), 'cos-jdtool-')))
  ws.write('knowledge/skills.md', '# 技能词表\n')
  createJobFile(
    ws,
    {
      company: 'Company-A 医疗',
      title: '管理培训生',
      location: 'City-Y',
      salary: '8-15k·15薪',
      requirements: '熟练使用办公软件;数据整理与文案',
      jdText: '任职要求 1：本科/硕士/博士应届生。',
    },
    new Date('2026-08-07T00:00:00Z'),
  )
  return ws
}

test('submit_jd_analysis：合法 Proposal → 岗位智能段写入 + written 回执', async () => {
  const ws = setup()
  const t = createSubmitJdAnalysisTool(ws)
  const out = await t.execute!(
    {
      jobId,
      context: { workMode: [{ value: '轮岗学习', source: '岗位定位', confidence: 'high' }] },
      constraints: {
        education: { values: ['本科', '硕士', '博士'], source: '任职要求 1', confidence: 'high' },
        major: { values: ['生物医学工程'], source: '任职要求 2', confidence: 'medium' },
      },
      capabilities: [
        {
          responsibility: '数据整理与文案输出',
          priority: 'must',
          category: 'hard',
          capabilities: ['办公软件', '数据整理'],
          evidencePatterns: ['method', 'validation'],
          questions: ['你用哪些工具整理数据'],
        },
      ],
    },
    { toolCallId: 'test', messages: [], context: {} },
  )
  const parsed = JSON.parse(String(out)) as { written: boolean; skipped: string[]; issueCount: number }
  assert.equal(parsed.written, true)
  assert.equal(parsed.skipped.length, 0)
  assert.equal(parsed.issueCount, 0)
  const md = ws.read(`jobs/${jobId}.md`)
  assert.ok(md.includes('## 岗位智能'), '岗位智能段应写入')
  assert.ok(md.includes('## 岗位理解'), '岗位理解段应写入')
  assert.ok(md.includes('## 岗位门槛'), '岗位门槛段应写入')
})

test('submit_jd_analysis：Anti-Hallucination——source=岗位名称 → 该字段跳过（不写入）', async () => {
  const ws = setup()
  const t = createSubmitJdAnalysisTool(ws)
  const out = await t.execute!(
    {
      jobId,
      constraints: {
        education: { values: ['本科'], source: '岗位名称', confidence: 'high' },
      },
      capabilities: [
        {
          responsibility: '数据整理与文案输出',
          priority: 'must',
          category: 'hard',
          capabilities: ['办公软件', '数据整理'],
          evidencePatterns: ['method'],
          questions: [],
        },
      ],
    },
    { toolCallId: 'test', messages: [], context: {} },
  )
  const parsed = JSON.parse(String(out)) as { written: boolean; skipped: string[]; issueCount: number }
  assert.ok(parsed.skipped.includes('constraints.education.source'), '非法锚点应跳该字段')
  assert.ok(!ws.read(`jobs/${jobId}.md`).includes('## 岗位门槛'), '门槛段整体不应写入（唯一约束行被拒）')
})

test('submit_jd_analysis：岗位文件不存在 → 抛错（诚实失败，不静默）', async () => {
  const ws = setup()
  const t = createSubmitJdAnalysisTool(ws)
  await assert.rejects(() =>
    t.execute!(
      {
        jobId: '不存在-岗位',
        capabilities: [
          {
            responsibility: 'r',
            priority: 'must',
            category: 'hard',
            capabilities: ['c'],
            evidencePatterns: [],
            questions: [],
          },
        ],
      },
      { toolCallId: 'test', messages: [], context: {} },
    ),
  )
})
