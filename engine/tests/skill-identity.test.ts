/**
 * buildSkillIdentity 契约测试：Agent 任务上下文注入的协议面完整性——
 * 2026-08-22 真机定位：仅 1500 字符截断导致城市评估 Agent 拿不到摘要字段协议，
 * 自创字段（city-selection/salary_expect/score）→ 引擎判 invalid → 驾驶舱「待人工处理」。
 * 断言：① 注入「决策文件输出标准」段（摘要字段表/评估明细协议/命名约定）
 *      ② person 归属注入 ③ 初始化状态注入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSkillIdentity } from '../transport/websocket.ts'

const SKILL_MD = `---
name: career-advisor
description: 职业决策分析系统
---

# career-advisor

**职业决策分析系统。一个入口，七个子流程。**

## 会话启动协议

### 0. Workflow Stage 路由（最高优先）

Agent 任务若带【WORKFLOW_STAGE】Envelope，先于一切用户意图路由。

## 输出标准

所有子流程遵守。完整规则见 \`references/protocols/output-standard.md\`。

### 每个子流程结束时必须：

1. 写 \`workspace/career-advisor/decisions/{YYYY-MM-DD}-{主题}.md\`
   - 文件开头必须包含 \`## 分析摘要\` 表格（14 字段）

### 摘要字段

| 字段 | 必需？ | 说明 |
|------|:--:|------|
| skill | 是 | 来源子流程名称 |
| direction | 否 | career-path/transition/jd-analysis 必填 |
| risk_level | 是 | 低/中/中高/高 |
| key_risk | 是 | ≤30字 |
| status | 是 | complete/partial/draft |
| protocol_version | 是 | 2.9 |

### 评估明细段落（v2.8 业务协议结构化）

\`\`\`md
## 城市评估明细

| 城市 | 得分 | 置信度 | 关键优势 | 关键风险 |
|------|:--:|:--:|---------|---------|
| 苏州 | 7.6/10 | 中 | 薪酬性价比/政策 | 产业规模小于深圳 |
\`\`\`

### 文件命名约定

| 约定 | 规则 |
|------|------|
| decisions/ 命名 | \`{YYYY-MM-DD}-{主题}.md\`（不可变） |

## 决策汇总协议

触发：用户说"出结论"/"总结"/"下一步"
`

function makeSkillsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-skill-identity-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), SKILL_MD, 'utf8')
  return dir
}

test('buildSkillIdentity：注入决策文件输出标准段（摘要字段表/明细协议/命名约定）', () => {
  const dir = makeSkillsDir()
  try {
    const out = buildSkillIdentity(dir, '/ws')
    assert.ok(out.includes('决策文件输出标准'))
    assert.ok(out.includes('## 分析摘要'), '应包含摘要表协议')
    assert.ok(out.includes('risk_level'), '应包含摘要字段表')
    assert.ok(out.includes('城市评估明细'), '应包含评估明细协议')
    assert.ok(out.includes('decisions/ 命名'), '应包含文件命名约定')
    assert.ok(out.includes('protocol_version'), '应包含协议版本字段')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildSkillIdentity：注入当前分析对象（person 归属）与工作区初始化状态', () => {
  const dir = makeSkillsDir()
  try {
    const out = buildSkillIdentity(dir, '/ws', { name: '某某', personId: 'person_001' })
    assert.ok(out.includes('person_001'), 'personId 必须注入')
    assert.ok(out.includes('某某'), 'person 名必须注入')
    assert.ok(out.includes('decisions/*.md'), 'frontmatter person_id 规则必须注入')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildSkillIdentity：skillsDir 无 SKILL.md → fallback 人设（不抛错）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cos-skill-identity-empty-'))
  try {
    const out = buildSkillIdentity(dir, '/ws')
    assert.ok(out.includes('Career OS 的职业决策助手'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
