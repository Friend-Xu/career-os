/**
 * 演示工作区构建器（浏览器 E2E 用）：向目标目录写入最小资产链
 * （claim + evidence + resume + 一份 pending 提案），引擎指向该目录即可看到全链。
 * 用法：node tests/demo-workspace.mjs <目标目录>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const CLAIM_ID = 'claim_20260805_00001'
const EVIDENCE_ID = 'evidence_20260805_00001'
const RESUME_ID = 'resume_20260805_00001'
const OLD = '负责自动化设备机械结构设计，完成机架及传动机构优化'
const NEW = '主导自动化设备机架结构设计，传动精度由 0.1mm 提升至 0.05mm'

const target = process.argv[2]
if (!target) {
  console.error('用法：node tests/demo-workspace.mjs <目标目录>')
  process.exit(1)
}

const w = (rel, content) => {
  mkdirSync(dirname(join(target, rel)), { recursive: true })
  writeFileSync(join(target, rel), content, 'utf8')
}

w(`claims/${CLAIM_ID}.md`, `---
id: ${CLAIM_ID}
---

# 机械结构设计

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | ${OLD} |
| claim_type | fact |
| source | agent_generated |
| captured_at | 2026-08-05 |

## 证据来源

- ${EVIDENCE_ID}
`)

w(`evidence/${EVIDENCE_ID}.md`, `---
id: ${EVIDENCE_ID}
---

# 新机型平台开发项目

## 分析摘要

| 字段 | 值 |
|------|-----|
| role | 机械结构负责人 |
| contribution | 负责机架和传动模块设计 |
| source_type | user_input |
| captured_at | 2026-08-05 |
| status | trusted |

## 事件

公司新机型平台开发项目。

## 证据

### scope
- 负责机架和传动模块设计

## 来源

用户口述整理
`)

w(`resumes/documents/${RESUME_ID}.md`, `# ${RESUME_ID}

## 分析摘要

| 字段 | 值 |
|------|-----|
| status | draft |
| person | 我 |
| template_id | mechanical |
| template_version | 1.2 |
| generated_at | 2026-08-05T10:00:00Z |
| derivation_type | jd_generate |
| created_by | ai |

## 章节

### experience | 工作经历

- ${OLD}（claim: ${CLAIM_ID}）

### skills | 技能

- SolidWorks（asset）

## 操作记录

- operation_001 | ai | create | 2026-08-05T10:00:00Z
`)

w('proposals/ai-改进建议.md', `# 改进建议

## 分析摘要

| 字段 | 值 |
|------|-----|
| type | resume_proposal |
| source_resume_id | ${RESUME_ID} |
| proposal_type | improve |

## 变更建议

- ${CLAIM_ID}（section: experience；old: "${OLD}"；new: "${NEW}"；reason: "岗位强调量化结果，期望有可度量输出"）
`)

console.log(`演示工作区已写入：${target}`)
