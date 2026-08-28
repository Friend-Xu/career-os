# Session Context Contract v0.1（**FROZEN**，2026-08-26 评审通过——ADR-036 冻结即本契约冻结）

> **已冻结**：作为 Phase 2（Session Context Store）/ Phase 3（Context Compiler）/ Phase 4（UI 适配）
> 的实现依据；冻结前按修订记录演进，冻结后语义变更需新版本契约 + 关联 ADR 修订。
> 定位：**会话连续性的受控承载物定义 + 引擎侧确定性编译规则**（不是 Prompt 文档，不是聊天
> 历史存储方案）。
> 前置契约：`docs/ADR/036-agent-session-context-boundary.md`（边界裁定）、
> `docs/ADR/034-agent-runtime-execution-model.md`（Session/Execution 两实体）、
> `docs/ADR/030-agent-provider-decoupling.md`（直连唯一路径；resume 语义废弃）。
> 正交契约：`evidence-sufficiency-contract-v0.1.md`（检索证据状态——本契约不消费、不修改）。

---

## A. 适用范围（v0.1 Reference Implementation）

- **适用**：conversation 平面——UI 对话触发的执行（执行存在 `sessionId` 归属；任意 taskType）。
- **不适用**：workflow_stage 触发的执行（start 参数含 `workflowId/stageId`——控制平面任务
  不读不写 Frame；阶段上下文 = Stage Envelope + 工作区，保持现状）。
- **与 taskType 正交**：Frame 不区分 taskType；`company_research`/`job_analysis`/
  普通过话同等受益。协议面（task-protocol）与 Frame 互不注入对方内容。
- **泛化条件**：v0.1 先行；仅当出现「跨设备/跨刷新会话恢复」「口头指代解析」等真实消费方时，
  才按 ADR-006 触发条件扩展（Summary / Lock / 解析均在边界外，见 §H）。

## B. Session Context Frame v0.1 定义（冻结级）

### B.1 类型（引擎侧单一事实源）

```ts
interface SessionContextFrame {
  sessionId: string            // Execution 的交互归属（ADR-034 §1.6）
  personId?: string            // 归属人（执行注入的当前分析对象；可缺省）
  focus: FocusRef[]            // 显式引用投影（有界 ≤3；来自最近一次带引用的执行）
  recentTurns: TurnRecord[]    // 有界 ≤6 条；原始文本（非摘要）
  lastExecutionId?: string     // 最近一次参与 Frame 更新的执行
  updatedAt: string            // ISO 时间戳
}

interface FocusRef {
  type: 'job' | 'company' | 'resume' | 'decision'   // CONTEXT_REF_TYPES（ADR-020）
  id: string                                         // 领域对象 ID（引用解析后的合法 ID）
  label: string                                      // 展示名（如「Company-A · 机械工程师」）
}

interface TurnRecord {
  role: 'user' | 'assistant'
  text: string                                       // 原始文本；单条上限 2000 字符（超限截断）
  at: string                                         // ISO 时间戳
}
```

### B.2 生产方与生命周期

- **生产方 = Context Compiler（引擎侧单写方）**；UI 只读投影（P4 展示），永不直接写。
- **登记时机（Engine Registration）**：引擎首次观察到某 sessionId 的 conversation 执行时
  创建 Frame（空 focus + 空 recentTurns）；无执行 = 无 Frame。
- **销毁**：v0.1 无自动销毁；Frame 与 UI 会话同寿命（UI 会话删除时引擎侧一并清理，
  Phase 4 定义删除通道——v0.1 孤儿 Frame 无消费路径（§E），不存在脏引用风险，不做时效兜底）。
- **存储域**：workspace 用户数据域（私人数据，gitignored）；不进入 git 跟踪文件；
  不使用 sanitize 通道之外的任何架构文件路径。

### B.3 字段语义（禁止项）

- `focus` 只存**显式引用投影**（resolveContextRefs 输出），禁止存口语解析结果
  （§F 边界）与推断对象。
- `recentTurns` 只存**原始文本**（截断可，改写不可）；禁止 LLM 生成摘要
  （Producer Ownership：生成式内容不得成为系统语境权威——ADR-036 红线 1）。
- **定位声明（用词克制）**：`recentTurns` = **Bounded Raw Conversation Context**——
  最近几条原始文本的确定性窗口。**不是** Memory Engine / Summary Memory / Semantic Memory；
  未来讨论「记忆」时不得与此复用同一词表（如同 ADR-035 的维度状态与 M2 三态禁止混词）。

## C. 编译规则（每轮 start；确定性，冻结级）

### C.1 注入优先级（编译顺序 = 优先级，非质量判定）

```text
1. 本轮显式 contextRefs（权威——ADR-020；有则注入「显式上下文」段，原样）
2. 无显式引用 → 继承 focus（注入「会话焦点（继承）」段，标注来源非权威）
3. recentTurns（≤6 条；注入「最近对话（原始摘录）」段）
4. 现有 system 段（身份 / 任务协议 / Stage Envelope）——不变
```

### C.2 注入形式（system 通道）

- 新增 section：`## 会话上下文（引擎装配）`，列 focus（含「继承自会话」标注）与
  recentTurns（`User:` / `Assistant:` 前缀原文）。
- **与用户消息分离**：入 system 通道（对齐 ADR-030 通道修正——协议/上下文面不拼 user 尾部，
  避免被长任务稀释）。
- **无 Frame 或 Frame 为空**：不注入该 section（= 现状行为，零风险路径）。

### C.3 有界规则（替代动态预算的唯一机制）

| 项 | 上限 | 超限行为 |
|---|---|---|
| focus | 3 项 | 保留最近执行的前 3 项 |
| recentTurns | 6 条 | 追加时丢最旧（FIFO） |
| 单条文本 | 2000 字符 | 截断 + 省略号（保留首尾，中间删） |
| 注入增量总量 | ≈ 6–8K token（物理上限——**仅约束会话连续性增量**） | 无需动态裁决：上限即预算 |

> **修订注记（2026-08-28）**：单条上限 500 → 2000（字符）。真机定位：500 字截断让下一轮
> recentTurns 只剩首尾残片——HR 回复类长消息中间信息全丢，模型读到断裂文本（上下文质量缺陷，
> 与"空输出"故障同轮定位）。2000 覆盖典型单条消息；增量上限随之 2–3K → 6–8K token，
> 与对话输出预算 16K 无冲突。截断机制不变（保留首尾、中间删、禁止改写——§B.3 红线）。
> 若出现真实膨胀样本，按 ADR-006 触发条件评估，不在本条款内预建机制。

> **表述限定（起草评审，2026-08-26）**：v0.1 对**会话连续性增量**采用物理上限，**不建立独立的
> 动态 Context Governance**；不预先否定未来对**总上下文空间**（Stage 协议 / 任务协议 /
> Capability Manifest / 工具面等）的治理——出现真实膨胀样本时按 ADR-006 触发条件评估，
> 不在本契约内预建机制。

## D. 更新时机（单写方；冻结级）

| 事件 | 更新 |
|---|---|
| execution done（conversation） | focus：本轮有显式引用 → **替换**；无 → **保留**；recentTurns 追加本轮 user（task 文本）+ assistant（done.result） |
| execution error / cancelled | recentTurns 仅追加 user（task 文本）；focus 不变 |
| question_request（提问卡） | 不触发 Frame 更新（答案在后续执行内流转） |
| workflow_stage 执行 | **不读不写 Frame**（§A） |

- **focus 切换规则（确定性，无 LLM 判定）**：仅当本轮 execution 携带显式引用时替换——
  这天然实现「换对象」语义：用户从新公司/JD 入口发起任务 → 引用切换 → 焦点切换；
  口头换对象（无引用）→ 焦点保留 + recentTurns 记录原文（§F）。
- **任务切换 ≠ 焦点清空**：taskType 变化不触发 focus 变化（focus 跟对象走，不跟任务走）。

## E. 有效性规则（编译时判定）

- 编译引用条件：Frame 的 `sessionId` 与当前执行归属一致。不匹配者不参与编译
  （孤儿 Frame——UI 会话已删——无消费路径，不存在脏引用路径；不做时效兜底）。
- personId 不一致（同一 sessionId 换人——v0.1 视为会话重建）：不注入 Frame，
  由 UI 创建新会话承载（现状行为）。

## F. 指代与解析边界（诚实边界，冻结级）

- **v0.1 不做**口语指代解析（「这家公司」→ objectId）、命名实体抽取、焦点外推。
- 指代链的承载体 = recentTurns **原始文本**：Agent 可读「这个公司团队很小」原文，
  本轮即能正确回应；**焦点不因口头指称自动更新**（无显式引用）。
- Agent 允许在指代不明时**主动提问**（ask_user_question，既有通道）——提问是 Agent 行为，
  不进入 Frame；用户回答后答案流转于同执行内（提问卡同任务续答，ADR-034 §6.1）。
- 升级条件（后置）：命名实体 → 引用解析能力就绪 + 真实指代误判样本出现时，
  按 ADR-006 触发条件另立契约；v0.1 不预留字段。

## G. 与现有物料的映射（迁移声明，Phase 4）

| 现有物料 | 语义 | 迁移 |
|---|---|---|
| UI `session.contextBundle` | 最近一次执行的引用快照（展示「本次分析依据」） | 保留为展示投影；**权威 = 引擎 Frame.focus**（同源，不双写） |
| UI `sessions[].messages`（localStorage） | 完整会话历史（展示/刷新恢复） | 保持不变；**不注入模型**；引擎 recentTurns 独立累积（与 UI messages 解耦，允许短暂不一致） |
| `resumeSessionId` 传参与注释（UI/CLI 遗留） | CLI 管道模式续接 | **废弃**（直连不消费）；Phase 4 清理传参 + 注释改为「会话上下文 = Frame（ADR-036）」 |
| `schema.ts` Session 接口（messages 字段） | CLI 残留 | 冻结不删（兼容老接口）；引擎侧新实体 = SessionContextFrame |

## H. 红线（冻结级；与 ADR-036 §五逐项对应）

1. ❌ 生成式 Summary 注入（任何 LLM 压缩文本进上下文）
2. ❌ Context Health / 质量评分 / 运行时「上下文充分性」判定
3. ❌ 统一加权预算（百分比分区；有界 = 物理上限 + 帧内裁剪，不做动态模型）
4. ❌ Context Lock / 绑定对象（依赖 Canvas 决策）
5. ❌ 修改 ADR-034 状态机 / Frame 进 Execution 身份字段
6. ❌ 控制平面（workflow_stage）读写 Frame
7. ❌ 口语指代解析驱动焦点更新（focus 只认显式引用）

## I. 附录：Golden Flow 样本

| 样本 | 场景 | 编译输入 | 预期行为 |
|---|---|---|---|
| A 同话题追问 | 上轮分析 Company-A · Job-B（带引用，focus 已登记）；本轮「怎么回复 HR？」（无引用） | focus=[Company-A, Job-B] + recentTurns=[…原文] | 不问「哪家公司」；直接以「这家公司」为对象回应 |
| B 显式换对象 | 用户另开 Company-C 页面点击分析（本轮引用 = Company-C） | 权威引用 = Company-C；focus 替换为 Company-C；旧 focus 不进 prompt | 不被旧对象绑架；done 后 focus=[Company-C] |
| C 全新会话 | 新 sessionId，引擎无 Frame | 无 section 注入 | 行为 = 今日现状（Agent 自读信息池，可提问） |
| D 口头指称 | 上轮无引用（纯问答，focus 空）但消息含「这个公司」；本轮「那怎么回复她？」 | recentTurns 含原文 | Agent 可从原文理解指代；焦点不更新；指代不明时提问（允许） |
| E 控制平面 | workflow_stage 执行（带 sessionId 的对话内 Stage） | 不读不写 Frame | Stage 上下文 = Stage Envelope + 工作区（现状，不回归） |

## J. 修订记录

- v0.1（2026-08-26）：初始起草——ADR-036 冻结预期（Phase 1）；Frame 字段 / 编译规则 /
  更新时机 / 有界规则 / 指代边界 / 物料映射 / 5 样本。
- v0.1（起草评审修订，2026-08-26）：① §B.3 增加 recentTurns 定位声明（Bounded Raw
  Conversation Context，禁止与 Memory 词表混用）；② §C.3 有界性表述限定为「会话连续性
  增量」，不预先否定未来总上下文空间治理（触发条件 ADR-006）；③ §B.2 清理 30 天时效
  兜底（孤儿 Frame 无消费路径，与 §E 一致——禁止兜底原则）。
