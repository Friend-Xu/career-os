# JD 智能分析
>
> 本文件是 career-advisor skill 的子模块。由主 SKILL.md 路由加载，不作为独立 skill 运行。

**拿到一份 JD，告诉你"靠不靠谱、匹不匹配、怎么投、面试会问什么"。**

不做关键词计数——做需求理解、证据锚定、隐性信号解码。不编造经历——只帮用户把真实的故事用 JD 的语言讲出来。

---

## 依赖

| 工具 | 来源 | 状态 | 说明 |
|------|------|:----:|------|
| `WebSearch` | Claude Code 内置 | 必选 | 公司轻量搜索 |
| `WebFetch` | Claude Code 内置 | 必选 | 深度阅读JD链接 |
| `Read` | Claude Code 内置 | 必选 | 读取 reference 文件 + 上游 skill 输出 |
| `Agent` | Claude Code 内置 | 推荐 | JD批量对比时并行派发 |

---

## 与现有 skill 的关系

```
career-path → career-transition → city-advisor → company-screener → company-research
                                                                         ↓
                                                             【JD Analysis】
                                                                         ↓
                                                             投递/面试
```

| | career-transition | jd-analysis |
|---|---|---|
| 层级 | 方向级 | 岗位级 |
| 核心问题 | "怎么从现在的位置走到想去的位置？" | "这个岗位靠谱吗？我能投吗？怎么投？" |

### 数据复用

| 上游 | 复用数据 | 方式 |
|------|---------|------|
| career-transition | 技能画像、差距分析、风险系数 | Read 文件（如存在） |
| company-research | 公司评估报告 | Read `workspace/career-advisor/companies/[公司名].md`（如存在） |
| career-path | 目标方向画像卡 | Read career-path-map.md（索引）→ ../../references/directions/[专业].md |

### 公司上下文获取优先级

```
1. workspace/career-advisor/companies/[公司名].md 存在 → 0次搜索
2. 不存在 → 轻量搜索（3-4次：规模+口碑+薪资基准）
3. 用户口述

输出标注来源：[公司上下文: company-research报告] / [JD分析轻量搜索] / [用户提供]
```

---

## 工作流总览

```
阶段1: JD质量评估（30秒）
  → 五轴评分 + 欺诈检测
  → 出口：PASS / WARN【可选停】 / SKIP【停】

阶段2: JD深度拆解
  → 结构化提取 + 隐性信号 + Must/Nice分级 + 红旗
  → 出口：只看JD【停】 / 要评估匹配 → 继续

阶段3: 匹配度计算（需简历/技能画像）
  → 证据锚定 + 多维评分 + 差距分类 + 转行加成
  → 出口：只看匹配【停】 / 要投 → 继续

阶段4: 投递行动包
  → 投递决策 + 简历定制指令 + 面试准备包
  → 出口：完整输出
```

**阶段之间询问"继续还是停在这里？"**

---

## 入口分流

```
"你拿到了什么JD？

A. 只有JD文本 → 从阶段1开始，阶段3时问技能
B. JD + 简历 → 完整四阶段
C. JD + 已跑过 career-transition → 读取技能画像，跳过重复询问
D. 多份JD对比 → 每份独立评估 + 对比表"
```

### 简历来源判断

```
用户提到"之前做过XX分析" / "技能画像是" → 检测 career-transition 输出
  → 存在 → "这是你之前的技能画像，还用这个吗？"
  → 不存在 → "有简历吗？还是口述3-5项核心技能？"

有简历 → 完整模式（按 skill-audit-guide.md 提取）
无简历 → 快速模式（口述核心技能，标注"数据不完整"）
```

---

## 阶段1：JD 质量评估

Read `references/jd-quality-check.md` 和 `references/euphemism-dictionary.md`。

```
"先花30秒判断这个JD靠不靠谱。"

轴5 欺诈检测（优先）：
  → 任何触发 → 输出 SKIP，建议停。除非用户坚持。

轴1-4 综合评分：
  - 轴1 清晰度: 职责/技能/范围的具体程度
  - 轴2 薪资透明: 数字+福利细节
  - 轴3 文化信号: 对照 euphemism-dictionary.md
  - 轴4 招聘行为: 官网可查+发布时效
```

输出按 `output-template.md` 阶段1格式。

---

## 阶段2：JD 深度拆解

Read `references/jd-parsing-guide.md` 和 `references/euphemism-dictionary.md`。

```
1. 结构化提取：基本信息/硬门槛/必备技能/软技能/职责拆解
2. 隐性信号解码：团队/业务阶段/技术成熟度
3. 红旗标注：高/中/低风险
```

输出按 `output-template.md` 阶段2格式。结尾问"要继续评估匹配度吗？"

**岗位入库（Roles 生产契约）**：JD 拆解完成后，把岗位登记进 `workspace/career-advisor/knowledge/roles.md`（岗位清单）——格式与 Producer Boundary 见 `../../references/roles-contract.md`（`## 岗位名（公司名）` + `essential:/nice-to-have:` 技能需求，**每项必带 `（来源: JD-{公司}-{日期}）`**；公司名用 canonical 档案名；同公司同名岗位已登记则更新不重复建）。岗位清单是公司岗位实例库，不是市场通识库——技能需求必须能从本 JD 回溯，禁止写 JD 之外的泛化技能。

**Job Intelligence 双输出（M1）**：用户从岗位工作区发起完整分析时，除对话输出与决策摘要表（写 `decisions/`）外，把「岗位智能表」写回岗位文件 `workspace/career-advisor/jobs/{日期}-{公司}-{岗位}.md`（找不到文件名时询问用户）——格式与词表见 `output-template.md`「岗位智能表」。决策摘要表照旧，双输出互不替代。**决策文件名由引擎登记**（系统 ID `decision_{YYYYMMDD}_{序号}`，M1.6）：你照常按 `{日期}-{主题}` 写入 `decisions/`，引擎自动登记重命名——**重复分析同一岗位无需自己加序号**，引擎保证每次登记生成新 ID、历史不覆盖。如需关联岗位，可在决策内容头部声明（可选，引擎登记时透传保留）：

```md
---
type: jd-analysis
subject_id: {岗位 id：jobs/ 文件名去 .md}
---
```

---

## 阶段3：匹配度计算

Read `references/matching-model.md`。

```
确认数据来源 → 硬门槛检查(一票否决) → 二维映射(证据锚定)
→ 多维评分 → 差距分类 → 转行加成(如适用)

红线: 无证据不计入匹配。"我可以学"→标注为"声称可学"而非"匹配"
```

输出按 `output-template.md` 阶段3格式。问"要进入简历定制和面试准备吗？"

---

## 阶段4：投递行动包

Read `references/resume-tailoring-guide.md` 和 `references/interview-prep-guide.md`。

```
4a. 投递决策: 投 / 定制后投 / 观望 / 跳过 + 理由
4b. 简历定制: 推荐深度(L1-L4) → 个人总结/技能区/bullet改写/关键词/弱项应对
4c. 面试准备: 预测问题 + 反问生成 + 故事线 + 风险应对
```

输出按 `output-template.md` 阶段4格式。

---

## 批量JD对比

每份独立跑阶段1-3 → 对比表（质量/薪资/门槛/匹配度/差距数/红旗/建议）→ 推荐排序 → 用户选1-2份进阶段4。

---

## 边界情况

| 情况 | 处理 |
|------|------|
| JD大量复制粘贴、无具体信息 | 阶段1判SKIP |
| JD 过于简略（仅岗位名/一句招聘语，无具体职责要求） | 不写岗位智能表（Anti-Hallucination：禁止从岗位名推断职责） |
| 用户无简历无技能画像 | 阶段3快速模式，定性判断，不计算精确% |
| 转行跨度极大 + 匹配<30% | 诚实标注，建议中间跳板 |
| JD未提及公司名 | 跳过公司上下文，标注"公司信息不可得" |
| 用户只需要面试准备 | 跳过4b，直接输出4c |
| 用户说"已经改好简历了" | 跳过4b，输出4c |

---

## 质量规则

1. **不编造经历** — 每个匹配必须有可追溯证据。`[用户声称可学]` 不计入匹配
2. **硬门槛不可绕过** — 不满足则诚实标注，不计算综合分
3. **JD 质量差就说差** — 不假装每个JD值得深度分析
4. **薪资推断标注来源** — `[来源: BOSS直聘, 2026]` vs `[推断·行业平均]`
5. **公司信息缺失就说不知道**
6. **"先别投"不阻断** — SKIP/WARN有警告，最终决策交用户
7. **快速模式标注不确定性** — `[快速模式·数据不完整]`
8. **转行加成不改变硬门槛** — 通过差异化优势维度体现

---

## 文件导航

```
jd-analysis/
├── SKILL.md                         ← 本文件（编排层）
├── README.md
├── design.md                        ← 设计方案（设计文档）
├── research-report.md               ← 调研报告（研究笔记）
└── references/
    ├── euphemism-dictionary.md      ← 中文JD黑话词典
    ├── jd-quality-check.md          ← 阶段1: 五轴评分 + 欺诈检测
    ├── jd-parsing-guide.md          ← 阶段2: 结构化提取 + 动词解码
    ├── matching-model.md            ← 阶段3: 加权评分 + 证据锚定
    ├── resume-tailoring-guide.md    ← 阶段4b: 简历定制
    ├── interview-prep-guide.md      ← 阶段4c: 面试准备
    └── output-template.md           ← 各阶段输出模板
```

**复用外部数据**：
- `../career-transition/references/skill-audit-guide.md` — 简历提取规则
- `workspace/career-advisor/companies/[公司名].md` — 公司上下文（如存在）
- `../career-path/references/career-path-map.md` — 方向索引（路由表+行业标签）
- `../../references/directions/` — 8个专业方向画像卡
