/**
 * regen-companies：用 skill（真实 claude CLI，经 agent 适配层）按新协议
 * 产出公司档案 markdown（## 分析摘要 表），替代旧格式（## 速判摘要）档案。
 * CLI 只产出内容（不写文件），由主会话写入 companies/。
 *
 * 用法：
 *   node scripts/regen-companies.mjs              # 全部旧档案
 *   node scripts/regen-companies.mjs 示例诊断          # 只重生成文件名含"示例诊断"的
 *
 * 输出：stdout 打印每份档案的完整 markdown（--- FILE {name} START --- 分隔）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { query } from '../agent/adapter/claude.ts'
import { defaultConfig } from '../config.ts'

const companiesDir = join(defaultConfig().paths.workspace, 'companies')
const filter = process.argv[2]

const oldFiles = readdirSync(companiesDir)
  .filter((f) => f.endsWith('.md'))
  .filter((f) => !filter || f.includes(filter))
  // 已是新协议格式（含 ## 分析摘要）的档案跳过，只重生成旧格式
  .filter((f) => !readFileSync(join(companiesDir, f), 'utf8').includes('## 分析摘要'))

if (oldFiles.length === 0) {
  console.log('没有匹配的旧档案')
  process.exit(0)
}

console.log(`将重生成 ${oldFiles.length} 份档案：${oldFiles.join(', ')}`)

for (const f of oldFiles) {
  const oldPath = join(companiesDir, f)
  const oldContent = readFileSync(oldPath, 'utf8')
  const name = f.replace(/：求职背调报告\.md$/, '').replace(/\.md$/, '')

  console.log(`\n=== ${name} ===`)
  const task = `你是 Career OS 的公司尽调 agent，为候选人整理公司求职档案（候选人画像与偏好以 workspace persons/ 档案为准，不要臆造方向或城市）。

把下面这份旧版背调报告，按新协议重写为规范公司档案。**不要写任何文件**，把完整 markdown 作为最终回复，放在 \`\`\`markdown 代码块中：

---旧报告开始---
${oldContent.slice(0, 6000)}
---旧报告结束---

markdown 格式必须严格如下（这是引擎解析协议，字段名或表格错一个字符都会解析失败）：

# ${name}

## 分析摘要

| 字段 | 值 |
|------|-----|
| city | <城市> |
| industry | <产业，如 医疗仪器/体外诊断> |
| match_score | <如 82% 或 8.2/10> |
| risk_level | <低/中/中高/高> |
| source | <信息来源> |
| tags | <逗号分隔，如 医疗, 体外诊断> |
| contacted | 否 |

## 尽调详情
<正文 3-6 段：业务概况、岗位机会、求职风险、建议>`

  let text = ''
  let error = null
  try {
    for await (const ev of query(
      {
        task,
        cwd: defaultConfig().paths.workspace,
        permissionMode: 'acceptEdits',
        allowedTools: ['Read', 'Write', 'Edit', 'Grep', 'Glob'],
        maxTurns: 15,
        onPermissionRequest: async (tool) => {
          console.log(`  权限请求：${tool.name} → 自动放行`)
          return true
        },
      },
      (id) => console.log(`  sessionId=${id}`),
    )) {
      if (ev.type === 'text_delta' && ev.text) text += ev.text
      if (ev.type === 'error') error = ev.error
    }
  } catch (err) {
    error = err
  }

  const m = text.match(/```(?:markdown)?\s*([\s\S]*?)```/)
  const content = (m ? m[1] : text).trim()
  const hasSummary = content.includes('## 分析摘要') && content.includes('| 字段 | 值 |')
  console.log(`  结果：${error ? `失败（${JSON.stringify(error).slice(0, 120)}）` : hasSummary ? `已产出且含摘要表 ✓（${content.length} 字符）` : '已产出但格式可疑（缺摘要表）✗'}`)
  if (!hasSummary || error) process.exitCode = 1
  console.log(`--- FILE ${name} START ---`)
  console.log(content)
  console.log(`--- FILE ${name} END ---`)
}
