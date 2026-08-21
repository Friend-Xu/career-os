# Career Workflow 契约 v0.3（Stage 3/4 落地：评估闭环 + 推荐落盘）

> 2026-08-21 草案 v0.1 | 增量契约（基于 v0.2 冻结语义，v0.2 全文仍有效）
> 一句话：**v0.3 把 v0.2 预留的 Stage 3/4 从「占位放行」落成机制——`evaluation_candidate` 评估闭环 + `decision-registered` 推荐落盘；证据域参数化（每 artifact_type 声明证据域）。**
> 核心不变量延续 v0.1 §〇 / v0.2 §一：**Agent=Proposal / User=Confirmation Authority / Engine=Registration + Deterministic Evaluation / UI=Projection + Human Action。**

---

## 〇、对 v0.2 的修订清单（增量，非重写）

| # | 修订点 | 内容 |
|---|--------|------|
| 1 | v0.2 §1.4 证据域 | 从硬编码 `facts/ + snapshot/current/` 参数化为 `StageArtifactSpec.evidenceRefPattern`（每 artifact_type 声明自己的证据域） |
| 2 | v0.2 §三 evaluator | `artifact-exists` 挂参到 `direction_evaluation`（`evaluation_candidate`）；`decision-registered` 从占位 `return true` 改为真实判定 |
| 3 | 新增 §二 | Stage 3（direction_evaluation）评估闭环：`evaluation_candidate` + `onEvaluationDone` + 无 gate 推进 |
| 4 | 新增 §三 | Stage 4（recommendation）推荐落盘：`decision-registered`（intake + artifacts 列）+ `review_recommendation` gate 联动 + Goal 完成 |
| 5 | Stage 4 出口 | reject 推荐 → `workflow/restage`（复用 v0.2 §4.2 通用 restageWorkflow，不改语义） |

---

## 一、证据域参数化（修订 v0.2 §1.4 第 3 条）

`StageArtifactSpec` 增加 `evidenceRefPattern`：

```ts
interface StageArtifactSpec {
  artifactType: string
  dir: (personId: string) => string
  idPrefix: string
  marker: RegExp
  /** 证据域：evidence_refs 引用路径必须匹配（相对 person 根，含 .md）。 */
  evidenceRefPattern: RegExp
}
```

| artifact_type | 证据域 | 说明 |
|---------------|--------|------|
| `direction_candidate` | `facts/` + `snapshot/current/` | 不变（v0.2 语义） |
| `evaluation_candidate` | `facts/` + `snapshot/current/` + `directions/` | 评估的依据 = 已确认方向 + 个人事实 |

- 校验语义不变（v0.2 §1.4 第 3 条）：引用必须匹配 `evidenceRefPattern` + 文件真实存在。
- **directions/ 引用的 state 不校验**（P0：文件存在即可；`confirmed` 语义校验属语义级引用校验，V3 范畴——对齐 v0.2 §2.1「引擎只校验路径解析，不校验支撑逻辑」）。

---

## 二、Stage 3（direction_evaluation）评估闭环

### 2.1 evaluation_candidate 提案（Agent 写，暂存名）

路径 `persons/{person_id}/evaluations/{YYYYMMDD}-{主题}.md`：

```markdown
---
person_id: person_001
workflow_id: workflow_20260821_00001
stage_id: direction_evaluation
---

## 方向评估

新能源汽车结构件设计方向匹配度高，建议重点推进。

## 事实依据

- directions/direction_20260821_00001.md：已确认方向（评估对象）
- facts/education.md：机械工程本科（支撑：专业对口）
```

- 登记后 frontmatter 与 direction_candidate 同构（`id/created_at/source_file/artifact_type/.../state: registered/evidence_refs`），系统 ID 前缀 `evaluation_`。
- marker = `## 方向评估`；marker 段后首个非空段落 = 评估摘要（UI 投影 `claim`）。

### 2.2 evaluator 与 gate

- evaluator：`artifact-exists { artifactType: 'evaluation_candidate', min: 1 }`（完成判定 = 已登记产物存在，state 不限——L2-6 裁决 A 延续）。
- **gate：无**——评估明细是 AI 推理结果（加权打分），不是用户事实，无需 User Confirmation；`evaluation_candidate` 恒 `registered`，不进入裁决。

### 2.3 时序

```text
Stage 2 completed → advance → Stage 3 running + agent/start（Envelope 含边界：禁推荐）
        ↓ Agent 执行方向评估（消费已确认方向池 + 事实；产出评估提案）
        ↓ done 钩子（onEvaluationDone）：intake 内提案登记 → guard
guard：registered ≥ 1？
        ├─ YES → waiting_gate（无 gate）
        └─ NO  → failed
        ↓ 用户点「继续」（advance 不传 gateId）
引擎校验：状态 waiting_gate ✅ → artifact-exists(evaluation_candidate) ✅ → 无 gate 跳过 → Stage 4 inputs 齐备
        ↓
Stage 3 completed → Stage 4 创建（running）
```

---

## 三、Stage 4（recommendation）推荐落盘

### 3.1 decision 报告

- Agent 产出决策报告到 `decisions/`（Decision Record Contract v1.0，**不改该冻结契约**）。
- Agent 在 frontmatter 声明 `person_id`（从 identity 获取）+ `type: direction`（DECISION_SPEC.passthroughFields 透传保留）。
- decision 登记走既有 `registerDecisionIdentity`（watcher 自动 + done 钩子幂等补登记），系统 ID `decision_{YYYYMMDD}_{NNNNN}`。

### 3.2 decision-registered evaluator（从占位到真实）

- 完成判定 = **workflow 的 recommendation stage `artifacts` 列非空**（≥1 条关联本 workflow 的 decision 系统 ID）。
- artifacts 列由 `onRecommendationDone` 写入（Engine Registration），evaluator 只读列——单一真相源，不做第二套合法性校验。

### 3.3 onRecommendationDone（done 钩子）

```text
Stage 4 done → intake boundary（decisions/ 快照外新文件）→ registerDecisionIdentity（幂等登记）
  → 逐个校验新决策 frontmatter person_id == workflow.personId
  → 合法 → 记录 decision 系统 ID 到 stage 4 artifacts 列（累积追加）
guard：合法决策 ≥ 1？
  ├─ YES → waiting_gate（挂 review_recommendation）
  └─ NO  → failed
```

### 3.4 review_recommendation gate + Goal 完成（advance 联动）

```text
用户点「采纳推荐」→ workflow/advance { workflowId, gateId: 'review_recommendation' }
引擎四步校验：
  1. 状态 waiting_gate ✅
  2. decision-registered（artifacts 列非空）✅
  3. gate review_recommendation 未过 ✅ + 无条件（完成判定已保证 decision 存在）
  4. 无下一 stage（末阶段）
→ 联动：decision status → accepted（BUG-007 模式：confirm_person_facts → completePersonInit 的同源联动）
→ Stage 4 completed、gate passed、workflow.status = completed（Goal 完成，§六语义）
```

- 联动方式：advance 时引擎把 artifacts 列记录的 decision 文件 frontmatter `status` 置 `accepted`（Engine Registration 拥有 Canonical State）。
- **decision status 联动失败不阻断 advance**：decision 文件缺失/不可写时记录 logger.error（decision 状态是投影事实，workflow 完成是控制平面事实——二者解耦，与 BUG-007「同源校验不会抛」的前提不同，此处决策文件是外部产出，容错于管线错误通道）。

### 3.5 reject 出口

- 用户审阅后不满意 → `workflow/restage`（复用 v0.2 §4.2 通用语义：waiting_gate 且 gate 未过 → running + 清 gate）。
- decision 报告 append-only 累积（每次 restage 产出新 decision 文件，旧报告保留审计）；stage 4 artifacts 列累积追加，不覆盖。

---

## 四、Golden Flow 完整验收（Stage 1→4）

```text
Stage 1 completed（person-init）→ advance
Stage 2 方向池（confirm ≥ 1）→ advance
Stage 3 评估（evaluation_candidate 登记 → advance）
Stage 4 推荐（decision 登记 → review_recommendation → advance → decision accepted + workflow completed）
```

反例（确定性校验不依赖 Agent 自觉）：

| # | 场景 | 预期 |
|---|------|------|
| V3-R1 | 评估提案 evidence_refs 引用 directions/ 不存在文件 | 拒绝登记（EVIDENCE_UNRESOLVABLE） |
| V3-R2 | 评估提案 evidence_refs 引用 decisions/（不在评估证据域） | 拒绝登记（EVIDENCE_OUT_OF_SCOPE） |
| V3-R3 | Stage 3 done 无合法评估产物 | failed（registered=0） |
| V3-R4 | Stage 4 done 决策 person_id 与 workflow 不符 | 不记录 artifacts 列 → failed |
| V3-R5 | Stage 4 advance 前 artifacts 列空 | decision-registered 未过 → STAGE_INCOMPLETE |
| V3-R6 | Stage 4 reject → restage | decision append-only；artifacts 列累积；restage 后重新 done |

---

## 五、范围防线

**本切片不做**：

- evaluation_candidate 的 state 语义校验（引用必须是 confirmed 方向）——语义级引用校验（V3）
- evaluation_candidate / decision 的 UI 投影卡（评估明细卡、推荐审阅卡）——引擎先行，UI 投影下一 checkpoint
- 新增 RPC（`person/evaluations/list` 等）——UI 投影需要时再增；本切片复用 agent/start / workflow/advance / workflow/restage
- Decision Record Contract v1.0 改动（workflow 关联走 artifacts 列，不加 workflow_id 字段）
