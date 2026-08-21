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

## 第四轮验证重点（移植后）

1. 完整 UI 链路：发起工作流 → 初始化会话收集教育/经历 → 确认候选 → identity 投影 → 卡片「确认并继续」→ Stage 2 + 「初始化中」横幅消失（init_state 联动生效）
2. Stage 2（direction_exploration）Envelope 对 Agent 的实际约束：问方向问题应被路由到当前阶段处理
3. 重启引擎 → reconcilePersonInitStates 对账：completed + 缺件 → 回滚（已有测试覆盖，测试区实测确认）
