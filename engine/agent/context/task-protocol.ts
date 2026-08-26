/**
 * Task Protocol（任务级协议面——ADR-020 通道修正 v0.2）：
 * - 聚合任务（job_analysis/company_research/interview_preparation）不经 Workflow Stage——
 *   无 Stage Envelope；此前仅有弱身份节选（buildSkillIdentity），flash 模型在无协议约束下
 *   输出英文过程叙述、不收敛产出（2026-08-26 真机：DL = "Let me explore..."循环，0 产物）。
 * - buildTaskProtocol：按 taskType 注入协议段（放 system 通道——与用户任务分离）。
 * - aggregateTaskBudget：非 Stage 聚合任务输出预算提档（与 workflow 16384 档一致；
 *   8/22 真机：flash 长叙述 + 多文件/工具调用一轮输出 8192 截断、16384 达标）。
 * - company_research：Evidence Sufficiency v0.1 协议投影（ADR-035 +
 *   references/evidence-sufficiency-contract-v0.1 §A–§I）——9 维清单 / 双层级状态机 /
 *   确定性折叠 / derive 判定 / 有界再查 / 预算纪律 / SUFFICIENCY_STATE 输出结构。
 *   COMPANY_RESEARCH_DIMENSIONS 是契约 §B 的代码投影（单一事实源），Phase 3 Validator 复用。
 */
import type { AgentTaskType } from '../../ir/agent-task.ts'

/** 聚合任务输出预算（非 Stage 路径；无对应档位 = undefined → runner 8K 默认） */
export function aggregateTaskBudget(taskType: AgentTaskType | undefined): number | undefined {
  return taskType === 'job_analysis' || taskType === 'company_research' || taskType === 'interview_preparation'
    ? 16384
    : undefined
}

/** company_research 检索证据维度键（契约 §B——顺序无约束，与 DIMENSIONS 同源） */
export const COMPANY_RESEARCH_KEYS = [
  'company_overview',
  'industry',
  'products',
  'business',
  'hiring',
  'salary',
  'financing',
  'risk',
  'career_development',
] as const

/** 维度规格（契约 §B 的代码投影——协议文本由它渲染） */
export interface CompanyResearchDimension {
  key: string
  label: string
  critical: boolean
  /** 适用通道优先序（契约 §B；Standard 声明「该维度应该去哪里找」） */
  channels: string
}

/** company_research 检索证据维度表（单一事实源 = 契约 §B 9 维；Phase 3 Validator 复用） */
export const COMPANY_RESEARCH_DIMENSIONS: readonly CompanyResearchDimension[] = [
  { key: 'company_overview', label: '公司概况', critical: false, channels: 'web_search > exa' },
  { key: 'industry', label: '行业', critical: false, channels: 'exa > web_search' },
  { key: 'products', label: '产品', critical: false, channels: 'web_search > exa' },
  { key: 'business', label: '业务', critical: false, channels: 'web_search > exa' },
  { key: 'hiring', label: '招聘活跃', critical: true, channels: 'web_search > exa' },
  { key: 'salary', label: '薪资水平', critical: true, channels: 'nbs > web_search > exa' },
  { key: 'financing', label: '融资', critical: false, channels: 'web_search > exa' },
  { key: 'risk', label: '风险', critical: true, channels: 'exa > web_search' },
  { key: 'career_development', label: '职业发展', critical: true, channels: 'web_search > exa' },
]

/** job_analysis 专属协议（自包含——Agent 不可读技能文件，协议必须引擎注入） */
function jobAnalysisProtocol(jobId?: string): string {
  return [
    '【任务协议：job_analysis】',
    '职责：从 JD 原文提取三段结构化信息——岗位理解（Context）/岗位门槛（Constraint）/岗位智能（Capability+Evidence）。你只做提取，不做画像匹配（匹配度/差距由系统基于岗位智能段计算，不要读画像做结论）。',
    '步骤顺序：',
    `1) Read 读岗位文件（jobId=${jobId ?? '见任务上下文'}，含 JD 原文与既有「岗位智能」段），确认依据；`,
    '2) 组织 Proposal：岗位理解（work_mode/career_path/industry）、岗位门槛（education/major/experience）、岗位智能（责任单元+Priority must/nice+Category hard/soft/preference+能力词+证据模式+追问）；',
    '3) 调用 submit_jd_analysis 提交（引擎校验并写入岗位档案——禁止用 Edit/Write 直接改岗位文件）；',
    '4) 提交成功后用中文简述分析要点（职责拆解/门槛/加分项）；匹配与差距由系统展示，不输出画像匹配结论。',
    '纪律：',
    '- 工具调用前后不输出过程叙述（不输出 "Let me..."/Now let me... 之类英文过程描述），全部输出用中文；',
    '- 每个字段必须带 JD 原文来源锚点（引任职要求 N/岗位职责 N）；JD 未写的不提取不补写（反幻觉）；',
    '- 能力词只认「任职要求」段；「培养/轮岗/带教」类为岗位提供内容（soft/preference，禁 hard）；「A或B」OR 语义合并为上位概念（禁拆并列硬要求）；',
    '- 行为/素质词（协作/沟通/学习能力/抗压…）只能 soft 或 preference；',
    '- 若 JD 无学历/专业/年限表述：对应维度不产出（禁止填「-」伪装已评估）。',
    '- 最终输出语言：中文。',
  ].join('\n')
}

/** company_research 专属协议（Evidence Sufficiency v0.1——契约 §A–§I 的 Agent 可执行投影） */
function companyResearchProtocol(companyId?: string): string {
  const dims = COMPANY_RESEARCH_DIMENSIONS.map(
    (d) => `- ${d.key} ${d.label} ${d.critical ? '★' : '□'} ${d.channels}`,
  ).join('\n')
  return [
    '【任务协议：company_research】（Evidence Sufficiency v0.1——契约 evidence-sufficiency-contract-v0.1）',
    '职责：回答用户对公司的调查问题。你只做检索与证据充分性判断——不写文件、不改公司档案、不输出「公司评分/值不值得关注」结论（Company Assessment 由系统计算）、不做画像匹配。',
    '步骤顺序：',
    `1) Read 读公司档案（companyId=${companyId ?? '见任务上下文'}，文件 companies/{companyId}.md——既有公司事实与风险评级作为 internal 证据引用，sources[].tier=internal）；`,
    '2) 按维度适用通道优先序检索（WebSearch 快查 / WebResearch 深查 / QueryMacroStats 宏观统计）；',
    '3) 逐维度标注状态 → 计算总体状态（确定性折叠）→ 声明 nextAction 并执行：stop=直接写结论；continue=对最需解决的一个关键维度做一次定向再查（该维度 retries 0→1，之后不可再查）；finalize=以当前证据写结论并声明 limitations；',
    '4) 最终回答末尾输出 ## SUFFICIENCY_STATE（json 代码围栏）。',
    '证据维度（9 维，★=关键 □=非关键；全部关键维度 RESOLVED 才可声明 SUFFICIENT）：',
    dims,
    '维度状态（逐维度标注）：RESOLVED（≥1 来源、无未解冲突/口径/时效疑问）/ UNCERTAIN（单一来源、口径未明、样本不足、时效存疑）/ CONFLICTED（≥2 个独立来源实质结论不一致且未消解；独立=主域不同；转载/聚合站不独立）/ UNCOVERED（无来源——禁止填「-」伪装已评估）。',
    '总体状态（确定性折叠，只看关键维度）：存在 CONFLICTED→CONFLICTED；否则存在 UNCOVERED→GAP；否则存在 UNCERTAIN→UNCERTAIN；否则 SUFFICIENT。',
    '下一动作（确定性判定）：SUFFICIENT→stop；GAP/CONFLICTED/UNCERTAIN→存在该状态的关键维度且其适用通道可用（已注册且预算未耗尽）且该维度 retries=0→continue；否则→finalize。',
    '有界再查（每关键维度至多 1 次——不要无谓小步搜索）：UNCOVERED→目标来源直接尝试 1 次；UNCERTAIN→更高质量来源 1 次（按该维度适用通道优先序）；CONFLICTED→至多 1 个新独立来源域。非关键维度不触发再查（记录 note/conflicts 即可）。',
    '预算：检索被拒（预算用尽）后不得再调用该通道，该通道视为不可用；被拒事实记入 limitations。',
    '纪律：',
    '- 工具调用前后不输出过程叙述（无 "Let me..."/"Now..."），全部输出中文；',
    '- 每维度结论标注来源：正文给出引用（URL 级）；SUFFICIENCY_STATE 的 sources 只填主域+tier，不要粘贴长引文（URL/原文由检索 trace 记录）；',
    '- 结论强度 ≤ 证据状态：声称「已确认/准确/无风险」的维度必须 RESOLVED；UNCERTAIN/CONFLICTED/UNCOVERED 维度只能带限定表述（如「未确认/存在口径差异/未能获取」）；',
    '- 最终输出语言：中文。',
    '输出结构（最终回答的最后一段）：',
    '## SUFFICIENCY_STATE',
    '',
    '```json',
    '{ "sufficiency": { "state": "SUFFICIENT|GAP|CONFLICTED|UNCERTAIN", "dimensions": [ { "key": "...", "status": "RESOLVED|UNCERTAIN|CONFLICTED|UNCOVERED", "retries": 0, "sources": [ { "domain": "...", "tier": "internal|official|statistics|recruiting|aggregator" } ], "note": "..." } ×9 ], "conflicts": [ { "dimension": "...", "note": "..." } ], "limitations": [ { "type": "budget_exhausted|gap|conflict|uncertainty", "channel": "...", "note": "..." } ], "nextAction": "stop|continue|finalize" } }',
    '```',
  ].join('\n')
}

/** 聚合任务通用纪律（interview_preparation——防同款英文叙述漂移） */
const AGGREGATE_DISCIPLINE = [
  '【任务纪律（引擎注入）】',
  '工具调用前后不输出过程叙述，最终输出用中文结论；',
  '产出结论以中文结构化呈现，不做冗长英文过程描述。',
].join('\n')

/** 按任务类型注入协议段（普通对话/explanation/无 taskType → 空） */
export function buildTaskProtocol(
  taskType: AgentTaskType | undefined,
  ctx: { jobId?: string; companyId?: string } = {},
): string {
  if (taskType === 'job_analysis') return jobAnalysisProtocol(ctx.jobId)
  if (taskType === 'company_research') return companyResearchProtocol(ctx.companyId)
  if (taskType === 'interview_preparation') return AGGREGATE_DISCIPLINE
  return ''
}
