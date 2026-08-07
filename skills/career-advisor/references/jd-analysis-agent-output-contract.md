# JD Analysis Agent Output Contract v0.1（已冻结，2026-08-07）

> 冻结版（评审通过：写入通道 B / jobs 文件所有权归 Engine / RPC 载荷 JSON 非 Markdown /
> Validator 只答「是否符合契约」不做语义判断 / 恶意输出验收 Case）。
> 定位：**Agent → Artifact 的生产协议**（不是 Prompt 文档，不是分析教程）。补齐整条链的
> 生产端：Constraint Match Engine（837eba8）已有推理能力，但真实 JD 无生产者——岗位理解/
> 岗位门槛段目前不存在，Matcher 只有人工构造的测试输入。
> 前置契约：JD Analysis Artifact Contract v2.0（冻结）+ JD Constraint Match Engine Contract
> v0.2（冻结）+ Person Education Registration Contract v0.1（冻结——本契约的 JD 侧对齐物）。

---

## 1. Agent 输出责任边界（冻结级）

| Agent 负责 | Agent 不负责 |
|-----------|-------------|
| 提取（从 JD 原文） | 匹配个人（不读画像做判断） |
| 分类（Context/Constraint/Capability/Evidence 归类） | 判断是否适合投递 |
| 来源锚点（每字段带原文依据） | 推导最低学历（min_rank 归 Matcher Policy） |
| confidence 标注（high/medium） | 补充行业常识（JD 没写的不补） |

核心纪律（与 v1 同源，扩展至全部维度）：
- **Anti-Hallucination**：禁止从岗位名推断职责/门槛；JD 没写学历/经验 → 该维度不产出
- **Claim Strength ≤ Evidence Strength**：每个提取字段必须能从 JD 原文回溯
- **Agent ≠ Fact Owner**：输出是提取 Proposal，不是事实；事实性经引擎校验（Validator）后成立

## 2. 三段式输出协议（冻结级）

Agent 分析产物 = jobs/{id}.md 的三个段落（v1 只有岗位智能段，v2 补两段）：

```
## 岗位理解    Context（岗位是什么——工作方式/发展路径/轻量行业）
## 岗位门槛    Constraint（学历/专业/经验——原文枚举 + 来源 + 置信度）
## 岗位智能    Capability + Evidence（v1 保留 + Category 列分级）
```

### 岗位理解（Context Model，契约 v2 §4）

```md
## 岗位理解

| 维度 | 值 | 来源 |
|------|-----|------|
| work_mode | 轮岗学习；跨部门项目推进；定岗落地 | 岗位定位 |
| career_path | 入职 → 6 个月轮岗 → 按表现定岗（研发/生产/质量/市场） | 培养机制 |
| industry | 医疗器械（神经介入） | 企业简介 |
```

- 结构化条目 + 来源锚点；禁止 AI 评价性语言（营销语/愿景总结）
- business_domain 归 Company Artifact，不在此层（Composition Rule）

### 岗位门槛（Constraint Model，契约 v2 §4）

```md
## 岗位门槛

| 维度 | 值 | 来源 | 置信度 |
|------|-----|------|--------|
| education | 本科;硕士;博士 | 任职要求 1 | high |
| major | 生物医学工程;机械;材料 | 任职要求 2 | high |
| experience | fresh | 任职要求 1 | high |
```

- **值 = 原文枚举**（Derived Data Separation：不压缩成「最低本科」）
- 模糊值（「相关专业」「优先」）→ 原样入表 + medium 置信度，Engine 派生 NEEDS_CONFIRMATION
- JD 未写 → 无该维度行（消费端派生 NOT_DECLARED，禁止填「-」伪装「已评估」）

### 岗位智能（Capability + Evidence，v1 保留 + Category 列）

```md
| Responsibility | Priority | Category | Capabilities | Evidence Patterns | Questions |
| 多部门轮岗学习 | must | soft | 跨部门协作;学习能力 | scope;method | … |
| 数据整理与文案输出 | must | hard | 办公软件;数据整理;文案 | method;validation | … |
```

- Category 列：hard / soft / preference（hard 进匹配；soft/preference 仅证据引导）
- v1 存量解析兼容（无 Category 列按 v1 解析）

## 3. 写入通道（冻结级：方案 B——引擎 RPC 通道）

**冻结文字**：`jobs/{id}.md` Artifact 的写入所有权归 Engine。Agent 只能通过
`jd/analyze-result` Proposal Channel 提交候选分析结果，**禁止直接修改 Artifact 文件**。
（对称：Person 侧 `facts/education.md` 写入所有权归 Registration Engine。）

```
JD 原文
  ↓
Agent Extractor（Content Producer）
  ↓  JDAnalysisProposal（JSON，非 Markdown）
jd/analyze-result RPC
  ↓
JD Validator（只答「是否符合 Artifact Contract」，不做「是否正确」）
  ↓
Artifact Writer（Engine 写 jobs/{id}.md 三段式）
  ↓
Parser / Matcher
```

- **Markdown 是 Artifact 表现形式，不是内部通信格式**——RPC 载荷传 JSON，
  Markdown 由 Writer 投影生成（对齐 Person 侧：candidate proposal → facts/education.md，
  而不是 Agent 生成 education.md）
- 不选方案 A（Agent 直写）：① jobs/{id}.md 承担建档/分析/匹配输入多职责，Agent 直写 =
  Agent 成为文件所有者（Person 侧 identity.md 同款错误）② Validator 只能事后发现污染
  ③ Company Research 等后续 Extractor 复用同一通道

### RPC 载荷（JDAnalysisProposal，冻结级）

```ts
interface JDAnalysisProposal {
  jobId: string
  artifactVersion: 2
  context: {
    workMode?: ProposalField[]
    careerPath?: ProposalField[]
    industry?: ProposalField[]
  }
  constraints: {
    education?: ConstraintProposal
    major?: ConstraintProposal
    experience?: ConstraintProposal
  }
  capabilities: CapabilityProposal[]
  generatedAt: string
}

interface ProposalField {
  value: string
  source: string      // 原文锚点（JD 段落引用）
  confidence: 'high' | 'medium'
}

interface ConstraintProposal {
  values: string[]     // 原文枚举
  source: string
  confidence: 'high' | 'medium'
}

interface CapabilityProposal {
  responsibility: string
  priority: 'must' | 'nice'
  category: 'hard' | 'soft' | 'preference'
  capabilities: string[]
  evidencePatterns: string[]   // 固定词表（scope/method/validation/impact/adoption）
  questions: string[]
}
```

## 4. 非标准 JD 降级（反幻觉验收，冻结级）

| 输入形态 | 岗位理解 | 岗位门槛 | 岗位智能 |
|---------|---------|---------|---------|
| 结构化工程 JD（职责/要求分节） | work_mode/career_path 正常提取 | education/major 正常 | 正常 |
| 培养型 JD（管培生） | work_mode/career_path 提取（轮岗/定岗） | 正常 | Category 多为 soft/preference |
| 简略 JD（「招聘机械工程师1名，负责设备设计维护」） | 仅原文可回溯条目 | **无任何维度行**（禁止补写「本科要求/3年以上经验」） | 信息不足 → 不输出 |
| 模糊 JD（「机械相关专业」） | 正常 | major 行原样 + medium（Engine → NEEDS_CONFIRMATION） | 正常 |

## 5. 引擎校验对齐（Validator 端，冻结级）

| 段落 | Parser | 状态 |
|------|--------|------|
| 岗位门槛 education | `parseJdConstraint`（837eba8） | ✅ 已实现 |
| 岗位门槛 major/experience | schema 预留（`JDConstraintIR.major/experience`） | 待实现（v1 只校验格式与枚举） |
| 岗位理解 | 表格解析（work_mode/career_path/industry + 来源） | 待实现 |
| 岗位智能 | `parseJobIntelligence`（v1 已有）+ Category 列扩展 | 待实现（版本分派） |

**Validator 职责边界（冻结级）**：
- 只回答「**这个 Proposal 是否符合 Artifact Contract**」（结构/值域/枚举/锚点格式）
- **不做**「这个 Proposal 是否正确」——不判断岗位是什么、专业是否相关、能力是否合理
  （语义归 Agent 提取 + Benchmark）
- **Anti-Hallucination 硬校验**：education/major/experience 的 `source` 禁止为岗位名/
  标题类锚点（如「岗位名称」「岗位标题」）——学历门槛不能由岗位名支撑
  （Claim Strength ≤ Evidence Strength 进入系统层）
- 校验失败 → 段落级 degraded（可见降级，不静默丢弃——不变量 9）；恶意/无锚点 Proposal
  该字段不写入 Artifact

## 6. 验收标准（冻结后）

- 心玮医疗：完整三段式可解析 → Matcher 端到端 MATCHED（Golden Case 1）
- 简略 JD：三段无补写（反幻觉）
- 「相关专业」→ medium + 原样入表 → NEEDS_CONFIRMATION
- 方案 B 落地后：Agent 无法直接改 jobs 文件（权限通道校验）
- **恶意/错误 Agent 输出**：Proposal 的 education source=「岗位名称」→ Validator 拒绝该
  字段，Artifact 不写入 education（Claim Strength ≤ Evidence Strength 系统层验证）

## 7. 实现顺序（冻结后，先 Schema/Validator 后 Prompt——防隐式契约）

```
3.1 JDAnalysisProposal Schema
3.2 jd/analyze-result RPC
3.3 Validator（结构/值域/锚点 + Anti-Hallucination 硬校验）
3.4 Artifact Writer（Proposal → jobs/{id}.md 三段式 Markdown 投影）
3.5 Parser 版本接入（岗位理解段 + Category 列 + major/experience）
3.6 End-to-End Golden Case（Proposal → RPC → Validator → Writer → Parser → Matcher）
```

- **不先改 Agent Prompt**——Agent 输出格式由 Schema/Validator 定义后 Prompt 才对齐

## 7. 范围边界

- 本契约 = 生产协议（Agent 输出格式 + 校验 + 通道），**不含**分析质量教程（jd-analysis 各
  reference 已有）
- major/experience 匹配规则**不在此契约**（Constraint Match Contract 暂缓项）
- 面试重点（Interview Focus）不进 Artifact（v2 已决）

## 9. Freeze Review（2026-08-07，契约冻结验证——只读评审 + 真实 JD 试构，无代码变更）

**三风险检查：**

| 风险 | 结论 |
|------|------|
| 分析结果 vs 推理过程混入 | ✅ 通过——Proposal 只有提取结果（value/source/confidence），无 reasoning 字段；推理归 Agent 内部 |
| 未来扩展空间 | ✅ 有——constraints major/experience 已预留；capabilities category 枚举扩展向后兼容（旧字段不变）；evidencePatterns 词表扩展走版本分派 |
| Validator 权限边界 | ✅ 清晰——只校验格式/值域/锚点/黑名单；「硕士优先」的值域合法性通过（归一化语义在 Parser）；不做「AI 评审器」 |

**真实 JD 试构（心玮医疗·培养型 + 博流控制·工程型）：**

| 发现 | 结论 |
|------|------|
| 「本科;硕士;博士（应届）」括号表述 → Parser 值域外 → 整维度 NEEDS_CONFIRMATION（误伤：学历实际明确） | **提取端拆分职责**：education 枚举 vs experience 状态（「应届」→ experience=fresh）分离——Schema 支持，写进 Prompt 约束 |
| 「本科以上学历优先考虑」（高频表述）→ preferred → 无 hard 维度 → NOT_DECLARED | **行为确认**：「优先考虑」= 偏好非硬门槛，v1 无偏好模型 → 诚实 NOT_DECLARED（Prompt 约束：优先表述保留原文 + medium 置信度） |
| **ConstraintProposal 缺 fuzzy 字段**（「相关专业」无法显式标记） | **Schema 补丁建议**：`ConstraintProposal` 加 `fuzzy?: boolean`——major 的「相关专业」→ fuzzy → Matcher NEEDS_CONFIRMATION（契约 v0.2 §4 Case 4 对齐） |

**冻结验证结论**：Proposal v0.1 基本可承载真实 JD（2/2 试构通过，含培养型/工程型两类）；补 fuzzy 字段后进入 Prompt 迁移。

**matchMode 补丁（2026-08-07，已实现）**：`ConstraintProposal` 加 `matchMode?: 'exact' | 'related' | 'preferred' | 'inferred'`（缺省 exact）——语义状态标记，非匹配能力：
- preferred（「优先考虑」）→ Parser 不产出 hard 维度（Matcher 视 NOT_DECLARED）
- related（「相关专业」）/ inferred（Agent 推断）→ NEEDS_CONFIRMATION（归一化不猜）
- exact → 现有归一化逻辑；4 列旧格式（无模式列）兼容 = exact
- Validator 只校验 matchMode 值域；Writer 投影「模式」列（5 列表格）；Matcher 不改（normalizationStatus 驱动四态）

## 10. 相关

- JD Analysis Artifact Contract v2.0（冻结）——Artifact Schema 源
- JD Constraint Match Engine Contract v0.2（冻结）——消费端
- Person Education Registration Contract v0.1（冻结）——本契约的 JD 侧对齐物（Proposal → Validation → Artifact）
- 记忆：[[jd-analysis-v2-contract-freeze]]
