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
 * - v0.1 单一类型 career_direction，四 Stage 串行；Stage 2-4 本轮只定义不深改业务（§十）。
 */
import type { Workspace } from './workspace.ts'
import { scanPersons } from './person-watcher.ts'
import { watch } from 'chokidar'

// ─── 类型（契约 §一/§二）──────────────────────────────────────────────────

export type WorkflowType = 'career_direction'
export type WorkflowStatus = 'active' | 'completed' | 'aborted'
export type StageStatus = 'pending' | 'running' | 'waiting_gate' | 'completed' | 'failed'
export type StageId = 'fact_collection' | 'direction_exploration' | 'direction_evaluation' | 'recommendation'
export type GateId = 'confirm_person_facts' | 'review_recommendation'

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
  gate?: GateId
  /** Stage task 指令模板（UI 收到 nextStage 后按此发起 agent/start；resumeSessionId 续接前一 Stage）。
   *  career-path SKILL 阶段化（契约 §2.3 task 字段）：每 Stage 一个独立任务片段，不再一个长 task 跑完。 */
  taskTemplate: string
}

export const CAREER_DIRECTION_STAGES: StageSpec[] = [
  {
    id: 'fact_collection',
    inputs: ['person', 'conversation'],
    outputs: ['person_aggregate'],
    evaluator: 'person-init',
    gate: 'confirm_person_facts',
    taskTemplate:
      '阶段任务：个人事实收集（Career Workflow Stage 1/4）。\n' +
      '从当前会话收集用户的教育/经历/技能/求职偏好口述信息，逐一整理为候选（不要自己登记为事实）：\n' +
      '1. 将识别到的用户事实写入 persons/{person_id}/extraction/candidates.md（appendCandidates 通道，标注 source 与分类）\n' +
      '2. 候选必须带来源（口述/简历），禁止编造\n' +
      '3. 收集完成后报告候选清单，等待用户确认——不要继续做方向分析（下一阶段会另行开始）',
  },
  {
    id: 'direction_exploration',
    inputs: ['person_aggregate'],
    outputs: ['exploration_artifact'],
    evaluator: 'artifact-exists',
    taskTemplate:
      '阶段任务：方向探索（Career Workflow Stage 2/4）。\n' +
      '基于已确认的个人事实，执行 career-path 的 Step 1-3（三问定框架 / 方向画像卡 / Cross Off 排除 + IKIGAI）——\n' +
      '输出方向候选清单与画像卡对比（exploration_artifact），不要进入加权打分（下一阶段）',
  },
  {
    id: 'direction_evaluation',
    inputs: ['exploration_artifact', 'person_aggregate'],
    outputs: ['evaluation_artifact'],
    evaluator: 'artifact-exists',
    taskTemplate:
      '阶段任务：方向评估（Career Workflow Stage 3/4）。\n' +
      '基于方向候选清单，执行 career-path 的 Step 4-5（路径画像 / 加权打分）——\n' +
      '输出方向加权评估明细（evaluation_artifact），不要输出最终推荐（下一阶段）',
  },
  {
    id: 'recommendation',
    inputs: ['evaluation_artifact', 'person_aggregate'],
    outputs: ['decision_artifact'],
    evaluator: 'decision-registered',
    gate: 'review_recommendation',
    taskTemplate:
      '阶段任务：形成推荐（Career Workflow Stage 4/4）。\n' +
      '基于方向评估明细，执行 career-path 的 Step 6（输出报告）——\n' +
      '产出决策报告（decisions/，Decision Record Contract），报告必须区分：confirmed fact（已登记事实）/ exploration input（未登记口述）/ inference（推理结论）',
  },
]

export const WORKFLOW_TYPES: WorkflowType[] = ['career_direction']

/** Stage spec 查询（UI 按 currentStage 取 taskTemplate 发起 agent/start；契约 §2.3） */
export function getStageSpec(stageId: StageId): StageSpec | undefined {
  return CAREER_DIRECTION_STAGES.find((s) => s.id === stageId)
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

function writeWorkflow(ws: Workspace, w: WorkflowState, now: Date): void {
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

function stageMissingInputs(ws: Workspace, spec: StageSpec, personId: string): string[] {
  // v0.1：只实现 person-init 输入判定（person_aggregate = 三件快照）；artifact-exists/decision-registered
  // 为 Stage 2-4 预留（本轮不深改业务），其 inputs 校验留空（Stage 2-4 定义完整但 advance 推进时由 evaluator 把关）
  const missing: string[] = []
  for (const input of spec.inputs) {
    if (input === 'person_aggregate' && !isPersonInitComplete(ws, personId)) {
      missing.push('person_aggregate（画像三件快照未齐备）')
    }
  }
  return missing
}

function stageEvaluatorPassed(ws: Workspace, spec: StageSpec, personId: string): boolean {
  switch (spec.evaluator) {
    case 'person-init':
      return isPersonInitComplete(ws, personId)
    case 'artifact-exists':
      // Stage 2-4 业务未深改：本轮推进由调用方（UI）显式触发后由 gate/inputs 把关；
      // evaluator 留接口，返回 true 仅表示"无已实现阻断项"
      return true
    case 'decision-registered':
      return true
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
  // Path B guard（契约 §4.4 增强）：有候选 且 候选类别足以支撑缺失快照（否则 waiting_gate 后 advance
  // 必 STAGE_INCOMPLETE → 死锁——测试区 7 条约束/兴趣候选无教育/经历即此场景）。不足 → 走 Path A 补采。
  const useExisting = canUseExistingCandidates(ws, params.personId)
  const stage1: WorkflowStageState = {
    id: 'fact_collection',
    status: useExisting ? 'waiting_gate' : 'running',
    startedAt: ts,
    ...(useExisting
      ? { gate: { id: 'confirm_person_facts' as GateId, status: 'waiting' as const } }
      : {}),
  }
  const workflow: WorkflowState = {
    id,
    type: params.type,
    personId: params.personId,
    statement: params.statement.trim(),
    status: 'active',
    currentStage: 'fact_collection',
    stages: [stage1],
    totalStages: CAREER_DIRECTION_STAGES.length,
    createdAt: ts,
    updatedAt: ts,
  }
  writeWorkflow(ws, workflow, now)
  return { workflow, path: useExisting ? 'B' : 'A' }
}

// ─── workflow/advance（四步校验；契约 §四.2）───────────────────────────────

export type AdvanceResult =
  | { ok: true; workflow: WorkflowState; nextStage: StageId | null; status: WorkflowStatus }
  | { ok: false; code: 'ILLEGAL_STATE' | 'STAGE_INCOMPLETE' | 'NO_GATE' | 'GATE_PASSED' | 'MISSING_INPUTS'; missing: string[] }

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
  // 2. 完成条件满足（确定性 Evaluator）
  if (!stageEvaluatorPassed(ws, spec, w.personId)) {
    const REQUIRED = ['identity.md', 'skill_inventory.md', 'preference_constraints.md']
    const missingSnapshots = REQUIRED.filter((f) => !ws.exists(`persons/${w.personId}/snapshot/current/${f}`))
    const missingCandidates = missingSnapshots
      .map((f) => {
        const cover = SNAPSHOT_CANDIDATE_COVERAGE[f.replace(/\.md$/, '')] ?? []
        return `${f}（需 ${cover.join('/')} 类候选）`
      })
    return {
      ok: false,
      code: 'STAGE_INCOMPLETE',
      missing: [
        `${cur.id} 完成条件未满足（evaluator=${spec.evaluator}）`,
        `画像缺：${missingSnapshots.length > 0 ? missingSnapshots.join('、') : '（快照已齐但判定失败——需人工排查）'}`,
        ...(missingCandidates.length > 0 ? [`候选缺：${missingCandidates.join('；')}——需先采集并确认对应候选（Agent 依据已确认候选写快照）`] : []),
      ],
    }
  }
  // 3. Gate 存在且未过
  if (spec.gate) {
    const gate = cur.gate
    if (!gate) return { ok: false, code: 'NO_GATE', missing: [`Stage ${cur.id} 缺 gate ${spec.gate}`] }
    if (gate.status === 'passed') return { ok: false, code: 'GATE_PASSED', missing: [`gate ${gate.id} 已通过`] }
    if (gateId !== undefined && gateId !== spec.gate) {
      return { ok: false, code: 'ILLEGAL_STATE', missing: [`gateId 不匹配（期望 ${spec.gate}，收到 ${gateId}）`] }
    }
  }
  // 4. 下一 Stage inputs 齐备
  const nextSpec = CAREER_DIRECTION_STAGES[curIdx + 1]
  const missingInputs = nextSpec ? stageMissingInputs(ws, nextSpec, w.personId) : []
  if (missingInputs.length > 0) return { ok: false, code: 'MISSING_INPUTS', missing: missingInputs }

  // 推进：当前 → completed（gate passed）；创建下一 Stage
  const ts = now.toISOString()
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

// ─── 状态变更钩子（Agent 完成 Stage 输出时由调用方触发；v0.1 只实现 fact_collection）──

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
