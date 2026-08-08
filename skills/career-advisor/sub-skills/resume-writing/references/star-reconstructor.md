# STAR 重构引擎（Claim Producer）

将 frontier 追问收集的碎片素材拼接为**候选表达（ClaimProposal Candidate）**——不是直接产出简历文本。
它是"经历重构 Agent"（素材 → 候选表达），不是"资产登记 Agent"（登记由 Engine + 用户确认完成）。
引用 `verb-dictionary.md` 做动词升级。

**方向内容标准加载链路（v2，2026-08-03）**：如果可识别用户的目标方向（通过 profile.md 的目标方向字段或用户口述），在 Step 3 开始前按以下链路加载标准：

```
if 方向 == 机械工程（已迁移至 Expression Family 结构）:
  1. 读 references/direction-standards/机械工程.md（路由索引）
  2. 按岗位/子方向定位语言族 → 读 standards/mechanical/{design|automation|simulation|manufacturing}.md
     （路径相对 sub-skills/resume-writing/ 根目录，如 skills/career-advisor/sub-skills/resume-writing/standards/mechanical/design.md）
  3. 输出时标注来源：Resume Standard Source: Career Expression Standard v1（standards/mechanical/xxx.md）
else:
  读 references/direction-standards/{方向名}.md（旧链路，Data Layer，待 Phase 2 迁移）
  输出时标注来源：Resume Standard Source: Legacy Direction Standard（direction-standards/{方向名}.md）
```

标准文件提供 HR 高频关键词、量化指标锚点、行内强力动词、项目分组惯例和 ATS 关键词清单。生成候选表达时优先对齐这些标准。

---

## 一、输入：素材池

frontier 追问结束后，每段工作经历累积了一个素材池：

```
素材池结构（每段经历一个）：
  {
    company: "苏州某汽车零部件有限公司",
    role: "高级机械设计工程师",
    start: "2022.03",
    end: "至今",

    // 以下来自用户多轮回答：
    duties: ["产线异常处理", "夹具设计", "新项目结构评审"],
    achievements: ["良率从92%提到96%", "写了SOP被纳入培训"],
    numbers: ["做了大概3个月", "减少了废品损失"],
    exceptions: ["同事请假时顶过调试工作"],
    management: [],
    positioning: ["对夹具设计有直觉，能快速定位问题"],
    connections: ["从上一份工作延续了公差分析的经验"]
  }
```

## 二、候选表达生成流程

### Step 1：提取 STAR 骨架

从素材池中提取每一条成就/职责，分配到 STAR 四要素：

```
duties → T（Task，任务）
achievements + numbers → R（Result，结果）
exceptions → S（Situation，情境）
用户对具体过程的描述 → A（Action，行动）
```

### Step 2：合并为候选表达

**格式定位**：Claim statement 是**事实表达**，不保证 STAR 格式——STAR（动作+方法+量化结果）
是 Sentence Generator 的表达策略，不是 Claim 的存储格式。候选表达优先做到事实完整
（动词 + 对象 + 可验证结果），句式随场景由 sentence-generator 调整。

```
优先规则：
  - 同一件事的 S+T+A+R 合并为一条候选（事实单元完整）
  - 独立的事实（如"写了SOP"和"良率提升"如果不同源）→ 分为两条
  - 一条候选 1-2 行，不超过 80 字
  - 每段经历 3-5 条候选，最重要的排前面
```

### Step 3：动词升级

逐条扫描候选，将弱动词替换为 `verb-dictionary.md` 中的强动词：

```
原文："负责产线异常处理，把良率从92%提到96%"

→ 检测到弱动词：负责 → 查询统筹类 → 场景：独立解决问题 → "主导"
→ 检测到弱动词：提到 → 查询改善类 → 场景：提升数据指标 → "提升"

→ 升级后："主导产线异常诊断与改进，将良率从92%提升至96%"
```

### Step 4：量化萃取

扫描素材池和候选，优先提取可量化的表述：

```
"做了大概3个月"
  → 加上动词和对象 → "3个月内完成夹具改进从诊断到落地全流程"

"减少了废品损失"
  → 追问要到了具体数字 → "日均减少废品损失约500元"

"良率从92%到96%"
  → 直接可用 → "良率从92%提升至96%（+4个百分点）"
```

如果素材池中确实没有数字 → 用半定量描述（每份简历此类表述 **不超过 3 处**）。

### Step 5：证据锚定（evidenceRefs——Claim Strength ≤ Evidence Strength）

每条候选表达必须锚定证据。**只引用用户已确认进入 Evidence 资产的条目**
（evidence id，如 `evidence_20260806_00001`——从 Evidence 资产列表选择，不凭空写）。

```
锚定规则：
  - 候选表达中的每个事实要素（公司/项目/数字/技术名词）必须能在 evidenceRefs 中找到
  - 素材池中用户口述但尚未登记为 Evidence 的内容 → 不产出候选，先提示登记
  - 无法锚定的数字/能力/影响词 → 不得写入候选（否则引擎锚点校验会拒绝）
```

### Step 6：写 claim-proposals/{id}.md

每条候选表达写一个文件到 `workspace/career-advisor/claim-proposals/{id}.md`
（**id 由 Agent 起语义名或序号，引擎扫描时登记**）。格式与引擎
parseClaimProposalMarkdown 兼容（claim-registration-contract v0.1）：

```md
---
created_at: 2026-08-08
source: star_reconstructor
status: pending
---
# 主导产线关键产品良率改善，将良率从92%提升至96%

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | 主导产线关键产品良率改善，经根因分析定位夹具设计缺陷，独立完成结构改进方案，3个月内将良率从92%提升至96% |
| source | star_reconstructor |
| section | experience |
| explanation | 依据产线夹具设计项目的良率数据（92%→96%）与根因分析过程 |

## 证据来源

- evidence_20260806_00001
```

## 三、输出边界（禁止）

star-reconstructor **不输出**：

- ❌ 完整简历 Experience Section（段落/顺序/公司时间线——归组装层）
- ❌ 针对岗位的完整简历（岗位适配走 claims/select + sentence-generator）
- ❌ 未登记事实的表达（素材池口述未成为 Evidence → 先登记）
- ❌ 无锚数字/能力词（引擎锚点校验拒绝——Claim Strength ≤ Evidence Strength）

它产出的是**候选表达**，用户确认（素材空间「确认加入表达资产」）后才成为表达资产。

## 四、质量检查

完成拼接后逐条检查：

| # | 检查项 | 通过标准 |
|---|--------|---------|
| 1 | 可追溯 | 每条候选能对应到 evidenceRefs（Evidence 资产条目） |
| 2 | 无编造 | 没有写入用户未提及的公司名/项目名/数字/技术名词 |
| 3 | 动词强度 | "负责/参与/做了"不超过 1 处（每段经历） |
| 4 | 量化充分 | 全简历至少 2 处可量化表述 |
| 5 | 长度 | 每条候选不超过 80 字 |
| 6 | 锚点完整 | 候选中的数字/能力词在 evidenceRefs 文本中可找到（引擎锚点校验的输入准备） |
| 7 | 关键词密度 | 技能区覆盖方向标准中 HR 高频关键词的 ≥60%（加载了方向标准时检查） |
| 8 | 格式合法 | claim-proposals md 可被引擎解析（frontmatter + 分析摘要 + 证据来源段） |

## 五、示例

### 输入素材池

```
用户描述（初次 + 2轮追问）：
  "我在苏州一家汽车零部件公司做机械设计，五年了。
   主要做产线夹具设计和异常处理。之前良率92%老是上不去，
   我发现是夹具定位有问题，重新设计了定位方式，三个月把良率提到96%。
   这个过程中跟工艺部门配合比较多。
   后来我写了份异常处理SOP，现在新人都拿这个培训。"
```

### 输出候选表达（claim-proposals/）

```
claim-proposals/2026-08-08-夹具良率改善.md

---
created_at: 2026-08-08
source: star_reconstructor
status: pending
---
# 主导产线关键产品良率改善，将良率从92%提升至96%

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | 主导产线关键产品良率改善，经根因分析定位夹具设计缺陷，独立完成结构改进方案，3个月内将良率从92%提升至96% |
| source | star_reconstructor |
| section | experience |
| explanation | 良率数据（92%→96%）、根因定位过程与改进方案均来自夹具设计项目素材 |

## 证据来源

- evidence_20260806_00001
```

```
claim-proposals/2026-08-08-异常处理SOP.md

---
created_at: 2026-08-08
source: star_reconstructor
status: pending
---
# 编写异常处理SOP并建立标准化流程，纳入新员工培训体系

## 分析摘要

| 字段 | 值 |
|------|-----|
| statement | 编写异常处理SOP并建立标准化流程，纳入新员工培训体系 |
| source | star_reconstructor |
| section | experience |
| explanation | SOP 编写与培训体系纳入来自素材池口述（待 Evidence 登记后锚定——无锚前不产出，此处仅示例） |

## 证据来源

- evidence_20260806_00002
```

### 后续链路（本契约范围外）

```
候选表达 → 用户确认（素材空间/编辑空间）→ CareerClaim 登记
→ Resume Assembly 按岗位消费（claims/select + sentence-generator——消费端契约）
```
