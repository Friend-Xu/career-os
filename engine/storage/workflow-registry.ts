/**
 * workflow-registry：Career Workflow Control Plane v0.1（契约 docs/contracts/Career-Workflow-Contract-v0.1.md）。
 * - Goal / Stage / Gate / Progress 归本层（Engine 单方写 workflows/{id}.md，Agent/UI 不写）；
 *   Agent 只负责当前 Stage 执行；完成判定 = 确定性 Evaluator，不信任 Agent 自报。
 * - start 双路径：有 pending candidates → 直接 waiting_gate（Path B，不重新收集）；
 *   无 → 启动 fact_collection Agent task（Path A）。
 * - advance 四步校验（用户只能表达"我要继续"，不能决定"系统已完成"）：
 *   状态=waiting_gate → 完成条件满足 → gate 未过 → 下一 Stage inputs 齐备；任一失败 → 拒绝 + 缺件。
 * - 「暂不登记，继续探索」= 受控 exploration branch：不登记、Stage 1 不 completed、
 *   不通过正常 advance 越过 Stage 1（契约 §4.3）。
 * - v0.2（契约 Career-Workflow-Contract-v0.2）：artifact-exists evaluator 参数化落地
 *  （evaluateStageCompletion 自报缺件）；confirm_directions Gate 与 restage 见同名契约。
 */
import type { Workspace } from './workspace.ts'
import type { StageArtifact } from '../ir/schema.ts'
import { completePersonInit, readManifestInitState, scanPersons } from './person-watcher.ts'
import { countStageArtifacts, listStageArtifacts, registerStageArtifactBatch, type StageArtifactRejection } from './stage-artifact-registry.ts'
import { DIRECTION_SPEC, EVALUATION_SPEC, getArtifactSpec } from './artifact-type-registry.ts'
import { splitFrontmatter } from './decision-registry.ts'
import { updateDecisionFile } from './decision-editor.ts'
import { watch } from 'chokidar'

// ─── 类型（契约 §一/§二）──────────────────────────────────────────────────

export type WorkflowType = 'career_direction'
export type WorkflowStatus = 'active' | 'completed' | 'aborted'
export type StageStatus = 'pending' | 'running' | 'waiting_gate' | 'completed' | 'failed'
export type StageId = 'fact_collection' | 'direction_exploration' | 'direction_evaluation' | 'recommendation'
export type GateId = 'confirm_person_facts' | 'confirm_directions' | 'review_recommendation'

export interface WorkflowGate {
  id: GateId
  status: 'waiting' | 'passed'
  confirmedAt?: string
}

export interface WorkflowStageState {
  id: StageId
  status: StageStatus
  startedAt?: string
  completedAt?: string
  /** 本 Stage 产出的 Artifact 引用（completed 时非空；Engine 登记） */
  artifacts?: string[]
  gate?: WorkflowGate
}

export interface WorkflowState {
  id: string // workflow_{YYYYMMDD}_{NNNNN}
  type: WorkflowType
  personId: string // person_XXX
  statement: string // 用户目标原文
  status: WorkflowStatus
  currentStage: StageId | null
  stages: WorkflowStageState[]
  /** 全流程阶段总数（= Stage 定义表长度；UI 投影阶段进度用——stages 数组只含已创建阶段，非总数） */
  totalStages: number
  createdAt: string
  updatedAt: string
  abortedAt?: string
}

// ─── Stage 定义表（契约 §2.3 Artifact I/O；本轮完成判定只实现 person-init，其余 evaluator 留接口）──

export interface StageSpec {
  id: StageId
  inputs: string[] // Artifact 语义名（非文件路径）
  outputs: string[]
  evaluator: 'person-init' | 'artifact-exists' | 'decision-registered'
  /** artifact-exists 参数（契约 v0.2 §3.1，L2-6 裁决 A）：完成判定 = 已登记产物存在（state 不限）；
   *  未挂 = 占位放行（Stage 3 下一切片） */
  evaluatorParams?: { artifactType: string; min: number }
  gate?: GateId
  /** 阶段执行任务（Execution Contract——Agent Execution Boundary Repair P0-B：
   *  结构化声明而非自由 Prompt；compileStageTask 编译成单一 Stage Execution Envelope 注入 agent/start）。
   *  declaredBoundaries.forbiddenStages = 声明边界（P0 注入 Envelope 文本；P1 接 PreToolUse 工具级强制）。 */
  task: {
    objective: string
    instructions: string[]
    expectedOutputs: string[]
    stopCondition: string
    declaredBoundaries: { forbiddenStages: StageId[] }
    /**
     * 单步输出预算（token）——Stage Policy（ADR-030 收尾）：输出上限是 Control Plane 旋钮，
     * 按阶段声明（成本/防截断同一尺）：@ai-sdk/anthropic 兼容模式默认 4096 曾实测截断工具调用
     * （2026-08-22 真机事故），显式预算必须 ≥ 阶段真实产出需要；数值以真机测量为准可调档。
     * 语义=单次 assistant 回合（每次工具调用回合独立计）。
     */
    outputBudget: number
    /**
     * Stage 级工具集声明（Tool Runtime 第二阶段 P1）：本阶段允许装配的工具名（收窄集）。
     * 缺省 = 不声明 = 继承全局白名单 config.agent.allowedTools（存量阶段行为不变）。
     * 声明后装配 = 本声明 ∩ 全局白名单 ∩ 已注册工具（交集语义，只收窄不扩大）；
     * 声明引擎未知工具名 → 任务启动 fail fast（Tool Assembly Layer 校验）。
     * ask_user_question 恒可用，不在此声明。
     */
    tools?: string[]
  }
}

export const CAREER_DIRECTION_STAGES: StageSpec[] = [
  {
    id: 'fact_collection',
    inputs: ['person', 'conversation'],
    outputs: ['person_aggregate'],
    evaluator: 'person-init',
    gate: 'confirm_person_facts',
    task: {
      objective: '澄清与补缺（Interview Agent）：基于已生成的候选清单与登记事实，回答用户疑问、引导确认、补问简历外信息；事实登记由确定性通道负责（Resume Facts Artifact → Candidate Generator），本阶段不做事实登记、不输出候选协议',
      instructions: [
        '候选事实不归本阶段生产：简历/访谈候选由引擎生成并进入候选清单（Candidate Inbox），用户确认后由引擎登记并投影',
        '禁止输出「候选标记：」等候选协议行——候选不走 Agent 文本通道（Agent 已退出候选生产）',
        '只做访谈职责：澄清用户问题、引导用户在候选清单逐条确认、补问遗漏信息（项目细节/兴趣/约束补充）',
        '用户补充的信息随对话写入 intake 记录，引擎可从访谈记录再次生成候选——不要自行写候选文件/快照/档案',
      ],
      expectedOutputs: ['用户问题回答', '候选确认引导', '简历外信息补问'],
      stopCondition: '用户疑问澄清 + 候选确认引导完成——停止；初始化完成判定由引擎门禁（快照三件齐备）裁决',
      declaredBoundaries: { forbiddenStages: ['direction_exploration', 'direction_evaluation', 'recommendation'] },
      outputBudget: 8192, // Interview 无产物文件名，档位居中（回笼元数据；不以 8192 为锚点扩大）
      // 渐进披露（Phase 4A）：访谈只读——「不自行写候选文件/快照/档案」从能力面杜绝（无 Write/Edit）；
      // 无外部工具（访谈不采外部事实——事实登记走确定性通道）。ask_user_question 恒可用，不在声明。
      tools: ['Read', 'Grep', 'Glob'],
    },
  },
  {
    id: 'direction_exploration',
    inputs: ['person_aggregate'],
    outputs: ['exploration_artifact'],
    evaluator: 'artifact-exists',
    evaluatorParams: { artifactType: 'direction_candidate', min: 1 },
    gate: 'confirm_directions',
    task: {
      objective: '方向探索：基于已确认的个人事实，执行 career-path 的 Step 1-3（三问定框架 / 方向画像卡 / Cross Off 排除 + IKIGAI）',
      instructions: ['只消费已登记事实（facts/ 与快照投影）', '输出方向候选清单与画像卡对比（exploration_artifact）', '不要进入加权打分（下一阶段）'],
      expectedOutputs: ['方向候选清单', '画像卡对比'],
      stopCondition: 'exploration_artifact 产出完成——停止，不进入加权打分',
      declaredBoundaries: { forbiddenStages: ['direction_evaluation', 'recommendation'] },
      outputBudget: 16384, // 2026-08-22 真机复测：flash 长叙述 + 多文件写入一轮输出；8192 在"准备写入处"截断（4/4 失败）→ 提档
      // 渐进披露（Phase 4A）：方向探索 = 外部世界事实采集唯一入口（行业/城市研究需要真实信息）
      // + 产物写入（exploration_artifact）——全信息工具集；其余阶段无外部取证职责。
      tools: [
        'Read', 'Grep', 'Glob', 'Write', 'Edit',
        'WebSearch', 'WebResearch', 'WebFetch',
        'QueryIndustryEvidence', 'QueryMacroStats', 'CompareRegionProfiles',
      ],
    },
  },
  {
    id: 'direction_evaluation',
    inputs: ['exploration_artifact', 'person_aggregate'],
    outputs: ['evaluation_artifact'],
    evaluator: 'artifact-exists',
    evaluatorParams: { artifactType: 'evaluation_candidate', min: 1 },
    task: {
      objective: '方向评估：基于方向候选清单，执行 career-path 的 Step 4-5（路径画像 / 加权打分）',
      instructions: ['基于上一阶段的方向候选清单加权打分', '输出方向加权评估明细（evaluation_artifact）', '不要输出最终推荐（下一阶段）'],
      expectedOutputs: ['方向加权评估明细'],
      stopCondition: 'evaluation_artifact 产出完成——停止，不输出最终推荐',
      declaredBoundaries: { forbiddenStages: ['recommendation'] },
      outputBudget: 16384, // 与探索同档（2026-08-22 真机测量指向长叙述 + 多文件写入一轮输出）
      // 渐进披露（Phase 4A）：evaluation = 消费探索产物的加权打分——不新增外部证据
      //（Evidence Contract 纪律：事实在探索阶段采集，评估阶段只推理）。
      tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
    },
  },
  {
    id: 'recommendation',
    inputs: ['evaluation_artifact', 'person_aggregate'],
    outputs: ['decision_artifact'],
    evaluator: 'decision-registered',
    gate: 'review_recommendation',
    task: {
      objective: '形成推荐：基于方向评估明细，执行 career-path 的 Step 6（输出报告）',
      instructions: [
        '产出决策报告（decisions/，Decision Record Contract；frontmatter 声明 person_id: {当前人} 与 type: direction）',
        '报告必须区分：confirmed fact（已登记事实）/ exploration input（未登记口述）/ inference（推理结论）',
      ],
      expectedOutputs: ['决策报告'],
      stopCondition: '决策报告产出完成——停止，等待 review_recommendation Gate',
      declaredBoundaries: { forbiddenStages: [] },
      outputBudget: 16384, // 2026-08-22 真机复测：4096 两次 45-57s 空输出（工具调用 JSON 截断态，0 决策）→ 与探索/评估同档提档
      // 渐进披露（Phase 4A）：recommendation = 基于评估明细出决策报告——写入 decisions/，无外部取证。
      tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
    },
  },
]

export const WORKFLOW_TYPES: WorkflowType[] = ['career_direction']

/** 合法 StageId 枚举（RPC 边界校验用） */
export const STAGE_IDS = CAREER_DIRECTION_STAGES.map((s) => s.id)

/** Stage spec 查询（UI 按 currentStage 取 taskTemplate 发起 agent/start；契约 §2.3） */
export function getStageSpec(stageId: StageId): StageSpec | undefined {
  return CAREER_DIRECTION_STAGES.find((s) => s.id === stageId)
}

/** Stage 序号（1-based；契约 §二 四阶段串行） */
export function stageIndex(stageId: StageId): number {
  return CAREER_DIRECTION_STAGES.findIndex((s) => s.id === stageId) + 1
}

/**
 * Stage Task Compiler（Agent Execution Boundary Repair P0-B/C）：
 * 引擎侧 Stage Boundary 三重校验 + 编译单一 Stage Execution Envelope。
 * 校验（任一失败 throw——Agent 启动被拒，不进入对话）：
 *   1. workflow 存在且 active；2. stageId == workflow.currentStage；3. 当前 Stage 状态 == running
 * 编译产物 = 一段系统级 Envelope 文本（注入 agent/start context，与用户消息分离——
 * 不是"又一条用户消息"，是控制平面下发的执行边界）。
 */
export function compileStageTask(ws: Workspace, workflowId: string, stageId: StageId): { workflow: WorkflowState; envelope: string } {
  const w = getWorkflow(ws, workflowId)
  if (!w) throw new Error(`Stage 启动被拒：workflow 不存在（${workflowId}）`)
  if (w.status !== 'active') throw new Error(`Stage 启动被拒：workflow 状态 ${w.status}（非 active）`)
  if (w.currentStage !== stageId) throw new Error(`Stage 启动被拒：当前阶段是 ${w.currentStage ?? '无'}，请求 ${stageId}（UI 越界）`)
  const stage = w.stages.find((s) => s.id === stageId)
  if (!stage || stage.status !== 'running') throw new Error(`Stage 启动被拒：${stageId} 状态 ${stage?.status ?? '未知'}（需 running）`)
  const spec = getStageSpec(stageId)!
  const idx = stageIndex(stageId)
  const total = w.totalStages
  const boundaryLine =
    spec.task.declaredBoundaries.forbiddenStages.length > 0
      ? `本阶段禁止进入：${spec.task.declaredBoundaries.forbiddenStages.join('、')}。用户若问到这些方向的问题，回答"该问题会在后续阶段处理"，然后继续当前阶段任务。`
      : '无阶段禁令。'
  // 方向池裁决状态注入（契约 §4.2「restage 后的 Stage task 上下文」）：每次 direction_exploration 执行
  // 都注入既有裁决——用户已排除的方向不得作为候选重新提案（标准约束，Envelope 层；引擎不做硬去重）
  let directionPoolState = ''
  if (stageId === 'direction_exploration') {
    const existing = listStageArtifacts(ws, DIRECTION_SPEC, w.personId, { workflowId: w.id, stageId })
    const confirmed = existing.filter((a) => a.state === 'confirmed').map((a) => a.claim).filter((c): c is string => Boolean(c))
    const rejected = existing.filter((a) => a.state === 'rejected').map((a) => a.claim).filter((c): c is string => Boolean(c))
    if (confirmed.length > 0 || rejected.length > 0) {
      directionPoolState = [
        '【DIRECTION_POOL_STATE】',
        ...(confirmed.length > 0 ? [`用户已保留的方向：${confirmed.join('、')}。`] : []),
        ...(rejected.length > 0 ? [`用户已排除的方向（不得作为候选重新提案）：${rejected.join('、')}。`] : []),
        '',
      ].join('\n')
    }
  }
  const artifactContract = buildArtifactContract(w.id, w.personId, stageId)
  const envelope = [
    '【WORKFLOW_STAGE】',
    `workflow_id: ${w.id}`,
    `stage_id: ${stageId}`,
    `stage_index: ${idx}`,
    `stage_count: ${total}`,
    '',
    '【USER_GOAL】',
    w.statement,
    '',
    '【STAGE_OBJECTIVE】',
    spec.task.objective,
    '',
    '【STAGE_INSTRUCTIONS】',
    ...spec.task.instructions.map((s, i) => `${i + 1}. ${s}`),
    '',
    '【EXPECTED_OUTPUTS】',
    ...spec.task.expectedOutputs.map((s, i) => `${i + 1}. ${s}`),
    '',
    '【STOP_CONDITION】',
    spec.task.stopCondition,
    '',
    ...(directionPoolState ? [directionPoolState] : []),
    '【STAGE_BOUNDARY】',
    boundaryLine,
    `Gate：${spec.gate ? `本阶段完成需通过 ${spec.gate}（由引擎裁决，用户确认）` : '本阶段无 Gate'}`,
    '不得自行推进下一 Stage。',
    // 用户交互契约（BUG 审计修复）：用户确认/选择由系统 Gate 与方向池呈现（Human Action 归引擎裁决），
    // Agent 不得以提问/请求确认收尾——完成本阶段产物后直接结束（done 由引擎登记 → Gate）。
    '本阶段的用户确认由系统在阶段结束后呈现（Gate/方向池），你不得以提问或请求用户确认收尾：',
    '完成本阶段产物后直接结束——不要向用户提问，不要请求确认，不要停留在对话等待。',
    ...(artifactContract ? ['', '【ARTIFACT_CONTRACT】', artifactContract, ''] : []),
  ].join('\n')
  return { workflow: w, envelope }
}

/** Artifact 契约（ADR-030 直连运行时标准修复）：产出格式由引擎声明注入 Envelope——
 *  不依赖模型读取工作区外的技能文件（直连工具 root 绑定 workspace，绝对路径不可读）。
 *  契约依据：storage/artifact-type-registry.ts 的 StageArtifactSpec（marker/证据域）+ 决策记录契约。 */
function buildArtifactContract(workflowId: string, personId: string, stageId: StageId): string | undefined {
  if (stageId === 'direction_exploration') {
    return [
      `- 产出文件：persons/${personId}/directions/{文件名}.md（每个方向一个文件——不要写总览文件）`,
      `- 文件名：{序号}-{描述}.md（如 01-通用机械结构工程师.md）；禁止使用 direction_/evaluation_ 前缀（系统命名由引擎登记后生成，Agent 不得占用）`,
      `- frontmatter（文件开头，必须，值照抄；只允许以下三个字段）：`,
      `  ---`,
      `  person_id: ${personId}`,
      `  workflow_id: ${workflowId}`,
      `  stage_id: direction_exploration`,
      `  ---`,
      `- 禁止在 frontmatter 增加 id/source_file/artifact_type/state/version 等字段（引擎登记时生成）`,
      `- 正文必须含段：段标题逐字照抄「## 方向主张」（写成「## 方向候选清单」等变体视为未完成；列表项 "- {方向名称}：{一句主张}"）与「## 事实依据」（每项 "- {引用来源}：依据说明"）`,
      `- 引用来源只允许 facts/ 或 snapshot/current/ 下的已有文件路径；无素材支撑的断言禁止写入；素材不足时标注"信息不足"`,
    ].join('\n')
  }
  if (stageId === 'direction_evaluation') {
    return [
      `- 产出文件：persons/${personId}/evaluations/{文件名}.md（每个方向一个文件——不要写总览文件）`,
      `- 文件名：{序号}-{描述}.md（如 01-通用机械结构工程师.md）；禁止使用 evaluation_/direction_ 前缀（系统命名由引擎登记后生成，Agent 不得占用）`,
      `- frontmatter（文件开头，必须，值照抄；只允许以下三个字段）：`,
      `  ---`,
      `  person_id: ${personId}`,
      `  workflow_id: ${workflowId}`,
      `  stage_id: direction_evaluation`,
      `  ---`,
      `- 禁止在 frontmatter 增加 id/source_file/artifact_type/state/version 等字段（引擎登记时生成）`,
      `- 正文必须含段：段标题逐字照抄「## 方向评估」（写成变体视为未完成；列表项 "- {方向名称}：{匹配度评估一句话}"）与「## 事实依据」（每项 "- {引用来源}：依据说明"）`,
      `- 引用来源只允许 facts/、snapshot/current/ 或 persons/${personId}/directions/ 下的已有文件路径；无素材支撑的断言禁止写入`,
    ].join('\n')
  }
  if (stageId === 'recommendation') {
    return [
      `- 产出文件：decisions/{YYYY-MM-DD}-{主题}.md`,
      `- frontmatter（文件开头，必须，值照抄；只允许以下三个字段）：`,
      `  ---`,
      `  person_id: ${personId}`,
      `  workflow_id: ${workflowId}`,
      `  stage_id: recommendation`,
      `  ---`,
      `- 禁止在 frontmatter 增加 id/source_file/artifact_type/state/version 等字段（引擎登记时生成）`,
      `- 正文必须以「## 分析摘要」两列表格开头（列协议：| 字段 | 值 |；字段名逐字照抄，值按括号内规则填）：`,
      `  | 字段 | 值 |`,
      `  |------|-----|`,
      `  | skill | career-path（来源子流程名） |`,
      `  | profile | 一句话用户画像（如"机械工程师 3 年经验"，不得为 -） |`,
      `  | direction | 主攻方向名（必须来自方向评估产物之一） |`,
      `  | direction_match | -（多方向评估按协议填 -；分项进明细段落） |`,
      `  | direction_confidence | - 或 高/中/低 |`,
      `  | city | {已登记城市名} 或 - |`,
      `  | city_score | - 或 X/10 |`,
      `  | salary_feasible | true/false |`,
      `  | risk_level | 低/中/中高/高 |`,
      `  | key_risk | ≤30 字一句话 |`,
      `  | status | complete |`,
      `  | protocol_version | 2.9 |`,
      `- 各方向分项必须写「## 方向评估明细」段落，列协议（表头逐字照抄，按列位置解析）：`,
      `  | 方向 | 匹配度 | 置信度 | 关键优势 | 关键风险 |`,
      `  |------|:--:|:--:|---------|---------|`,
      `  每方向一行；匹配度只许 71% 或 7.1/10 两种格式（百分号或 /10，其他写法引擎无法解析）`,
      `- 正文必须含段：## 推荐理由（每条理由标注依据来源）；推荐方向必须来自方向评估产物之一；无据断言禁止写入`,
    ].join('\n')
  }
  return undefined
}

// ─── 目录监听（workflows/ 变更 → 广播 workflowChanged；Engine 单方写，Agent/UI 只读）──

export function watchWorkflows(ws: Workspace, onChanged: (parsed: WorkflowState[]) => void): { close: () => Promise<void> } {
  const watcher = watch(ws.paths.workflows, { ignoreInitial: true })
  const rescan = (): void => onChanged(scanWorkflows(ws))
  watcher.on('add', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  watcher.on('change', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  watcher.on('unlink', (p: string) => {
    if (p.endsWith('.md')) rescan()
  })
  return { close: () => watcher.close() }
}

// ─── 序列化（workflows/{id}.md，Engine 单方写）────────────────────────────

function serialize(w: WorkflowState): string {
  return [
    '---',
    `id: ${w.id}`,
    `type: ${w.type}`,
    `person_id: ${w.personId}`,
    `status: ${w.status}`,
    `created_at: ${w.createdAt}`,
    `updated_at: ${w.updatedAt}`,
    ...(w.abortedAt ? [`aborted_at: ${w.abortedAt}`] : []),
    '---',
    '# 工作流',
    '',
    `目标：${w.statement}`,
    '',
    '## 分析摘要',
    '',
    '| 字段 | 值 |',
    '|------|-----|',
    `| id | ${w.id} |`,
    `| type | ${w.type} |`,
    `| person_id | ${w.personId} |`,
    `| status | ${w.status} |`,
    `| current_stage | ${w.currentStage ?? '-'} |`,
    `| total_stages | ${w.totalStages} |`,
    `| created_at | ${w.createdAt} |`,
    `| updated_at | ${w.updatedAt} |`,
    '',
    '## 阶段',
    '',
    '| stage | status | started_at | completed_at | gate | artifacts |',
    '|-------|--------|-----------|--------------|------|-----------|',
    ...w.stages.map((s) => [
      `| ${s.id} | ${s.status} | ${s.startedAt ?? '-'} | ${s.completedAt ?? '-'} | ${s.gate ? `${s.gate.id}/${s.gate.status}${s.gate.confirmedAt ? `/${s.gate.confirmedAt}` : ''}` : '-'} | ${(s.artifacts ?? []).join('、') || '-'} |`,
    ]),
    '',
  ].join('\n')
}

function parseWorkflowMarkdown(md: string): WorkflowState | null {
  const fm = md.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!fm) return null
  const meta: Record<string, string> = {}
  for (const line of fm[1].split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  if (!meta.id || !meta.type || !meta.person_id) return null
  const statement = md.match(/^目标：(.+)$/m)?.[1]?.trim() ?? ''
  // current_stage 在摘要表（frontmatter 不重复）——从表格行回读
  const currentStageRaw = md.match(/^\| current_stage \| ([^|]+) \|$/m)?.[1]?.trim()
  const currentStage = currentStageRaw && currentStageRaw !== '-' ? (currentStageRaw as StageId) : null
  const totalStagesRaw = md.match(/^\| total_stages \| (\d+) \|$/m)?.[1]?.trim()
  const totalStages = totalStagesRaw && /^\d+$/.test(totalStagesRaw) ? parseInt(totalStagesRaw, 10) : CAREER_DIRECTION_STAGES.length
  const stages: WorkflowStageState[] = []
  for (const line of md.split('\n')) {
    const m = line.match(/^\|\s*(\w+)\s*\|\s*(\w+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|$/)
    if (!m || m[1] === 'stage') continue
    if (!CAREER_DIRECTION_STAGES.some((s) => s.id === m[1])) continue
    const [st, started, completed, gateRaw, artifactsRaw] = [m[2], m[3]?.trim(), m[4]?.trim(), m[5]?.trim(), m[6]?.trim()]
    stages.push({
      id: m[1] as StageId,
      status: st as StageStatus,
      ...(started && started !== '-' ? { startedAt: started } : {}),
      ...(completed && completed !== '-' ? { completedAt: completed } : {}),
      ...(gateRaw && gateRaw !== '-'
        ? (() => {
            const parts = gateRaw.split('/')
            return {
              gate: {
                id: parts[0] as GateId,
                status: parts[1] === 'passed' ? ('passed' as const) : ('waiting' as const),
                ...(parts[2] ? { confirmedAt: parts.slice(2).join('/') } : {}),
              },
            }
          })()
        : {}),
      artifacts: artifactsRaw && artifactsRaw !== '-' ? artifactsRaw.split('、').filter(Boolean) : [],
    })
  }
  if (stages.length === 0) return null
  return {
    id: meta.id,
    type: meta.type as WorkflowType,
    personId: meta.person_id,
    statement,
    status: meta.status === 'completed' || meta.status === 'aborted' ? meta.status : 'active',
    currentStage,
    stages,
    totalStages,
    createdAt: meta.created_at ?? '',
    updatedAt: meta.updated_at ?? '',
    ...(meta.aborted_at ? { abortedAt: meta.aborted_at } : {}),
  }
}

// ─── 扫描 / 读写 ───────────────────────────────────────────────────────────

export function scanWorkflows(ws: Workspace, personId?: string): WorkflowState[] {
  let files: string[]
  try {
    files = ws.listMarkdown('workflows')
  } catch {
    return []
  }
  return files
    .sort()
    .map((f) => parseWorkflowMarkdown(ws.read(`workflows/${f}`)))
    .filter((w): w is WorkflowState => w !== null)
    .filter((w) => !personId || w.personId === personId)
}

export function getWorkflow(ws: Workspace, workflowId: string): WorkflowState | null {
  if (!/^workflow_\d{8}_\d{5}$/.test(workflowId)) return null
  const rel = `workflows/${workflowId}.md`
  if (!ws.exists(rel)) return null
  return parseWorkflowMarkdown(ws.read(rel))
}

export function writeWorkflow(ws: Workspace, w: WorkflowState, now: Date): void {
  const next: WorkflowState = { ...w, updatedAt: now.toISOString() }
  ws.write(`workflows/${w.id}.md`, serialize(next))
}

// ─── 确定性 Evaluator（契约 §三：不信任 Agent 自报）────────────────────────

/** person-init 完成判定：复用 completePersonInit 门禁（identity + skill_inventory + preference_constraints 齐备）。
 *  单一事实源——不另立第二套"初始化完成"规则（契约 §三）。 */
export function isPersonInitComplete(ws: Workspace, personId: string): boolean {
  const REQUIRED = ['identity.md', 'skill_inventory.md', 'preference_constraints.md']
  return REQUIRED.every((f) => ws.exists(`persons/${personId}/snapshot/current/${f}`))
}

function stageMissingInputs(ws: Workspace, spec: StageSpec, personId: string, workflowId: string): string[] {
  // v0.2/v0.3：person_aggregate（三件快照）+ exploration_artifact（方向池 confirmed ≥ 1）+
  // evaluation_artifact（评估候选已登记 ≥ 1，Stage 4 输入判定）
  const missing: string[] = []
  for (const input of spec.inputs) {
    if (input === 'person_aggregate' && !isPersonInitComplete(ws, personId)) {
      missing.push('person_aggregate（画像三件快照未齐备）')
    }
    if (input === 'exploration_artifact' && confirmedDirectionCount(ws, workflowId, personId) < 1) {
      missing.push('exploration_artifact（方向池 confirmed = 0——无用户批准的方向）')
    }
    if (
      input === 'evaluation_artifact' &&
      countStageArtifacts(ws, EVALUATION_SPEC, personId, { workflowId, stageId: 'direction_evaluation' }) < 1
    ) {
      missing.push('evaluation_artifact（已登记评估候选 = 0——Stage 3 未产出评估明细）')
    }
  }
  return missing
}

/**
 * 完成判定（契约 v0.2 §3）：evaluator 自报缺件（advance 第 2 步直接透传，不硬编码缺件名）。
 * - person-init：复用 completePersonInit 门禁（快照三件齐备）；缺件 = 快照缺 + 可补足候选缺
 * - artifact-exists：count(workflow/stage/artifactType/state) ≥ min（登记校验已由注册时完成，
 *   evaluator 只统计——单一真相源）；未挂 evaluatorParams = 占位放行（Stage 3 下一切片）
 * - decision-registered：仍占位（Stage 4 下一切片）
 */
export function evaluateStageCompletion(
  ws: Workspace,
  spec: StageSpec,
  personId: string,
  workflowId: string,
): { passed: boolean; missing: string[] } {
  switch (spec.evaluator) {
    case 'person-init': {
      const REQUIRED = ['identity.md', 'skill_inventory.md', 'preference_constraints.md']
      const missingSnapshots = REQUIRED.filter((f) => !ws.exists(`persons/${personId}/snapshot/current/${f}`))
      if (missingSnapshots.length === 0) return { passed: true, missing: [] }
      const missing: string[] = missingSnapshots.map((f) => `画像缺：${f}`)
      const candidatesMissing = missingSnapshots
        .map((f) => {
          const cover = SNAPSHOT_CANDIDATE_COVERAGE[f.replace(/\.md$/, '')] ?? []
          return `${f}（需 ${cover.join('/')} 类候选）`
        })
      if (candidatesMissing.length > 0) {
        missing.push(`候选缺：${candidatesMissing.join('；')}——需先采集并确认对应候选（Agent 依据已确认候选写快照）`)
      }
      return { passed: false, missing }
    }
    case 'artifact-exists': {
      const p = spec.evaluatorParams
      if (!p) return { passed: true, missing: [] } // 未挂参 = 占位（Stage 3 下一切片）
      const artifactSpec = getArtifactSpec(p.artifactType) // 挂参即需登记 spec——缺 = 配置错误 fail fast
      // L2-6 裁决 A：state 不限——已登记产物存在即完成（registered 是瞬态，裁决后仍算「有产物」；确认与否归 Gate）
      const count = countStageArtifacts(ws, artifactSpec, personId, {
        workflowId,
        stageId: spec.id,
      })
      if (count >= p.min) return { passed: true, missing: [] }
      return {
        passed: false,
        missing: [
          `已登记 Artifact 数 ${count}/${p.min}（artifact_type=${p.artifactType}，state 不限）`,
        ],
      }
    }
    case 'decision-registered': {
      // 契约 v0.3 §3.2：完成判定 = recommendation stage artifacts 列非空（onRecommendationDone 写入）。
      // evaluator 只读列——单一真相源（decision 合法性校验在登记时完成），不做第二套校验。
      const w = getWorkflow(ws, workflowId)
      const stage = w?.stages.find((s) => s.id === spec.id)
      const artifacts = stage?.artifacts ?? []
      if (artifacts.length >= 1) return { passed: true, missing: [] }
      return { passed: false, missing: [`已登记决策 0/1（decisions/ 关联本 workflow 的合法决策）`] }
    }
  }
}

// ─── workflow/start（双路径）──────────────────────────────────────────────

/** pending candidates 存在性（Path B 判定：复用现有候选，不重新收集） */
function hasPendingCandidates(ws: Workspace, personId: string): boolean {
  const rel = `persons/${personId}/extraction/candidates.md`
  if (!ws.exists(rel)) return false
  return ws.read(rel).split('\n').some((line) => /^\| c-\d+ \| pending \|/.test(line.trim()))
}

/** 候选类别（extraction/candidates.md 中文类目 → 英文键；与 person-watcher 的 CANDIDATE_CATEGORY_LABEL 反向一致） */
const CANDIDATE_CATEGORY_KEY: Record<string, string> = { 教育: 'education', 经历: 'experience', 技能: 'skill', 约束: 'constraint', 兴趣: 'interest' }

/** person-init 三件快照缺件 → 可由哪类候选补足（Path B guard：候选类别覆盖缺失快照才算"复用候选"成立）。
 *   identity.md ← 教育/经历候选（Agent 依据已确认教育/经历写身份档案）；
 *   skill_inventory.md ← 技能候选；
 *   preference_constraints.md ← 约束/兴趣候选（薪资/城市/偏好）。 */
const SNAPSHOT_CANDIDATE_COVERAGE: Record<string, string[]> = {
  identity: ['education', 'experience'],
  skill_inventory: ['skill'],
  preference_constraints: ['constraint', 'interest'],
}

/** 候选能否满足 person-init（Path B guard；契约 §4.4 增强——"有候选"≠"候选足以完成画像"）：
 *   - 快照已齐 → true（无需候选补足）；
 *   - 否则每个缺失快照都必须有对应类别的 pending 候选（否则 waiting_gate 后 advance 必 STAGE_INCOMPLETE → 死锁）。 */
export function candidatesCanSatisfyInit(ws: Workspace, personId: string): boolean {
  const REQUIRED = ['identity.md', 'skill_inventory.md', 'preference_constraints.md'] as const
  const missing = REQUIRED.filter((f) => !ws.exists(`persons/${personId}/snapshot/current/${f}`))
  if (missing.length === 0) return true
  const rel = `persons/${personId}/extraction/candidates.md`
  const categories = new Set<string>()
  if (ws.exists(rel)) {
    for (const line of ws.read(rel).split('\n')) {
      const m = line.match(/^\| c-\d+ \| pending \| (\S+) \|/)
      const key = m ? CANDIDATE_CATEGORY_KEY[m[1]!.trim()] : undefined
      if (key) categories.add(key)
    }
  }
  return missing.every((f) => (SNAPSHOT_CANDIDATE_COVERAGE[f.replace(/\.md$/, '')] ?? []).some((c) => categories.has(c)))
}

/** Path B 判定（startWorkflow/onFactCollectionReady 共用）：有候选 且 候选足以支撑 person-init */
function canUseExistingCandidates(ws: Workspace, personId: string): boolean {
  return hasPendingCandidates(ws, personId) && candidatesCanSatisfyInit(ws, personId)
}

function nextWorkflowId(ws: Workspace, now: Date): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `workflow_${day}_`
  let max = 0
  for (const f of ws.listMarkdown('workflows')) {
    if (!f.startsWith(prefix)) continue
    const n = parseInt(f.slice(prefix.length, -3), 10)
    if (!Number.isNaN(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(5, '0')}`
}

/**
 * workflow/start：创建 Goal + Stage 1。
 * - Path B：已有 pending candidates → Stage 1 直接 waiting_gate（不启动 Agent，不重新收集）
 * - Path A：无 → Stage 1 running（由调用方随后启动 fact_collection Agent task）
 * 返回 { workflow, path: 'A' | 'B' }。
 */
export function startWorkflow(
  ws: Workspace,
  params: { type: WorkflowType; personId: string; statement: string },
  now: Date = new Date(),
): { workflow: WorkflowState; path: 'A' | 'B' } {
  if (!WORKFLOW_TYPES.includes(params.type)) throw new Error(`workflow type 非法（合法：${WORKFLOW_TYPES.join('/')}）`)
  if (!/^person_\d{3}$/.test(params.personId)) throw new Error(`personId 非法：${params.personId}`)
  if (!params.statement?.trim()) throw new Error('statement 必填（用户目标原文）')
  if (!scanPersons(ws).some((p) => p.personId === params.personId)) throw new Error(`person 不存在：${params.personId}`)

  const id = nextWorkflowId(ws, now)
  const ts = now.toISOString()
  // P1 门禁（2026-08-22，用户旅程顺序）：初始化未完成 → 禁止发起工作流（UI/引擎双门禁）。
  // 初始化闭环（P0-1 确定性候选）负责事实；工作流不再承担事实收集——阶段 1 由此前置完成态跳过。
  const initState = readManifestInitState(ws, params.personId)
  if (initState !== 'completed') {
    throw new Error(
      `INIT_REQUIRED：请先完成职业档案初始化（当前 init_state=${initState ?? '缺失'}）——基础档案建立后才能发起职业方向工作流`,
    )
  }
  // 初始化已完成：事实收集（阶段 1）由初始化闭环（确定性候选 → 确认 → 快照）完成 →
  // 阶段 1 直接 completed + gate passed，工作流从阶段 2 方向探索开始（无会话 Agent 再收集）。
  const stage1: WorkflowStageState = {
    id: 'fact_collection',
    status: 'completed',
    completedAt: ts,
    gate: { id: 'confirm_person_facts' as GateId, status: 'passed', confirmedAt: ts },
  }
  const stage2: WorkflowStageState = {
    id: 'direction_exploration',
    status: 'running',
    startedAt: ts,
  }
  const workflow: WorkflowState = {
    id,
    type: params.type,
    personId: params.personId,
    statement: params.statement.trim(),
    status: 'active',
    currentStage: 'direction_exploration',
    stages: [stage1, stage2],
    totalStages: CAREER_DIRECTION_STAGES.length,
    createdAt: ts,
    updatedAt: ts,
  }
  writeWorkflow(ws, workflow, now)
  return { workflow, path: 'B' }
}

// ─── workflow/advance（四步校验；契约 §四.2）───────────────────────────────

export type AdvanceResult =
  | { ok: true; workflow: WorkflowState; nextStage: StageId | null; status: WorkflowStatus }
  | {
      ok: false
      code: 'ILLEGAL_STATE' | 'STAGE_INCOMPLETE' | 'NO_GATE' | 'GATE_PASSED' | 'GATE_BLOCKED' | 'MISSING_INPUTS'
      missing: string[]
    }

/** 方向池 confirmed 计数（confirm_directions gate 判定与 Stage 3 input 判定的单一事实源） */
function confirmedDirectionCount(ws: Workspace, workflowId: string, personId: string): number {
  return countStageArtifacts(ws, DIRECTION_SPEC, personId, {
    workflowId,
    stageId: 'direction_exploration',
    state: 'confirmed',
  })
}

/**
 * Gate 可过判定（契约 v0.2 §4.1 第 3 步）：gate 存在且未过时的附加确定性条件。
 * confirm_person_facts：完成条件已含（person-init 第 2 步判）→ 无条件；
 * confirm_directions：方向池 confirmed ≥ 1（用户批准至少 1 个方向作为 Stage 3 输入）→ 否则拒绝。
 */
function gateConditionPassed(ws: Workspace, gateId: GateId, w: WorkflowState): { passed: boolean; missing: string } {
  if (gateId === 'confirm_directions') {
    const confirmed = confirmedDirectionCount(ws, w.id, w.personId)
    if (confirmed < 1) {
      return { passed: false, missing: '无已确认方向（方向池 confirmed = 0——需用户确认至少 1 个方向候选后才能进入 Stage 3）' }
    }
  }
  return { passed: true, missing: '' }
}

/** v0.3 §3.4：review_recommendation gate passed → 联动 decision status → accepted。
 *  读 recommendation stage artifacts 列的 decision 系统 ID，复用 decision-editor 白名单更新。
 *  decision 文件在 advance 时点必存在（onRecommendationDone 已校验 person 匹配 + 记录 artifacts 列），
 *  缺失 = 系统异常 fail fast（updateDecisionFile 抛错）。 */
function acceptRecommendationDecisions(ws: Workspace, w: WorkflowState): void {
  const stage = w.stages.find((s) => s.id === 'recommendation')
  for (const id of stage?.artifacts ?? []) {
    updateDecisionFile(ws, id, { status: 'accepted' })
  }
}

export function advanceWorkflow(ws: Workspace, workflowId: string, gateId?: string, now: Date = new Date()): AdvanceResult {
  const w = getWorkflow(ws, workflowId)
  if (!w) throw new Error(`workflow 不存在：${workflowId}`)
  if (w.status !== 'active') return { ok: false, code: 'ILLEGAL_STATE', missing: [`workflow 状态 ${w.status}，非 active`] }

  const curIdx = w.stages.findIndex((s) => s.id === w.currentStage)
  if (curIdx < 0) return { ok: false, code: 'ILLEGAL_STATE', missing: ['currentStage 未定位'] }
  const cur = w.stages[curIdx]!
  const spec = CAREER_DIRECTION_STAGES.find((s) => s.id === cur.id)!

  // 1. 状态必须 waiting_gate（Agent running / pending 不允许推进；契约 §4.2）
  if (cur.status !== 'waiting_gate') {
    return { ok: false, code: 'ILLEGAL_STATE', missing: [`当前 Stage ${cur.id} 状态 ${cur.status}（需 waiting_gate）`] }
  }
  // 2. 完成条件满足（确定性 Evaluator；缺件由 evaluator 自报——契约 v0.2 §3.3，advance 不硬编码缺件名）
  const completion = evaluateStageCompletion(ws, spec, w.personId, w.id)
  if (!completion.passed) {
    return {
      ok: false,
      code: 'STAGE_INCOMPLETE',
      missing: [`${cur.id} 完成条件未满足（evaluator=${spec.evaluator}）`, ...completion.missing],
    }
  }
  // 3. Gate 存在且未过 + gate 可过判定（契约 v0.2 §4.1：confirm_directions 需 confirmed ≥ 1）
  if (spec.gate) {
    const gate = cur.gate
    if (!gate) return { ok: false, code: 'NO_GATE', missing: [`Stage ${cur.id} 缺 gate ${spec.gate}`] }
    if (gate.status === 'passed') return { ok: false, code: 'GATE_PASSED', missing: [`gate ${gate.id} 已通过`] }
    if (gateId !== undefined && gateId !== spec.gate) {
      return { ok: false, code: 'ILLEGAL_STATE', missing: [`gateId 不匹配（期望 ${spec.gate}，收到 ${gateId}）`] }
    }
    const gateCond = gateConditionPassed(ws, spec.gate, w)
    if (!gateCond.passed) return { ok: false, code: 'GATE_BLOCKED', missing: [`gate ${spec.gate} 条件未满足`, gateCond.missing] }
  }
  // 4. 下一 Stage inputs 齐备
  const nextSpec = CAREER_DIRECTION_STAGES[curIdx + 1]
  const missingInputs = nextSpec ? stageMissingInputs(ws, nextSpec, w.personId, w.id) : []
  if (missingInputs.length > 0) return { ok: false, code: 'MISSING_INPUTS', missing: missingInputs }

  // 推进：当前 → completed（gate passed）；创建下一 Stage
  const ts = now.toISOString()
  // BUG-007 修复：confirm_person_facts gate passed = 用户确认事实的权威时刻 →
  //   联动 manifest init_state → completed（Engine Registration 拥有 Canonical State；
  //   复用 completePersonInit 单一门禁——advance 第 2 步已判三件齐备，此处重校验同源不会抛）
  if (cur.id === 'fact_collection' && spec.gate === 'confirm_person_facts') {
    completePersonInit(ws, w.personId)
  }
  // v0.3 §3.4：review_recommendation gate passed = 用户采纳推荐的权威时刻 →
  //   联动 decision status → accepted（Engine Registration 拥有 Canonical State；
  //   复用 decision-editor 白名单——decision 文件在 advance 时点必存在，onRecommendationDone 已校验）
  if (cur.id === 'recommendation' && spec.gate === 'review_recommendation') {
    acceptRecommendationDecisions(ws, w)
  }
  const stages = w.stages.map((s, i) =>
    i === curIdx
      ? {
          ...s,
          status: 'completed' as StageStatus,
          completedAt: ts,
          ...(spec.gate ? { gate: { id: spec.gate, status: 'passed' as const, confirmedAt: ts } } : {}),
        }
      : s,
  )
  if (nextSpec) {
    stages.push({ id: nextSpec.id, status: 'running' as StageStatus, startedAt: ts })
  }
  const done = nextSpec === undefined
  const next: WorkflowState = {
    ...w,
    status: done ? 'completed' : 'active',
    currentStage: nextSpec ? nextSpec.id : null,
    stages,
    updatedAt: ts,
  }
  writeWorkflow(ws, next, now)
  return { ok: true, workflow: next, nextStage: nextSpec ? nextSpec.id : null, status: next.status }
}

// ─── workflow/abort ────────────────────────────────────────────────────────

export function abortWorkflow(ws: Workspace, workflowId: string, now: Date = new Date()): WorkflowState {
  const w = getWorkflow(ws, workflowId)
  if (!w) throw new Error(`workflow 不存在：${workflowId}`)
  if (w.status !== 'active') throw new Error(`workflow 状态 ${w.status}，不可 abort`)
  const ts = now.toISOString()
  // 同步当前 Stage → failed（六态含 failed）：abort = 当前阶段未完成即中止，
  // 阶段表不得滞留 waiting_gate/running（审计语义一致——BUG-004 修复）
  const next: WorkflowState = {
    ...w,
    status: 'aborted',
    abortedAt: ts,
    updatedAt: ts,
    stages: w.stages.map((s) => (s.id === w.currentStage && (s.status === 'waiting_gate' || s.status === 'running' || s.status === 'pending') ? { ...s, status: 'failed' as StageStatus } : s)),
  }
  writeWorkflow(ws, next, now)
  return next
}

/**
 * workflow/restage（契约 v0.2 §4.2）：当前 Stage 重跑出口。
 * 前置条件（收紧）：仅 current stage = waiting_gate 且 gate.status != passed，或 current stage = failed。
 * 禁止：completed / gate=passed / pending / running（restage 只作用于 currentStage，无 stageId 参数）。
 * 动作：当前 stage → running、清 gate；已完成 stage 不动；方向池不重置（append-only 累积池）。
 * 新 intake boundary 由 transport 层在下一次 agent/start 时建立。
 */
export function restageWorkflow(ws: Workspace, workflowId: string, now: Date = new Date()): WorkflowState {
  const w = getWorkflow(ws, workflowId)
  if (!w) throw new Error(`workflow 不存在：${workflowId}`)
  if (w.status !== 'active') throw new Error(`workflow 状态 ${w.status}，不可 restage`)
  const stage = w.stages.find((s) => s.id === w.currentStage)
  if (!stage) throw new Error('currentStage 未定位，不可 restage')
  const allowed = stage.status === 'failed' || (stage.status === 'waiting_gate' && stage.gate?.status !== 'passed')
  if (!allowed) {
    throw new Error(`Stage ${stage.id} 状态 ${stage.status}（gate ${stage.gate?.status ?? '无'}），不可 restage（仅 waiting_gate 且 gate 未过 / failed）`)
  }
  const ts = now.toISOString()
  const next: WorkflowState = {
    ...w,
    updatedAt: ts,
    stages: w.stages.map((s) =>
      s.id === w.currentStage ? { ...s, status: 'running' as StageStatus, gate: undefined } : s,
    ),
  }
  writeWorkflow(ws, next, now)
  return next
}

/**
 * direction_exploration 输出就绪回调（契约 v0.2 §4.1 done 钩子）：Agent 完成方向探索后调用。
 * - intake 清单（本次执行新产生的提案文件）逐个登记：合法 → registered；非法 → 拒绝明细（调用方广播）
 * - guard（确定性，不信任自报）：registered ≥ 1 → waiting_gate（挂 confirm_directions）+ artifacts 列写盘；
 *   registered = 0 → failed（无登记产物 = 完成判定必败）
 * - 幂等：非 running 的 direction_exploration 不处理。
 */
export function onExplorationDone(
  ws: Workspace,
  workflowId: string,
  proposalFiles: string[],
  now: Date = new Date(),
): { workflow: WorkflowState | null; registered: StageArtifact[]; rejected: StageArtifactRejection[] } {
  const w = getWorkflow(ws, workflowId)
  if (!w || w.status !== 'active') return { workflow: null, registered: [], rejected: [] }
  const stage = w.stages.find((s) => s.id === 'direction_exploration')
  if (!stage || stage.status !== 'running') return { workflow: null, registered: [], rejected: [] }

  const batch = registerStageArtifactBatch(
    ws,
    DIRECTION_SPEC,
    { personId: w.personId, workflowId: w.id, stageId: 'direction_exploration', proposalFiles },
    now,
  )
  const ts = now.toISOString()
  const passed = batch.registered.length > 0
  const next: WorkflowState = {
    ...w,
    stages: w.stages.map((s) =>
      s.id === 'direction_exploration'
        ? {
            ...s,
            status: passed ? ('waiting_gate' as StageStatus) : ('failed' as StageStatus),
            ...(passed
              ? {
                  // 累积池（§4.2）：restage 后二次执行的登记追加到既有 artifacts 列，不覆盖
                  artifacts: [...(stage.artifacts ?? []), ...batch.registered.map((a) => a.artifact_id)],
                  gate: { id: 'confirm_directions' as GateId, status: 'waiting' as const },
                }
              : {}),
          }
        : s,
    ),
    updatedAt: ts,
  }
  writeWorkflow(ws, next, now)
  return { workflow: next, registered: batch.registered, rejected: batch.rejected }
}

/**
 * direction_evaluation 输出就绪回调（契约 v0.3 §2.3 done 钩子）：Agent 完成方向评估后调用。
 * - intake 清单（本次执行新产生的评估提案）逐个登记：合法 → registered；非法 → 拒绝明细（调用方广播）
 * - guard：registered ≥ 1 → waiting_gate（无 gate——评估非用户事实，不裁决）；0 → failed
 * - 幂等：非 running 的 direction_evaluation 不处理。
 */
export function onEvaluationDone(
  ws: Workspace,
  workflowId: string,
  proposalFiles: string[],
  now: Date = new Date(),
): { workflow: WorkflowState | null; registered: StageArtifact[]; rejected: StageArtifactRejection[] } {
  const w = getWorkflow(ws, workflowId)
  if (!w || w.status !== 'active') return { workflow: null, registered: [], rejected: [] }
  const stage = w.stages.find((s) => s.id === 'direction_evaluation')
  if (!stage || stage.status !== 'running') return { workflow: null, registered: [], rejected: [] }

  const batch = registerStageArtifactBatch(
    ws,
    EVALUATION_SPEC,
    { personId: w.personId, workflowId: w.id, stageId: 'direction_evaluation', proposalFiles },
    now,
  )
  const ts = now.toISOString()
  const passed = batch.registered.length > 0
  const next: WorkflowState = {
    ...w,
    stages: w.stages.map((s) =>
      s.id === 'direction_evaluation'
        ? {
            ...s,
            status: passed ? ('waiting_gate' as StageStatus) : ('failed' as StageStatus),
            ...(passed
              ? {
                  // 累积（§4.2 语义延续）：restage 后二次执行追加到既有 artifacts 列，不覆盖
                  artifacts: [...(stage.artifacts ?? []), ...batch.registered.map((a) => a.artifact_id)],
                }
              : {}),
          }
        : s,
    ),
    updatedAt: ts,
  }
  writeWorkflow(ws, next, now)
  return { workflow: next, registered: batch.registered, rejected: batch.rejected }
}

/**
 * recommendation 输出就绪回调（契约 v0.3 §3.3 done 钩子）：Agent 完成推荐报告后调用。
 * 前置：调用方（transport 层）已 registerDecisionIdentity 幂等补登记——本函数只校验归属 + 记录，
 * 不做登记（登记权在 decision-registry，非本层）。
 * - 逐个校验新决策文件 frontmatter person_id == workflow.personId（归属正确）
 * - 合法 → 记录 decision 系统 ID 到 stage 4 artifacts 列（累积追加）
 * - guard：合法 ≥ 1 → waiting_gate（挂 review_recommendation）；0 → failed
 * - 幂等：非 running 的 recommendation 不处理。
 */
export function onRecommendationDone(
  ws: Workspace,
  workflowId: string,
  newDecisionFiles: string[],
  now: Date = new Date(),
): { workflow: WorkflowState | null; decisions: string[] } {
  const w = getWorkflow(ws, workflowId)
  if (!w || w.status !== 'active') return { workflow: null, decisions: [] }
  const stage = w.stages.find((s) => s.id === 'recommendation')
  if (!stage || stage.status !== 'running') return { workflow: null, decisions: [] }

  const decisions: string[] = []
  for (const f of newDecisionFiles) {
    const rel = `decisions/${f}`
    if (!ws.exists(rel)) continue
    const { meta } = splitFrontmatter(ws.read(rel))
    if (meta.person_id !== w.personId) continue
    decisions.push(meta.id ?? f.replace(/\.md$/, ''))
  }

  const passed = decisions.length > 0
  const ts = now.toISOString()
  const next: WorkflowState = {
    ...w,
    stages: w.stages.map((s) =>
      s.id === 'recommendation'
        ? {
            ...s,
            status: passed ? ('waiting_gate' as StageStatus) : ('failed' as StageStatus),
            ...(passed
              ? {
                  // 累积：restage 后二次执行追加到既有 artifacts 列，不覆盖（decision append-only）
                  artifacts: [...(stage.artifacts ?? []), ...decisions],
                  gate: { id: 'review_recommendation' as GateId, status: 'waiting' as const },
                }
              : {}),
          }
        : s,
    ),
    updatedAt: ts,
  }
  writeWorkflow(ws, next, now)
  return { workflow: next, decisions }
}

// ─── 状态变更钩子（Agent 完成 Stage 输出时由调用方触发；v0.2：fact_collection + direction_exploration）──

/**
 * fact_collection 输出就绪回调：Agent 完成候选收集（Path A）后调用——
 * 有 pending candidates → waiting_gate（挂 gate）；无 → failed（Agent 未产出候选，不信任自报）。
 * 幂等：非 running 的 fact_collection 不处理。
 */
export function onFactCollectionReady(ws: Workspace, workflowId: string, now: Date = new Date()): WorkflowState | null {
  const w = getWorkflow(ws, workflowId)
  if (!w || w.status !== 'active') return null
  const stage = w.stages.find((s) => s.id === 'fact_collection')
  if (!stage || stage.status !== 'running') return null
  const ts = now.toISOString()
  // Path B guard 同判（契约 §4.4 增强）：Agent 产出候选须足以支撑 person-init——
  // 只有约束/兴趣类（无教育/经历/技能）→ failed（缺件引导补采），不挂 waiting_gate（否则确认即死锁）
  const useExisting = canUseExistingCandidates(ws, w.personId)
  const next: WorkflowState = {
    ...w,
    stages: w.stages.map((s) =>
      s.id === 'fact_collection'
        ? {
            ...s,
            status: useExisting ? ('waiting_gate' as StageStatus) : ('failed' as StageStatus),
            ...(useExisting ? { gate: { id: 'confirm_person_facts' as GateId, status: 'waiting' as const } } : {}),
          }
        : s,
    ),
    updatedAt: ts,
  }
  writeWorkflow(ws, next, now)
  return next
}
