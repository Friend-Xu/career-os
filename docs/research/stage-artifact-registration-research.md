# Stage-Artifact Registration 调研与架构初判（Business Depth v0.2 前置）

> 2026-08-21 | 问题来源：GPT 裁决「范围维持 1→2→3→4，第一刀 = 通用登记基础设施 + Stage 2 方向池闭环；先回答：能否抽出统一 stage-artifact registration primitive 且不破坏 Stage 1」+ 用户指示先上网调研。
> 结论先行：**能抽。引擎已有 2/3 零件，特化债务有实证位置；外部调研确认四条设计原则。第一刀建议先立契约草案（标准优先于 Prompt，ADR-006），再落代码。**

---

## 0. TL;DR

1. **已有零件**：`engine/storage/artifact-registry.ts`（M1.6 通用命名/身份层）+ person-watcher candidates 链（完整 Proposal→Registration→Confirmation→Projection 生命周期，但 person 领域写死）+ workflow-registry 的 evaluator 三分支（`artifact-exists`/`decision-registered` 空转 `return true`）。
2. **外部原则**：确定性校验 > 提示词约束；append-only 事件 + 幂等投影；HITL = 引擎持有 checkpoint、用户输入是命令；审查流不修改 artifact 状态。
3. **架构答案**：抽统一 primitive = 分三层（身份层复用 / 生命周期层新增 / evaluator 参数化）。Stage 1 **零改动**保证不破坏；回迁放 Stage 2 切片验证之后，用 ADR 登记时机。
4. **第一刀**：先写 v0.2 契约草案，再实现 primitive + DirectionCandidate 实例。

---

## 1. 现状盘点（代码实证）

| 层 | 现有实现 | 缺口 |
|----|---------|------|
| **命名/身份层** | `artifact-registry.ts`：`ArtifactSpec{type,dir,idPrefix,marker,passthroughFields}` + `registerArtifacts`（marker 校验 → 系统 ID 命名 → frontmatter 注入 `id/created_at/source_file` → 幂等）。Decision/Evidence 共用，已实现「命名权归引擎」 | 无状态机、无 evidence_refs、无确认流、无 workflow/stage 关联 |
| **生命周期层** | person-watcher：`appendCandidates`（append-only 表格提案）→ `resolveCandidate`（确认/拒绝）→ `projectPersonSnapshots`（幂等投影）→ `completePersonInit`（门禁） | 完整生命周期只存在于 person 领域：路径、六列表格、正则解析全部写死，无法复用给 direction/evaluation |
| **Stage 层** | `workflow-registry.ts`：`stageEvaluatorPassed` 三分支；`stageMissingInputs` 只查 `person_aggregate` | `artifact-exists`/`decision-registered` **直接 `return true`**（注释自认「无已实现阻断项」）；advance 的 STAGE_INCOMPLETE 错误报告**硬编码** `identity.md/skill_inventory.md/preference_constraints.md` 快照名——Stage 1 特化已渗透通用 advance 路径（**特化债务实证位置**） |
| **契约层** | `docs/contracts/Career-Workflow-Contract-v0.1.md` §2.3/§3：Stage 2-4 的 inputs/outputs/evaluator/gate 语义已冻结（`artifact-exists` = outputs 指定 Artifact 已登记且 validation 合法；`decision-registered` = decisions/ 出现关联本 workflow 的合法决策） | 契约已写、实现空转——v0.2 是把冻结语义落成机制，**不重新发明语义** |

### 1.1 ADR 对齐（避免调研结论与已定决策冲突）

- **ADR-004（Agent Workflow Contract，V3 defer）**：revisit trigger「Multiple agent tasks require composition, state tracking」——**v0.2 正是触发点**，本切片可以登记 ADR-004 的落地。
- **ADR-003（Evidence 原子资产，V3 defer）**：本切片**不落地**。Stage 2 的 `evidence_refs` 只指向现有 facts/ 与快照投影（文件级 + 可选锚），不迁移 evidence 原子模型——那是 V3 范畴，不借 v0.2 偷跑。
- **ADR-009**：Evidence `epistemic_status` 三态未实现（标准缺失，ADR-006 先立标准）。**推论**：Stage 3 评分卡不发明「确信度」类语义字段，只做 `score + evidence_refs` 硬校验，避免踩标准缺失坑。

---

## 2. 外部调研 → 设计映射

| 外部模式 | 来源 | 映射到本项目 |
|---------|------|-------------|
| HITL：引擎持有 checkpoint，人输入是 resume command 而非新一轮 agent turn | [LangChain HITL 文档](https://docs.langchain.com/oss/python/langchain/frontend/human-in-the-loop)（`interrupt()` + `Command(resume=…)`） | 现有 `waiting_gate` + `workflow/advance` + `resolveCandidate` 已是此形态。**沿用，不引入**「用户输入直接续跑 Agent」的混合模式 |
| Durable execution：审批 pending 不占用进程，状态持久化可跨重启 | [Temporal HITL cookbook](https://docs.temporal.io/ai-cookbook/human-in-the-loop-python.md) / [Learn Temporal 教程](https://learn.temporal.io/tutorials/ai/building-durable-ai-applications/human-in-the-loop/) | 已满足（workflows/*.md 文件持久化）。v0.2 的 artifact 状态同样文件持久化 |
| **Guardrails beat guidance**：确定性校验优先于模型指令 | [agentpatterns.ai](https://learn.agentpatterns.ai/verification/guardrails-beat-guidance/)（[glossary](https://learn.agentpatterns.ai/verification/reference/)） | 直接支撑 GPT 的核心约束：**「有 facts 引用」是 Registration 硬约束，不是 Prompt 约束**。Proposal ≠ Registered Artifact，校验不过就拒绝登记 |
| Event sourcing for AI agents：append-only 事件日志 + 投影读模型 | [inferensys glossary](https://inferensys.com/glossary/agentic-memory-and-context-management/state-management-for-agents/event-sourcing) / [callsphere 博客](https://callsphere.ai/blog/agentic-ai-event-sourcing-cqrs-saga-patterns) | 现有 candidates 表 + snapshots 投影已是此形态。primitive 保持：状态**只增不改**（reject 追加新状态，不改原提案行）、投影幂等 |
| Grounded evaluation：claim 级引用校验（GEDD 领域专家指南 / GroundednessEval / CiteGuard 引用级假发现控制） | [AWS sample-GEDD](https://github.com/aws-samples/sample-GEDD/blob/main/grounded-evals/docs/domain-expert-guide.md) / [AgentEvalHQ](https://github.com/AgentEvalHQ/AgentEval/blob/main/src/AgentEval.Evals.Agentic/Quality/GroundednessEval.cs) / [CiteGuard (ICML)](https://icml.cc/virtual/2026/poster/64935) | `evidence_refs` 最小校验 = 引用**可解析**且**归属当前 person**（fact-012 存在？属于 person_XXX 的事实域？）。语义级「引用是否真的支撑主张」留后续，不在注册时做 |
| Signoff gate 不修改 artifact 状态：审查产物与状态机分离 | [agent-sop](https://github.com/ythx-101/agent-sop) / [tomzx/agents sdlc skill](https://github.com/tomzx/agents/blob/main/skills/sdlc/SKILL.md)（review 不改 artifact status，只写 review-* 文件） | 用户确认只写 confirmation 字段（confirmed_by/confirmed_at）；Agent 不得改已登记 artifact 的 state——与「Engine owns Fact/State」不变量同源 |
| 事实模型版本化 | [relay-knowledge 图事实模型](https://github.com/coolplayagent/relay-knowledge/blob/main/docs/en/03-architecture-specs/06-graph-fact-model-and-versioning.md) | `version` 字段随每次登记递增；配合 artifact-registry 现有「ID 防覆盖」机制（新 ID 不覆盖旧文件） |
| 人工审批门禁集成示例 | [galdor integration-approval-gate](https://pkg.go.dev/github.com/YasserCR/galdor/examples/integration-approval-gate) / [Ably + Anthropic HITL](https://ably.com/docs/ai-transport/guides/anthropic/anthropic-human-in-the-loop) | 参考其「pending approval 状态显式建模」做法；我们已有 waiting_gate，语义对齐即可 |

> 注：以上为模式级引用（文档/教程/开源仓库展示的通行做法），「映射到本项目」列是本项目的设计推断，非对来源内容的断言。
> 呼应 v0.1 已有结论（P1 不做）：forbiddenStages 接 PreToolUse 工具级强制不做——guardrails 调研方向一致（确定性校验），但工具级强制仍属纵深防御第二层，触发条件不变。

---

## 3. 架构问题初判：能否抽出统一 primitive 且不破坏 Stage 1？

**答案：能。分三层抽取，Stage 1 第一刀零改动。**

### 3.1 三层抽取

```text
L3  Evaluator 参数化（改造 workflow-registry.ts）
      CompletionSpec.evaluator → 注册表 + 参数
      person-init（现有实例）/ artifact-exists(type, state, min)/ decision-registered
      advance 缺件报告由 evaluator 自报（消除硬编码快照名）
        ▲
L2  Stage-Artifact 生命周期（新增，本切片核心）
      { artifact_type, artifact_id, workflow_id, stage_id,
        state: proposed → registered → confirmed | rejected,
        evidence_refs[], version, registered_by: 'engine' }
      注册时引擎硬校验：evidence_refs 可解析 + 归属当前 person（Proposal ≠ Registered）
      DirectionCandidate = 第一实例
        ▲
L1  命名/身份层（不动，复用）
      artifact-registry.ts：系统 ID 命名 + frontmatter 注入 + 幂等
```

### 3.2 Stage 1 不破坏策略

- 第一刀 **不动** person-watcher candidates 链（表格格式、路径、RPC 全部原样）——750 引擎测试全绿 + 测试区行为回归 = 验收线。
- 新 primitive 先只服务 Stage 2（DirectionCandidate）。
- **Stage 1 回迁评估放 Stage 2 切片验证之后**（GPT 目标认同：让 Stage 1 成为通用模型实例；但第一刀同时改 Stage 1 = 风险叠加，直接违反「不破坏已通过行为」的验收约束）。回迁时用 ADR 登记：回迁范围（candidates 链迁到 L2 生命周期）、兼容策略（RPC/文件格式保持）、验收标准。
- 物理格式**不强制统一**：candidates 表格 vs frontmatter 是各 artifact_type 的投影细节；primitive 统一的是生命周期语义与状态机，不是文件格式。防「为统一而统一」的破坏性迁移。

### 3.3 待决策点（进契约草案定案）

1. **evidence_refs 粒度**：最小可行 = 文件级（person 范围内，如 `persons/person_001/facts/education.md`）+ 可选条目锚（如 `#第2条`）；条目级 ID 体系不建（那是 V3 Evidence 原子模型）。
2. **artifact-exists 的 state 判定**：Stage 2 完成判定用 `registered` 还是 `confirmed`？按 GPT 闭环：方向池 Gate = **confirmed > 0**；完成判定 = artifact 已登记（registered）。两者分离：`artifact-exists(type, min=1, state=registered)` 判完成，`confirmed count > 0` 判方向池 Gate。
3. **拒绝语义**：User reject 一个 DirectionCandidate → 候选保持 rejected（审计），方向池计数只算 confirmed；是否需要「Agent 补提案」循环？（建议：不需要——用户可重新触发 Stage 2 task，不加自动循环。）
4. **unregister/删除**：v0.2 不做（append-only；现有 abort/删除不在本切片）。

---

## 4. 建议执行顺序（第一刀）

```text
1. 契约 v0.2 草案（docs/contracts/Career-Workflow-Contract-v0.2.md）
   ——Stage Artifact Lifecycle + evaluator 参数化 + DirectionCandidate 结构 + 待决策点定案
   （标准优先于 Prompt，ADR-006：先立标准再写代码）
2. 引擎实现：L2 primitive + DirectionCandidate 实例 + L3 evaluator 参数化 + advance 接新 evaluator
3. 引擎测试：注册校验用例（无依据提案被拒 / 引用不存在被拒 / 引用不属于本 person 被拒 / 确认流转 / 投影幂等）
4. 测试区验证循环（沿用：你移植 → 我杀进程重启 → 你验证 → BUG 台账）
5. Stage 1 回迁评估 → 登记 ADR
```

**范围防线**：不做 Evidence 原子模型迁移（V3）、不做通用 DSL/DAG、不做第二种 workflow type（契约 v0.1 §七已冻结）、Stage 3/4 本切片只做契约预留不动实现。
