import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initWorkspace } from '../storage/workspace.ts'
import { createJobFile, parseJobMarkdown } from '../storage/job-watcher.ts'
import { writeJDAnalysis } from '../storage/jd-analysis-writer.ts'
import { validateJDAnalysisProposal } from '../runtime/jd-analysis-validator.ts'
import { parseJdConstraint } from '../runtime/jd-constraint.ts'
import { matchEducation } from '../runtime/constraint-matcher.ts'
import { computeGap } from '../runtime/gap-calculator.ts'
import type { JDAnalysisProposal, PersonSkill } from '../ir/schema.ts'

/**
 * JD Artifact 三段式稳定回归（主线 2：Artifact 是稳定数据产品，不是 Agent 输出副作用）。
 * 三类 JD 全链：Proposal → Validator → Writer → jobs md → Parser（约束/技能）→ Matcher。
 * 锁定的不变量：JD 原文不可变 / 段名定位不依赖顺序 / preferred 无 hard 维度 /
 * 无要求 → NOT_DECLARED / partial-相关不误推理（Skill Representation v0.1 边界）。
 */

function setup(jobId: string, company: string, title: string, jdText: string): ReturnType<typeof initWorkspace> {
  const root = mkdtempSync(join(tmpdir(), 'cos-jdar-'))
  const ws = initWorkspace(root)
  ws.write('knowledge/skills.md', '# 技能词表\n\n## 机械设计\n\n- 别名：结构设计\n')
  createJobFile(ws, { company, title, requirements: '占位要求', jdText }, new Date('2026-08-08T00:00:00Z'))
  return ws
}

const JD_ORIGINAL_A = `公司名称：示例流体科技
流体机械工程师 9-13K·13薪
杭州 经验不限 学历不限
岗位职责
1.熟练掌握常用的三维设计软件(inventor或sw等)
2.熟悉容器、管道、法兰等相关标准，熟悉泵、阀等设备，可以正确选型;
3.了解电气、上位机软件相关知识，可以进行项目前期洽谈，完善项目方案;
4.参与流体设备及系统的优化升级、故障排查与维护指导，整理技术文档;
5.配合团队完成其他相关技术工作。
任职要求
1.学历要求:本科以上学历优先考虑，机械设计、流体机械、过程装备与控制工程等相关专业优先考虑。
2.技能要求:熟练掌握Inventor、SolidWorks等至少一款三维设计软件。
3.能力素质:具备较强的现场技术指导能力、问题解决能力。
5.有流体系统集成、非标流体设备设计经验者优先;熟悉相关行业安全规范、具备设备调试经验者优先。`

// ─── A 工程型（流体机械工程师：工具技能 + 标准规范 + 设备能力）────────────

const A_ID = '2026-08-08-示例流体-流体机械工程师'
const aProposal: JDAnalysisProposal = {
  jobId: A_ID,
  artifactVersion: 2,
  context: {
    workMode: [{ value: '三维建模与施工图绘制；项目方案设计与客户洽谈', source: '岗位职责', confidence: 'high' }],
    industry: [{ value: '流体控制设备（泵阀传感器/非标流体系统）', source: '职位描述', confidence: 'medium' }],
  },
  constraints: {
    education: { values: ['本科以上学历优先考虑'], source: '任职要求 1', confidence: 'medium', matchMode: 'preferred' },
    major: { values: ['机械设计、流体机械、过程装备与控制工程等相关专业优先考虑'], source: '任职要求 1', confidence: 'medium', matchMode: 'related' },
    experience: { values: ['有流体系统集成、非标流体设备设计经验者优先'], source: '任职要求 5', confidence: 'medium', matchMode: 'preferred' },
  },
  capabilities: [
    { responsibility: '三维建模与施工图绘制', priority: 'must', category: 'hard', capabilities: ['Inventor', 'SolidWorks', '施工图'], evidencePatterns: ['scope', 'method', 'validation'], questions: ['你独立设计过哪些设备的结构；用什么软件建模出图'] },
    { responsibility: '泵阀传感器选型', priority: 'must', category: 'hard', capabilities: ['泵选型', '阀门选型', '传感器选型'], evidencePatterns: ['method', 'adoption'], questions: ['你按什么方法确定泵的扬程与流量'] },
    { responsibility: '系统优化与故障排查维护', priority: 'must', category: 'hard', capabilities: ['故障排查', '维护指导', '技术文档'], evidencePatterns: ['scope', 'method', 'impact'], questions: ['你排查过哪些设备故障'] },
    { responsibility: '团队协作与新技术跟进', priority: 'nice', category: 'soft', capabilities: ['团队协作', '行业技术跟进'], evidencePatterns: ['scope', 'adoption'], questions: ['你如何配合团队推进任务'] },
  ],
  generatedAt: '2026-08-08T10:00:00Z',
}

test('A 工程型：Writer 三段式 + JD 原文不可变（字节级）+ preferred/related 模式列投影', () => {
  const ws = setup(A_ID, '示例流体', '流体机械工程师', JD_ORIGINAL_A)
  try {
    const issues = validateJDAnalysisProposal(aProposal)
    assert.deepEqual(issues, [])
    const r = writeJDAnalysis(ws, aProposal, issues)
    assert.equal(r.written, true)

    const md = ws.read(`jobs/${A_ID}.md`)
    // 三段（岗位理解/门槛/智能）
    assert.match(md, /## 岗位理解/)
    assert.match(md, /## 岗位门槛/)
    assert.match(md, /## 岗位智能/)
    // 门槛 5 列含模式列（preferred/related 语义状态标记）
    assert.match(md, /\| education \| 本科以上学历优先考虑 \| 任职要求 1 \| medium \| preferred \|/)
    assert.match(md, /\| major \| 机械设计、流体机械、过程装备与控制工程等相关专业优先考虑 \| 任职要求 1 \| medium \| related \|/)
    assert.match(md, /\| experience \| 有流体系统集成、非标流体设备设计经验者优先 \| 任职要求 5 \| medium \| preferred \|/)
    // 智能 6 列（含 Category）
    assert.match(md, /\| 泵阀传感器选型 \| must \| hard \| 泵选型;阀门选型;传感器选型 \|/)
    // JD 原文不可变（Writer 只投影分析段，不触碰用户输入资产）
    assert.ok(md.includes(JD_ORIGINAL_A), 'JD 原文段必须原样保留')
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('A 工程型：preferred 门槛 → 无 hard 维度 → Matcher NOT_DECLARED（偏好≠门槛）', () => {
  const ws = setup(A_ID, '示例流体', '流体机械工程师', JD_ORIGINAL_A)
  try {
    writeJDAnalysis(ws, aProposal, validateJDAnalysisProposal(aProposal))
    const md = ws.read(`jobs/${A_ID}.md`)
    const ir = parseJdConstraint(md)
    assert.equal(ir.education, undefined) // preferred → 无 hard 维度
    const r = matchEducation([{ school: '东华大学', degree: '本科', status: 'confirmed', source: 'resume' }], ir.education)
    assert.equal(r.status, 'NOT_DECLARED')
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('A 工程型：Parser 回读（parseJobMarkdown）——ai responsibilities + category + 工具能力词', () => {
  const ws = setup(A_ID, '示例流体', '流体机械工程师', JD_ORIGINAL_A)
  try {
    writeJDAnalysis(ws, aProposal, validateJDAnalysisProposal(aProposal))
    const md = ws.read(`jobs/${A_ID}.md`)
    const parsed = parseJobMarkdown(md, `${A_ID}.md`)
    const ai = parsed.value.responsibilities.filter((r) => r.source === 'ai')
    assert.equal(ai.length, 4)
    assert.ok(ai.some((r) => r.category === 'soft')) // Category 列回读
    const caps = ai.flatMap((r) => r.capabilities)
    assert.ok(caps.includes('SolidWorks') && caps.includes('泵选型') && caps.includes('故障排查'))
    assert.equal(parsed.validation?.issues.length ?? 0, 0)
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

// ─── B 培养型（应届管培生：experience fresh + 枚举学历 + related 专业）──────

const B_ID = '2026-08-08-示例医疗-管理培训生'
const bProposal: JDAnalysisProposal = {
  jobId: B_ID,
  artifactVersion: 2,
  context: {
    workMode: [{ value: '轮岗学习；跨部门项目推进', source: '岗位定位', confidence: 'high' }],
    industry: [{ value: '医疗器械（神经介入）', source: '企业简介', confidence: 'medium' }],
  },
  constraints: {
    education: { values: ['本科', '硕士', '博士'], source: '任职要求 1', confidence: 'high' },
    major: { values: ['生物医学工程、机械、材料等专业'], source: '任职要求 1', confidence: 'medium', matchMode: 'related' },
    experience: { values: ['fresh'], source: '任职要求 1', confidence: 'high' },
  },
  capabilities: [
    { responsibility: '数据整理与文案输出', priority: 'must', category: 'hard', capabilities: ['办公软件', '数据整理'], evidencePatterns: ['method', 'validation'], questions: ['你用哪些工具整理数据'] },
    { responsibility: '多部门轮岗学习', priority: 'must', category: 'soft', capabilities: ['跨部门协作', '学习能力'], evidencePatterns: ['scope', 'method'], questions: ['你轮岗过哪些部门'] },
  ],
  generatedAt: '2026-08-08T10:00:00Z',
}

test('B 培养型：应届归 experience（fresh）+ 学历枚举 NORMALIZED → MATCHED；exact 缺省模式列', () => {
  const ws = setup(B_ID, '示例医疗', '管理培训生', '任职要求 1：2024-2027届本科/硕士/博士应届生，学业基础良好，已顺利毕业并全职入职；生物医学工程、机械、材料等专业。')
  try {
    writeJDAnalysis(ws, bProposal, validateJDAnalysisProposal(bProposal))
    const md = ws.read(`jobs/${B_ID}.md`)
    assert.match(md, /\| education \| 本科;硕士;博士 \| 任职要求 1 \| high \| exact \|/)
    assert.match(md, /\| experience \| fresh \| 任职要求 1 \| high \| exact \|/) // 应届 → experience 维度（原文枚举保留）
    assert.match(md, /\| major \| 生物医学工程、机械、材料等专业 \| 任职要求 1 \| medium \| related \|/)

    const ir = parseJdConstraint(md)
    assert.deepEqual(ir.education!.normalizedDegrees, ['本科', '硕士', '博士'])
    assert.equal(ir.education!.normalizationStatus, 'NORMALIZED')
    const r = matchEducation([{ school: '东华大学', degree: '本科', status: 'confirmed', source: 'resume' }], ir.education)
    assert.equal(r.status, 'MATCHED')
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

// ─── C 跨领域（机械设计 → 自动化设备：无门槛要求 + 不误推理）───────────────

const C_ID = '2026-08-08-示例自动化-机械设计工程师'
const cProposal: JDAnalysisProposal = {
  jobId: C_ID,
  artifactVersion: 2,
  context: {
    workMode: [{ value: '自动化设备机械结构设计；方案评审与样机调试', source: '岗位职责', confidence: 'high' }],
    industry: [{ value: '非标自动化设备', source: '职位描述', confidence: 'medium' }],
  },
  constraints: {}, // 无学历/专业/经验要求 → 门槛段不产出
  capabilities: [
    { responsibility: '自动化设备结构设计', priority: 'must', category: 'hard', capabilities: ['方案设计', '故障排查', '设备调试'], evidencePatterns: ['scope', 'method', 'validation'], questions: ['你设计过哪些自动化设备的结构'] },
    { responsibility: '电气与软件对接', priority: 'must', category: 'hard', capabilities: ['电气基础', '上位机软件'], evidencePatterns: ['method', 'adoption'], questions: ['你如何与电气团队对接'] },
  ],
  generatedAt: '2026-08-08T10:00:00Z',
}

test('C 跨领域：无约束 → 不产出门槛段 → Matcher NOT_DECLARED（无要求≠缺失）', () => {
  const ws = setup(C_ID, '示例自动化', '机械设计工程师', '负责自动化设备机械结构设计，与电气团队协同完成整机交付。')
  try {
    const r = writeJDAnalysis(ws, cProposal, validateJDAnalysisProposal(cProposal))
    assert.equal(r.written, true)
    const md = ws.read(`jobs/${C_ID}.md`)
    assert.ok(!md.includes('## 岗位门槛'), '无约束维度时门槛段不产出（空段不写）')
    assert.match(md, /## 岗位理解/)
    assert.match(md, /## 岗位智能/)

    const ir = parseJdConstraint(md)
    assert.deepEqual(ir, {}) // 空 IR
    const eduMatch = matchEducation([{ school: '东华大学', degree: '本科', status: 'confirmed', source: 'resume' }], ir.education)
    assert.equal(eduMatch.status, 'NOT_DECLARED')
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})

test('C 跨领域：不误推理——画像「方案设计与样机调试/故障诊断」不因 partial/related 命中 JD「方案设计/故障排查」', () => {
  const ws = setup(C_ID, '示例自动化', '机械设计工程师', '负责自动化设备机械结构设计，与电气团队协同完成整机交付。')
  try {
    writeJDAnalysis(ws, cProposal, validateJDAnalysisProposal(cProposal))
    const md = ws.read(`jobs/${C_ID}.md`)
    const parsed = parseJobMarkdown(md, `${C_ID}.md`)
    const role = {
      id: C_ID,
      name: '机械设计工程师',
      company: '示例自动化',
      skills: parsed.value.responsibilities
        .filter((r) => r.category === undefined || r.category === 'hard')
        .flatMap((r) => r.capabilities.map((name) => ({ name, essential: r.priority === 'must', source: 'JD' }))),
    }
    const personSkills: PersonSkill[] = [
      { name: '方案设计与样机调试', level: 4 },
      { name: '装配干涉处理与故障诊断', level: 4 },
      { name: '静应力仿真（Creo）', level: 2, tools: ['Creo'] },
    ]
    const gap = computeGap({ role, person: '我', personSkills, skills: [] })
    // Skill Representation v0.1 边界：partial（方案设计⊂方案设计与样机调试）/ related（故障排查≈故障诊断）
    // 不做语义推理——全部如实未声明（不误报为已具备）
    assert.deepEqual(gap.satisfied, [])
    assert.deepEqual(gap.transferable, [])
    assert.deepEqual(gap.missing.map((m) => m.name).sort(), ['上位机软件', '方案设计', '故障排查', '设备调试', '电气基础'].sort())
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true })
  }
})
