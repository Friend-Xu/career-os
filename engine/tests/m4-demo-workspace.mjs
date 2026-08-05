/**
 * M4 Artifact 演示工作区构建器（浏览器 E2E 用）：向目标目录写入四 Artifact 资产链
 * （portfolio project + interview QA + cover letter + resume + 各 pending 提案），
 * 引擎指向该目录即可看到 Artifact Studio 非空态。
 * 用法：node tests/m4-demo-workspace.mjs <目标目录>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const PROJECT_ID = 'project_20260805_00001'
const QA_ID = 'qa_20260805_00001'
const CL_ID = 'cl_20260805_00001'
const RESUME_ID = 'resume_20260805_00001'

const target = process.argv[2]
if (!target) {
  console.error('用法：node tests/m4-demo-workspace.mjs <目标目录>')
  process.exit(1)
}

const w = (rel, content) => {
  mkdirSync(dirname(join(target, rel)), { recursive: true })
  writeFileSync(join(target, rel), content, 'utf8')
}

w(`portfolio/projects/夹具设计.md`, `---
id: ${PROJECT_ID}
created_at: 2026-08-05
source_file: 夹具设计
---

> status: published
> version: 3

## 项目事实

| id | statement | type | evidence |
|----|-----------|------|----------|
| pf_001 | 完成自动化夹具设计 | engineering_work | design_001 |

## 证据资产

| id | type | location | metadata |
|----|------|----------|----------|
| design_001 | design | figma/project-x/design.pdf | 时间=2026-03 |

## 演化记录

| version | from | to | at | via |
|---------|------|----|----|-----|
| 1 | - | draft | 2026-08-05T08:00:00Z | - |
| 2 | draft | reviewed | 2026-08-05T09:00:00Z | - |
| 3 | reviewed | published | 2026-08-05T10:00:00Z | - |
`)

w(`portfolio/proposals/pp_20260805_00001.md`, `# pp_20260805_00001

## 提案摘要

| 字段 | 值 |
|------|-----|
| type | portfolio_proposal |
| project_id | ${PROJECT_ID} |
| status | pending |
| created_by | ai |
| created_at | 2026-08-05T11:00:00Z |

## 变更建议

- pf_001（type: rewrite；old: "完成自动化夹具设计"；new: "完成自动化夹具设计并负责验证夹具可靠性"；reason: "目标岗位强调验证能力"）
`)

w(`interviews/${QA_ID}.md`, `---
id: ${QA_ID}
created_at: 2026-08-05
source_file: 介绍项目
---

> status: ready

## 问题

介绍一个你负责过的项目

## 事实

| id | statement | type | evidence |
|----|-----------|------|----------|
| fact_001 | 负责自动化夹具设计 | responsibility | design_001 |

## 证据资产

| id | type | location | metadata |
|----|------|----------|----------|
| design_001 | design | figma/project-x/design.pdf | - |

## 回答

- ans_001（text: "我主导了夹具设计，负责从方案到落地"；facts: fact_001）

## 策略

- int_001（statement: "突出对结果负责"）

## 演化记录

| from | to | at | via |
|------|----|----|-----|
| - | draft | 2026-08-05T08:00:00Z | - |
| draft | reviewed | 2026-08-05T09:00:00Z | - |
| reviewed | ready | 2026-08-05T10:00:00Z | - |
`)

w(`interviews/proposals/ip_20260805_00001.md`, `# ip_20260805_00001

## 提案摘要

| 字段 | 值 |
|------|-----|
| type | interview_proposal |
| qa_id | ${QA_ID} |
| status | pending |
| created_by | ai |
| created_at | 2026-08-05T11:00:00Z |

## 变更建议

- ans_001（type: rewrite；old: "我主导了夹具设计，负责从方案到落地"；new: "我主导夹具设计全流程，方案评审一次性通过"；reason: "更突出结果"）
`)

w(`cover-letters/${CL_ID}.md`, `---
id: ${CL_ID}
created_at: 2026-08-05
source_file: 夹具工程师
---

> status: ready
> target_company: 示例公司

## 叙述单元

- nu_001（text: "我主导了自动化夹具设计全流程"；refs: portfolio.${PROJECT_ID}.pf_001）
- nu_002（text: "该设计支撑了产线验证"；refs: interview.${QA_ID}.fact_001）

## 投递记录

| targetCompany | targetJob | at |
|---------------|-----------|-----|
| 示例公司 | - | 2026-08-05T12:00:00Z |

## 演化记录

| from | to | at | via |
|------|----|----|-----|
| - | draft | 2026-08-05T08:00:00Z | - |
| draft | reviewed | 2026-08-05T09:00:00Z | - |
| reviewed | ready | 2026-08-05T10:00:00Z | - |
`)

w(`cover-letters/proposals/clp_20260805_00001.md`, `# clp_20260805_00001

## 提案摘要

| 字段 | 值 |
|------|-----|
| type | cover_letter_proposal |
| cl_id | ${CL_ID} |
| status | pending |
| created_by | ai |
| created_at | 2026-08-05T11:00:00Z |

## 变更建议

- nu_001（type: adapt；old: "我主导了自动化夹具设计全流程"；new: "我主导自动化夹具设计全流程，精度提升至 0.05mm"；reason: "适配岗位量化要求"）
`)

w(`resumes/documents/${RESUME_ID}.md`, `# ${RESUME_ID}

## 分析摘要

| 字段 | 值 |
|------|-----|
| status | exported |
| person | 我 |
| template_id | mechanical |
| template_version | 1.2 |
| generated_at | 2026-08-05T10:00:00Z |
| derivation_type | jd_generate |
| created_by | ai |

## 章节

### experience | 工作经历

- 负责自动化设备机械结构设计（claim: claim_20260805_00001）
- 完成机架及传动机构优化（claim: claim_20260805_00002）
- 主导夹具设计（claim: claim_20260805_00003）

### skills | 技能

- SolidWorks（asset）

## 操作记录

- operation_001 | ai | create | 2026-08-05T10:00:00Z
- operation_002 | user | export | 2026-08-05T10:30:00Z
`)

w(`proposals/resume-改进建议.md`, `# 改进建议

## 分析摘要

| 字段 | 值 |
|------|-----|
| type | resume_proposal |
| source_resume_id | ${RESUME_ID} |
| proposal_type | improve |

## 变更建议

- claim_20260805_00001（section: experience；old: "负责自动化设备机械结构设计"；new: "主导自动化设备机架结构设计，传动精度由 0.1mm 提升至 0.05mm"；reason: "岗位强调量化结果"）
`)

console.log(`M4 演示工作区已写入：${target}`)
