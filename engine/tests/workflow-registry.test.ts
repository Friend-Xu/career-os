import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initWorkspace, type Workspace } from '../storage/workspace.ts'
import {
  startWorkflow,
  advanceWorkflow,
  abortWorkflow,
  getWorkflow,
  scanWorkflows,
  onEvaluationDone,
  onExplorationDone,
  onFactCollectionReady,
  onRecommendationDone,
  restageWorkflow,
  isPersonInitComplete,
  evaluateStageCompletion,
  writeWorkflow,
  type WorkflowState,
  type WorkflowStageState,
  CAREER_DIRECTION_STAGES,
} from '../storage/workflow-registry.ts'
import { countStageArtifacts, registerStageArtifact, resolveStageArtifact } from '../storage/stage-artifact-registry.ts'
import { DIRECTION_SPEC } from '../storage/artifact-type-registry.ts'
import { KNOWN_TOOL_NAMES } from '../agent/tools/tool-assembly.ts'
import { registerDecisionIdentity } from '../storage/decision-registry.ts'
import { freshIntakeFiles } from '../transport/websocket.ts'
import { createPersonSession, scanPersons, setManifestInitState } from '../storage/person-watcher.ts'
import { compileStageTask, failStage, getStageSpec } from '../storage/workflow-registry.ts'

let wsSeq = 0
function testWorkspace(): Workspace {
  wsSeq++
  return initWorkspace(`.local/ws-workflow-test-${Date.now()}-${wsSeq}`)
}

function makePerson(ws: Workspace): string {
  const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
  seedCompleteSnapshots(ws, personId)
  setManifestInitState(ws, personId, 'completed')
  return personId
}

/** 旧语义工作流种子（legacy 兼容路径）：2026-08-22 后 startWorkflow 对已完成初始化档案直接跳过
 *  事实收集（阶段 1 completed）——running/waiting_gate 阶段 1 仅遗留工作流（restage）可达；
 *  onFactCollectionReady / stage-1 advance 守卫函数仍保留并在此覆盖。 */
let legacySeq = 0
function legacyStage1Workflow(ws: Workspace, personId: string, stageStatus: 'running' | 'waiting_gate'): WorkflowState {
  legacySeq++
  const id = `workflow_20260820_${String(10000 + legacySeq)}`
  const ts = '2026-08-20T00:00:00Z'
  const stages: WorkflowStageState[] = [
    {
      id: 'fact_collection',
      status: stageStatus,
      startedAt: ts,
      ...(stageStatus === 'waiting_gate' ? { gate: { id: 'confirm_person_facts' as const, status: 'waiting' as const } } : {}),
    },
  ]
  const w: WorkflowState = {
    id,
    type: 'career_direction',
    personId,
    statement: GOAL,
    status: 'active',
    currentStage: 'fact_collection',
    stages,
    totalStages: CAREER_DIRECTION_STAGES.length,
    createdAt: ts,
    updatedAt: ts,
  }
  writeWorkflow(ws, w, new Date(ts))
  return w
}

/** 补齐 person-init 三件快照（复用 completePersonInit 门禁判定） */
function seedCompleteSnapshots(ws: Workspace, personId: string): void {
  ws.write(`persons/${personId}/snapshot/current/identity.md`, '# 身份\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| location | 苏州 |\n')
  ws.write(`persons/${personId}/snapshot/current/skill_inventory.md`, '# 技能\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| skill_count | 1 |\n\n## A. 技能清单\n\n| skill_id | 技能 | level | usage_context |\n|----------|------|-------|---------------|\n| skill_001 | 机械设计 | applied-professional | 结构设计 |\n')
  ws.write(`persons/${personId}/snapshot/current/preference_constraints.md`, '# 偏好\n\n## 分析摘要\n\n| 字段 | 值 |\n|------|-----|\n| city | 苏州 |\n')
}

/** 写 pending candidates（Path B 判定输入；格式对齐 extraction/candidates.md）。
 *  默认含教育/经历/技能/约束/兴趣全类别（真实采集产物，足以支撑 person-init） */
function seedPendingCandidates(ws: Workspace, personId: string): void {
  ws.write(`persons/${personId}/extraction/candidates.md`, [
    '# Extraction Candidates',
    '',
    '| id | status | category | content | source |',
    '|----|--------|----------|---------|--------|',
    '| c-001 | pending | 教育 | University-A 机械工程本科 2019-2023 | user_reported |',
    '| c-002 | pending | 经历 | 2年 IVD 结构设计经验 | user_reported |',
    '| c-003 | pending | 技能 | 机械结构设计 | user_reported |',
    '| c-004 | pending | 约束 | 期望城市苏州 | user_reported |',
    '| c-005 | pending | 兴趣 | 继续机械方向 | user_reported |',
    '',
  ].join('\n'))
}

/** 测试区镜像：只有约束/兴趣候选（无教育/经历/技能）——Path B guard 必须拒绝复用，走 Path A 补采 */
function seedConstraintOnlyCandidates(ws: Workspace, personId: string): void {
  ws.write(`persons/${personId}/extraction/candidates.md`, [
    '# Extraction Candidates',
    '',
    '| id | status | category | content | source |',
    '|----|--------|----------|---------|--------|',
    '| c-001 | pending | 约束 | 期望城市苏州 | user_reported |',
    '| c-002 | pending | 兴趣 | 继续机械方向 | user_reported |',
    '',
  ].join('\n'))
}

const GOAL = '帮我确定职业方向'
const NOW = new Date('2026-08-21T00:00:00Z')

// ─── 发起门禁 + 初始化完成后的工作流结构（P1/P0-1 修正语义）────────────────────

test('startWorkflow 门禁（P1）：init_state 未完成 → INIT_REQUIRED（uploading/候选确认/旧 in_progress）', () => {
  for (const [label, prep] of [
    ['uploading（新创建）', (_ws: Workspace, _pid: string) => {}],
    ['candidate_review（已生成候选）', (ws: Workspace, pid: string) => seedPendingCandidates(ws, pid)],
    ['legacy in_progress', (ws: Workspace, pid: string) => setManifestInitState(ws, pid, 'in_progress')],
  ] as const) {
    const ws = testWorkspace()
    const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'resume' })
    prep(ws, personId)
    assert.throws(
      () => startWorkflow(ws, { type: 'career_direction', personId, statement: GOAL }),
      /INIT_REQUIRED：请先完成职业档案初始化/,
      label,
    )
  }
})

test('startWorkflow：初始化完成 → 阶段 1 事实收集 completed + gate passed + 阶段 2 方向探索 running', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow, path } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL }, new Date('2026-08-21T00:00:00Z'))
  // 事实收集已并入初始化闭环（P0-1 确定性候选）——工作流不再承担收集
  assert.equal(path, 'B')
  assert.equal(workflow.status, 'active')
  assert.equal(workflow.totalStages, 4)
  assert.equal(workflow.currentStage, 'direction_exploration')
  assert.equal(workflow.stages[0]!.status, 'completed')
  assert.deepEqual(workflow.stages[0]!.gate, { id: 'confirm_person_facts', status: 'passed', confirmedAt: workflow.stages[0]!.gate!.confirmedAt })
  assert.equal(workflow.stages[1]!.id, 'direction_exploration')
  assert.equal(workflow.stages[1]!.status, 'running')
  // 落盘可回读
  const reloaded = getWorkflow(ws, workflow.id)!
  assert.equal(reloaded.id, workflow.id)
  assert.equal(reloaded.currentStage, 'direction_exploration')
})

// ─── legacy 守卫（2026-08-22 后阶段 1 仅遗留工作流可达；守卫逻辑保留）────────────

test('onFactCollectionReady（legacy）：阶段 1 running + 候选齐备 → waiting_gate + gate 挂载', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflow = legacyStage1Workflow(ws, pid, 'running')
  seedPendingCandidates(ws, pid)
  const next = onFactCollectionReady(ws, workflow.id)!
  assert.equal(next.stages[0]!.status, 'waiting_gate')
  assert.deepEqual(next.stages[0]!.gate, { id: 'confirm_person_facts', status: 'waiting' })
})

test('onFactCollectionReady（legacy）：无候选 → failed（不信任自报）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflow = legacyStage1Workflow(ws, pid, 'running')
  const next = onFactCollectionReady(ws, workflow.id)!
  assert.equal(next.stages[0]!.status, 'failed')
})

test('onFactCollectionReady guard（legacy）：候选只有约束/兴趣（无教育/经历）→ failed（不挂 waiting_gate，防死锁）', () => {
  const ws = testWorkspace()
  const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
  const workflow = legacyStage1Workflow(ws, personId, 'running')
  seedConstraintOnlyCandidates(ws, personId)
  const next = onFactCollectionReady(ws, workflow.id)!
  assert.equal(next.stages[0]!.status, 'failed')
})

// ─── advance 四步校验（契约 §四.2；阶段 1 场景 = legacy 兼容）─────────────────

test('advance（legacy）：Stage 1 waiting_gate 但 person-init 未完成 → STAGE_INCOMPLETE 拒绝（可操作缺件清单）', () => {
  const ws = testWorkspace()
  const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
  seedPendingCandidates(ws, personId)
  const workflow = legacyStage1Workflow(ws, personId, 'waiting_gate')
  const res = advanceWorkflow(ws, workflow.id)
  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.equal(res.code, 'STAGE_INCOMPLETE')
    assert.ok(res.missing.some((m) => m.includes('person-init')))
    // BUG-001 修复：缺件清单可操作——列出缺的快照 + 缺哪类候选（用户知道该补什么）
    assert.ok(res.missing.some((m) => m.includes('identity.md')))
    assert.ok(res.missing.some((m) => m.includes('候选缺')))
  }
  // 状态未被推进（Stage 2 不存在——验收核心）
  const reloaded = getWorkflow(ws, workflow.id)!
  assert.equal(reloaded.currentStage, 'fact_collection')
  assert.equal(reloaded.stages.length, 1)
  // BUG-007 负向：advance 被拒不联动 init_state（仍 uploading）
  assert.equal(scanPersons(ws).find((p) => p.personId === personId)!.initState, 'uploading')
})

test('advance：person-init 完成 → 推进 Stage 2 running（Golden Flow 确认路径）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  seedPendingCandidates(ws, pid)
  const workflow = legacyStage1Workflow(ws, pid, 'waiting_gate')
  assert.equal(isPersonInitComplete(ws, pid), true)
  const res = advanceWorkflow(ws, workflow.id)
  assert.equal(res.ok, true)
  if (res.ok) {
    assert.equal(res.nextStage, 'direction_exploration')
    const reloaded = getWorkflow(ws, workflow.id)!
    assert.equal(reloaded.stages[0]!.status, 'completed')
    assert.deepEqual(reloaded.stages[0]!.gate, { id: 'confirm_person_facts', status: 'passed', confirmedAt: reloaded.stages[0]!.gate!.confirmedAt })
    assert.equal(reloaded.stages[1]!.id, 'direction_exploration')
    assert.equal(reloaded.stages[1]!.status, 'running')
    assert.equal(reloaded.currentStage, 'direction_exploration')
  }
})

test('BUG-007（legacy）：advance 过 confirm_person_facts → manifest init_state 联动 completed（引擎登记权威时刻）', () => {
  const ws = testWorkspace()
  const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
  seedPendingCandidates(ws, personId)
  const workflow = legacyStage1Workflow(ws, personId, 'waiting_gate')
  // advance 前：init_state = uploading（未标完成）
  assert.equal(scanPersons(ws).find((p) => p.personId === personId)!.initState, 'uploading')
  seedCompleteSnapshots(ws, personId)
  const res = advanceWorkflow(ws, workflow.id)
  assert.equal(res.ok, true)
  if (!res.ok) return
  // gate passed → 引擎联动 manifest（用户确认事实的权威时刻；UI 的「完成初始化」按钮为另一正向路径）
  assert.equal(scanPersons(ws).find((p) => p.personId === personId)!.initState, 'completed')
  // 联动幂等：再次 advance 同 gate → ILLEGAL_STATE，init_state 不退化
  const res2 = advanceWorkflow(ws, workflow.id, 'confirm_person_facts')
  assert.equal(res2.ok, false)
  if (res2.ok) return
  assert.equal(res2.code, 'ILLEGAL_STATE') // Stage 2 已 running
  assert.equal(scanPersons(ws).find((p) => p.personId === personId)!.initState, 'completed')
})

test('advance（legacy）：running 状态推进 → ILLEGAL_STATE 拒绝（用户不能决定完成）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflow = legacyStage1Workflow(ws, pid, 'running')
  const res = advanceWorkflow(ws, workflow.id)
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.code, 'ILLEGAL_STATE')
})

test('advance（legacy）：gateId 不匹配 → ILLEGAL_STATE 拒绝', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflow = legacyStage1Workflow(ws, pid, 'waiting_gate')
  const res = advanceWorkflow(ws, workflow.id, 'review_recommendation')
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.code, 'ILLEGAL_STATE')
})

// ─── 探索分支（契约 §4.3；阶段 1 场景 = legacy 兼容）────────────────────────

test('探索分支语义（legacy）：未登记 → Stage 1 不 completed，正常 advance 被拒（不得伪装成 Person Aggregate）', () => {
  const ws = testWorkspace()
  const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
  seedPendingCandidates(ws, personId)
  const workflow = legacyStage1Workflow(ws, personId, 'waiting_gate')
  // 用户点「暂不登记，继续探索」：不 resolve、不写快照——person-init 不满足
  assert.equal(isPersonInitComplete(ws, personId), false)
  const res = advanceWorkflow(ws, workflow.id)
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.code, 'STAGE_INCOMPLETE')
  // Stage 2 不存在
  const reloaded = getWorkflow(ws, workflow.id)!
  assert.equal(reloaded.stages.length, 1)
  assert.equal(reloaded.currentStage, 'fact_collection')
})

// ─── abort / list ─────────────────────────────────────────────────────────

test('abort：active → aborted（append-only 审计）；当前 stage 同步 failed；已完成后 abort 拒绝', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  // 新语义：阶段 1 已完成（初始化闭环），当前阶段 = 方向探索
  assert.equal(workflow.stages[0]!.status, 'completed')
  const aborted = abortWorkflow(ws, workflow.id)
  assert.equal(aborted.status, 'aborted')
  assert.ok(aborted.abortedAt)
  // BUG-004 修复：当前 stage 不得滞留 waiting_gate/running → failed
  assert.equal(aborted.stages[1]!.status, 'failed')
  // 落盘回读一致（审计语义）
  const reloaded = getWorkflow(ws, workflow.id)!
  assert.equal(reloaded.status, 'aborted')
  assert.equal(reloaded.stages[1]!.status, 'failed')
  assert.throws(() => abortWorkflow(ws, workflow.id), /不可 abort/)
})

test('totalStages：序列化落盘 + 回读；旧文件（无 total_stages 行）→ 默认 4', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  assert.equal(workflow.totalStages, 4)
  const reloaded = getWorkflow(ws, workflow.id)!
  assert.equal(reloaded.totalStages, 4)
  assert.ok(ws.read(`workflows/${workflow.id}.md`).includes('| total_stages | 4 |'))
  // 旧文件兼容：无 total_stages 行的 md → parse 回退 4
  const legacy = ws
    .read(`workflows/${workflow.id}.md`)
    .replace('| total_stages | 4 |\n', '')
  ws.write(`workflows/${workflow.id}.md`, legacy)
  assert.equal(getWorkflow(ws, workflow.id)!.totalStages, 4)
})

test('scanWorkflows：按 personId 过滤；getWorkflow 非法 id → null', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  assert.equal(scanWorkflows(ws, pid).length, 1)
  assert.equal(scanWorkflows(ws, 'person_999').length, 0)
  assert.equal(getWorkflow(ws, 'workflow_bad'), null)
})

// ─── 输入校验 ─────────────────────────────────────────────────────────────

test('startWorkflow 边界：type/personId/statement/person 存在性 fail fast', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  assert.throws(() => startWorkflow(ws, { type: 'unknown' as never, personId: pid, statement: GOAL }), /type 非法/)
  assert.throws(() => startWorkflow(ws, { type: 'career_direction', personId: 'bad', statement: GOAL }), /personId 非法/)
  assert.throws(() => startWorkflow(ws, { type: 'career_direction', personId: pid, statement: '  ' }), /statement 必填/)
  assert.throws(() => startWorkflow(ws, { type: 'career_direction', personId: 'person_999', statement: GOAL }), /person 不存在/)
})

// ─── Stage Task Compiler（Agent Execution Boundary P0-C：Stage Boundary 三重校验 + Envelope）──

test('Stage Policy：每阶段声明输出预算（正整数）；getStageSpec 查询与表一致（transport 用同一来源）', () => {
  assert.equal(CAREER_DIRECTION_STAGES.length, 4)
  for (const s of CAREER_DIRECTION_STAGES) {
    assert.ok(Number.isInteger(s.task.outputBudget) && s.task.outputBudget > 0, `${s.id} outputBudget 应为正整数`)
    assert.equal(getStageSpec(s.id)?.task.outputBudget, s.task.outputBudget, `${s.id} getStageSpec 与定义表不一致`)
  }
  // 档位锚点：真机实测档（探索/评估/推荐 16K；采集 8K）——调档须连带真机复测，此断言防无意识改动
  // 2026-08-22 真机复测：探索/评估 8192 在"准备写入处"截断（方向探索 4/4 失败）→ 升至 16K
  // 2026-08-22 真机复测：推荐 4096 两次空输出（45-57s，0 决策，ok:true——工具调用 JSON 截断态）→ 升至 16K
  assert.equal(getStageSpec('direction_exploration')?.task.outputBudget, 16384)
  assert.equal(getStageSpec('direction_evaluation')?.task.outputBudget, 16384)
  assert.equal(getStageSpec('recommendation')?.task.outputBudget, 16384)
  assert.equal(getStageSpec('fact_collection')?.task.outputBudget, 8192)
})

test('Stage 工具声明（Phase 4A 渐进披露）：声明名 ∈ KNOWN_TOOL_NAMES；语义不变量（只收窄不扩大）', () => {
  // 阶段策略（2026-08-23 落地）：
  // - fact_collection：访谈只读（无 Write/Edit——「不自行写候选文件」从能力面杜绝）；无外部工具
  // - direction_exploration：外部世界事实采集唯一入口（WebSearch/WebResearch/Exa/NBS 全量）+ 产物写入
  // - direction_evaluation / recommendation：消费探索产物推理（无外部取证——Evidence Contract 纪律）
  // 调整声明 = 连带真机复测（与 Stage Policy 调档同一纪律）。
  for (const s of CAREER_DIRECTION_STAGES) {
    const tools = s.task.tools
    assert.ok(tools !== undefined && Array.isArray(tools) && tools.length > 0, `${s.id} 应声明工具集（渐进披露）`)
    for (const t of tools) {
      assert.ok(KNOWN_TOOL_NAMES.includes(t), `${s.id} 声明了引擎未知工具 ${t}`)
    }
    assert.equal(getStageSpec(s.id)?.task.tools, s.task.tools, `${s.id} getStageSpec 与定义表不一致`)
  }
  const exploration = CAREER_DIRECTION_STAGES.find((s) => s.id === 'direction_exploration')!
  assert.ok(exploration.task.tools!.includes('WebResearch'), '探索阶段应可深入检索')
  assert.ok(exploration.task.tools!.includes('QueryMacroStats'), '探索阶段应可查权威统计')
  for (const id of ['fact_collection', 'direction_evaluation', 'recommendation'] as const) {
    const s = CAREER_DIRECTION_STAGES.find((x) => x.id === id)!
    assert.ok(!s.task.tools!.some((t) => t === 'WebSearch' || t === 'WebResearch' || t === 'QueryMacroStats' || t === 'QueryIndustryEvidence' || t === 'CompareRegionProfiles'), `${id} 不应有外部取证工具（证据契约）`)
  }
  assert.ok(!CAREER_DIRECTION_STAGES[0]!.task.tools!.includes('Write') && !CAREER_DIRECTION_STAGES[0]!.task.tools!.includes('Edit'), 'fact_collection 无写工具（不自行写候选文件）')
})

test('compileStageTask：running Stage 编译 Envelope（含边界声明 + 停止条件，不自行推进）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  // 新语义：当前阶段 = 方向探索（阶段 1 已完成）
  const { envelope } = compileStageTask(ws, workflow.id, 'direction_exploration')
  assert.ok(envelope.includes('【WORKFLOW_STAGE】'))
  assert.ok(envelope.includes(`workflow_id: ${workflow.id}`))
  assert.ok(envelope.includes('stage_id: direction_exploration'))
  assert.ok(envelope.includes('stage_index: 2'))
  assert.ok(envelope.includes('stage_count: 4'))
  assert.ok(envelope.includes('【USER_GOAL】'))
  assert.ok(envelope.includes(GOAL))
  assert.ok(envelope.includes('【STOP_CONDITION】'))
  assert.ok(envelope.includes('禁止进入：direction_evaluation、recommendation'))
  assert.ok(envelope.includes('不得自行推进下一 Stage'))
})

test('compileStageTask：Envelope 用户交互契约——不得提问收尾（确认归 Gate）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  const { envelope } = compileStageTask(ws, workflow.id, 'direction_exploration')
  assert.ok(envelope.includes('不得以提问或请求用户确认收尾'), '必须声明 Agent 不得提问收尾（双确认消除：确认归 Gate）')
  assert.ok(envelope.includes('完成本阶段产物后直接结束'), '必须声明完成即结束、不停留等待')
})

test('compileStageTask：ARTIFACT_CONTRACT 刚性化——命名/frontmatter/marker（direction_exploration）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  const { envelope } = compileStageTask(ws, workflow.id, 'direction_exploration')
  assert.ok(envelope.includes('【ARTIFACT_CONTRACT】'))
  assert.ok(envelope.includes('禁止使用 direction_/evaluation_ 前缀'), '系统命名前缀禁令（Agent 不得占用）')
  assert.ok(envelope.includes('只允许以下三个字段'), 'frontmatter 字段白名单')
  assert.ok(envelope.includes('字段（引擎登记时生成）'), '禁止添加 id/source_file/artifact_type/state/version 等字段')
  assert.ok(envelope.includes('段标题逐字照抄「## 方向主张」'), 'marker 标题逐字照抄（变体视为未完成）')
  assert.ok(envelope.includes('不要写总览文件'), '不产出总览文件（候选清单总览不是本阶段产物）')
  assert.ok(envelope.includes('写成「## 方向候选清单」等变体视为未完成'), '变体禁令显式示例')
})

test('compileStageTask：ARTIFACT_CONTRACT 刚性化（direction_evaluation / recommendation）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  // Stage 3：evaluation 契约（前缀禁令 + 三字段白名单 + marker 逐字照抄）
  const { workflowId } = advanceToEvaluation(ws, pid)
  const env3 = compileStageTask(ws, workflowId, 'direction_evaluation').envelope
  assert.ok(env3.includes('禁止使用 evaluation_/direction_ 前缀'), 'Stage3 系统命名前缀禁令')
  assert.ok(env3.includes('只允许以下三个字段'), 'Stage3 frontmatter 三字段白名单')
  assert.ok(env3.includes('段标题逐字照抄「## 方向评估」'), 'Stage3 marker 逐字照抄')
  // Stage 4：recommendation 契约（三字段白名单 + 富字段禁令）
  const workflowId4 = advanceToRecommendation(ws, pid)
  const env4 = compileStageTask(ws, workflowId4, 'recommendation').envelope
  assert.ok(env4.includes('只允许以下三个字段'), 'Stage4 frontmatter 三字段白名单')
  assert.ok(env4.includes('字段（引擎登记时生成）'), 'Stage4 富字段禁令')
})

test('compileStageTask（Stage 2）：市场检索强化——外部证据必须（BUG-4 回归）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  const { envelope } = compileStageTask(ws, workflow.id, 'direction_exploration')
  assert.ok(envelope.includes('必须调用外部检索工具收集证据'), '市场问必须调用外部工具（不得盘点替代探索）')
  assert.ok(envelope.includes('QueryIndustryEvidence'), '行业证据工具点名')
  assert.ok(envelope.includes('至少一次'), '检索下限明确')
  assert.ok(envelope.includes('不得无依据断言'), '市场机会必须有来源（不得无依据断言）')
  assert.ok(envelope.includes('检索尝试之后'), '信息不足标注必须在检索尝试之后（不得跳过工具）')
  assert.ok(envelope.includes('不得仅凭知识与盘点的推断'), 'objective 禁止盘点式推断')
})

test('failStage：running 阶段 → failed + failReason；非 running / 非 active → null（幂等）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  // running → failed + reason
  const f = failStage(ws, workflow.id, 'direction_exploration', '未执行市场检索')
  assert.ok(f)
  if (!f) return
  const stage = f.stages.find((s) => s.id === 'direction_exploration')
  assert.equal(stage?.status, 'failed')
  assert.equal(stage?.failReason, '未执行市场检索')
  // 幂等：已 failed 再 fail → null
  assert.equal(failStage(ws, workflow.id, 'direction_exploration', '再试'), null)
  // 非 active（abort）→ null
  const ws2 = testWorkspace()
  const pid2 = makePerson(ws2)
  const wb = startWorkflow(ws2, { type: 'career_direction', personId: pid2, statement: GOAL })
  abortWorkflow(ws2, wb.workflow.id)
  assert.equal(failStage(ws2, wb.workflow.id, 'direction_exploration', 'x'), null)
})

test('compileStageTask：LAST_FAILURE 注入——失败原因传入 Envelope（restage 指导）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  failStage(ws, workflow.id, 'direction_exploration', '未执行市场检索')
  // failed → restage → running（failReason 保留在阶段行）
  restageWorkflow(ws, workflow.id)
  const { envelope } = compileStageTask(ws, workflow.id, 'direction_exploration')
  assert.ok(envelope.includes('【LAST_FAILURE】'), '失败原因段注入')
  assert.ok(envelope.includes('未执行市场检索'), '失败原因原文')
  assert.ok(envelope.includes('不要重复导致上次失败的路径'), '指导语')
})

test('compileStageTask 校验：workflow 不存在 / 非 active / stage 不匹配 / 状态非 running → 拒绝', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  // workflow 不存在
  assert.throws(() => compileStageTask(ws, 'workflow_20260821_99999', 'direction_exploration'), /workflow 不存在/)
  // stage 不匹配（UI 越界：请求已完成的事实收集；当前阶段 = 方向探索）
  assert.throws(() => compileStageTask(ws, workflow.id, 'fact_collection'), /当前阶段是 direction_exploration/)
  // 状态非 running（legacy waiting_gate 不允许发任务）
  const ws2 = testWorkspace()
  const pid2 = makePerson(ws2)
  const wb = legacyStage1Workflow(ws2, pid2, 'waiting_gate')
  assert.throws(() => compileStageTask(ws2, wb.id, 'fact_collection'), /需 running/)
  // abort 后非 active
  const ws3 = testWorkspace()
  const pid3 = makePerson(ws3)
  const w3 = startWorkflow(ws3, { type: 'career_direction', personId: pid3, statement: GOAL })
  abortWorkflow(ws3, w3.workflow.id)
  assert.throws(() => compileStageTask(ws3, w3.workflow.id, 'direction_exploration'), /非 active/)
})

test('compileStageTask：start 后即可编译当前阶段（方向探索）Envelope（start/compile 同一编译器）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  const { envelope } = compileStageTask(ws, workflow.id, 'direction_exploration')
  assert.ok(envelope.includes('stage_id: direction_exploration'))
  assert.ok(envelope.includes('stage_index: 2'))
  assert.ok(envelope.includes('禁止进入：direction_evaluation、recommendation'))
})

// ─── v0.2 L2-3：artifact-exists evaluator（evaluator 自报缺件，只 count）────

const EXPLORATION_SPEC = CAREER_DIRECTION_STAGES.find((s) => s.id === 'direction_exploration')!

/** 造一条合法 direction 提案并登记 */
function registerDirectionFixture(ws: Workspace, pid: string, workflowId: string, fileName: string): string {
  ws.write(`persons/${pid}/facts/education.md`, '# 教育\n\n| 学校 |\n|------|\n| University-A |\n')
  ws.write(`persons/${pid}/directions/${fileName}`, [
    '---',
    `person_id: ${pid}`,
    `workflow_id: ${workflowId}`,
    'stage_id: direction_exploration',
    '---',
    '',
    '## 方向主张',
    '',
    '方向甲值得考虑。',
    '',
    '## 事实依据',
    '',
    '- facts/education.md：专业对口',
    '',
  ].join('\n'))
  const res = registerStageArtifact(ws, DIRECTION_SPEC, {
    personId: pid,
    workflowId,
    stageId: 'direction_exploration',
    proposalFile: fileName,
  }, new Date('2026-08-21T00:00:00Z'))
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('fixture 登记失败')
  return res.artifact.artifact_id
}

test('evaluateStageCompletion（artifact-exists）：0 条登记 → failed + 缺件自报（含 artifact_type/state）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const res = evaluateStageCompletion(ws, EXPLORATION_SPEC, pid, 'workflow_20260821_00001')
  assert.equal(res.passed, false)
  assert.ok(res.missing.some((m) => m.includes('0/1')))
  assert.ok(res.missing.some((m) => m.includes('artifact_type=direction_candidate')))
  assert.ok(res.missing.some((m) => m.includes('state 不限')))
})

test('evaluateStageCompletion（artifact-exists）：登记 1 条 → passed（按 workflow/stage 过滤）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  registerDirectionFixture(ws, pid, 'workflow_20260821_00001', '20260821-方向甲.md')
  const res = evaluateStageCompletion(ws, EXPLORATION_SPEC, pid, 'workflow_20260821_00001')
  assert.equal(res.passed, true)
  // 另一 workflow 不匹配 → failed
  const other = evaluateStageCompletion(ws, EXPLORATION_SPEC, pid, 'workflow_20260821_00002')
  assert.equal(other.passed, false)
})

test('evaluateStageCompletion（artifact-exists）：state 不限——confirmed 后仍算「有产物」（L2-6 裁决 A）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const id = registerDirectionFixture(ws, pid, 'workflow_20260821_00001', '20260821-方向甲.md')
  // confirmed 后：产物仍存在 → 完成判定仍 passed（完成 vs 确认分离：裁决结果归 Gate，§3.2）
  const ok = resolveStageArtifact(ws, DIRECTION_SPEC, pid, id, 'confirm', new Date('2026-08-21T00:00:00Z'))
  assert.equal(ok.ok, true)
  const res = evaluateStageCompletion(ws, EXPLORATION_SPEC, pid, 'workflow_20260821_00001')
  assert.equal(res.passed, true)
  // rejected 同样算产物存在（全拒场景：完成判定过、Gate 拦——restage 出口）
  const pid2 = makePerson(ws)
  const id2 = registerDirectionFixture(ws, pid2, 'workflow_20260821_00001', '20260821-方向乙.md')
  assert.equal(resolveStageArtifact(ws, DIRECTION_SPEC, pid2, id2, 'reject', new Date('2026-08-21T00:00:00Z')).ok, true)
  assert.equal(evaluateStageCompletion(ws, EXPLORATION_SPEC, pid2, 'workflow_20260821_00001').passed, true)
})

test('evaluateStageCompletion（person-init）：缺件自报（快照缺 + 候选缺），与 advance 缺件清单同源', () => {
  const ws = testWorkspace()
  const { personId } = createPersonSession(ws, { name: '甲', sourceMode: 'interview' })
  const spec = CAREER_DIRECTION_STAGES.find((s) => s.id === 'fact_collection')!
  const res = evaluateStageCompletion(ws, spec, personId, 'workflow_20260821_00001')
  assert.equal(res.passed, false)
  assert.ok(res.missing.some((m) => m.includes('画像缺：identity.md')))
  assert.ok(res.missing.some((m) => m.includes('候选缺')))
  assert.ok(res.missing.some((m) => m.includes('需 education/experience 类候选')))
})

test('evaluateStageCompletion（artifact-exists）：挂参但类型注册表缺 spec → fail fast 抛错（配置错误）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const bad: typeof EXPLORATION_SPEC = { ...EXPLORATION_SPEC, evaluatorParams: { artifactType: '未登记类型', min: 1 } }
  assert.throws(() => evaluateStageCompletion(ws, bad, pid, 'workflow_20260821_00001'), /artifactType 未登记/)
})

// ─── v0.2 L2-4：onExplorationDone（done 钩子 → 登记 → guard → waiting_gate/failed）──

/** start 到 Stage 2（方向探索）running 的 fixture（初始化完成 → 工作流从阶段 2 开始） */
function advanceToExploration(ws: Workspace, pid: string) {
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  return workflow.id
}

/** 只写提案不登记（onExplorationDone 的 intake 输入；教育事实文件先行；workflowId 动态传入） */
function writeDirectionProposal(ws: Workspace, pid: string, fileName: string, evidenceRef = 'facts/education.md', workflowId = 'workflow_20260821_00001'): void {
  ws.write(`persons/${pid}/facts/education.md`, '# 教育\n\n| 学校 |\n|------|\n| University-A |\n')
  ws.write(`persons/${pid}/directions/${fileName}`, [
    '---',
    `person_id: ${pid}`,
    `workflow_id: ${workflowId}`,
    'stage_id: direction_exploration',
    '---',
    '',
    '## 方向主张',
    '',
    '方向甲值得考虑。',
    '',
    '## 事实依据',
    '',
    `- ${evidenceRef}：依据`,
    '',
  ].join('\n'))
}

test('onExplorationDone：合法提案登记 → waiting_gate + confirm_directions + artifacts 列（落盘可回读）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflowId = advanceToExploration(ws, pid)
  writeDirectionProposal(ws, pid, '20260821-方向甲.md', 'facts/education.md', workflowId)

  const result = onExplorationDone(ws, workflowId, ['20260821-方向甲.md'], NOW)
  assert.ok(result.workflow)
  assert.equal(result.registered.length, 1)
  assert.equal(result.rejected.length, 0)
  const stage = result.workflow!.stages.find((s) => s.id === 'direction_exploration')!
  assert.equal(stage.status, 'waiting_gate')
  assert.deepEqual(stage.gate, { id: 'confirm_directions', status: 'waiting' })
  assert.equal(stage.artifacts!.length, 1)
  assert.match(stage.artifacts![0]!, /^direction_\d{8}_\d{5}$/)
  // 落盘回读一致
  const reloaded = getWorkflow(ws, workflowId)!
  assert.equal(reloaded.stages.find((s) => s.id === 'direction_exploration')!.status, 'waiting_gate')
  assert.ok(ws.read(`workflows/${workflowId}.md`).includes(stage.artifacts![0]!))
})

test('onExplorationDone：全部提案被拒 → failed + 拒绝明细（不信任自报，无登记产物不挂 gate）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflowId = advanceToExploration(ws, pid)
  writeDirectionProposal(ws, pid, '20260821-坏提案.md', 'facts/不存在的文件.md', workflowId)

  const result = onExplorationDone(ws, workflowId, ['20260821-坏提案.md'], NOW)
  assert.ok(result.workflow)
  assert.equal(result.registered.length, 0)
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0]!.code, 'EVIDENCE_UNRESOLVABLE')
  const stage = result.workflow!.stages.find((s) => s.id === 'direction_exploration')!
  assert.equal(stage.status, 'failed')
  assert.equal(stage.gate, undefined)
  // 坏提案保留原样（无系统身份）
  assert.equal(ws.exists(`persons/${pid}/directions/20260821-坏提案.md`), true)
})

test('onExplorationDone：部分成功 → waiting_gate + 拒绝明细并存', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflowId = advanceToExploration(ws, pid)
  writeDirectionProposal(ws, pid, '20260821-方向甲.md', 'facts/education.md', workflowId)
  writeDirectionProposal(ws, pid, '20260821-方向乙.md', 'facts/不存在的文件.md', workflowId)

  const result = onExplorationDone(ws, workflowId, ['20260821-方向甲.md', '20260821-方向乙.md'], NOW)
  assert.ok(result.workflow)
  assert.equal(result.registered.length, 1)
  assert.equal(result.rejected.length, 1)
  assert.equal(result.workflow!.stages.find((s) => s.id === 'direction_exploration')!.status, 'waiting_gate')
})

test('onExplorationDone 幂等：非 running（已 waiting_gate）→ workflow null，不重复登记', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflowId = advanceToExploration(ws, pid)
  writeDirectionProposal(ws, pid, '20260821-方向甲.md', 'facts/education.md', workflowId)
  const first = onExplorationDone(ws, workflowId, ['20260821-方向甲.md'], NOW)
  assert.ok(first.workflow)
  const second = onExplorationDone(ws, workflowId, ['20260821-方向甲.md'], NOW)
  assert.equal(second.workflow, null)
  assert.equal(second.registered.length, 0)
})

test('onExplorationDone：workflow 非 active / 不存在 → workflow null', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  assert.equal(onExplorationDone(ws, 'workflow_20260821_99999', [], NOW).workflow, null)
  const workflowId = advanceToExploration(ws, pid)
  abortWorkflow(ws, workflowId)
  assert.equal(onExplorationDone(ws, workflowId, [], NOW).workflow, null)
})

// ─── v0.2 L2-6：confirm_directions Gate + advance 全链 ─────────────────────

/** Stage 2 waiting_gate fixture：advance → 写提案 → onExplorationDone → 返回 { workflowId, directionId } */
function waitingGateExploration(ws: Workspace, pid: string) {
  const workflowId = advanceToExploration(ws, pid)
  writeDirectionProposal(ws, pid, '20260821-方向甲.md', 'facts/education.md', workflowId)
  const done = onExplorationDone(ws, workflowId, ['20260821-方向甲.md'], NOW)
  assert.ok(done.workflow)
  assert.equal(done.registered.length, 1)
  return { workflowId, directionId: done.registered[0]!.artifact_id }
}

test('advance（confirm_directions）：registered 但 confirmed=0 → GATE_BLOCKED（缺件：无已确认方向）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflowId } = waitingGateExploration(ws, pid)
  const res = advanceWorkflow(ws, workflowId, 'confirm_directions')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'GATE_BLOCKED')
  assert.ok(res.missing.some((m) => m.includes('confirm_directions')))
  assert.ok(res.missing.some((m) => m.includes('无已确认方向')))
  // 未推进
  const reloaded = getWorkflow(ws, workflowId)!
  assert.equal(reloaded.stages.find((s) => s.id === 'direction_exploration')!.status, 'waiting_gate')
  assert.equal(reloaded.stages.length, 2)
})

test('advance（confirm_directions）：confirmed ≥ 1 → Stage 2 completed + gate passed + Stage 3 创建', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflowId, directionId } = waitingGateExploration(ws, pid)
  // 用户确认 1 条方向
  const r = resolveStageArtifact(ws, DIRECTION_SPEC, pid, directionId, 'confirm', NOW)
  assert.equal(r.ok, true)

  const res = advanceWorkflow(ws, workflowId, 'confirm_directions')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.nextStage, 'direction_evaluation')
  const reloaded = getWorkflow(ws, workflowId)!
  const stage2 = reloaded.stages.find((s) => s.id === 'direction_exploration')!
  assert.equal(stage2.status, 'completed')
  assert.equal(stage2.gate!.id, 'confirm_directions')
  assert.equal(stage2.gate!.status, 'passed')
  assert.ok(stage2.gate!.confirmedAt)
  assert.equal(reloaded.stages[2]!.id, 'direction_evaluation')
  assert.equal(reloaded.currentStage, 'direction_evaluation')
})

test('advance（confirm_directions）：gate 条件过但 Stage 3 inputs 缺 person_aggregate → MISSING_INPUTS', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflowId, directionId } = waitingGateExploration(ws, pid)
  assert.equal(resolveStageArtifact(ws, DIRECTION_SPEC, pid, directionId, 'confirm', NOW).ok, true)
  // Stage 2 期间画像被重置（resetPerson 语义）→ Stage 3 的 person_aggregate input 缺件
  ws.delete(`persons/${pid}/snapshot/current/identity.md`)
  const res = advanceWorkflow(ws, workflowId, 'confirm_directions')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'MISSING_INPUTS')
  assert.ok(res.missing.some((m) => m.includes('person_aggregate')))
  // 未推进
  assert.equal(getWorkflow(ws, workflowId)!.stages.length, 2)
})

test('advance（confirm_directions）：gateId 缺失/不匹配 → 拒绝（gateId 校验与 v0.1 一致）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflowId, directionId } = waitingGateExploration(ws, pid)
  assert.equal(resolveStageArtifact(ws, DIRECTION_SPEC, pid, directionId, 'confirm', NOW).ok, true)
  const wrong = advanceWorkflow(ws, workflowId, 'confirm_person_facts')
  assert.equal(wrong.ok, false)
  if (wrong.ok) return
  assert.equal(wrong.code, 'ILLEGAL_STATE')
  // gateId 缺失：confirm_directions 有 gate 定义，允许省略（与 v0.1 一致——gateId 可选，缺失时按 spec.gate 校验）
  const omitted = advanceWorkflow(ws, workflowId)
  assert.equal(omitted.ok, true)
})

// ─── v0.2 L2-7：workflow/restage + intake boundary ─────────────────────────

test('restage：waiting_gate（gate 未过）→ running + 清 gate + 已完成 stage 不动 + 方向池不重置', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflowId } = waitingGateExploration(ws, pid)
  const before = getWorkflow(ws, workflowId)!
  assert.equal(before.stages.find((s) => s.id === 'direction_exploration')!.status, 'waiting_gate')

  const next = restageWorkflow(ws, workflowId, NOW)
  assert.equal(next.stages.find((s) => s.id === 'direction_exploration')!.status, 'running')
  assert.equal(next.stages.find((s) => s.id === 'direction_exploration')!.gate, undefined)
  // 已完成 stage 不动
  assert.equal(next.stages.find((s) => s.id === 'fact_collection')!.status, 'completed')
  // 方向池文件不动（registered 保留，累积池）
  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid, { workflowId, stageId: 'direction_exploration' }), 1)
  // 落盘回读
  assert.equal(getWorkflow(ws, workflowId)!.stages.find((s) => s.id === 'direction_exploration')!.status, 'running')
})

test('restage：failed → running（全拒出口）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflowId = advanceToExploration(ws, pid)
  writeDirectionProposal(ws, pid, '20260821-坏提案.md', 'facts/不存在的文件.md', workflowId)
  const done = onExplorationDone(ws, workflowId, ['20260821-坏提案.md'], NOW)
  assert.equal(done.workflow!.stages.find((s) => s.id === 'direction_exploration')!.status, 'failed')
  const next = restageWorkflow(ws, workflowId, NOW)
  assert.equal(next.stages.find((s) => s.id === 'direction_exploration')!.status, 'running')
})

test('restage 前置条件：running 中拒绝；abort 后（非 active）拒绝；workflow 不存在拒绝', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  // running 中（advance 后 Stage 2 running）→ 拒绝
  const workflowId = advanceToExploration(ws, pid)
  assert.throws(() => restageWorkflow(ws, workflowId, NOW), /不可 restage/)
  // abort 后（非 active）→ 拒绝
  const ws2 = testWorkspace()
  const pid2 = makePerson(ws2)
  const w2 = advanceToExploration(ws2, pid2)
  abortWorkflow(ws2, w2)
  assert.throws(() => restageWorkflow(ws2, w2, NOW), /不可 restage/)
  // 不存在
  assert.throws(() => restageWorkflow(ws, 'workflow_20260821_99999', NOW), /workflow 不存在/)
})

test('restage 后二次执行：artifacts 列累积（方向池 append-only）+ 已裁决保持终态', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflowId, directionId } = waitingGateExploration(ws, pid)
  // 用户 reject 第一条 → restage → 第二次执行产第二条
  assert.equal(resolveStageArtifact(ws, DIRECTION_SPEC, pid, directionId, 'reject', NOW).ok, true)
  const restaged = restageWorkflow(ws, workflowId, NOW)
  assert.equal(restaged.stages.find((s) => s.id === 'direction_exploration')!.status, 'running')

  writeDirectionProposal(ws, pid, '20260821-方向乙.md', 'facts/education.md', workflowId)
  const done2 = onExplorationDone(ws, workflowId, ['20260821-方向乙.md'], NOW)
  assert.ok(done2.workflow)
  const stage = done2.workflow!.stages.find((s) => s.id === 'direction_exploration')!
  assert.equal(stage.status, 'waiting_gate')
  // artifacts 累积：第一次 1 条 + 第二次 1 条
  assert.equal(stage.artifacts!.length, 2)
  // 已 rejected 保持终态（不复活）
  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid, { workflowId, stageId: 'direction_exploration', state: 'rejected' }), 1)
  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid, { workflowId, stageId: 'direction_exploration', state: 'registered' }), 1)
  // 新登记方向可 confirm → gate 通过（累积池语义：跨执行确认）
  const newId = stage.artifacts![1]!
  assert.equal(resolveStageArtifact(ws, DIRECTION_SPEC, pid, newId, 'confirm', NOW).ok, true)
  const adv = advanceWorkflow(ws, workflowId, 'confirm_directions')
  assert.equal(adv.ok, true)
})

// ─── intake boundary 纯函数（§1.6：R8 重复消费回归）────────────────────────

test('freshIntakeFiles：只返回快照外新文件；历史提案（含失败）不被重复消费', () => {
  // 第一次执行：快照空 → 全部是新文件
  assert.deepEqual(freshIntakeFiles(['20260821-方向甲.md', '20260821-坏提案.md'], []), ['20260821-方向甲.md', '20260821-坏提案.md'])
  // 第二次执行：快照含第一次的坏提案（保留暂存名）→ 不被再次消费（R8）
  const intake2 = ['20260821-坏提案.md', 'direction_20260821_00001.md']
  assert.deepEqual(freshIntakeFiles(['20260821-坏提案.md', 'direction_20260821_00001.md', '20260821-方向乙.md'], intake2), ['20260821-方向乙.md'])
  // 无新文件 → 空（done 时 registered=0 → failed 语义）
  assert.deepEqual(freshIntakeFiles(['20260821-坏提案.md'], ['20260821-坏提案.md']), [])
})

// ─── Envelope 注入方向池裁决状态（§4.2：用户已排除的方向不得重新提案）──────

test('compileStageTask（Stage 2）：注入 DIRECTION_POOL_STATE（已保留/已排除方向）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflowId = advanceToExploration(ws, pid)
  // 预先有裁决状态：一条 rejected（既有执行产物）
  writeDirectionProposal(ws, pid, '20260821-旧方向.md', 'facts/education.md', workflowId)
  const done = onExplorationDone(ws, workflowId, ['20260821-旧方向.md'], NOW)
  assert.ok(done.workflow)
  assert.equal(resolveStageArtifact(ws, DIRECTION_SPEC, pid, done.registered[0]!.artifact_id, 'reject', NOW).ok, true)
  // restage → running → 编译 Envelope
  restageWorkflow(ws, workflowId, NOW)
  const { envelope } = compileStageTask(ws, workflowId, 'direction_exploration')
  assert.ok(envelope.includes('【DIRECTION_POOL_STATE】'))
  assert.ok(envelope.includes('用户已排除的方向（不得作为候选重新提案）'))
  assert.ok(envelope.includes('方向甲值得考虑。')) // 被排除方向的 claim 投影进入 Envelope
})

// ─── v0.2 L2-8：Golden Flow 端到端（契约 §八正例：Stage 1 → 2 → 3 全链串行）──

test('Golden Flow：初始化完成 → 方向探索 → 用户裁决 → confirm_directions Gate → Stage 3', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)

  // Stage 1（事实收集）已由初始化闭环完成（P0-1 确定性候选 → 确认 → 快照；gate passed）
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  assert.equal(workflow.stages[0]!.status, 'completed')
  assert.equal(workflow.stages[0]!.gate!.status, 'passed')
  assert.equal(workflow.currentStage, 'direction_exploration')

  // Stage 2：Agent 产出 3 条方向提案 → done 钩子 → 登记 → waiting_gate
  for (const [name, ref] of [['20260821-方向甲.md', 'facts/education.md'], ['20260821-方向乙.md', 'snapshot/current/skill_inventory.md'], ['20260821-方向丙.md', 'facts/education.md']] as const) {
    writeDirectionProposal(ws, pid, name, ref, workflow.id)
  }
  const done = onExplorationDone(ws, workflow.id, ['20260821-方向甲.md', '20260821-方向乙.md', '20260821-方向丙.md'], NOW)
  assert.ok(done.workflow)
  assert.equal(done.registered.length, 3)
  assert.equal(done.rejected.length, 0)
  assert.equal(done.workflow!.stages.find((s) => s.id === 'direction_exploration')!.status, 'waiting_gate')
  const ids = done.registered.map((a) => a.artifact_id)

  // 用户裁决：confirm 2 / reject 1
  assert.equal(resolveStageArtifact(ws, DIRECTION_SPEC, pid, ids[0]!, 'confirm', NOW).ok, true)
  assert.equal(resolveStageArtifact(ws, DIRECTION_SPEC, pid, ids[1]!, 'confirm', NOW).ok, true)
  assert.equal(resolveStageArtifact(ws, DIRECTION_SPEC, pid, ids[2]!, 'reject', NOW).ok, true)
  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid, { workflowId: workflow.id, state: 'confirmed' }), 2)
  assert.equal(countStageArtifacts(ws, DIRECTION_SPEC, pid, { workflowId: workflow.id, state: 'rejected' }), 1)

  // advance（confirm_directions）：四步校验全过 → Stage 2 completed + Stage 3
  const adv2 = advanceWorkflow(ws, workflow.id, 'confirm_directions')
  assert.equal(adv2.ok, true)
  if (!adv2.ok) return
  assert.equal(adv2.nextStage, 'direction_evaluation')
  const final = getWorkflow(ws, workflow.id)!
  assert.equal(final.status, 'active')
  assert.equal(final.currentStage, 'direction_evaluation')
  const stage2 = final.stages.find((s) => s.id === 'direction_exploration')!
  assert.equal(stage2.status, 'completed')
  assert.equal(stage2.gate!.status, 'passed')
  assert.equal(stage2.artifacts!.length, 3)
  // 落盘审计：workflow 文件含 artifacts 与 gate 记录
  const md = ws.read(`workflows/${workflow.id}.md`)
  assert.ok(md.includes('confirm_directions/passed'))
  for (const id of ids) assert.ok(md.includes(id))
})

// ─── v0.3：Stage 3（direction_evaluation 评估闭环）────────────────────────

/** advance 到 Stage 3 running（复用 Stage 2 确认链路：confirm 1 条方向 → advance） */
function advanceToEvaluation(ws: Workspace, pid: string): { workflowId: string; directionId: string } {
  const workflowId = advanceToExploration(ws, pid)
  writeDirectionProposal(ws, pid, '20260821-方向甲.md', 'facts/education.md', workflowId)
  const done = onExplorationDone(ws, workflowId, ['20260821-方向甲.md'], NOW)
  assert.ok(done.workflow)
  const directionId = done.registered[0]!.artifact_id
  assert.equal(resolveStageArtifact(ws, DIRECTION_SPEC, pid, directionId, 'confirm', NOW).ok, true)
  const res = advanceWorkflow(ws, workflowId, 'confirm_directions')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('fixture advance 失败')
  return { workflowId, directionId }
}

/** 只写评估提案不登记（onEvaluationDone 的 intake 输入；evidenceRef 决定引用域） */
function writeEvaluationProposal(ws: Workspace, pid: string, fileName: string, workflowId: string, evidenceRef: string): void {
  ws.write(`persons/${pid}/evaluations/${fileName}`, [
    '---',
    `person_id: ${pid}`,
    `workflow_id: ${workflowId}`,
    'stage_id: direction_evaluation',
    '---',
    '',
    '## 方向评估',
    '',
    '方向甲评估：匹配度高，建议推进。',
    '',
    '## 事实依据',
    '',
    `- ${evidenceRef}：评估依据`,
    '',
  ].join('\n'))
}

test('onEvaluationDone：合法评估提案（引用已确认方向）登记 → waiting_gate（无 gate）+ artifacts 列', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflowId, directionId } = advanceToEvaluation(ws, pid)
  writeEvaluationProposal(ws, pid, '20260821-评估甲.md', workflowId, `directions/${directionId}.md`)

  const result = onEvaluationDone(ws, workflowId, ['20260821-评估甲.md'], NOW)
  assert.ok(result.workflow)
  assert.equal(result.registered.length, 1)
  assert.equal(result.rejected.length, 0)
  const stage = result.workflow!.stages.find((s) => s.id === 'direction_evaluation')!
  assert.equal(stage.status, 'waiting_gate')
  assert.equal(stage.gate, undefined) // Stage 3 无 gate（评估非用户事实，不裁决）
  assert.equal(stage.artifacts!.length, 1)
  assert.match(stage.artifacts![0]!, /^evaluation_\d{8}_\d{5}$/)
  // 落盘回读：evaluation 文件已登记（系统 ID 命名）
  assert.equal(ws.exists(`persons/${pid}/evaluations/${stage.artifacts![0]}.md`), true)
})

test('onEvaluationDone：评估提案引用 decisions/（证据域外）→ 拒绝（EVIDENCE_OUT_OF_SCOPE）→ failed', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflowId } = advanceToEvaluation(ws, pid)
  writeEvaluationProposal(ws, pid, '20260821-坏评估.md', workflowId, 'decisions/xxx.md')

  const result = onEvaluationDone(ws, workflowId, ['20260821-坏评估.md'], NOW)
  assert.ok(result.workflow)
  assert.equal(result.registered.length, 0)
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0]!.code, 'EVIDENCE_OUT_OF_SCOPE')
  assert.equal(result.workflow!.stages.find((s) => s.id === 'direction_evaluation')!.status, 'failed')
})

test('onEvaluationDone：引用 directions/ 不存在文件 → 拒绝（EVIDENCE_UNRESOLVABLE）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflowId } = advanceToEvaluation(ws, pid)
  writeEvaluationProposal(ws, pid, '20260821-坏评估.md', workflowId, 'directions/direction_99999999_99999.md')

  const result = onEvaluationDone(ws, workflowId, ['20260821-坏评估.md'], NOW)
  assert.equal(result.rejected[0]!.code, 'EVIDENCE_UNRESOLVABLE')
})

test('Stage 3 advance（无 gate）：evaluation 登记后 advance（不传 gateId）→ Stage 4 running', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflowId, directionId } = advanceToEvaluation(ws, pid)
  writeEvaluationProposal(ws, pid, '20260821-评估甲.md', workflowId, `directions/${directionId}.md`)
  const done = onEvaluationDone(ws, workflowId, ['20260821-评估甲.md'], NOW)
  assert.ok(done.workflow)

  const res = advanceWorkflow(ws, workflowId) // Stage 3 无 gate，不传 gateId
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.nextStage, 'recommendation')
  const reloaded = getWorkflow(ws, workflowId)!
  assert.equal(reloaded.currentStage, 'recommendation')
  assert.equal(reloaded.stages.find((s) => s.id === 'direction_evaluation')!.status, 'completed')
  assert.equal(reloaded.stages[3]!.id, 'recommendation')
  assert.equal(reloaded.stages[3]!.status, 'running')
})

test('Stage 3 未产出（running 状态）advance → ILLEGAL_STATE（评估 Agent 未完成不推进）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const { workflowId } = advanceToEvaluation(ws, pid)
  // 未调 onEvaluationDone → Stage 3 仍是 running
  const res = advanceWorkflow(ws, workflowId)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'ILLEGAL_STATE')
})

// ─── v0.3：Stage 4（recommendation 推荐落盘）──────────────────────────────

function writeDecisionReport(ws: Workspace, pid: string, fileName: string): void {
  ws.write(`decisions/${fileName}`, [
    '---',
    `person_id: ${pid}`,
    'type: direction',
    '---',
    '',
    '# 决策报告',
    '',
    '## 分析摘要',
    '',
    '| 字段 | 值 |',
    '|------|-----|',
    '| status | exploring |',
    '| direction | 方向甲 |',
    '',
    '推荐方向甲。',
    '',
  ].join('\n'))
}

/** 写 decision 报告 + registerDecisionIdentity（模拟 transport 层补登记）→ 返回系统 ID（diff 定位新文件） */
function writeAndRegisterDecision(ws: Workspace, pid: string, fileName: string): string {
  const before = new Set(ws.listMarkdown('decisions').filter((f) => /^decision_\d{8}_\d{5}\.md$/.test(f)))
  writeDecisionReport(ws, pid, fileName)
  registerDecisionIdentity(ws, NOW)
  const fresh = ws.listMarkdown('decisions').filter((f) => /^decision_\d{8}_\d{5}\.md$/.test(f)).find((f) => !before.has(f))
  assert.ok(fresh, 'fixture：decision 登记后应有新系统 ID 文件')
  return fresh!.replace(/\.md$/, '')
}

/** advance 到 Stage 4 running（Stage 3 评估 → advance） */
function advanceToRecommendation(ws: Workspace, pid: string): string {
  const { workflowId, directionId } = advanceToEvaluation(ws, pid)
  writeEvaluationProposal(ws, pid, '20260821-评估甲.md', workflowId, `directions/${directionId}.md`)
  const done = onEvaluationDone(ws, workflowId, ['20260821-评估甲.md'], NOW)
  assert.ok(done.workflow)
  const res = advanceWorkflow(ws, workflowId)
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('fixture advance 失败')
  return workflowId
}

test('onRecommendationDone：决策 person_id 匹配 → waiting_gate + review_recommendation + artifacts 列', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflowId = advanceToRecommendation(ws, pid)
  const decisionId = writeAndRegisterDecision(ws, pid, '20260821-推荐.md')

  const result = onRecommendationDone(ws, workflowId, [`${decisionId}.md`], NOW)
  assert.ok(result.workflow)
  assert.equal(result.decisions.length, 1)
  assert.equal(result.decisions[0], decisionId)
  const stage = result.workflow!.stages.find((s) => s.id === 'recommendation')!
  assert.equal(stage.status, 'waiting_gate')
  assert.deepEqual(stage.gate, { id: 'review_recommendation', status: 'waiting' })
  assert.deepEqual(stage.artifacts, [decisionId])
})

test('onRecommendationDone：决策 person_id 不匹配 → failed（不记录 artifacts 列）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflowId = advanceToRecommendation(ws, pid)
  const decisionId = writeAndRegisterDecision(ws, 'person_999', '20260821-别人推荐.md')

  const result = onRecommendationDone(ws, workflowId, [`${decisionId}.md`], NOW)
  assert.ok(result.workflow)
  assert.equal(result.decisions.length, 0)
  const stage = result.workflow!.stages.find((s) => s.id === 'recommendation')!
  assert.equal(stage.status, 'failed')
  assert.equal(stage.gate, undefined)
  assert.deepEqual(stage.artifacts ?? [], [])
})

test('compileStageTask（Stage 4）：recommendation 契约声明摘要表标准（两列表 12 行 + 明细列协议）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflowId = advanceToRecommendation(ws, pid)
  const { envelope } = compileStageTask(ws, workflowId, 'recommendation')
  // 摘要表必须逐字声明（v2.8/2.9 决策契约基准：两列表；profile/salary_feasible 为校验器必填基准）
  assert.ok(envelope.includes('| 字段 | 值 |'), '摘要表列协议应声明')
  assert.ok(envelope.includes('| skill | career-path'), 'skill 行应声明')
  assert.ok(envelope.includes('| profile |'), 'profile（v2.1 校验必填）应声明')
  assert.ok(envelope.includes('| salary_feasible |'), 'salary_feasible true/false 应声明')
  assert.ok(envelope.includes('| protocol_version | 2.9 |'), 'protocol_version 应声明')
  assert.ok(envelope.includes('| risk_level | 低/中/中高/高 |'), 'risk_level 值域应声明')
  // 多方向分项 → 明细段落（列协议按位置解析）
  assert.ok(envelope.includes('## 方向评估明细'), '多方向分项应走明细段落')
  assert.ok(envelope.includes('| 方向 | 匹配度 | 置信度 | 关键优势 | 关键风险 |'), '明细列协议应逐字声明')
  assert.ok(!envelope.includes('/100'), 'X/100（agents 用过的格式）不可解析，契约不得暗示')
})

test('evaluateStageCompletion decision-registered：artifacts 列空 → 未过；登记后 → 过', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflowId = advanceToRecommendation(ws, pid)
  const spec = CAREER_DIRECTION_STAGES.find((s) => s.id === 'recommendation')!
  // 未登记 → artifacts 列空 → 未过
  assert.equal(evaluateStageCompletion(ws, spec, pid, workflowId).passed, false)
  // 登记 → onRecommendationDone → artifacts 列非空 → 过
  const decisionId = writeAndRegisterDecision(ws, pid, '20260821-推荐.md')
  onRecommendationDone(ws, workflowId, [`${decisionId}.md`], NOW)
  const after = evaluateStageCompletion(ws, spec, pid, workflowId)
  assert.equal(after.passed, true)
  assert.deepEqual(after.missing, [])
})

test('Stage 4 advance（review_recommendation）：decision status→accepted + workflow completed（Goal 完成）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflowId = advanceToRecommendation(ws, pid)
  const decisionId = writeAndRegisterDecision(ws, pid, '20260821-推荐.md')
  const done = onRecommendationDone(ws, workflowId, [`${decisionId}.md`], NOW)
  assert.ok(done.workflow)

  const res = advanceWorkflow(ws, workflowId, 'review_recommendation')
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.nextStage, null)
  assert.equal(res.status, 'completed')
  // decision status 联动 → accepted（Engine Registration 拥有 Canonical State）
  assert.ok(ws.read(`decisions/${decisionId}.md`).includes('| status | accepted |'))
  // workflow completed + gate passed
  const reloaded = getWorkflow(ws, workflowId)!
  assert.equal(reloaded.status, 'completed')
  assert.equal(reloaded.currentStage, null)
  assert.equal(reloaded.stages.find((s) => s.id === 'recommendation')!.gate!.status, 'passed')
})

test('Stage 4 restage：reject 出口 → running + decision append-only（artifacts 列累积）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  const workflowId = advanceToRecommendation(ws, pid)
  const decisionId1 = writeAndRegisterDecision(ws, pid, '20260821-推荐一.md')
  const done1 = onRecommendationDone(ws, workflowId, [`${decisionId1}.md`], NOW)
  assert.ok(done1.workflow)
  // 用户不满意 → restage（waiting_gate 且 gate 未过）
  const restaged = restageWorkflow(ws, workflowId, NOW)
  assert.equal(restaged.stages.find((s) => s.id === 'recommendation')!.status, 'running')
  assert.equal(restaged.stages.find((s) => s.id === 'recommendation')!.gate, undefined)
  // 第二次产出 → artifacts 列累积
  const decisionId2 = writeAndRegisterDecision(ws, pid, '20260821-推荐二.md')
  const done2 = onRecommendationDone(ws, workflowId, [`${decisionId2}.md`], NOW)
  assert.ok(done2.workflow)
  const stage = done2.workflow!.stages.find((s) => s.id === 'recommendation')!
  assert.equal(stage.artifacts!.length, 2)
  // decision 文件 append-only（两份都在，不覆盖）
  assert.equal(ws.exists(`decisions/${decisionId1}.md`), true)
  assert.equal(ws.exists(`decisions/${decisionId2}.md`), true)
})

// ─── v0.3：Golden Flow 完整（Stage 1→4）───────────────────────────────────

test('Golden Flow 完整：初始化完成 → 方向 → 评估 → 推荐 → Goal completed（四阶段全链）', () => {
  const ws = testWorkspace()
  const pid = makePerson(ws)
  // 阶段 1（事实收集）已由初始化闭环完成
  const { workflow } = startWorkflow(ws, { type: 'career_direction', personId: pid, statement: GOAL })
  assert.equal(workflow.stages[0]!.status, 'completed')
  assert.equal(workflow.stages[0]!.gate!.status, 'passed')
  // Stage 2（方向探索，工作流起点）
  writeDirectionProposal(ws, pid, '20260821-方向甲.md', 'facts/education.md', workflow.id)
  const done2 = onExplorationDone(ws, workflow.id, ['20260821-方向甲.md'], NOW)
  assert.ok(done2.workflow)
  const directionId = done2.registered[0]!.artifact_id
  assert.equal(resolveStageArtifact(ws, DIRECTION_SPEC, pid, directionId, 'confirm', NOW).ok, true)
  assert.equal(advanceWorkflow(ws, workflow.id, 'confirm_directions').ok, true)
  // Stage 3
  writeEvaluationProposal(ws, pid, '20260821-评估甲.md', workflow.id, `directions/${directionId}.md`)
  const done3 = onEvaluationDone(ws, workflow.id, ['20260821-评估甲.md'], NOW)
  assert.ok(done3.workflow)
  assert.equal(advanceWorkflow(ws, workflow.id).ok, true)
  // Stage 4
  const decisionId = writeAndRegisterDecision(ws, pid, '20260821-推荐.md')
  const done4 = onRecommendationDone(ws, workflow.id, [`${decisionId}.md`], NOW)
  assert.ok(done4.workflow)
  const adv4 = advanceWorkflow(ws, workflow.id, 'review_recommendation')
  assert.equal(adv4.ok, true)
  if (!adv4.ok) return
  assert.equal(adv4.status, 'completed')
  // 全阶段 completed + 全部 gate passed + 全部 artifact 存在
  const final = getWorkflow(ws, workflow.id)!
  assert.equal(final.status, 'completed')
  assert.equal(final.stages.length, 4)
  for (const s of final.stages) assert.equal(s.status, 'completed')
  assert.ok(ws.read(`decisions/${decisionId}.md`).includes('| status | accepted |'))
})
