# Career Workflow 契约（Career Workflow Control Plane）

> 2026-08-21 冻结 v0.1 | Goal-Driven Workflow Runner 第一版
> 一句话：**Agent 负责「怎么完成当前阶段」，Workflow Control Plane 负责「现在处于哪个阶段、完成条件是什么、什么时候停下来」。**
> 背景：测试区真实路径暴露——初始化会话一口气做到方向推荐，教育/经历/偏好等用户事实从未登记（信息进了决策报告，没进 Person Aggregate）。根因是 Agent 单次长 task 内自跑完整流程，系统无阶段边界、无确定性完成判定、无 Human Gate。本契约在 Agent 外层增加控制平面，不给 Claude 加提示词，而是给它一个**无法越权的工作边界**。

---

## 〇、架构边界（一句话冻结）

> **Workflow Control Plane owns Goal / Stage / Gate / Progress；Agent owns Stage execution；Engine owns Fact / Artifact / Completion determination；UI owns Projection / Human Action。**

| 角色 | 拥有 | 禁止 |
|------|------|------|
| Workflow Control Plane（引擎层） | Goal / Stage / Gate / Progress / Checkpoint | 生成事实、替代 Agent 推理 |
| Agent | 当前 Stage 的执行（对话/检索/提取/提案） | 声明 Stage 完成、推进 Stage、写 Workflow State、写 Person Fact |
| Engine（Registration + Deterministic Evaluation） | 事实登记、Artifact 存在性校验、Stage 完成判定、Gate 校验 | 编造用户事实 |
| User | Confirmation Authority（唯一） | 决定"系统已完成"（只能表达"我要继续"） |
| UI | Workflow State 投影 + Human Action 入口 | 决定下一阶段、判定完成、编排 |

**核心不变量**：`workflow/advance` ≠ "用户点继续就推进"。advance 是**用户表达继续意愿**，引擎校验（Stage 完成 + Gate 满足 + Artifact 齐备 + 状态合法）后才推进；校验失败 → 拒绝 + 返回缺件清单。

---

## 一、Goal Schema

```ts
interface WorkflowGoal {
  id: string            // workflow_{YYYYMMDD}_{NNNNN}（Engine 派生）
  type: WorkflowType    // v0.1 仅 'career_direction'
  personId: string      // person_XXX（目标主体）
  statement: string     // 用户目标原文（如「帮我确定职业方向」）
  createdAt: string     // ISO
}
```

- **Goal 是用户声明的目标，不是任务标题**——系统围绕它推进阶段，直到 Goal Gate 判定达成。
- v0.1 只做 `career_direction` 单一类型；类型注册表见 §七。

---

## 二、Stage Schema 与生命周期

### 2.1 生命周期（六态，缺一不可）

```text
pending → running → waiting_gate → completed
              ↓           ↓
            failed      failed
```

| 状态 | 语义 | 谁写入 |
|------|------|--------|
| `pending` | 已注册未开始 | Engine（advance 创建） |
| `running` | Agent task 执行中（UI 显示"Agent 正在工作"） | Engine（start task 时） |
| `waiting_gate` | Agent 已产出 Artifact，等待用户确认（**≠ 卡住**） | Engine（stage 输出齐备 + gate 定义存在） |
| `completed` | Gate 通过 + 完成条件满足 | Engine（advance 校验通过） |
| `failed` | Agent 执行失败或超限（可重试） | Engine（task error / maxTurns） |

> **`running` 与 `waiting_gate` 是 UI 表达的关键**：「Agent 正在工作」vs「Agent 已做完，等你确认」——避免"看起来像卡住了"。

### 2.2 Stage 定义

```ts
interface WorkflowStage {
  id: StageId                    // 'fact_collection' | 'direction_exploration' | 'direction_evaluation' | 'recommendation'
  task: AgentTaskSpec            // 本阶段 Agent task（taskType + 指令模板）
  inputs: ArtifactRef[]          // 本阶段消费的已登记 Artifact（Stage 不是"再聊一轮"，是 Artifact 转换）
  outputs: ArtifactRef[]         // 本阶段必须产出的 Artifact（确定性检测对象）
  completion: CompletionSpec     // 完成判定（见 §三）
  gate?: HumanGateSpec           // 阶段末 Human Gate（见 §四）
}
```

### 2.3 Artifact I/O（Stage 的输入/输出——契约最容易漏的部分）

```yaml
CAREER_DIRECTION 工作流：

fact_collection:
  inputs:
    - person（person_XXX 主体）
    - conversation（初始化会话口述）
  outputs:
    - education_candidates / experience_candidates / preference_candidates / skill_candidates
      → 用户确认后登记 → person_aggregate（identity + facts/ + skill_inventory + preference_constraints）
  completion:
    evaluator: person-init       # 复用 completePersonInit 门禁（三件快照齐备），不另立新规
  gate:
    id: confirm_person_facts
    label: 确认个人事实
    items: [教育, 经历, 技能, 偏好]

direction_exploration:
  inputs:
    - person_aggregate（已登记事实）
  outputs:
    - exploration_artifact（方向候选清单 + 画像卡对比）
  completion:
    evaluator: artifact-exists    # exploration_artifact 文件登记
  gate: （无——探索不产生需确认的用户事实）

direction_evaluation:
  inputs:
    - exploration_artifact
    - person_aggregate
  outputs:
    - evaluation_artifact（方向加权评估明细）
  completion:
    evaluator: artifact-exists

recommendation:
  inputs:
    - evaluation_artifact
    - person_aggregate
  outputs:
    - decision_artifact（decisions/{id}.md，Decision Record Contract）
  completion:
    evaluator: decision-registered # decisions/ 出现该 workflow 关联的合法决策
  gate:
    id: review_recommendation
    label: 审阅推荐结论
```

---

## 三、Stage Completion Contract（确定性判定，不信任 Agent 自报）

- **判定方**：Engine（Completion Evaluator）。Agent 说"画像是建立完毕"系统不认。
- **判定物**：Artifact 存在性 + 状态，**不是** Agent 的自述文本。

```ts
interface CompletionSpec {
  evaluator: 'person-init' | 'artifact-exists' | 'decision-registered'
  // person-init:      复用 completePersonInit 门禁（identity + skill_inventory + preference_constraints 齐备）
  // artifact-exists:   outputs 指定的 Artifact 文件已登记且 validation 合法
  // decision-registered: decisions/ 出现关联本 workflow 的合法决策（Decision Record Contract）
}
```

**单一事实源原则**：`fact_collection` 的完成判定**直接复用 `isPersonInitComplete(personId)`**（即 completePersonInit 的门禁逻辑），不定义第二套"初始化完成"规则——避免 Person Init 认为完成、Workflow 认为没完成的双轨。

---

## 四、Human Gate Contract

### 4.1 Gate 语义

- Gate 是 **waiting_gate 状态下的用户确认点**：Agent 已产出该阶段全部输出，但**用户事实的登记（fact_collection）或最终结论的采纳（recommendation）必须经用户确认**。
- 未确认 → `workflow.status = waiting_gate`，**Agent 不得进入下一阶段**（控制平面硬切断，不靠 SKILL 自觉）。

### 4.2 advance 校验（引擎侧，fail fast）

```text
workflow/advance({ workflowId, gateId? })
      ↓
Engine:
  1. 当前 Stage 状态 === waiting_gate？    否则 → 拒绝（ILLEGAL_STATE）
  2. 当前 Stage 完成条件满足？             否则 → 拒绝（STAGE_INCOMPLETE + 缺件清单）
  3. gate 存在且未通过？                   否则 → 拒绝（NO_GATE / GATE_PASSED）
  4. 下一 Stage 的 inputs Artifact 齐备？   否则 → 拒绝（MISSING_INPUTS + 缺件清单）
      ↓
YES → 当前 Stage → completed；登记 gate 通过；创建下一 Stage（pending）→ 启动其 task（running）
NO  → 拒绝 + 返回缺件（UI 展示缺什么，不假装推进）
```

> **用户只能表达「我要继续」，不能决定「系统已经完成」。** 这是 Producer Boundary / Engine Ownership 在控制平面的直接延伸。

### 4.3 「暂不登记，继续探索」= 受控 Exploration Branch（不是 advance 成功路径）

用户提供的信息可以作为**本轮推理输入**，但不能因为被 Agent 听到了就自动升级成 Person Fact。语义写死：

```text
确认并继续
→ Candidate resolve → Person Registration → person-init completion
→ Stage 1 completed → 正式 advance → Stage 2

暂不登记，继续探索
→ 不登记 Person Fact
→ Stage 1 不 completed
→ 不允许通过正常 workflow/advance 越过 Stage 1
→ 仅允许 UI 发起受控 exploration branch：
   - exploration input 可进入后续 Agent context（推理上下文）
   - 但不能满足 person-init completion
   - 不能使 fact_collection → completed
   - 报告/UI 必须标注该结论基于未登记口述（exploration input），非 Person Fact
```

**不变量**：Workflow 可以使用未登记输入，但**不能把未登记输入伪装成 Person Aggregate**。Human Gate 是显式的持久化状态边界，不是 prompt 软约束——「继续探索」是受控临时分支，不是 `advance()` 的成功路径。

### 4.4 已有 pending candidates 的复用（Path B）

`workflow/start` 检查 personId：

```text
已有 pending candidates？
  ├─ YES → 不启动 Agent，直接进入 waiting_gate（确认 Gate）
  └─ NO  → 启动 fact_collection Agent task（Path A）
```

**不重新收集**——Candidate 已是系统事实收集链的一部分（Producer → Engine Validator → Registration → Projection），Workflow 编排这条链，**不复制这条链**（Single Source / Engine Ownership 不变量：不因引入 Workflow 产生第二份候选）。

---

## 五、Checkpoint / Resume Contract

- **持久化**：`workspace/career-advisor/workflows/{workflow_id}.md`（Engine 单方写，Agent/UI 不写——与 decisions/ 同模式）。
- **内容**：frontmatter（id/type/person_id/goal/created_at）+ 摘要表（status/current_stage/updated_at）+ `## 阶段` 段（每 stage：status/started_at/completed_at/artifacts/gate）+ `## Gate 记录`（gate_id/status/confirmed_at）。
- **会话续接**：每 Stage 的 Agent task 带 `resumeSessionId`（前一 Stage 的 sdkSessionId）——分段执行不丢上下文。
- **恢复**：引擎重启 → 扫描 workflows/ → 未完成 workflow 停留在其状态（`running` 中段 → 标记 `failed`（断流）或 `waiting_gate` 保持可确认）；**不自动重跑**，由用户 advance 或 UI 重新触发。
- **不变量**：Workflow State 是**引擎投影的事实**，Agent 无法声明自己完成了哪个 Stage。

---

## 六、Goal Completion Contract（Goal Gate）

```text
Goal Gate 判定（Engine，advance 到末 Stage 完成时）：
  1. 所有 Stage status === completed
  2. 全部必需 Artifact 存在（exploration/evaluation/decision）
  3. 全部 Gate 已通过
      ↓
  YES → workflow.status = completed；产出 Goal Summary（决策报告尾部总结段）
  NO  → 停留在当前状态，返回缺件
```

- Goal 完成后 workflow 只读（append-only 审计）；用户可发起新 Goal（新 workflow_id）。

---

## 七、Workflow Type Registry（v0.1 单一类型）

| type | 名称 | 阶段 | 触发 |
|------|------|------|------|
| `career_direction` | 职业方向确定 | fact_collection → direction_exploration → direction_evaluation → recommendation | `workflow/start`（用户目标） |

**暂不做（写进契约防蔓延）**：
- 通用 Workflow DSL / DAG / 多 Agent 编排（远期）
- 非 career_direction 的第二种工作流（触发条件：career_direction 稳定运行后）
- Stage 并行执行（当前串行）
- workflow 的自动重试/定时触发（当前仅 user_action）

---

## 八、RPC 面（v0.1）

| 方法 | params | 返回 | 说明 |
|------|--------|------|------|
| `workflow/start` | `{ type, personId, statement }` | `{ workflowId, status, currentStage }` | 创建 Goal + Stage 1（pending→running，启动 fact_collection task） |
| `workflow/get` | `{ workflowId }` | `WorkflowState`（投影） | UI 拉取状态 |
| `workflow/list` | `{ personId? }` | `WorkflowState[]` | 按人列出 |
| `workflow/advance` | `{ workflowId, gateId? }` | `{ nextStage?, status, missing? }` | 用户确认 Gate → 引擎校验推进（§四.2） |
| `workflow/abort` | `{ workflowId }` | `{ status: 'aborted' }` | 用户终止（append-only 审计） |

事件：`workflow.changed`（状态变更广播，UI 重拉投影）。

---

## 九、Golden Flow 验收（Conversation → Career Exploration）

测试区真实路径的回归用例（**契约级验收，不是可选测试**）。按「有无 pending candidates」拆两条路径：

### Path A：全新 Person（无 pending candidates）

```
输入：用户一次性口述「机械工程本科 2019-2023，做过 2 年医疗器械结构设计，
      想去苏州/上海，期望 10-12K」
要求：
1. workflow/start → Stage 1（fact_collection）→ running → 启动 Agent task（Path A）
2. Agent 收集口述事实 → 产出 Candidate Proposal（education/experience/preference/skill）
3. ⛔ Stage 1 结束，控制平面硬切断——Agent 不得自行进入方向分析
4. UI 显示 waiting_gate + 确认卡（4 项候选 + [确认并继续] / [暂不登记，继续探索]）
5a. 用户确认 → resolveCandidate（登记）→ isPersonInitComplete → Stage 1 completed
5b. 用户「暂不登记，继续探索」→ 不登记、Stage 1 不 completed、不进入正式 Stage 2；
    仅受控 exploration branch（推理上下文可用口述，报告标注 exploration input）
6. 确认路径：workflow/advance → Stage 2 task（resumeSessionId 续接同一会话）→ 方向探索
7. 最终 decision_artifact 落盘（Decision Record Contract），报告区分：
   - confirmed fact（已登记事实）
   - exploration input（本轮口述未登记）
   - inference（推理结论）
8. 中途任意时刻查询 workflow/get → 状态精确反映（running/waiting_gate/completed）
```

### Path B：已有 pending candidates（测试区 person_001 现状）

```
1. workflow/start → 引擎发现 pending candidates → 不启动 Agent → 直接 waiting_gate
2. UI 确认卡复用现有候选（4 项：约束/兴趣类）——不重新收集
3. 用户确认 → 登记 → isPersonInitComplete → Stage 1 completed → advance → Stage 2
```

**验收判定**：
- 旧路径（一口气到方向推荐、无登记）在 Stage 1 Gate 被硬切断 = 通过；未切断 = 失败。
- 「暂不登记」后 workflow/advance 被拒绝（ILLEGAL_STATE/STAGE_INCOMPLETE）= 通过；能推进 = 失败。

---

## 十、与现有资产的衔接（复用清单）

| 现有资产 | 复用方式 |
|----------|----------|
| `question_request` / `permission_request` | Gate 的交互载体（确认卡复用提问卡通道或独立 Gate 卡片） |
| `sdkSessionId` / `resumeSessionId` | Stage 间会话续接（§五） |
| `appendCandidates` / `resolveCandidate` / Registration | fact_collection 的提案→确认→登记链路（**不重写**） |
| `completePersonInit` 门禁 | fact_collection 完成判定（§三 单一事实源） |
| decisions/ 登记 + Decision Record Contract | recommendation 输出物 |
| agent-task.ts Task Type Registry | Stage task 的 taskType（career_direction 沿用） |
| Engine 事件广播（decisionsChanged 等） | workflow.changed 同模式 |

---

## 附：控制平面与既有三层的关系图

```text
用户目标 "帮我确定职业方向"
        ↓
Workflow Control Plane（workflows/*.md + workflow/* RPC + Completion Evaluator）
        │
        ├── Stage 1 fact_collection ──→ Agent task（对话/提取/提案）
        │        ↓ Candidate Proposal → User Gate → Registration → isPersonInitComplete
        ├── Stage 2 direction_exploration ──→ Agent task（检索/画像卡）
        │        ↓ exploration_artifact
        ├── Stage 3 direction_evaluation ──→ Agent task（加权评估）
        │        ↓ evaluation_artifact
        └── Stage 4 recommendation ──→ Agent task（综合）→ User Gate → decision_artifact
                       ↓
                  Goal Gate → completed（Summary）
```

**本契约冻结的核心**：Goal/Stage/Gate/Progress 归 Control Plane；Stage 执行归 Agent；事实登记与完成判定归 Engine；投影与确认归 UI。Agent 无法越权声明完成——**目的型工作来自边界，不来自提示词。**
