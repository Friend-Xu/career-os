---
name: salary-benchmark
description: >
  薪资基准检索：给定 岗位+城市+经验档位（可批量），检索市场薪资的单来源快照（岗位/城市/档位/薪资值或区间/样本量/来源/抓取日期），
  输出「薪资基准登记」JSON 由 Engine 登记（样本点模式，分位由引擎聚合）。当用户说"查薪资基准""这个岗位市场价多少"
  "我期望这个数合理吗（先查基准）""刷新薪资基准"时触发。
---

# 薪资基准检索（二期 §7.6）

> 本文件是 career-advisor skill 的子模块。由主 SKILL.md 路由加载，不作为独立 skill 运行。

**给定岗位 + 城市 + 经验档位，检索市场薪资的单来源快照并登记为基准条目。**

样本点模式（契约 §7.2）：**只登记单来源事实**（来源给多少记多少）；
P25/P50/P75 分位与「合理/偏低/偏高」三态对照由 **Engine 确定性聚合**（`engine/ir/salary.ts`）——
本 skill 不做分位计算、不做估价结论、不替用户定价。

---

## 依赖

| 工具 | 来源 | 状态 | 说明 |
|------|------|:----:|------|
| `WebSearch` | Claude Code 内置 | 必选 | 检索招聘平台/薪酬报告的岗位薪资 |
| `WebFetch` | Claude Code 内置 | 必选 | 读取薪酬数据页原文 |
| `Exa web_search_exa` | ECC 插件内置 MCP | 强烈推荐 | 中文薪酬数据搜索质量更高 |
| 天眼查 MCP（通道 A） | 用户本地配置 | 可选 | 招聘薪资相关能力发现调用（见下） |

### 数据源双通道（照 company-jobs 纪律）

- **通道 A（可选）**：天眼查 MCP `get_company_capabilities` 发现薪资/招聘相关能力后调用
- **通道 B（主）**：通用搜索——招聘平台岗位薪资 + 薪酬统计报告
- 降级纪律：通道 A 鉴权失败/限流/5xx → 通道 B；检索不到显式标缺，**不编造薪资**

---

## 分工边界

| | company-jobs | salary-benchmark（本 skill） |
|---|---|---|
| 输入 | 公司 canonical 名 | 岗位 + 城市 + 经验档位 |
| 产出 | 岗位线索 JobLead | 薪资基准条目 SalaryBenchmarkEntry |
| 语义 | 这家公司在招什么 | 这个岗位市场值多少 |

- 与 jd-analysis 分工：JD 分析消费基准做薪资核实；本 skill 只负责采集登记
- 基准条目 ≠ 用户期望：期望薪资在画像 `preference_constraints.md`，本 skill 不改不动

---

## 工作流总览

```
Step 1: 确认输入组 → 岗位 + 城市 + 档位（映射枚举，可批量）
Step 2: 检索       → 招聘平台 + 薪酬报告（全量纪律，来源链接 + 抓取日期）
Step 3: 口径换算   → 统一月薪 K（税前）；年薪来源换算，note 留原始口径
Step 4: 输出登记   → salary-benchmark-upsert JSON（Engine 登记，不写文件）
```

---

## Step 1: 确认输入组（岗位 + 城市 + 档位）

- 岗位：用户画像 `career_profile.md` 当前/目标岗位，或用户临时指定
- 城市：`preference_constraints.md` 意向城市，或用户指定
- 档位枚举（Engine 定义，`engine/ir/schema.ts` SalaryExpTier）：

| 来源表述 | 登记值 |
|---------|--------|
| 0-2 年 / 应届 | `0-2` |
| 3-5 年 | `3-5` |
| 6-10 年 | `6-10` |
| 10 年以上 | `10+` |
| 不限经验 | `不限`（Engine 归一 `any`） |

- 来源表述与枚举**映射有歧义 → 该条不登记**（显式说明，不猜）
- 批量 ≤ 3 组；超过 3 组分批执行

## Step 2: 检索（全量纪律）

检索纪律（照契约 §5.2）：

1. 招聘平台岗位薪资优先，薪酬统计报告次之（报告类登记 `sampleN`）
2. **全量纪律**：禁止只看第一页；列表翻全量（或等价全量）再本地过滤
3. 每条带**来源链接 + 抓取日期**
4. **不编造**：薪资必须来自检索结果；「服务不可用」与「无数据」严格区分：
   - 平台打不开/反爬/超时 → 「服务不可用」，换其他来源再试
   - 页面正常但该组合无薪资数据 → 「该城市×岗位×档位无数据」

## Step 3: 口径换算（统一月薪 K 税前）

| 情形 | 处理 |
|------|------|
| 来源给月薪 K | 直接登记 `salary` |
| 来源给区间（如 12-16K） | 登记 `salaryRange: {min:12, max:16}` |
| 来源给年薪（如 18-25w） | 换算月薪后登记，`note` 留原始口径（如「年薪 18-25w 换算」） |
| 单条 JD 薪资 | 登记该值，不填 `sampleN`（聚合按 1 计） |
| 薪酬报告统计 | 登记报告值 + `sampleN`（报告样本量） |

- 一个来源登记**一条条目**；多来源 → 多条 entries

## Step 4: 输出登记（Agent Output Contract）

JSON 直接输出为文本行（不要放入代码块），参照 company-jobs「岗位线索登记」模式。
Agent 无文件写权限——只输出 JSON，由 Engine 登记。

---

## 输出契约（薪资基准登记）

```
薪资基准登记：{"type":"salary-benchmark-upsert","entries":[{"role":"结构工程师","city":"城市A","expTier":"3-5","salary":12,"sampleN":30,"source":"https://example.com/report/123","note":"报告口径"},{"role":"结构工程师","city":"城市A","expTier":"3-5","salaryRange":{"min":11,"max":14},"source":"https://jobs.example.com/456"}]}
```

字段规则（严格对齐 `engine/storage/salary-benchmarks.ts` 的 `upsertSalaryBenchmarks` 输入）：

| 字段 | 规则 |
|------|------|
| `type` | `salary-benchmark-upsert`（固定） |
| `entries[].role` | 岗位名（非空） |
| `entries[].city` | 城市（非空） |
| `entries[].expTier` | 档位枚举或中文标签（`3-5` / `3-5年` / `不限`；Engine 归一） |
| `entries[].salary` | 月薪 K（税前），正数；与 salaryRange 至少其一 |
| `entries[].salaryRange` | `{min, max}` 月薪 K，min ≤ max |
| `entries[].sampleN` | 可选；报告类来源样本量（正整数），单条 JD 省略 |
| `entries[].source` | 来源链接（非空） |
| `entries[].note` | 可选；原始口径备注（年薪换算等） |

- 引擎 RPC：`salary-benchmarks/upsert`（params `{entries}`）；upsert = 全量覆盖该组文件（刷新语义）
- **一次输出一组**：entries 内 role/city/expTier 必须全同（引擎 fail fast：混批报错）
- **`entries` 禁止空数组**（引擎 fail fast）：检索不到 → 不上报，对话中显式标注「该城市×岗位×档位无数据」
- `id` / `expiresAt`（capturedAt + 90 天）由 Engine 派生；过期条目 Engine 标注「数据较旧」，不删除
- **不做分位计算、不做三态估价**——那是 Engine 的事；本 skill 只交单来源事实

---

## 边界情况

| 情况 | 处理 |
|------|------|
| 批量 > 3 组 | 分批执行，每批独立输出 |
| 该组合无薪资数据 | 对话显式标注「该城市×岗位×档位无数据」（≠ 服务不可用） |
| 平台服务不可用 | 标注「服务不可用」，换其他来源再试 |
| 档位表述映射有歧义 | 该条不登记，显式说明 |
| 年薪口径 | 换算月薪登记，note 留原始值 |
| 条目过期（90 天） | Engine 标注「数据较旧」，用户可触发「刷新检索」 |

---

## 质量规则

1. 每条条目带来源链接 + 抓取日期
2. 薪资来自检索结果，绝不编造；检索不到就说检索不到
3. 全量纪律：禁止只看第一页
4. 只登记单来源事实，不心算分位、不输出估价结论（Engine 聚合，契约 §7.2.2）
5. 年薪来源换算月薪并留 note 原始口径

---

## 文件导航

```
salary-benchmark/
└── SKILL.md                          ← 本文件（编排层）
```

**复用外部数据**：
- `workspace/career-advisor/knowledge/薪资基准-{城市}-{岗位}-{档位}.md` — 已有基准条目（同组登记 = 刷新覆盖）
- `workspace/career-advisor/persons/{person_id}/snapshot/career_profile.md` — 岗位来源
- `workspace/career-advisor/persons/{person_id}/snapshot/preference_constraints.md` — 城市/期望薪资来源
- 契约：`docs/contracts/Company-Leaderboard-Contract-v0.1.md` §7
