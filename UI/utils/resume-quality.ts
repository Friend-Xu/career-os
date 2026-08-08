/**
 * 简历内容质量规则（R0：从 resumes-page 抽取；R1：升级为清单式检查）。
 * 仅作表达诊断（结构/动词/对象/方法/验证/影响），不产生权威分——三义分离（ADR-018）。
 * 检查项概念对齐 JDAnalysisProposal.evidencePatterns 词表（scope/method/validation/impact/adoption）；
 * v0.1 为 UI 层纯函数（草稿未桥接引擎前，引擎无法投影 mock 数据——ADR-021 回填注明过渡）。
 */

export interface QualityCheck {
  category: 'structure' | 'metrics' | 'action' | 'object' | 'method' | 'validation' | 'impact'
  label: string
  status: 'ok' | 'partial' | 'missing'
  hint: string // 为什么（当前证据）+ 怎么修
}

/** 质量总分（R0 规则：Dashboard 与编辑区共用单一实现；诊断参考非评分结论） */
export function computeResumeQuality(modules: { content: string }[]): number {
  const totalLen = modules.reduce((s, m) => s + m.content.length, 0)
  const hasMetrics = modules.some((m) => /\d+%|\d+年/.test(m.content))
  let score = 70
  if (totalLen > 200) score += 10
  if (hasMetrics) score += 12
  if (modules.length >= 4) score += 5
  return Math.min(score, 96)
}

const ACTION_VERBS = ['主导', '负责', '实现', '完成', '构建', '设计', '优化', '推动', '搭建', '开发']
const METHOD_TERMS = [
  'CATIA', 'SolidWorks', 'Inventor', 'ANSYS', 'Fluent', 'Python', 'C++', 'ROS', 'PyTorch',
  'OpenCV', 'MATLAB', 'LabVIEW', 'CAD', 'FEA', 'CFD', 'UG', 'Creo', 'ProE', 'ADAMS', 'ABAQUS',
]
const VALIDATION_TERMS = ['测试', '验证', '实验', '校核', '仿真', '实测', '试制', '迭代', '验收', '对标']
const IMPACT_TERMS = ['提升', '降低', '优化', '减少', '缩短', '提高', '增长', '节约']

/** 经历类模块（对象/方法/验证/影响检查的作用域——个人信息/技能不属于表达性内容） */
const EXPERIENCE_TITLES = ['工作经历', '项目经验', '项目经历', '实习经历']

function contains(text: string, terms: string[]): boolean {
  return terms.some((t) => text.toLowerCase().includes(t.toLowerCase()))
}

/** 清单式检查（R1：逐项可解释——为什么 + 怎么修；不做加权总分） */
export function computeQualityChecks(modules: { title: string; content: string }[]): QualityCheck[] {
  const all = modules.map((m) => `${m.title}\n${m.content}`).join('\n\n')
  const expModules = modules.filter((m) => EXPERIENCE_TITLES.some((t) => m.title.includes(t)))
  const expText = expModules.map((m) => m.content).join('\n')

  const checks: QualityCheck[] = []

  // 结构：核心模块齐全（个人信息/经历/技能）
  const hasCore = modules.some((m) => /个人|基本信息/.test(m.title)) &&
    expModules.length > 0 &&
    modules.some((m) => /技能/.test(m.title))
  checks.push({
    category: 'structure',
    label: '结构完整',
    status: hasCore ? 'ok' : modules.length >= 2 ? 'partial' : 'missing',
    hint: hasCore
      ? '个人信息、经历、技能等核心模块齐全'
      : '缺核心模块（个人信息 / 经历 / 技能）——补全后简历才完整',
  })

  // 量化：含量化指标（数字/%/年）
  const hasMetrics = /\d+%|\d+年|\d+个|\d+项|\d+次|\d+人/.test(all)
  checks.push({
    category: 'metrics',
    label: '量化指标',
    status: hasMetrics ? 'ok' : 'missing',
    hint: hasMetrics
      ? '含数字或百分比，效果可度量'
      : '无明显量化（如 40%、3 个项目）——用数字说明成果更可信',
  })

  // 动词：行为动词（非"负责了""参与了"式空泛）
  const hasAction = contains(expText, ACTION_VERBS)
  checks.push({
    category: 'action',
    label: '动词明确',
    status: hasAction ? 'ok' : 'partial',
    hint: hasAction
      ? '使用主导/实现/构建等行为动词'
      : '经历中缺少行为动词——用「主导/实现/完成」开头而非「负责」',
  })

  // 对象：做了什么（经历模块有具体描述）
  const objectOk = expModules.some((m) => m.content.length > 24)
  checks.push({
    category: 'object',
    label: '对象明确',
    status: objectOk ? 'ok' : 'missing',
    hint: objectOk
      ? '经历描述了具体工作对象（系统/设备/项目）'
      : '经历过于简短——补充做了什么（对象 + 场景）',
  })

  // 方法：怎么做（工具/技术术语）
  const hasMethod = contains(expText, METHOD_TERMS)
  checks.push({
    category: 'method',
    label: '方法技术',
    status: hasMethod ? 'ok' : 'partial',
    hint: hasMethod
      ? '含工具/技术术语（CATIA/ANSYS/Python 等）'
      : '未出现工具或技术名称——写明用什么做的（软件/方法/标准）',
  })

  // 验证：如何证明（测试/验证/仿真/实测）
  const hasValidation = contains(expText, VALIDATION_TERMS)
  checks.push({
    category: 'validation',
    label: '验证方式',
    status: hasValidation ? 'ok' : 'missing',
    hint: hasValidation
      ? '含验证手段（测试/仿真/校核）'
      : '未说明如何验证——补一句验证方式（如「通过仿真校核」）',
  })

  // 影响：结果（效果词或量化成果）
  const hasImpact = contains(expText, IMPACT_TERMS) || /\d+%/.test(expText)
  checks.push({
    category: 'impact',
    label: '影响结果',
    status: hasImpact ? 'ok' : 'missing',
    hint: hasImpact
      ? '含效果词或成果指标（提升/降低/缩短 + 数字）'
      : '未说明结果——用一句成果收尾（提升 X%、缩短周期）',
  })

  return checks
}
