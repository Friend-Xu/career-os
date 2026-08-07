# JD Analysis Artifact Contract v2.0（已冻结，2026-08-07）

> 冻结版（v0.2 评审通过：三层模型/四态匹配/Derived Data Separation/Category 列）。
> 背景：v1 岗位智能段被当完整 JD 分析使用，暴露三类失真——学历等硬门槛无表达、
> 岗位理解（JD 结构视角）缺失、培养型岗位（管培生）被强压成能力词。
> 触发条件已激活：用户在 JD Workspace 需要查看学历/专业/年限匹配结果。
> 本契约是 Career OS「外部非结构化世界接入层」的第一个实例——后续 Company
> Research / Skill Extraction / Resume Evaluation / Interview Analysis 复用同一范式
> （External Text → Agent Extract(source+confidence) → Artifact → Engine Reasoning → Projection → UI）。

---

## 1. 核心定位（第一原则，冻结级）

**JD Analysis 不是「技能需求抽取器」，而是对任意形态 JD 的语义提取与归一化——把
「这个岗位是什么、要求什么、如何证明」表达为结构化 Artifact。**

输入边界：市场 JD 无标准模板（工程岗位/管培培养型/创业公司/传统招聘文本/简略几行），
模型按语义提取而非模板匹配。

## 2. 六条设计约束（冻结级，任何字段设计不得违反）

1. **全字段可选**——JD 没写的维度不产出字段，禁止占位符伪装「已评估」
2. **四态匹配语义**——`满足 / 不满足 / 未声明 / 待确认`；JD 未提及 ≠ 不满足；
   JD 写了模糊值（如「相关专业」）≠ Engine 可猜 → 待确认（走 User Confirmation）
3. **来源锚点强制**——每个提取字段带 JD 原文依据；Claim Strength ≤ Evidence Strength
4. **能力词分级**——hard（硬技能，进匹配计算）/ soft（软能力，进证据引导）/
   preference（意愿，进岗位理解叙述）分层，不混入单一 capabilities 池
5. **质量降级诚实**——JD 信息不足 → 各层诚实显示受限/缺失，不硬凑
6. **Derived Data Separation**——推导数据不得覆盖原始事实：Artifact 保存原文枚举
   （如 education = [本科, 硕士, 博士]），「最低学历 = 本科」是派生结论，需显式规则
   或 Engine 匹配时派生，不得由 Agent 提取时静默压缩。「本科/硕士/博士均可」≠「最低本科」

## 3. 三层模型

```
JD Analysis Artifact
│
├── Context Model       岗位是什么（工作方式/发展路径/岗位语境）
│
├── Requirement Model   岗位要求什么
│     ├── Constraint    任职门槛（学历/专业/经验/其他约束）
│     └── Capability    能力要求（hard/soft/preference 分级）
│
└── Evidence Model      如何证明（现有 Evidence Pattern + Questions 拆出独立层）
```

- Constraint 与 Capability 都是 Requirement 的类别——未来扩展（证书/语言/驾照/出差）
  加 Constraint 子类即可，不增加顶层模型
- Evidence Model 从 Capability 内部拆出：能力（SolidWorks）与证据（设计过什么结构）
  分离；门槛也有证据（档案教育经历 vs 学历要求）——逻辑统一
- 保留 v1 Capability Model + Evidence Pattern + Questions（服务证据沉淀，不重写）

## 4. Artifact Schema（Agent 输出，Markdown 段落写回 jobs/{id}.md，`artifact_version: 2`）

### `## 岗位理解`（Context Model）

结构化条目 + 来源锚点。回答「工作环境是什么」，禁止 AI 评价性语言（营销语/愿景总结）。

```md
## 岗位理解

| 维度 | 值 | 来源 |
|------|-----|------|
| work_mode | 轮岗学习；跨部门项目推进；定岗落地 | 岗位定位 |
| career_path | 入职 → 6 个月轮岗 → 按表现定岗（研发/生产/质量/市场） | 培养机制 |
| industry | 医疗器械（神经介入） | 企业简介 |
```

- 字段集：`work_mode`（工作方式）/ `career_path`（发展路径）/ `industry`（轻量行业，
  仅当公司档案无此信息时；公司档案已有 → 引用不复制，Composition Rule）
- business_domain（业务构成）归 Company Artifact，不在此层
- JD 信息不足 → 对应维度省略（不硬凑）

### `## 岗位门槛`（Constraint Model）

```md
## 岗位门槛

| 维度 | 值 | 来源 | 置信度 |
|------|-----|------|--------|
| education | 本科;硕士;博士（应届） | 任职要求 1 | high |
| major | 生物医学工程;机械;材料;临床医学 | 任职要求 2 | high |
| experience | fresh | 任职要求 1 | high |
```

- **值 = 原文枚举**（Derived Data Separation：保存 JD 原文的取值集合，不压缩成
  「最低本科」）；`required` 语义（硬性 vs 优先）由 Engine 在匹配时派生
- 维度值域：education ∈ 高中/大专/本科/硕士/博士；experience ∈ fresh/0-1年/1-3年/
  3-5年/5年+（归一化枚举）
- confidence：high（原文直述）/ medium（原文暗示）/ 缺失（不产出该行）
- 模糊值（如「相关专业」「优先考虑」）→ 该行标记 `fuzzy`，匹配时派生「待确认」
- JD 未写 → 无该维度行（「未声明」由消费端派生）

### `## 岗位智能`（Capability + Evidence Model）

v1 表格保留，**新增 Category 列**（结构化列，非文本前缀）：

```md
| Responsibility | Priority | Category | Capabilities | Evidence Patterns | Questions |
| 多部门轮岗学习 | must | soft | 跨部门协作;学习能力 | scope;method | … |
| 数据整理与文案输出 | must | hard | 办公软件;数据整理;文案 | method;validation | … |
| 按方向定岗落地 | nice | hard | 医疗器械研发流程;工艺优化 | method;impact | … |
```

- Category 列值：hard / soft / preference——解析器按列结构化读取，禁止文本前缀
- hard 进匹配计算；soft/preference 仅证据引导与岗位理解叙述

## 5. 匹配四态（Engine 派生，冻结级）

| 状态 | 含义 | 来源 |
|------|------|------|
| MATCHED | 明确匹配 | 档案值 ∈ 门槛值集（Engine 比较） |
| NOT_MATCHED | 明确冲突 | 档案值 ∉ 门槛值集（Engine 比较） |
| NOT_DECLARED | JD 无该维度要求 | 门槛无该维度行 |
| NEEDS_CONFIRMATION | 存在模糊条件（fuzzy/「相关专业」）或档案缺件 | 派生 → 走 User Confirmation |

**档案缺失状态规则（写死，防止实现混乱）：**

| 情况 | 状态 |
|------|------|
| JD 无要求 | NOT_DECLARED |
| JD 有要求 + Person 无信息 | NEEDS_CONFIRMATION（不是 NOT_MATCHED——不知道，不是冲突） |
| JD 有要求 + Person 有信息，匹配 | MATCHED |
| JD 有要求 + Person 有信息，冲突 | NOT_MATCHED |

**Capability Matching Boundary（写死）：**

- Match Engine 默认**只消费 Category=hard**——soft/preference 不直接进入技能匹配
  （「跨部门协作 △ 有基础」这类由 soft 词派生的匹配结果禁止出现）
- soft/preference 必须经过 Evidence Projection（证据沉淀引导），不产生匹配结论

**Engine 不猜**：模糊值不强行判定；档案侧缺件 → 该维度「待确认」，不得用 UI 兜底。
匹配计算 = 档案登记事实 vs 门槛分析产物，两侧都必须经过 Registration。

## 6. Producer Boundary（冻结级，长期原则）

```
JD 原文（用户事实）
  │
  │ Agent Extract（Content Producer：提取 + 来源锚点 + confidence，保存原文枚举）
  ▼
JD Analysis Artifact（jobs/{id}.md，artifact_version: 2）
  │
  │ Engine Validate（Registration Owner：格式/值域/枚举归一化）
  ▼
Requirement Match（Engine：档案登记事实 vs 门槛——四态派生）
  │
  ▼
Projection → UI Display（只渲染四态结果）
```

硬规则：
- **UI 不拥有语义判断权**——学历比较由 Engine 计算，UI 只渲染四态。禁止 UI 自行推断
  （与 Company Resolver 同一原则：UI 曾经「≈」公司名是错误，现在「>=」学历也是错误）
- **匹配输入两侧必须都是登记事实**：档案侧 = Person Aggregate（education 等），
  门槛侧 = 分析产物（Agent 提取 + 引擎校验）。任一缺失 → 未声明/待确认
- **NEEDS_CONFIRMATION 走 User Confirmation Flow**（candidates 模式：候选 → 用户确认 →
  登记），不做自动猜测

## 7. UI Consumer Matrix

| 工作区区块 | 数据源 | 未分析 | 已分析 |
|-----------|--------|--------|--------|
| 岗位理解 | Context Model | 不渲染 | 工作方式/发展路径表格 |
| 岗位门槛 | Constraint Model + Engine Match | 不渲染 | 表格卡片：维度 / 门槛值 / 你的情况 / 四态结果 |
| 能力匹配 | Capability Model（hard 词） | 空态引导 | ✓ 符合 / △ 有基础 / ✗ 不足 |
| 证据沉淀 | Evidence Model | 隐藏 | 「整理相关经历」入口 |

- 门槛展示用**表格卡片**（不是 chips）——门槛是条件不是技能标签
- 未分析统一由「尚未完成岗位分析」空态承接（P0 已落地）

## 8. 迁移与兼容

- `artifact_version: 2` 解析器版本分派（validator 按 version 分派是惯例）
- v1 存量岗位智能段（无 version）→ 按 v1 解析，无新段则对应区块不渲染（不伪造）
- 旧岗位重分析后补齐三段式 + version 2
- ProtocolVersion 演进（契约改动走版本分派，UI 无感知）

## 9. 已决与待决

**已决（v0.2 评审结论）：**
1. Context Model = 结构化条目 + 来源锚点（非自由文本）✅
2. 门槛 UI = 表格卡片（维度/门槛值/你的情况/结果）✅
3. Interview Focus 不进入 Artifact（阶段 4 对话已有，防膨胀）✅
4. 学历匹配档案侧唯一来源 = Person Aggregate education artifact
   （简历 PDF / UI 表单 / Resume 文件均不是直接来源）✅
5. Capability 结构化 = 表格 Category 列 + artifact_version 分派 ✅

**实现前前置检查：**
- Person Aggregate 当前 education 字段的登记现状（identity.md / snapshot 哪一层、缺件表达）

## 10. 验收标准（冻结后）

- 心玮医疗（培养型）：岗位理解展示工作方式/发展路径；门槛显示 学历 ✓（档案本科，四态
  正确）；能力匹配只算 [hard] 词（soft/preference 不进匹配）
- 博流控制（工程型，分析后）：门槛 学历 —（JD 未写学历）→ NOT_DECLARED 不误判
- 模糊门槛（「相关专业」）→ NEEDS_CONFIRMATION 走确认流，Engine 不猜
- 档案缺件（Person 无 education）+ JD 有学历要求 → NEEDS_CONFIRMATION（非 NOT_MATCHED）
- 简略 JD：三层诚实缺失
- **非标准反幻觉 JD**：输入「招聘机械工程师1名，负责设备设计维护」→ Context 缺失/
  Constraint 学历未声明/经验未声明/Capability hard=机械设备设计——**禁止出现**「本科要求/
  机械本科专业/3年以上经验」等原文没有的字段（核心定位：任意形态 JD，不是标准模板）
- UI 无任何自行推断逻辑（全部消费引擎投影）
