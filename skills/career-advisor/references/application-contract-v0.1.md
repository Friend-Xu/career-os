# Application Contract v0.1（投递行动记录）

Status:
FROZEN（2026-08-08——DRAFT 后用户评审通过（含实测迁移盘点确认），进入实现阶段）

**冻结评审确认（用户）**：① 语义边界为最高优先级约束（Application 三禁止——
matchScore / decisionReason / gapAnalysis，防 Decision+Application+Resume Context
三处重复表达职业判断）② COMMUNICATING 合并回复正确（「收到回复」是事件不是稳定
状态，未来 ApplicationEvent[] 扩展）③ PREPARING/READY 区分为 Resume Rewrite Bridge
留接口 ④ displayFallback 只允许 title/company，禁止 constraints/matchScore/analysis
⑤ ApplicationEvent 只留扩展点不提前设计 ⑥ Engine 可做 id 生成/validation/projection/
migration，但不能 create Application（用户事件）⑦ 迁移删除的是错误关系（JD 存在 =
Application 存在），不是用户数据。

**Reference Invariant（冻结评审补充）**：Application 主身份来自 jobId；displayFallback
仅用于历史展示，**不构成 Job 数据副本**。正常形态 `Application { jobId }`，禁止
title/company 作为主字段（对齐 Career Decision Loop「外部实体只引用，不复制」）。

Context:
ADR-019 触发条件成立（用户扫描投递模块——「投递的岗位与JD脱轨」暴露 Application
Tracking 是 JD 列表的附属看板而非领域对象），进入 Application Tracking Domain v0.1。
核心语义：**Application 是用户行动事实**——回答「我投了吗？进展如何？」，不拥有
职业判断（不回答「为什么投/值不值得投」，那些属 Decision）。

**冻结前提（ADR-019 Decision 1-10）**：① 触发条件 = 用户产生职业行动事件，不是
「需要一个投递看板」② Application 创建 = 用户显式「开始投递流程」，废弃 JD 建档
自动占位 ③ 三实体职责分离（Job=事实 / Decision=判断 / Application=行动）④ 8 态
生命周期（PREPARING 起）⑤ relationshipStatus ≠ communicationStatus ⑥ Decision
intent 不直接创建 Application ⑦ Job 软删除 + displayFallback ⑧ Engine Application
Registry 为唯一未来源（P0-P4 迁移）⑨ followUp 不冻结业务规则 ⑩ Application 不拥有
职业判断。

---

## 1. 语义边界（核心不变量，继承 ADR-019 Decision 10）

Application **可以**知道：

```
我投了        → 存在一条 Application
什么时候投    → submittedAt
当前状态      → status
有没有回复    → communication 事件
```

Application **禁止**包含（这些属于 Decision）：

```
是否值得投    → Decision.userIntent
匹配度        → Decision gapRows / Job Analysis
为什么投      → Decision.reason
差距/优势     → Decision gapRows
```

**禁止模型**：`Application { matchScore, reason, gaps }`——这是第二套决策系统，
半年后必然与 Decision 分裂（改一个不动另一个，无法回答「为什么投这个岗位」）。
Application 判断职业问题 = 越权；需要判断时沿 jobId → decisionId 回溯。

## 2. 生命周期（8 态，废弃旧 7 态）

| 状态 | 含义 | 进入方式 |
|------|------|---------|
| PREPARING | 进入投递准备流程（不是「草稿」——Decision/Agent/Resume draft 语义混淆源） | 用户「开始投递流程」（显式事件） |
| READY | 准备就绪，待提交 | 用户推进 |
| SUBMITTED | 用户确认投出（**唯一真实投出事件**） | 用户「我已提交」→ 登记 submittedAt |
| COMMUNICATING | 公司主动联系 / 用户建立沟通 | 用户推进 |
| INTERVIEWING | 进入面试流程 | 用户推进 |
| OFFERED | Offer | 用户推进 |
| REJECTED | 结束 | 用户推进 |
| WITHDRAWN | 主动停止 | 用户推进 |

**状态迁移规则**：
- 全部状态由**用户推进**（UI 操作），Agent 不得自动推进投递状态
- 废弃映射：已评估（删除——建档占位语义消失）｜ 已投递 → SUBMITTED ｜ 已联系 →
  COMMUNICATING ｜ 已回复（并入 COMMUNICATING——回复是沟通事件不是独立状态）｜
  面试中 → INTERVIEWING ｜ 已录取 → OFFERED ｜ 已拒绝 → REJECTED

## 3. Application Schema（P0 冻结）

```ts
type ApplicationStatus =
  | 'PREPARING'     // 进入投递准备流程
  | 'READY'         // 准备就绪，待提交
  | 'SUBMITTED'     // 已投递（用户确认投出）
  | 'COMMUNICATING' // 已联系/沟通中
  | 'INTERVIEWING'  // 面试中
  | 'OFFERED'       // 已录取
  | 'REJECTED'      // 已拒绝
  | 'WITHDRAWN'     // 撤回

interface Application {
  id: string                    // Engine Registration（引擎派生，Agent/UI 不写）
  personId: string              // 归属人（按人过滤，同 Decision/Resume 模式）
  jobId: string                 // Job Reference（必填——Application 是岗位的行动记录）
  decisionId?: string           // Decision Reference（可选——从决策发起时挂）
  status: ApplicationStatus
  createdAt: string             // 用户「开始投递流程」事件时间（Engine 登记）
  submittedAt?: string          // SUBMITTED 事件时间（用户确认投出时登记）
  displayFallback?: {           // 投出时登记的展示快照——仅 Job 删除后展示用
    company: string             // （ADR-019 Decision 7：不是 Job 信息复制，
    position: string            //   不参与任何判断）
  }
  notes?: string                // 用户备注（自由文本）
  events: ApplicationEvent[]    // 事实事件流（§4——v0.1 预留，未来实现）
}

/** 跟进投影（§5——派生，不存事实） */
type FollowUpState = 'NEEDS_ATTENTION' | 'WAITING' | 'NONE'
```

**displayFallback 登记时机**：用户确认投出（SUBMITTED）时，从当时 job.company /
job.title 登记快照。PREPARING 阶段不登记（Job 存活，消费端解析活数据）。

## 4. ApplicationEvent（事实流——v0.1 预留，不实现）

未来事实来源（每个状态推进都产生事件，followUp 从事件派生）：

```ts
interface ApplicationEvent {
  type: 'created' | 'submitted' | 'communication' | 'interview'
      | 'offered' | 'rejected' | 'withdrawn'
  at: string          // ISO 时间戳
  note?: string       // 事件备注（如沟通内容）
}
```

v0.1 不建事件存储——`events` 字段存在于 Schema（契约冻结），实现（P1-P3）只登记
必要时间戳（createdAt/submittedAt）。**未来**：沟通记录（「HR 周三电话说…」）进入
事件流后，FollowUpState 才有真实数据源。

## 5. FollowUpState（投影，非事实）

```
FollowUpState = NEEDS_ATTENTION / WAITING / NONE
```

- 派生规则**不冻结**（ADR-019 Decision 9：校招/社招/猎头/内推周期不同，「7 天无回复」
  不能写死）——v0.1 不计算，全部 NONE，规则未来按真实使用调整
- 是 projection（对齐 Company Assessment 纯 Projection 原则），不落盘、不进事实资产
- 废弃：mock 手填的 urgency（urgent/overdue/waiting/cooled）+ followupDue

## 6. Reference 规则（Job / Decision）

- **Job 是岗位唯一事实源**：Application 不持有岗位信息；title/company/location/salary
  等消费端一律从 jobId 解析活数据（对齐 ADR-019 A1——不再拷贝 position/company 快照）
- 唯一例外 = `displayFallback`（§3，投出时登记，仅 Job 删除后展示）
- **Decision Reference**：`decisionId` 可选——从决策发起投递时挂；无 decisionId 的
  Application（如直接对 JD 投递）不强制，但 UI 显示「未挂决策」而非编造关联
- 禁止：Application 直接引用 Job 的 status 决定显示（ADR-019 Decision 7）

## 7. Producer Boundary（谁创建 / 谁推进 / 谁禁止）

| 操作 | Owner | 规则 |
|------|-------|------|
| 创建 Application | **User**（显式「开始投递流程」事件） | `CreateApplicationRequest { jobId, decisionId?, createdBy: 'user' }` |
| id / createdAt / submittedAt | **Engine Registration** | 引擎派生，Agent/UI 不写 |
| status 推进 | **User**（UI 操作） | 每个状态 = 用户确认（「我已提交」→ SUBMITTED） |
| Agent | **禁止** | 不得自动创建（JD 建档/分析完成/补账不生成 Application）、不得自动推进状态、不得写 id/时间戳 |

**废弃的自动路径**（P3 拆除）：createJob 建档自动占位「已评估」｜ pullJobs 补账 ｜
addApplication 手动录入（无 UI 入口的死代码）｜ 两处「加入投递」假入口（agent-page
决策卡仅跳页、infopool 图谱节点 toast「阶段 3 接入」）。

## 8. 存储与迁移（Engine Application Registry，P0-P4）

### 唯一未来源 = Engine Application Registry

对齐 companies/（档案 + watcher + RPC）模式：

```
P0  冻结 schema（本契约 + ADR-019）              ← 当前
P1  engine storage：Application Registry + watcher（applications/ 目录）
P2  RPC：applications/list · applications/create · applications/update-status
    · applications/delete（delete 含 Job 软删除联动检查）
P3  UI：看板/工作台消费引擎数据；拆除 §7 自动路径
P4  旧数据迁移（见下）
```

### 迁移策略

**实测（2026-08-08，浏览器 localStorage 盘点）**：11 条记录 = 2 条真实占位（Company-B/Company-A
JD 建档自动生成，status 已评估，从未推进）+ 9 条 mock 演示（无 jobId）。**无任何真实
投递记录需要迁移**——用户从未推进过状态，唯一真实数据源就是自动占位。

| 旧来源 | 处理 |
|--------|------|
| mock-data.ts 9 条（无 jobId） | **删除**（演示数据，不迁移进真实资产） |
| localStorage 已评估占位记录（2 条真实 + 1 条 mock） | **删除**（legacy artifact，不迁移——ADR-019 Decision 2：建档占位本就不该存在；JD 还活着，投递入口将来从 Decision 走） |
| 已推进记录（已投递~已拒绝） | 迁移表保留（§2 映射），**当前无真实样本**——将来若有（用户真实使用后），按映射迁移 |
| engine applications_projection 死表 | **删除**（建表无写入无消费的遗留） |
| company.contacted | 保留字段（v0.1 不动——relationshipStatus 迁移是公司模块的事，触发未到） |

**迁移边界**：P4 只做状态映射 + 引用保留，不补 jobId（无法回溯的旧记录诚实显示
legacy 而非伪造关联——对齐 Company Reference Closure「错误关联比无关联危险」）。

## 9. UI Projection（看板 = 生命周期的投影）

- 看板 8 列 = §2 状态（PREPARING 起），废弃「已评估」列——建档占位不再产生记录
- 卡片：岗位信息从 jobId 解析活数据；Job 删除 → displayFallback 展示「曾投递：公司 -
  岗位」+「岗位已失效」标注
- FollowUpState 投影位：NEEDS_ATTENTION 高亮（v0.1 全 NONE，规则未启用）
- 与 Decision 联动：有 decisionId 的卡片可回跳 Decision；「未挂决策」诚实标注
- **不新增「已联系」列语义**：看板 COMMUNICATING 列 ≠ 公司页 relationshipStatus
  （ADR-019 Decision 5——不同步）

## 10. v1 边界（不做什么）

- 不做 Interview Loop（InterviewEvent[]——Application 存在后才有事件源）
- 不做 Offer Negotiation（OfferArtifact）
- 不做 Recruiter CRM（Contact Entity）
- 不实现 ApplicationEvent 事件流（§4 仅契约预留）
- 不实现 FollowUpState 计算规则（§5 全部 NONE）
- 不做 Company.relationshipStatus 迁移（公司模块触发未到）
- Application 不回答职业判断（§1 核心不变量——沿 jobId/decisionId 回溯）

---

Related:
- ADR-019（Application Tracking Domain Boundary——语义上游；本契约是其实现起点）
- ADR-017（Career Decision Loop v1——Decision 是 Application 上游，intent 语义）
- ADR-016（JD Analysis Data Pipeline v1——Job 实体上游）
- ADR-018（Company Score Semantic Boundary——同路径参照：契约先行 → 用户校准 → 冻结）
- 记忆：[[career-decision-loop-v1]]、[[company-module-lifecycle-todos]]
