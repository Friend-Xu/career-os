# Agent Task Contract v0.1（已冻结，2026-08-08）

> 冻结版（ADR-020 FROZEN 后入库——实现契约：Engine/UI/Agent 三方如何交互，类型定义，
> 字段语义，验收规则。设计决策与禁止项见 `docs/ADR/020-agent-task-context-boundary.md`，
> 本契约不复制理由只落接口）。
> 背景：Agent 已接真实 LLM，从聊天入口演进为 Career OS 推理入口。现状 taskType 无语义
> 契约（英文 key + 中文映射）、上下文注入不可审计（Agent 自读 workspace 为隐形上下文、
> 面板「已加载上下文」为硬编码 mock）、输出边界依赖调用方约定。本契约把 Agent 动作
> 冻结为：Task（请求是什么）→ Context（Agent 能看到什么）→ Output（Agent 能影响什么）。

---

## 1. 定位（冻结级）

**Defines the runtime contract between UI actions, Engine context assembly, and Agent execution.**

```
UI（声明 contextRefs）→ Engine（校验/解析/装配）→ Agent（消费）→ UI（投影展示来源）
```

- Engine = 装配 Owner（事实引用）
- Agent = 推理
- UI = 展示来源（只投影不解释）
- Agent 自读 workspace = 补充能力（**不属于 Context Contract 输入**，不进入 Bundle 生命周期）

## 2. AgentTaskRequest（冻结级）

```ts
interface AgentTaskRequest {
  taskType: AgentTaskType
  contextRefs?: ContextReference[]
  outputTarget?: OutputTarget    // 默认 'none'
  trigger: TaskTrigger           // v0.1 仅 'user_action'
}
```

- Task Request 是**瞬态请求契约**：UI → Engine，发送时冻结，**不落盘**
- 三生命周期分离：TaskRequest（runtime 一次执行参数）→ Session（history 执行记录）→
  Artifact/Decision（business state 业务事实）
- taskType 由页面动作直接声明（按钮即意图，无 User Intent 中间层）

## 3. TaskType Registry（冻结级）

实现所需列（完整语义见 ADR-020）；**required 缺失 = Task rejected**（fail fast）：

| taskType | contextPolicy | outputTarget |
|----------|---------------|--------------|
| `job_analysis` | required(job); optional(company,resume); emptyAllowed:false | decision |
| `company_research` | required(company); emptyAllowed:false | none |
| `decision_reassessment` | required(decision); emptyAllowed:false | decision |
| `decision_review` | required(decision); emptyAllowed:false | none |
| `resume_generation` | optional(person); emptyAllowed:true | artifact |
| `resume_adaptation` | required(job,resume); emptyAllowed:false | artifact |
| `interview_preparation` | required(job); optional(resume,company); emptyAllowed:false | none |
| `explanation` | optional(任意引用); emptyAllowed:true | none |
| `career_direction` | optional(person); emptyAllowed:true | decision |
| `company_screening` | optional(company); emptyAllowed:true | none |
| `job_lead_search` | required(company); emptyAllowed:false | none |

## 4. ContextReference（冻结级）

```ts
interface ContextReference {
  type: 'job' | 'company' | 'resume' | 'decision'
  id: string
}
```

**契约保护**：type 禁止 `file` / `markdown` / `workspace_path`——Context Contract 面向
领域对象（Domain Object → Projection），不面向存储结构；Agent Context 不绕过 IR /
Artifact 契约层退回 markdown 驱动。

## 5. AgentContextBundle（冻结级）

Engine 为一次 Task 执行生成的可审计上下文声明：

```ts
interface AgentContextBundle {
  references: ResolvedContextReference[]
  generatedAt: string
}

interface ResolvedContextReference {
  type: 'job' | 'company' | 'resume' | 'decision'
  id: string
  label?: string                        // 展示名（如「Company-B·流体机械工程师」）
  snapshot?: {
    kind: 'version' | 'timestamp'       // resume=version / job/company/decision=timestamp
    value: string
  }
  provenance: {
    kind: string                        // 来源通道（如 'jd-analysis' / 'resume-artifact'）
    label: string                       // 展示标签（如「岗位分析」）
  }
}
```

- **Bundle = Reference Manifest，不是 Knowledge Dump**——不包含业务内容；Context
  Assembler 不是数据复制层
- **空引用 = 合法 Bundle**（`references: []`）——统一生命周期，无「有/无 Context」双路径
- Bundle 是 Execution Context：`create → agent.start → stream events → session complete →
  discard`——**不进入** Decision/Artifact/Application（非业务状态）
- 双消费方同一数据源：Agent（prompt 注入）+ UI（「本次分析依据」投影）消费同一 Bundle

## 6. Resolution Rules（冻结级，验收点）

```
AgentTaskRequest → Reference Validation → Projection Resolution → Bundle Generation → Agent Execution
```

1. **Validation**：type 合法（§4）+ **存在性 Engine 侧重验**（不能信任 UI 声明的 id：
   job 可能删除、resume 版本过期、decision 失效）+ contextPolicy required 检查
2. **失败语义**：`TaskRejected { reason: 'INVALID_CONTEXT_REFERENCE', refs: [{type, id,
   error}] }`——**不进入 Agent Runtime，不创建 Session**（Rejected Task ≠ Failed Session；
   Session 创建时机 = Validation 通过后）
3. **Resolution**：直接消费既有 Registry（job-watcher / company-watcher / resume-watcher /
   decision-registry）——**不引入 ContextRepository 等新抽象**；产物 = **引用解析时生成
   snapshot 标识 + 有效性确认**（非 optimistic lock——Engine 不比较客户端版本；resume →
   版本号，job/company/decision → updatedAt 时间戳），不复制内容

## 7. Output Boundary（冻结级）

允许：`decision | artifact | none`（none = 纯问答，不产生业务事实）。

禁止：`application`（ADR-019：用户行动事实，Agent 无创建权）、`company_assessment`
（ADR-018：纯 Projection，无写入口）。

Agent 层接入 Producer Ownership 链：`Agent（提议/生成）→ Engine（校验/登记）→ Canonical
State`。

## 8. Agent Runtime Consumption（冻结级）

Agent 收到：`taskType + ContextBundle`（SYSTEM 段前置注入）——**不是 workspace dump**。

v0.1 最小形态：

```
SYSTEM

你正在执行 task: {taskType}

当前已确认上下文：
1. 岗位：{label}（id: {id}，更新于 {snapshot}，来源：{provenance.label}）
...

规则：
- 上述引用为本次任务明确依据
- 不得假设不存在的上下文
- 如需其他信息，可经补充通道（workspace 自读）
```

## 9. UI Projection（冻结级）

UI 展示「本次分析依据」= Bundle 投影（引用级 + 版本戳），**UI 不重新查询来源**
（不成为 Context Owner）：

```
本次分析依据
✓ 岗位：Company-B 流体机械工程师（更新于 08-02，来源：岗位分析）
✓ 简历：Resume v3
```

## 10. Acceptance Checklist（实现完成必须满足）

- [ ] UI 不直接拼装 Agent context（只声明 contextRefs）
- [ ] Engine 是唯一 Assembly Owner
- [ ] Bundle 可同时供 Agent / UI 使用（同一数据源）
- [ ] invalid reference → TaskRejected，**不创建 Session**
- [ ] contextPolicy required 缺失 → TaskRejected
- [ ] Self-read 不进入 Bundle，不展示为「本次依据」
- [ ] outputTarget 不越过 Output Boundary（禁 application / company_assessment）
- [ ] agentContextFiles mock 移除（真实化依赖 Assembly，不产生双套）
