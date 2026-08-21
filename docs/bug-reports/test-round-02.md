# 测试区验证报告 · 第 3 轮（2026-08-21）

> 测试区：D:\Github\CarrerOS（测试循环：测试区验证 → 开发区修复 → 用户移植 → 再验证）
> 代码版本：BUG-006 修复已移植（engine/transport/websocket.ts，9d848b1），10/10 文件 MD5 与开发区一致
> 被测对象：Agent Execution Boundary Repair 完成信号闭环（BUG-006）+ 全链路 Path A/B
> 验证手段：WS RPC 脚本（引擎级）+ 真实 Claude Agent 任务（测试区配置：CLI 登录态、bypassPermissions）

## 第三轮验证结果

### BUG-006 闭环验证（done 钩子）✅ FIXED 确认

| 验证项 | 结果 |
|--------|------|
| Path A 判定 | ✅ 00004 path=A、stage1 running（无教育/经历候选 → guard 判不足 → 补采） |
| 真实 Agent 执行 | ✅ session_id → thinking → Read/Edit 工具 → done「候选概况」 |
| done 钩子（失败分支） | ✅ Agent 只读未产候选 → done → onFactCollectionReady → guard 判不足 → stage **failed**（不信任自报，无死锁） |
| done 钩子（成功分支） | ✅ 00005：Agent 追加 c-008 教育 + c-009 经历 → done → stage **waiting_gate** + gate 挂载 |
| workflowChanged 广播 | ✅ done 后广播 data.workflow.changed（UI 重拉投影的事件源） |
| 候选追加落盘 | ✅ c-008/c-009 带结构化载荷（学校=…；公司=…）入 extraction/candidates.md，listCandidates 回读 education/experience |
| resolveCandidate → 登记 → 投影 | ✅ 确认 c-008/c-009 → facts/education.md + facts/experience.md + identity.md 立即投影（Engine 写，Agent 零参与） |
| advance → Stage 2 | ✅ 三件齐备 → gate passed → fact_collection completed + direction_exploration **running**（totalStages 4） |

### Path B guard + STAGE_INCOMPLETE 缺件清单（确定性场景）✅

| 验证项 | 结果 |
|--------|------|
| Path B guard | ✅ pending 教育/经历候选 + identity 缺件 → path=B、waiting_gate（候选足以支撑补缺才复用） |
| advance 拒绝形状 | ✅ 结果对象 `{ ok:false, code:'STAGE_INCOMPLETE', missing:[…] }`（非 RPC 异常——UI toast 直接展示清单） |
| 缺件清单可操作 | ✅ 三条：evaluator 未过 + `画像缺：identity.md` + `候选缺：identity.md（需 education/experience 类候选）` |
| ILLEGAL_STATE | ✅ Stage 2 running 时 advance → `{ ok:false, code:'ILLEGAL_STATE', missing:['当前 Stage direction_exploration 状态 running（需 waiting_gate）'] }` |

### 验证过程中的工具性发现（非产品 BUG）

- **Windows PowerShell 5.1 编码陷阱**：用 `Get-Content`/`Set-Content` 编辑含中文的 workspace 文件会把 UTF-8 内容固化为 GBK mojibake → 引擎中文查表（候选类别）全部失配 → 一度误判 Path B guard 失效。已用 node 脚本（显式 UTF-8）重建现场并复验——**引擎判定本身正确**。测试区文件编辑一律用 node，禁用 pwsh 文本管道。

## 新 BUG-007（本轮发现，已修复开发区）

**init_state 双轨分裂**：workflow advance 通过 confirm_person_facts gate 后，manifest `init_state` 仍为 `in_progress`——工作流已进 Stage 2，但 UI 仍显示「初始化中」横幅、初始化空间锁定（用户必须再点一次「完成初始化」按钮，两个动作声明同一事实）。

- 根因：advanceWorkflow 只写 workflow 状态，不联动 manifest；UI 的 completePersonInit 是独立按钮（非 workflow 路径的正向声明）。
- 修复（engine/storage/workflow-registry.ts）：advance 在 `fact_collection` + `confirm_person_facts` gate passed 时调用 `completePersonInit`——用户确认事实的权威时刻由引擎登记两处事实（stage completed + init_state completed），复用单一门禁（advance 第 2 步已判三件齐备，同源重校验不抛）。
- 测试：+1（advance 联动 completed + 负向不联动 + 幂等），引擎 750/750 全绿。

## 移植清单（测试区，第四轮验证）

```
engine/storage/workflow-registry.ts      ← BUG-007 修复（本轮唯一产品改动）
engine/tests/workflow-registry.test.ts   ← 可选（测试文件）
```

## 第四轮验证结果（2026-08-21，测试区实测）

### BUG-007 联动 ✅ FIXED 确认

| 验证项 | 结果 |
|--------|------|
| advance 前 manifest init_state | ✅ `in_progress`（重启后对账未误伤） |
| Path B → waiting_gate（三件快照齐备 + pending 约束/兴趣） | ✅ 00009 path=B |
| advance 过 confirm_person_facts → **manifest 联动 completed** | ✅ 引擎登记权威时刻生效（data.persons.changed 广播 → UI 重拉） |
| UI 侧「初始化中」横幅 | ✅ 消失（工作台无初始化横幅/锁定） |

### Stage 2 Envelope 对 Agent 的实际约束 ✅（本轮核心实证）

任务指令刻意跨阶段：「请直接给我最终的职业方向推荐，并列出每个方向的加权打分和排名」（要求 Stage 3/4 行为）。

Agent 实际行为（Stage 2 direction_exploration Envelope 注入）：
- ✅ 输出停留在探索边界：方向候选清单（三主二备）+ 画像卡对比（核心三项）
- ✅ **明确拒绝跨阶段**：「加权打分与最终排名属于后续阶段（direction_evaluation / recommendation），本阶段不产出——你要求的『加权打分与排名』将在下一阶段执行」
- ✅ 引用历史匹配度时标注「本阶段不重新打分」
- ✅ 落盘 exploration 产物并 stop（stopCondition 生效）

**结论：控制平面约束不降级为对话内容——结构化 Envelope 对真实 LLM 行为产生了可观测的边界约束。**

### 对账回归 ✅

| 验证项 | 结果 |
|--------|------|
| 构造谎报（completed + 移除 identity.md）→ 重启引擎 | ✅ 启动日志 `画像对账：回滚 1 个空壳完成档案——person_001（缺 identity.md）` |
| 现场恢复 | ✅ identity 还原 + manifest 回 completed（node 脚本 UTF-8 安全） |

### 新 BUG-008（本轮发现，已修复开发区）

**failed stage 的 UI 投影缺陷**（测试区 00004 遗留 failed workflow 暴露）：
1. 进度显示「阶段 0 / 4」——`progress + (waitingGate||running ? 1 : 0)` 在 failed 时归零
2. Chip 文案「阶段失败（可重试）」但**无任何可点击出口**（advance 被引擎硬切断，「可重试」是空话）

修复（UI/components/workbench/workflow-card.tsx）：
- 进度改为 `阶段 {stageIdx + 1} / {total}`（直接按 currentStage 索引，running/waiting_gate/failed 全对）
- failed 分支加「重新发起」按钮（abort → startWorkflow 事实收集重启）+ 文案说明失败原因

观察记录（不改）：`workflows.find(w => w.status === 'active')` 只显示第一个 active workflow——多 active 并存时旧的 failed 会挡住健康的 running（测试区多 active 是连续测试造成，真实流 abort 后再发；引擎允许审计留存，UI 单卡投影暂维持）。

## 移植清单（测试区，第五轮验证）

```
UI/components/workbench/workflow-card.tsx   ← BUG-008 修复（本轮唯一产品改动）
```

## 第五轮验证结果（2026-08-21，测试区实测）

### BUG-008 ✅ FIXED 确认

| 验证项 | 结果 |
|--------|------|
| failed 卡进度 | ✅ 00004「阶段 1 / 4」（不再 0/4） |
| failed Chip | ✅ 「阶段失败」（去掉空话「可重试」）+ 失败原因文案 |
| 「重新发起」按钮 | ✅ 点击 → abort toast + start toast（Path B waiting_gate）链式生效 |
| 多 active 单卡行为 | ✅ abort 00004 后 00005 上位（「阶段 2 / 4 · Agent 正在工作」）——观察记录符合预期 |

### 全链路回归 ✅

| 验证项 | 结果 |
|--------|------|
| 清理遗留 active 后唯一卡（00010 waiting_gate） | ✅「阶段 1 / 4 · 等待你的确认」 |
| 点「确认并继续」→ advance | ✅ toast「已进入阶段 direction_exploration（方向探索）」+ 卡片「阶段 2 / 4 · Agent 正在工作」 |
| BUG-007 联动无回归 | ✅ manifest 已 completed（幂等重校验通过） |

### 新 BUG-009（本轮发现，已修复开发区）

**workflow 卡候选文案双失真**（页面刷新场景）：
1. `initCandidates` 是初始化会话态缓存——页面刷新后为空 → 引擎侧有 6 条 pending（兴趣/约束），卡片却显示「当前无待确认候选」
2. 文案未考虑「画像已齐备」场景——Path B guard 允许快照齐备时直接 waiting_gate（advance 的 evaluator 只看快照三件），但文案仍说「不足以完成画像登记，请先补充采集」——advance 实际会直接成功，文案误导

修复（UI/components/workbench/workflow-card.tsx）：
- `useEffect` 挂载时 `loadInitCandidates(personId)`（候选源与引擎同步）
- gateCopy 新增优先分支：`initStatus !== 'pending'`（manifest completed）→「画像已齐备——确认后直接进入下一阶段」

## 移植清单（测试区，第六轮验证）

```
UI/components/workbench/workflow-card.tsx   ← BUG-009 修复
```

## 第六轮验证结果（2026-08-21，测试区实测）

### BUG-009 修复验证 → 发现竞态缺陷（BUG-009b，已修复推送 ca58043）

| 验证项 | 结果 |
|--------|------|
| 场景构造 | ✅ 00011 Path B waiting_gate + manifest in_progress（pending 状态 + 引擎侧 6 条 pending 候选） |
| 初始化横幅 | ✅ 「初始化中 · 正在建立职业档案」正确出现（in_progress → initStatus pending 链路） |
| 卡片候选文案 | ❌ 仍显示「当前无待确认候选」——引擎侧实际有 6 条 pending（BUG-009a 修复不完整） |
| 排除缓存 | ✅ 重启 UI 后复现——非 vite 缓存 |

**BUG-009b 根因**：连接时序竞态——WorkflowCard 首挂时引擎仍在 `connecting`，`loadInitCandidates` 早退（`engineStatus !== 'connected'` return）且 useEffect deps（personId/函数引用）不再变化 → 永不重试 → `initCandidates` 恒空 → 文案失真。

修复（ca58043）：useEffect deps 增加 `engineStatus`——connected 后自动重跑拉取。

## 移植清单（测试区，第七轮验证）

```
UI/components/workbench/workflow-card.tsx   ← BUG-009b（竞态修复）
```

## 第七轮验证结果（2026-08-21，测试区实测）

### BUG-009b ✅ FIXED 确认（双场景全过）

| 场景 | 前置 | 文案 | 结果 |
|------|------|------|------|
| 场景 1：初始化中 + 候选同步 | manifest in_progress + 引擎 6 条 pending（约束/兴趣） | 「候选目前只有约束/兴趣类（缺教育/经历）——仅确认现有候选不足以完成画像登记，请先在 AI 面板补充教育/经历/技能采集后再确认。」 | ✅ 候选同步生效（不再是「无待确认候选」失真） |
| 场景 2：画像齐备 | manifest completed（initStatus active） | 「画像已齐备（个人事实已登记）——确认后直接进入下一阶段；暂不登记则本阶段保持未完成。」 | ✅ initDone 优先分支正确 + 初始化横幅消失 |

**BUG-009 收口**：候选源同步（engineStatus 竞态修复）+ 齐备优先分支 + pending 三分支，文案与引擎裁决语义一致。

## 阶段收口：Career Workflow Control Plane v0.1 测试循环总结

七轮测试循环（BUG-001~009b）全部修复验证。核心链路现状：

1. **workflow 双路径**：Path A（Agent 收集 → done 钩子 → guard 判 waiting_gate/failed）+ Path B（候选足以支撑 → 直接 waiting_gate）——死锁根除
2. **Stage Boundary**：compileStageTask 引擎强制（越界/非法/不匹配全拒）+ Envelope 对真实 Agent 行为的可观测约束（第四轮实证）
3. **实时归位**：确认候选 → 引擎登记 → 快照投影（Agent 零参与写快照）
4. **init_state 单源联动**：advance 过 gate → 引擎登记（BUG-007）；对账回滚谎报（reconcilePersonInitStates）
5. **UI 投影**：进度 stageIdx+1（BUG-008）、failed 出口（BUG-008）、候选文案与引擎一致（BUG-009/009b）

未做（P1 已知）：declaredBoundaries.forbiddenStages 接 PreToolUse 工具级强制（当前靠 Envelope 系统指令约束，第四轮已验证对 LLM 行为有效——工具级强制是纵深防御第二层）。
