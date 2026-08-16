# 简历撰写
>
> 本文件是 career-advisor skill 的子模块。由主 SKILL.md 路由加载，不作为独立 skill 运行。

**帮用户把模糊的工作经历转化为一份体面的简历。** 核心价值不在"写作"，在"挖掘"——用户知道的事比他们以为自己知道的多，用 frontier 追问帮他们发现。

---

## 依赖

| 工具 | 来源 | 状态 | 说明 |
|------|------|:----:|------|
| `Read` | Claude Code 内置 | 必选 | 读 reference 文件 + profile + decisions |
| `Write` | Claude Code 内置 | 必选 | 写简历文件 + decisions |
| `Glob` | Claude Code 内置 | 必选 | 扫描 workspace 已有数据 |
| `WebSearch` | Claude Code 内置 | 条件 | 场景 C（有JD）时查公司和岗位信息 |

### Reference 文件

| 文件 | 加载时机 | 说明 |
|------|---------|------|
| `references/discovery-engine.md` | Step 2 始终 | frontier 追问引擎 |
| `references/direction-standards/{方向}.md` | Step 2-3 条件 | 方向特定简历内容标准（HR关键词/量化锚点/强力动词/项目分组/ATS清单） |
| `references/star-reconstructor.md` | Step 3 始终 | 素材池 → 候选表达（Claim Producer——写 claim-proposals/，不直接产出简历文本） |
| `references/verb-dictionary.md` | Step 3 始终 | 动词升级 |
| `references/resume-output-template.md` | Step 4 始终 | 输出模板（基于已确认表达组装） |

---

## 与其他模块的关系

```
resume-writing 是独立子流程，条件触发上游模块，被下游模块消费：

  条件触发（根据 destination）：
    ├─ 目的地 A（通用）→ 独立运行
    ├─ 目的地 B（转行）→ 先跑 career-transition，复用技能画像
    ├─ 目的地 C（有JD）→ 先跑 jd-analysis JD拆解，关键词反向追问
    └─ 目的地 D（有简历）→ 轻量审计，只补缺口

  被消费：
    resume-writing 产出简历
      → jd-analysis 读入做匹配
      → resume-tailoring-guide 做 JD 定制
```

---

## 工作流总览

```
Step 0：destination-first 入口分流
Step 1：信息收集（一次性采集基本字段）
Step 2：frontier 追问挖掘（→ discovery-engine.md）
Step 3：STAR 重构（→ star-reconstructor.md + verb-dictionary.md）
Step 4：组装输出（→ resume-output-template.md）
```

---

## Step 0：入口分流（destination-first）

先确定目的地，再决定怎么走。不直接开始追问。

### 分流提问

```
"你的目标是哪种？
 A. 做一份通用简历，先投着看看
 B. 我要转行到 [X] 方向，用新方向的语言重写经历
 C. 我手里有一个 JD / 目标岗位，希望针对它来写
 D. 我有现在用的简历，帮我改好"
```

### 分流逻辑

```
A 通用：
  → 读 profile.md（如有）
  → 进入 Step 1

B 转行：
  → 检查 workspace/career-advisor/decisions/ 中是否有 career-transition 输出
  → 有 → 读取技能画像 → 进入 Step 1
  → 无 → "建议先跑一下转行分析，看看你的哪些能力可以迁移到新方向。
         大概5分钟。要现在跑吗？"
         → 用户同意 → 加载 career-transition/SKILL.md 执行
         → 用户拒绝 → 记录偏好，进入 Step 1（用当前方向语言写）

C 有 JD：
  → 用户粘贴 JD 或提供链接
  → 检查是否已有该岗位的岗位决策记录（decisions/ 中 type: jd-analysis + subject_id 匹配岗位 id）
  → 有 → 消费结构化岗位差距上下文（Engine 投影：`node engine/main.ts --resume-context {decisionId} {personId}` CLI，或经 UI 的 decision/resume-context RPC）——
         三部分：岗位要求（JD 原文投影）/ 候选人已有（画像证据引用）/ 待确认差距（四态：NOT_DECLARED = 未声明不代表不具备）
         **禁止解析 decisions/ markdown 差距表**——存储格式归 Engine，结构化上下文是消费契约（见 ../../references/career-decision-loop-contract-v0.1.md §12）
  → 无 → 加载 jd-analysis SKILL.md Step 1-2（JD质量快判 + 深度拆解）
  → 将拆解结果（必备技能/加分项/隐性信号）作为 Step 2 的事实来源
  → 进入 Step 1（JD 信息替代部分基本信息采集）

D 有简历：
  → 用户上传简历文件 → Read 提取文本
  → 运行轻量技能审计（复用 career-transition 的 skill-audit-guide.md 规则）
  → 检测模糊信号和量化缺口
  → 跳过 Step 1 中已有信息的采集
  → 进入 Step 2（只追问缺口）
```

---

## Step 1：信息收集

一次性采集简历必需的基本字段。**不计入 frontier 轮次。**

### 采集内容

```
如果 profile.md 已存在 → 读取并确认，只问变更

如果 profile.md 不存在 → 一次性问：
  "先聊几个基本信息：
   - 当前岗位 / 工作年限？
   - 学历 / 专业？
   - 所在城市？
   - 目标方向？（有明确方向就说，没有的话我帮你分析）
   - 有没有明确不想要的？（比如不想做管理、不接受出差）

  然后，把你做过的几份工作（从最近到最早），用你自己的话说一遍——
  不用担心写得好不好、是不是'简历语言'。
  
  包含：公司名 / 职位 / 做了多久 / 具体做了什么"
```

### 完成条件

- 至少 1 段工作经历被描述（哪怕很模糊）
- 基本信息字段已填充或标注"用户未提供"
- 如果目的地是 B（转行），目标方向已确认

完成后 → 进入 Step 2。

---

## Step 2：Frontier 追问挖掘

引用 `references/discovery-engine.md`。本文件只描述编排逻辑，完整规则在 reference 中。

### 流程

```
1. 扫描用户 Step 1 的描述 → 模糊信号检测器 → 构建缺口列表
2. 事决分离：查 profile/decisions/简历 → 填事实缺口
3. 计算 frontier（互不依赖的决策缺口）
4. 每轮：
   - 输出 3-5 个单一问题（来自 to-questionnaire 规则：一个想法一个问题）
   - 每个问题附带推荐答案（粗体标注）
   - 等用户回答
   - 更新缺口列表
5. 直到 frontier 为空 → 结束
```

### 每轮输出格式

```
"基于你刚才说的，我发现了 [N] 个需要补充的信息缺口。这轮先问 [M] 个：

1. [问题1] 我猜测可能是 **[推荐答案]**——对吗？

2. [问题2] ——这个大概是什么情况？**[推荐方向]**

3. [问题3] 的方向是哪个？
   - [选项A]
   - [选项B]
   - 其他（你说）"
```

### 完成条件

来自 discovery-engine.md 终止条件：
- 每段经历 ≥ 3 个具体行为描述
- 全简历 ≥ 2 个量化结果
- 所有模糊信号已消除
- 基本信息已填充

### 提前退出

用户说"够了，先写" → 立即结束追问，标注剩余缺口：
> "好的。这版出来之后，如果你后续能补上 [缺口简述]，我可以把对应部分改得更出彩。"

---

## Step 3：STAR 重构（→ 候选表达）

引用 `references/star-reconstructor.md` + `references/verb-dictionary.md`。

**定位（ADR-022 Claim Producer Boundary）**：本步产出**候选表达**（写 claim-proposals/），
不是简历文本——Agent 提案，用户确认后才成为表达资产，简历组装只消费已确认表达。

### 流程

1. 从用户多轮回答中，为每段经历构建素材池
2. 提取 STAR 骨架 → 拼接候选表达（≤80字，3-5条/段）
3. 逐条做动词升级（弱动词 → 强动词）
4. 量化萃取（能精确的精确，不能的半定量，不超过 3 处半定量）
5. 证据锚定（evidenceRefs——只引用已登记的 Evidence 资产；无锚内容先提示登记，不产出）
6. 写 claim-proposals/{id}.md（格式见 star-reconstructor.md 第六节——引擎扫描登记为待确认）

### 质量自检

逐条检查：
- 可追溯：每条候选能对应到 evidenceRefs（Evidence 资产条目）
- 无编造：无用户未提及的公司/项目/数字/技术名词
- 动词强度："负责/参与/做了" ≤ 1 处/段
- 量化充分：≥ 2 处可量化
- 锚点完整：候选中的数字/能力词在 evidence 文本中可找到（引擎锚点校验）
- 转行场景：动词方向与目标方向对齐

---

## Step 3.5：用户确认候选

候选表达不会自动成为简历内容——引导用户确认（素材空间「待确认表达」/编辑空间）：

```
"我从你的经历整理出 N 条表达建议，可以确认加入素材库：
  1. 主导产线关键产品良率改善，将良率从92%提升至96%
  2. ...
确认后这些表达可以加入简历；不想用的可以直接丢弃。"
```

用户确认 → 引擎登记为 CareerClaim（素材空间「已确认表达」）→ 简历组装可消费。
未确认的候选不进入简历（Claim 是资产，简历是表达组合——不自动插入）。

---

## Step 4：组装输出

引用 `references/resume-output-template.md`。

**消费边界**：仅从**已确认表达资产**组装简历（引擎 claims/select + sentence-generator
消费端契约）；素材池里尚未确认的新内容 → 先走 Step 3 候选 + Step 3.5 确认，不直接写入。

### 输出内容

1. **标准简历**（Markdown 格式）
2. **ATS 纯文本版**（去格式，可粘贴到招聘系统）
3. **内部映射表**（证据追溯，不向用户展示）
4. **用户提示**：

```
这份简历有什么想调整的吗？比如：
- 想增减某段经历
- 想调整某个表述的方向（比如更强调管理 vs 更强调技术）
- 某句话感觉不太对

如果有目标 JD，给我看一下，我可以针对性地定制一版。
```

### 数据写入

```
子流程结束：
  → 写 resumes/drafts/（Draft Manifest——M3 简历版本协议，不直接写 profiles/）
  → 写 workspace/career-advisor/decisions/{YYYY-MM-DD}-简历撰写.md（含14字段摘要表）
  → 更新 workspace/career-advisor/INDEX.md（用户画像段；决策记录/城市评估段由引擎投影接管，禁止手写）
  → 个人总结 + 技能关键词回写 persons/{person_id}/snapshot/skill_inventory.md（走采集协议）
```

---

## 边界情况

### 应届生 / 无工作经历

```
"没关系。即使没有正式工作，你也有值得写的经历。
 我们可以从这些方向挖掘：
 - 课程项目/毕业设计（你做了什么、用了什么工具/方法）
 - 实习经历（哪怕很短）
 - 社团/学生组织（有没有组织过活动、管过钱、带过人）
 - 自学/培训（有没有自己的项目、GitHub、比赛）
 - 志愿者/兼职"

→ frontier 追问适配：量化锚点用"项目规模/参与人数/成果"替代"标的额/良率"
→ 动词词典不用调整
```

### 多段短期工作（每段 < 1 年）

```
"几段工作都不长——这在简历上是个挑战，但我们有几件事可以帮你：
 1. 合并同类项：如果做的事类似，可以合并为一段'XX方向工作经历'
 2. 强调成长线：每段展示不同层级的能力（执行→独立→主导）
 3. 如果确实不好写——标出'可合并不展开'的选项"

→ frontier 追问优先主线关联缺口（为什么跳？每次跳的原因是什么？）
```

### 长期空窗

```
如果空窗期间有具体行动：
  → 复用 career-transition 的 gap 成长审计规则
  → 可认证的技能写入简历（如"系统学习XX"）

如果空窗期间什么都没做：
  → 不评判，不追问
  → 空窗期在简历中不展开，只在面试环节准备应答
```

### 用户中途改变主意

```
如果 Step 2 追问过程中用户发现"我其实想转行"：
  → 保存当前进度
  → 切到 destination B 流程
  → 之前收集的经历素材保留，但 STAR 重构时改用新方向语言

如果 Step 2 追问过程中用户给了 JD：
  → 已经是 C 场景，直接切换
  → 当前缺口中新增 JD 相关缺口
```

---

## 质量规则

### 内容真实性

1. 不新增原经历不存在的公司/学校/岗位/项目/奖项/技能/数字
2. 可以重写 highlights、summary、skills 排序，可以重排经历顺序
3. 不得增删经历条目数量
4. 保留姓名/邮箱/电话/城市/链接/时间等基础事实
5. JD 要求但用户没有证据的能力 → 弱化为"了解/有兴趣"，不伪造
6. 每条子弹句可追溯到用户口述（内部映射表记录）
7. **差距语义边界（决策上下文消费时）**：差距行保持四态原文（NOT_DECLARED = 未声明不代表不具备，NEEDS_CONFIRMATION = 待确认）；对未声明能力的简历处理为「若候选人实际具备 X，可加入技能区」（人工确认式建议），**禁止写成「缺少/不足 X」**；待确认项转面试准备问题，不写进简历

### 输出质量

7. 每份简历 ≥ 2 个量化结果；半定量 ≤ 3 处
8. 弱动词替换率 ≥ 80%（"负责/参与/做了"全文 ≤ 3 处）
9. 信息不足就说不足，不硬编
10. 简历正文不出现诚实标注

### 追问体验

11. 每轮 frontier ≤ 5 个问题
12. 每个问题带推荐答案（用户只需确认/修正）
13. 不问 agent 自己能查到的事实
14. 不写复合问题
15. 最重要的问题排前面

### 隐私安全

16. 发送给外部 AI 前自动脱敏（移除 email、phone、links）
17. decisions/ 文件不含真实姓名、手机号等 PII

---

## 文件导航

```
resume-writing/
├── SKILL.md                           ← 本文件（编排层）
└── references/
    ├── discovery-engine.md            ← frontier 追问引擎 + 7类缺口 + 事决分离
    ├── star-reconstructor.md          ← STAR 拼接 + 量化萃取 + 证据标注
    ├── verb-dictionary.md             ← 7类弱→强动词映射
    └── resume-output-template.md      ← 双版本模板 + 内部映射表
```
