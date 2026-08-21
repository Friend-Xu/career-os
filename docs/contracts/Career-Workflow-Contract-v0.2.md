# Career Workflow 契约 v0.2（Stage Artifact Lifecycle + 方向池闭环）

> 2026-08-21 草案 v1.2（审阅修正版：P0×3 + P1×3 + L2-6 裁决 ×1 已吸收，见 §〇.1）| 基于 v0.1 冻结语义的增量契约（v0.1 全文仍有效，本契约只声明增量与修订）
> 一句话：**v0.2 把 v0.1 的「Stage 1 特例」提升为「四阶段通用机制」——新增 Stage Artifact 生命周期原语 + evaluator 参数化；第一个实例 = DirectionCandidate（方向池闭环）。**
> 背景：v0.1 闭环验证后，Stage 2-4 的 evaluator（`artifact-exists`/`decision-registered`）空转（`return true`），exploration/evaluation artifact 无登记通道、无用户确认、无依据校验。外部调研与代码盘点见 `docs/research/stage-artifact-registration-research.md`。
> 核心不变量延续 v0.1 §〇：**Agent=Proposal / User=Confirmation Authority / Engine=Registration + Deterministic Evaluation / UI=Projection + Human Action。**

---

## 〇、对 v0.1 的修订清单（增量，非重写）

| # | 修订点 | 内容 |
|---|--------|------|
| 1 | v0.1 §2.3 Stage 2 gate | **从「无」改为 `confirm_directions`（确认方向池）**——方向候选是后续阶段的决策输入，须经用户确认（Confirmation Authority） |
| 2 | v0.1 §3 CompletionSpec | `artifact-exists` 从占位改为真实判定（参数化：artifact_type + min + state）；`decision-registered` 本切片仍占位（Stage 4 下一切片） |
| 3 | v0.1 §4.2 advance 第 2 步 | 缺件清单改由 **evaluator 自报**（消除 person 快照名硬编码——Stage 1 特化债务） |
| 4 | 新增 §一 | Stage Artifact Lifecycle（通用原语） |
| 5 | 新增 §二 | DirectionCandidate 结构（第一实例） |
| 6 | 新增 RPC | `person/directions/list`、`person/directions/resolve`、`workflow/restage`（§五） |
| 7 | Stage 1 | **candidates 链零改动**（回迁评估触发条件见 §十） |

### 0.1 草案审阅修正记录（v1.0 → v1.1）

| 优先级 | 修正 | 落点 |
|--------|------|------|
| P0 | Proposal intake boundary：done 只消费**本次 Stage Execution 新产生**的提案；历史提案（含登记失败的）不被后续 done 自动重复消费 | §1.6 |
| P0 | Artifact 归属粒度 = `workflow_id + stage_id`；restage 不重置方向池（append-only 累积池）；不引入 execution_id | §4.2 |
| P0 | resolve 幂等语义定死：同动作幂等成功 / 反动作拒绝 / 终态不可逆 | §4.3 |
| P1 | 删除 artifact-exists「validation 合法」表述——登记校验是单一真相源，evaluator 只统计 | §3.1 |
| P1 | `evidence_refs` 统一 YAML array（IR `string[]` ↔ frontmatter 列表 ↔ parser 同构） | §1.2/§2.2 |
| P1 | 身份统一：`artifact_id` ↔ frontmatter `id`，不为 DirectionCandidate 再造 `direction_id` | §1.2/§2.2 |
| P0（L2-6 裁决 A） | 完成判定 = **已登记产物存在（state 不限）**——`registered` 是瞬态，advance 时点（用户裁决后）重新计数会归零、Gate 永久卡死（3 个失败测试证实）；evaluatorParams 移除 `state` 参数，Gate 判定（confirmed≥1）不变 | §3.1/§3.2 |

---

## 一、Stage Artifact Lifecycle（通用原语）

### 1.1 定位

阶段产出物的统一生命周期语义。**统一的是生命周期与状态机，不是物理格式**——candidates 表格 / directions frontmatter 是各 artifact_type 的投影细节，不强制统一（防「为统一而统一」的破坏性迁移）。

### 1.2 字段

```ts
interface StageArtifact {
  artifact_type: string       // 类型注册表：v0.2 仅 'direction_candidate'
  artifact_id: string         // 系统 ID（统一身份 ↔ 登记 frontmatter 的 id；不另造 direction_id 等第二套 ID）
  workflow_id: string         // 关联 workflow（引擎登记时注入）
  stage_id: StageId           // 产出 stage
  person_id: string           // 归属主体
  state: 'registered' | 'confirmed' | 'rejected'
  evidence_refs: string[]     // 事实依据引用（§1.4 校验对象；frontmatter 序列化为 YAML array，与 IR 同构）
  version: number             // v0.2 固定 1（演进追踪不做——append-only 新 ID 已防覆盖，V3 范畴）
  registered_by: 'engine'     // 登记权恒为引擎
  confirmed_at?: string       // 裁决时间（引擎写）
  confirmed_by?: 'user'       // 裁决权恒为用户
}
```

### 1.3 状态机

```text
proposed ──(引擎校验通过)──▶ registered ──┬─(用户 confirm)─▶ confirmed（终态，进下游输入）
（Agent 提案文件，       │
 无系统身份）            └─(用户 reject)──▶ rejected（终态，保留审计，不进下游）
```

- **proposed 不是系统状态**：Agent 写的提案文件没有系统身份；只有引擎登记后才产生 `artifact_id` 与权威 frontmatter。**Proposal ≠ Registered Artifact。**
- 状态流转只发生在 `registered → confirmed | rejected`，由用户裁决触发、引擎写盘。
- **提案内容不可变**：登记后 Agent 不得改已登记 artifact 的正文与依据（Signoff 不改 artifact 状态——用户确认只写 state/confirmed_at 字段）。
- 修订 = 新提案 = 新 ID（append-only，旧 artifact 保留审计）。

### 1.4 注册校验（硬约束，Engine Registration）

登记时引擎执行**确定性校验**（Guardrails beat guidance：不依赖提示词）：

1. **格式**：提案文件含 artifact_type 规定的 marker 段落（如 `## 方向主张`）——非资产格式不赋予系统身份（沿用 artifact-registry 语义）。
2. **依据非空**：`evidence_refs` 至少 1 条。
3. **依据可解析**：每条引用必须指向 person 范围内**真实存在**的文件（`persons/{person_id}/facts/` 或 `persons/{person_id}/snapshot/current/` 下；相对 person 根书写；拒绝 `../`、绝对路径、跨 person 引用）。
4. **归属正确**：提案声明的 `workflow_id/stage_id/person_id` 与当前活动 workflow 的当前 stage 一致。

**失败 → 拒绝登记**：提案文件保留原样（不重命名、不注入身份），返回结构化原因（如 `evidence_refs 引用不存在：facts/foo.md`）。

### 1.5 拒绝反馈（用户可见）

登记拒绝走**已有管线错误通道**：`logger.error` + `error.engine` 广播（ARCHITECTURE.md §5.4 语义：管线错误用户可见）。workflow 状态不变；Stage 完成 guard（§4.1）因 registered=0 判 failed → UI「重新发起」出口（v0.1 BUG-008 已有按钮语义）。被拒提案保留暂存名，不进入后续 done 的扫描范围（§1.6）。

### 1.6 Proposal Intake Boundary（消费边界，P0）

「扫描未登记提案」的边界定义：

- `done` 钩子只处理**当前 Stage Execution 期间产生**的提案文件；历史提案（含此前登记失败的）**不得被后续 done 自动重复消费**。
- 边界建立：`agent/start` 时引擎记录 `persons/{person_id}/directions/` 既有文件名快照（进程内，随 stage task 存入 stageTasks Map）；`done` 时只扫描快照之外的新文件。
- 登记失败的文件保留原样（暂存名、无身份）；修复 = Agent 在新一次 Stage Execution 中写**新提案文件**（新 intake），不修改历史文件。
- 引擎重启：v0.1 §五恢复语义（running 中段 → failed 断流），无 done 事件 → 无重复消费路径。
- **proposed 依然不是系统状态**：intake boundary 是引擎对「本次执行新文件」的判定，不是给提案加生命周期状态。

---

## 二、DirectionCandidate（第一实例）

### 2.1 提案文件（Agent 写，暂存名）

路径 `persons/{person_id}/directions/{YYYYMMDD}-{主题}.md`，结构：

```markdown
---
person_id: person_001
workflow_id: workflow_20260821_00001
stage_id: direction_exploration
---

## 方向主张

新能源汽车结构件设计方向值得重点考虑。

## 事实依据

- facts/education.md：机械工程本科（支撑：专业对口）
- snapshot/current/skill_inventory.md：结构设计 2 年经验（支撑：经验延续）
```

- `evidence_refs` 从「事实依据」段解析：每条 = 引用路径（相对 person 根）+ 支撑说明（支撑说明是 Agent 推理文本，**引擎只校验路径解析，不校验支撑逻辑**——语义级校验后续）。
- 引用格式：`facts/{文件名}` 或 `snapshot/current/{文件名}`（可选条目锚 `#第N条` 允许，引擎解析到文件级）。

### 2.2 登记后（引擎注入权威 frontmatter）

```markdown
---
id: direction_20260821_00001
created_at: 2026-08-21
source_file: 20260821-新能源汽车结构件设计.md
artifact_type: direction_candidate
workflow_id: workflow_20260821_00001
stage_id: direction_exploration
person_id: person_001
state: registered
version: 1
registered_by: engine
evidence_refs:
  - facts/education.md
  - snapshot/current/skill_inventory.md
---
```

- 系统 ID 前缀 `direction_`（artifact-registry 新 ArtifactSpec）。
- 暂存文件重命名为 `direction_20260821_00001.md`（命名权归引擎，不归写入方）。
- frontmatter `id` ↔ IR `artifact_id`：同一系统身份，UI/下游一律用 `artifact_id`；**不为 direction 另造 `direction_id`**。
- `evidence_refs` 为 YAML array（与 IR `string[]` 同构，parser 直读）。

### 2.3 方向池

`persons/{person_id}/directions/` 下该 workflow 的全部 `direction_candidate` = 方向池。

- **confirmed 子集** = Stage 3 的输入（`exploration_artifact` 的判定对象）。
- **rejected** = 保留审计，不进下游。
- 方向池是 workflow/stage 的 **append-only 累积池**（restage 不重置，见 §4.2）。
- 计数引擎实时算（扫描文件 state，不缓存）——与「实时归位」哲学一致。

---

## 三、evaluator 参数化（CompletionSpec v0.2）

### 3.1 语义（修订 v0.1 §3；L2-6 裁决 A 再修订）

```ts
interface CompletionSpec {
  evaluator: 'person-init' | 'artifact-exists' | 'decision-registered'
  evaluatorParams?: {
    artifactType: string   // artifact-exists 专用
    min: number            // 最小登记数（默认 1）
    // 无 state 参数：完成判定 = 已登记产物存在（registered/confirmed/rejected 均算「有产物」）。
    // 裁决结果归 Gate——registered 是瞬态，advance 时点（用户裁决后）按 state=registered 重计数
    // 必然归零，Golden Flow 主路径会被自己卡死（L2-6 实测冲突，裁决 A）。
  }
}
```

| evaluator | v0.1 | v0.2 |
|-----------|------|------|
| `person-init` | 实现 | **不变**（复用 completePersonInit 门禁） |
| `artifact-exists` | `return true` 空转 | **真实判定**：count(workflow/stage/artifactType 匹配，state 不限) ≥ min。**已登记 ⇒ 登记校验已通过——evaluator 不做第二套合法性验证**（登记校验是单一真相源，杜绝「Registration Validator + Completion Evaluator + 另一套 validation」三源） |
| `decision-registered` | `return true` 空转 | 仍占位（Stage 4 下一切片；语义 = decisions/ 出现关联本 workflow 的合法决策，v0.1 §3 已冻结） |

### 3.2 完成判定与 Gate 判定分离

- **完成判定**（advance 第 2 步）：`artifact-exists(type, min=1)` ——**「有产物」是阶段完成**（已登记产物存在即完成，state 不限）。
- **Gate 判定**（方向池）：`confirmed > 0` ——「用户保留方向」是进入下游的前提。
- 二者不混：有产物但全被拒 → 完成但不放行（advance 被 Gate 拒——GATE_BLOCKED，restage 出口）。

### 3.3 advance 缺件报告改造（消除硬编码）

advance 第 2 步失败时，missing 清单 = **evaluator.check 自报的缺件** + 通用前缀（`{stage} 完成条件未满足（evaluator={id}）`），不再在 advance 内硬编码 person 快照名（改造点：`workflow-registry.ts` `stageEvaluatorPassed` 的 person-init 分支把缺件清单外移进 evaluator 实现）。

---

## 四、Stage 2 方向池闭环（Golden Loop）

### 4.1 时序

```text
Stage 1 completed → advance → Stage 2 running + agent/start（Stage Execution Envelope，v0.1 语义不变）
        ↓ Agent 执行方向探索（消费已登记事实；产出方向候选提案文件）
        ↓ done 钩子（引擎，v0.1 BUG-006 模式按 stage 分派）
引擎：扫描本次 intake（§1.6）内的新提案 → 逐个 §1.4 校验
        ├─ 通过 → 登记（registered）+ 写 workflow stage 行 artifacts 列 + workflow.changed 广播
        └─ 拒绝 → error.engine 广播（提案保留原样）
guard：registered ≥ 1？
        ├─ YES → stage 状态 waiting_gate（gate: confirm_directions waiting）
        └─ NO  → stage 状态 failed（无登记产物 = 完成判定必败 → 直接 failed，不进 waiting_gate）
        ↓ UI 方向池卡片（主张 + 依据 + 状态；registered/confirmed/rejected）
        ↓ 用户逐条 confirm / reject（person/directions/resolve）
        ↓ 用户点「继续」（workflow/advance, gateId=confirm_directions）
引擎校验：
  1. stage 状态 waiting_gate
  2. 完成判定：artifact-exists(direction_candidate, min=1, registered) ✅
  3. gate confirm_directions 未过 ✅ 且 gate 可过判定通过：方向池 confirmed ≥ 1
     （引擎确定性检查——不满足 → 拒绝 + 缺件「无已确认方向」）
  4. 下一 Stage inputs：person_aggregate ✅ + exploration_artifact（confirmed 方向池 ≥ 1）
        ↓
Stage 2 completed（gate passed）→ Stage 3 创建（pending）
```

### 4.2 全 reject 出口（workflow/restage，新增）

用户 reject 全部方向（confirmed=0）→ gate 无法通过 → advance 拒绝（缺件：无已确认方向）。出口：

- `workflow/restage { workflowId }`：重置当前 stage → `running`、清 gate，重新 `agent/start`（新 Stage task，resume 上一 stage session；新 intake boundary 随新执行建立）。
- **前置条件（收紧）**：仅允许 `current stage = waiting_gate 且 gate.status != passed`，或 `current stage = failed`。禁止：completed / gate=passed / pending / running / 非 current stage。
- **restage 是 Gate 无候选可通过时的合法重跑路径，不是兜底**（用户对候选不满意是常态场景）；已完成 stage 不受影响；不做自动循环（重跑由用户显式触发）。
- v0.1 failed 的「重新发起」（BUG-008）语义并入 restage（实现阶段对齐，UI 不感知差异）。

**Artifact 归属与累积池（P0 定死）**：

- v0.2 Artifact 归属粒度 = `workflow_id + stage_id`，**不引入 stage_execution_id / attempt**。
- 同一 Stage 的 restage 产生的 Artifact 仍属于同一 workflow/stage；方向池是该 workflow/stage 的 append-only 累积池。
- **restage 不重置方向池**：已 confirmed/rejected 的 Artifact 保持终态（用户裁决不可逆、不复活）。
- 引擎不做方向语义去重（restage 后 Agent 重提相似方向是新提案，由用户再裁决）——语义级判重是推理层（V3）范畴。

**restage 后的 Stage task 上下文**：Envelope 须注入方向池既有裁决状态（哪些已被用户排除）；Stage 2 task 规范写明「用户已排除的方向不得作为候选重新提案」。这是标准约束（Envelope 层），引擎不做硬去重。

### 4.3 resolve 幂等语义（P0 定死）

```text
registered ──confirm──▶ confirmed     confirmed ──confirm──▶ 幂等成功（state 不变）
registered ──reject───▶ rejected      rejected  ──reject───▶ 幂等成功（state 不变）
confirmed  ──reject───▶ 拒绝（ALREADY_RESOLVED，返回当前 state）
rejected   ──confirm──▶ 拒绝（ALREADY_RESOLVED，返回当前 state）
```

- 同动作幂等成功；反动作拒绝；**终态不可逆**（与 append-only 一致）。
- 仅 `registered` 可进入裁决；`confirmed/rejected` 是终态。

---

## 五、RPC 面增量（v0.2）

| 方法 | params | 返回 | 说明 |
|------|--------|------|------|
| `person/directions/list` | `{ personId, workflowId? }` | `DirectionArtifact[]` | 方向池投影（IR 类型，含 state/evidence_refs） |
| `person/directions/resolve` | `{ directionId, action: 'confirm' \| 'reject' }` | `{ directionId, state }` | 用户裁决（§4.3：同动作幂等成功，反动作 ALREADY_RESOLVED，终态不可逆） |
| `workflow/restage` | `{ workflowId }` | `{ workflow }` | §4.2 语义 |

事件：复用 `workflow.changed`（登记/裁决/restage 均广播）。登记失败走 `error.engine`。

**无新增登记 RPC**——登记时机 = Stage task done 钩子（引擎权威时刻，Agent 不显式触发；与 v0.1「Agent 不自报完成」一致）。

---

## 六、Workflow State 文件增量

- stage 行的 `artifacts` 列（v0.1 已留列、恒为 `-`）开始写入：登记时追加 `direction_{id}`（`、` 分隔）。
- `## Gate 记录` 段：confirm_directions 的 waiting/passed/confirmed_at（沿用 confirm_person_facts 格式）。
- 文件仍由引擎单方写（v0.1 §五不变量不变）。

---

## 七、IR 增量（ir/schema.ts）

- 新增 `DirectionArtifact`（§1.2 字段 + 提案正文摘要投影）、`DirectionResolveAction`。
- `WorkflowStageState.artifacts` 已存在（v0.1），语义正式启用。
- **不 bump ProtocolVersion**（2.9）：新增类型 + 新增 RPC 方法名不破坏存量（validator 按 version 分派原则不变）。

---

## 八、Golden Flow v0.2 验收（Stage 2 切片）

**验收终点 = Stage 2 gate passed → Stage 3 创建（pending）**（Stage 3 的 done/evaluator 语义下一切片实现，本切片只保证注册表可扩展）。

### 正例

1. Stage 1 completed → advance → Stage 2 running + agent/start（Envelope 含 Stage 2 边界：禁打分/禁推荐）。
2. Agent 产出 3 条方向提案（各带 facts/ 或 snapshot/current/ 引用）→ done。
3. 引擎登记 3 条（registered）→ stage 行 artifacts 列写入 → waiting_gate → UI 方向池 3 卡。
4. 用户 confirm 2 条、reject 1 条 → 方向池 confirmed=2。
5. advance(gateId=confirm_directions) → Stage 2 completed、gate passed → Stage 3 pending。

### 反例（确定性校验不依赖 Agent 自觉）

| # | 场景 | 预期 |
|---|------|------|
| R1 | 提案无「事实依据」段 / evidence_refs 为空 | 拒绝登记 + error.engine 可见；done guard registered=0 → failed → 重新发起出口 |
| R2 | evidence_refs 引用不存在（`facts/foo.md`） | 拒绝登记（结构化原因） |
| R3 | evidence_refs 越界（`../decisions/x.md` / 跨 person / 绝对路径） | 拒绝登记 |
| R4 | 提案声明 workflow_id/stage_id 与当前不符 | 拒绝登记 |
| R5 | 用户 reject 全部方向 → advance | 拒绝（Gate：无已确认方向）→ restage 出口可用；restage 后方向池不重置（rejected 保持终态） |
| R6 | resolve 幂等语义 | 同动作 → 幂等成功（state 不变）；反动作 → ALREADY_RESOLVED；仅 registered 可裁决 |
| R7 | restage 前置条件 | 仅 waiting_gate(gate≠passed) / failed 可 restage；completed / gate=passed / pending / running / 非 current stage → 拒绝 |
| R8 | 重复消费回归 | 登记失败的提案（保留暂存名）不被下次 done 自动重复消费（intake boundary）；error.engine 不重复广播 |
| R9 | Stage 1 行为回归 | 750 引擎测试全绿 + 测试区 v0.1 七轮验证行为不变（candidates 链零改动） |

---

## 九、待决策点定案（调研笔记 §3.3）

1. **evidence_refs 粒度**：文件级（person 相对路径）+ 可选条目锚；条目级 ID 体系不建（V3 Evidence 原子模型，ADR-003）。
2. **完成 vs Gate 分离**：`artifact-exists(registered≥1)` 判完成；`confirmed>0` 判方向池 Gate（§三.2）。
3. **全 reject 出口**：restage（§4.2），不自动补提案循环。
4. **删除语义**：不做（append-only）。

---

## 十、范围防线与 Stage 1 回迁触发条件

**本切片不做**：

- Evidence 原子模型迁移 / epistemic_status（ADR-003/ADR-009，V3）
- Stage 3/4 实现（evaluator 注册表占位可扩展；`decision-registered` 下一切片接 advance）
- 通用 DSL/DAG、第二种 workflow type、Stage 并行（v0.1 §七冻结延续）
- forbiddenStages 接 PreToolUse 工具级强制（P1 结论不变）

**Stage 1 回迁评估（candidates 链 → 通用原语实例）**：

- 目标：让 Stage 1 成为通用模型的实例（调研笔记 §3.2），但**不在第一刀做**（与 Stage 2 新机制叠加 = 风险叠加，违反「不破坏 Stage 1 已通过行为」）。
- 触发条件：Stage 2 切片在测试区验证通过 + 完成一次完整 Golden Flow（Stage 1→4）+ 750 测试全绿。
- 回迁范围/兼容策略/验收标准届时登记 ADR（candidates 表格物理格式是否保留、RPC 兼容性、投影幂等性）。
