# 测试区验证报告 · 第 1 轮（2026-08-21）

> 测试区：D:\Github\CarrerOS（只读验证，不改代码）
> 代码版本：workflow 模块已移植（workflow-registry.ts 15:14 / main.ts 15:27 / protocol.ts 含 5 RPC + 事件）
> 引擎进程：PID 15728（16:53 启动，晚于移植 → 新代码生效）｜UI：PID 4396（IPv6 loopback :5288）
> 被测对象：Career Workflow Control Plane v0.1 + 工作台 UI

## 环境确认（PASS）

| 检查项 | 结果 |
|--------|------|
| 引擎 5289 加载新代码（启动晚于移植时间） | ✅ |
| UI 5288 可访问（IPv6 loopback，IPv4 探测会误报） | ✅ |
| 引擎在线（UI 顶栏） | ✅ |
| workflow_20260821_00001.md 存在（fact_collection/waiting_gate） | ✅（旧 workflow，后被 abort） |

## 验证用例

### TC-01 死锁复现：advance → STAGE_INCOMPLETE 【BUG-001，REPRODUCED ×2】
- 前置：workflow 处于 fact_collection/waiting_gate，person_001 有 7 条 pending 候选（全为约束/兴趣类）
- 操作：点「确认并继续」
- 实际：alert「无法推进：STAGE_INCOMPLETE——fact_collection 完成条件未满足（evaluator=person-init）」，卡片保持 waiting_gate
- 预期：应能推进或给出可操作引导（缺什么、怎么补）
- 根因（已定位，开发区侧）：Path B 判定只看"有无 pending 候选"，未校验候选类别能否满足 person-init（缺 identity.md / preference_constraints.md / 教育/经历事实）；约束/兴趣候选确认后不产生任何快照 → 门禁永远不满足 → 死锁
- 影响：用户卡死在 waiting_gate，无 UI 出口

### TC-02 探索分支：暂不登记不推进 【PASS】
- 操作：点「暂不登记，继续探索」
- 实际：toast「暂不登记：本轮对话仍可继续探索，但口述信息不会升级为个人事实——确认登记后才会推进阶段」，状态保持 waiting_gate
- 结论：符合契约 §4.3，探索输入不会伪装成已登记事实 ✅

### TC-03 abort：终止工作流 【PASS】
- 操作：点「终止」
- 实际：toast「工作流已终止（历史保留可审计）」，卡片消失，回到「发起」按钮
- 结论：append-only 审计语义，符合契约 ✅

### TC-04 Path B 重新发起 【PASS】
- 操作：abort 后点「发起「职业方向」工作流」
- 实际：toast「工作流已开始（已有候选待确认——阶段 1/4 等待你的确认）」，直接 waiting_gate，未重新收集
- 结论：符合契约 §4.4（复用候选）✅

### TC-05 阶段总数显示不一致 【BUG-002，根因已定位】
- 实际：workflow 卡片标题显示「阶段 1 / 1」，toast 显示「阶段 1/4」；契约为 4 阶段
- 根因（已读代码确认）：
  - 引擎 `startWorkflow` 只初始化当前 stage（`stages: [stage1]`），后续 stage 推进时才 push（advance 第 409 行）——**stages 数组只有 1 项**，序列化到 md 阶段表也只有 1 行
  - UI `workflow-card.tsx` L54 `const total = active.stages.length` → 永远显示 x/x（1/1、2/2、3/3…）
  - toast `app-store.ts` L808-809 硬编码「阶段 1/4」
  - 两处 UI 显示来源不一致，且卡片随推进会更错（推进到 Stage 2 显示 2/2）
- 影响：UI 误导——用户以为只有 1 个阶段
- 修复方向：引擎 WorkflowState 增加 `totalStages`（= CAREER_DIRECTION_STAGES.length，契约六态含 pending，可预置 4 个 stage 或仅加总数字段）；UI 卡片与 toast 统一读取

### TC-06b abort 后 stage 状态滞留 【BUG-004】
- 实际：00001 workflow.status=aborted + aborted_at 正确落盘；但阶段表 `fact_collection` 仍为 `waiting_gate`（abortWorkflow 只改 workflow.status，stage 不动）
- 影响：整体已 aborted 但 stage 显示等待确认——审计语义不一致；若 UI/后续逻辑按 stage 状态判断会误读
- 修复方向：abort 时同步将当前 stage 置为 failed（六态含 failed）或新增 aborted 态

### TC-06 职业画像页状态投影 【观察】
- 实际：覆盖维度 2/7、已确认事实 0、待确认 7、教育/经历/目标岗位/城市/偏好未建立、简历版本 0
- 观察：画像卡顶部徽章显示「初始化完成」，但覆盖维度 2/7 且 education/experience 全空——"初始化完成"语义与 person-init 门禁不一致（徽章指"简历通道"初始化？需确认语义，避免误导）

### TC-07 文案与实际不符 【BUG-003，UI 文案】
- 实际：waiting_gate 卡片文案「系统已收集到候选事实（教育/经历/技能/偏好）」——但 person_001 的 7 条候选全是约束/兴趣，无教育/经历/技能候选
- 影响：用户误以为事实已齐备，点确认却被拒（与 BUG-001 叠加，加深困惑）

### TC-08 死锁时无候选查看/确认出口 【与 BUG-001/003 叠加】
- 操作：workflow waiting_gate 时访问决策助手页（agent-page）
- 实际：无「正在收集的信息」候选投影（person_001 为「初始化完成」状态，非初始化模式，候选投影不渲染）
- 影响：用户看不到 7 条 pending 候选、无处确认/补充 → waiting_gate 死锁完全无 UI 出口（只剩「终止」放弃路径）
- 结论：BUG-001 的 UI 侧影响闭环——引擎拒绝 + UI 无路可走

## BUG 汇总

| 编号 | 严重度 | 模块 | 描述 | 状态 |
|------|--------|------|------|------|
| BUG-001 | 高 | 引擎 workflow-registry | Path B 未校验候选能否满足 person-init → waiting_gate 死锁，advance 永远 STAGE_INCOMPLETE | ✅ 已修复（start/onFactCollectionReady 双处 guard + advance 缺件清单可操作化） |
| BUG-002 | 中 | 引擎+UI | stages 只含当前 stage（引擎）+ UI 用 stages.length 显示总数 → 卡片「1/1」vs toast 硬编码「1/4」 | ✅ 已修复（引擎 totalStages 字段 + UI 统一读取） |
| BUG-003 | 中 | UI workflow-card | waiting_gate 文案声称已收集教育/经历/技能/偏好候选，与实际候选类别不符 | ✅ 已修复（文案按实际 pending 候选类别渲染，缺教育/经历时明示缺口） |
| BUG-004 | 低 | 引擎 workflow-registry | abort 只改 workflow.status，当前 stage 滞留 waiting_gate，审计语义不一致 | ✅ 已修复（abort 同步当前 stage → failed） |
| BUG-005 | 高 | 引擎 person-watcher | 历史空壳 completed（manifest 标完成但三件快照缺件）无存量回溯——UI 徽章与 workflow 判定分裂 | ✅ 已修复（reconcilePersonInitStates 对账循环 + 启动钩子） |

## 修复记录（第三轮：Agent Execution Boundary Repair——1b3a959）

用户拍板方向：受约束的 Agent + 实时归位（信息不浪费）。借鉴微软 Agent Framework（Workflow 控制流程/Gate，LLM 阶段内推理；工具级审批）、K8s Reconciliation、Event Sourcing 投影。

**P0-A 实时归位**（快照 = Engine 投影的 Materialized View，Agent 不写快照）：
- 新模块 `person-snapshot-projection.ts`：facts/ + 已确认候选 → 三件快照全量投影（幂等；无事实不生成文件）
- resolveCandidate RPC 确认 → Registration → 立即投影（确认一条归位一条，会话中断不丢）
- 技能/约束候选补结构化载荷（技能=；级别=；场景= / 薪资=；城市=；现居=）；listCandidates 通用挂载 payload
- 初始化 Agent 指令回退"收尾写三件"→"引擎实时归位"；SKILL.md Producer 归属 Agent→Engine（消除两契约打架）

**P0-B/C Stage Envelope**（控制平面约束不再降级为对话内容）：
- StageSpec.taskTemplate string → 结构化 StageTaskSpec（objective/instructions/expectedOutputs/stopCondition/declaredBoundaries.forbiddenStages）
- compileStageTask：三重校验（active + stage==current + running）+ 编译单一 Envelope；start/advance 同一编译器
- agent/start 接 workflowId/stageId → 引擎校验后注入 context（UI 误发 stage 被拒）
- SKILL.md Workflow Stage 路由最高优先（Stage ≠ 用户意图：用户问方向问题也留在当前 Stage）

质量门：引擎 749/749（+11）、engine tsc 0 错、UI typecheck 0 错、sanitize CLEAN。
P1 待做（明确不做本轮）：declaredBoundaries 接 PreToolUse 工具级强制。

移植清单（测试区）：engine/storage/person-snapshot-projection.ts（新）、engine/storage/person-watcher.ts、engine/storage/workflow-registry.ts、engine/storage/role-proposal-registry.ts、engine/runtime/agent-runtime.ts、engine/transport/websocket.ts、UI/store/app-store.ts、UI/store/engine-client.ts、skills/career-advisor/SKILL.md（测试文件可不移植）。

### 测试区回归验证项（移植后第二轮）
1. 启动引擎 → 画像对账回滚 person_001 → 重新发起工作流 → Path A 补采（guard 生效）
2. 初始化会话：Agent 收技能候选带载荷 → 用户确认 → 快照立即出现（实时归位）
3. workflow advance：三件齐备自动可过；Stage 2 Envelope 由引擎注入
4. Stage Boundary：Stage 1 中问"我该选什么方向"→ Agent 答"后续阶段处理"

## 第二轮验证结果（2026-08-21，测试区实测）

### FIXED 确认 ✅
| 验证项 | 结果 |
|--------|------|
| 画像对账回滚 | ✅ manifest completed→in_progress；UI 显示「初始化中」横幅 + 会话锁定 |
| Path B guard | ✅ 重发工作流 → Path A running「Agent 正在工作」（7 条约束/兴趣候选不足 → 补采，死锁根除） |
| totalStages | ✅ 卡片「阶段 1 / 4」 |
| 候选类别文案 | ✅「当前无待确认候选——需先在 AI 面板完成候选采集」 |
| Stage Boundary 引擎强制 | ✅ WS 实测：正确 stage 放行；越界 stage/不存在 workflow/非法格式全部拒绝 |
| 实时归位（WS 路径） | ✅ 确认 c-001 → preference_constraints.md 立即投影（Engine 写，Agent 零参与） |
| 实时归位（UI 路径） | ✅ UI 点确认 → RPC → 投影 → 快照新增原文；计数同步（待确认 6→5、已确认 1→2） |
| advance 状态机 | ✅ running → ILLEGAL_STATE（控制平面硬切断） |

### 新 BUG-006（本轮发现，已修复推送）
**Path A 完成信号断链**：onFactCollectionReady 只有单测调用，生产链路无调用方——Agent 收集完候选后 Stage 1 永远卡在 running，用户无法 advance（第二死锁）。
修复：引擎侧 Stage Task 完成钩子——agent/start 带 workflowId/stageId 的任务注册进 stageTasks Map；Agent done 事件 → fact_collection 调 onFactCollectionReady（确定性 guard：候选不足 → failed）→ 广播 workflowChanged。引擎闭环，不依赖 UI 事件处理。

## 建议修复方向（供开发区决策）

1. **BUG-001（引擎侧，治本）**：Path B 判定增强——候选须含 education/experience 类 或 快照已齐备才直接 waiting_gate；否则走 Path A（启动 fact_collection task 补采集）或进入缺件引导态。advance 失败时返回可操作缺件清单。
2. **BUG-002/003（UI 侧）**：阶段总数读契约 stage 数组长度；waiting_gate 文案按实际候选类别渲染（或显示缺件清单 + 补采集入口）。
