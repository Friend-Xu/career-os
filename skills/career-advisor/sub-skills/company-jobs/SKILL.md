---
name: company-jobs
description: >
  岗位线索检索：给定公司 canonical 全称（可批量 ≤10 家），检索该公司在招岗位线索清单，
  输出「岗位线索登记」JSON 由 Engine 登记。当用户说"刷新线索""这家公司在招什么岗位""查一下招聘""刷新岗位线索"时触发。
---

# 求职向岗位线索检索
>
> 本文件是 career-advisor skill 的子模块。由主 SKILL.md 路由加载，不作为独立 skill 运行。

**给定公司名，输出该公司在招岗位线索清单。**

轻量 skill：只查招聘，不做业务/财务尽调。线索给用户看、给榜单投递层消费；
不替用户投递、不自动抓 JD 入库。

---

## 依赖

| 工具 | 来源 | 状态 | 说明 |
|------|------|:----:|------|
| 天眼查 MCP（通道 A） | 用户本地配置（`https://mcp.tianyancha.com/v1`，用户 API Key） | 推荐 | 结构化锚定 + 招聘/风险能力发现调用 |
| `WebSearch` | Claude Code 内置 | 必选 | 通道 B 搜索（官网/招聘平台） |
| `WebFetch` | Claude Code 内置 | 必选 | 读取 careers 页 / 招聘页原文 |
| `Exa web_search_exa` | ECC 插件内置 MCP | 强烈推荐 | 通道 B 中文搜索质量更高 |
| `Agent` | Claude Code 内置 | 推荐 | 批量公司并行派发 |

### 天眼查 MCP（通道 A）配置

- 服务地址 `https://mcp.tianyancha.com/v1`，API Key 由用户本地配置，skill 不持有密钥
- 工具锚定：`search_companies`；招聘/风险相关能力经 `get_company_capabilities` 发现后 `call_tool` 调用
- **能力发现模式**：skill 不硬编码接口清单，以能力发现返回为准

---

## 与 company-research 的分工边界（契约 §5.1）

| | company-research | company-jobs（本 skill） |
|---|---|---|
| 时机 | 尽调时快照 | 按需刷新（榜单「刷新线索」动作） |
| 范围 | 业务/财务/风险全量尽调 | 只查招聘线索 |
| 产出 | 公司档案 + rating 回链 | JobLead 线索清单 |
| 频率 | 一次性深度 | 可重复，14 天过期后刷新 |

- 与 jobs/ 分工：只产线索，不写 `jobs/`、不登记 `roles.md`（未分析岗位不进岗位清单）
- 诚实边界：**不承诺自动投递**；线索 ≠ 已递交 JD——用户点击 → 粘贴 JD → 才进入 jobs/

---

## 工作流总览

```
Step 1: 确认清单   → canonical 公司名核对（批量 ≤10 家）
Step 2: 通道 A     → 天眼查 MCP：search_companies 锚定 → 招聘能力发现调用
Step 3: 通道 B     → 官网 careers 页优先 → 主流招聘平台（全量纪律）
Step 4: 诈骗信号   → 顺带识别求职诈骗信号（fraudFlags）
Step 5: 输出登记   → job-leads JSON 输出（Engine 登记，不写文件）
```

---

## Step 1: 确认清单（canonical 锚定）

- 输入必须是 canonical 全称（已锚定公司名，来自候选池 / 公司档案）
- 批量 ≤ 10 家；超过 10 家分批执行
- 锚定铁律：简称/品牌名不得自行补全；名称不确定 → 先用 `search_companies` 确认精确全称再查

## Step 2: 通道 A —— 天眼查 MCP（结构化）

1. `search_companies` 锚定公司（确认精确全称）
2. `get_company_capabilities` 发现该公司招聘/风险相关能力
3. `call_tool` 调用发现到的招聘能力，取岗位线索

- 鉴权失败 / 限流 / 5xx → 降级通道 B（见「数据源双通道与降级纪律」）

## Step 3: 通道 B —— 通用搜索（官网优先）

检索纪律（契约 §5.2）：

1. **官网优先**：先查公司官网 careers/招聘页，其次主流招聘平台
2. **全量纪律**：禁止只看第一页；列表页翻全量（或等价全量）再本地过滤
3. 每条线索带**来源链接 + 抓取日期**
4. **不编造**：岗位名/薪资必须来自检索结果
5. **「服务不可用」与「该司无在招」严格区分**：
   - 官网/平台打不开、反爬、超时 → 「服务不可用」，换其他来源再试
   - 页面正常但无在招岗位 → 「该司无在招」

## Step 4: 求职诈骗信号（契约 §5.4）

顺带识别以下信号，命中写入 `fraudFlags`：

| 信号 | 特征 |
|------|------|
| 收费内推 | 以「内推名额」名义收费 |
| 保 offer | 承诺付费保录用 |
| 培训贷 | 入职前强制培训 + 贷款 |
| 入职收费 | 入职前收取押金/服装费/体检费 |
| 私信加微信引流 | 招聘帖引导脱离平台私聊加微信 |

- 命中**不自动否决**，最终判断归用户；榜单行显示 ⚠ 提示

## Step 5: 输出登记（Agent Output Contract）

JSON 直接输出为文本行（不要放入代码块），参照 jd-analysis「岗位分析提交」模式。
Agent 无文件写权限——只输出 JSON，由 Engine 登记。

---

## 数据源双通道与降级纪律（契约 §5.3）

| 情形 | 动作 |
|------|------|
| 通道 A 可用 | 结构化线索优先，通道 B 补全官网/平台详情 |
| 通道 A 鉴权失败 / 限流 / 5xx | 降级通道 B，标注「天眼查通道不可用」 |
| 部分可用 | 优先交付已得线索，标注缺的维度 |
| 通道 B 也检索不到 | 显式标缺，标注数据源局限 |

- **绝不编造岗位名/薪资**——缺失即标缺，不补齐

---

## 输出契约（岗位线索登记）

```
岗位线索登记：{"type":"job-leads-upsert","company":"示例公司A","leads":[{"title":"结构工程师","salary":"15-25K","city":"城市A","url":"https://example.com/careers/123","source":"官网","fraudFlags":[]}]}
```

字段规则（严格对齐 `engine/storage/job-leads.ts` 的 `upsertJobLeads` 输入）：

| 字段 | 规则 |
|------|------|
| `type` | `job-leads-upsert`（固定） |
| `company` | canonical 全称（必须已锚定，非空） |
| `leads[].title` | 岗位名，必须来自检索结果（非空） |
| `leads[].salary` | 检索不到 → **省略字段**（Engine 落盘 `-`） |
| `leads[].city` | 同上 |
| `leads[].url` | 来源链接（非空，用户自行查看原文） |
| `leads[].source` | 枚举：`官网` / `招聘平台` / `其他`（官网优先） |
| `leads[].fraudFlags` | 可选；命中 Step 4 信号才填，未命中省略 |
| `leads[].capturedAt` | 可选；省略时 Engine 记为当日 |

- 引擎 RPC：`job-leads/upsert`（params `{company, leads}`）；upsert = 全量覆盖该公司线索文件（刷新语义）
- **`leads` 禁止空数组**（引擎 fail fast）：该司无在招 → 不上报，对话中显式标注「该司无在招」；「服务不可用」单独标注，不输出空 leads
- 批量：每家公司输出**一条独立 JSON**（RPC 按 company 单公司登记）
- `id` / `expiresAt`（capturedAt + 14 天）由 Engine 派生；过期线索 Engine 标注「可能过期，可刷新」，不删除

---

## 边界情况

| 情况 | 处理 |
|------|------|
| 批量 > 10 家 | 分批执行，每批独立输出 |
| 公司无在招岗位 | 对话显式标注「该司无在招」（≠ 服务不可用） |
| 官网/平台服务不可用 | 标注「服务不可用」，换其他来源再试 |
| 线索过期（14 天） | Engine 标注「可能过期」，用户可触发「刷新线索」重查 |
| 公司名未锚定 | 先 `search_companies` 锚定，禁止简称自补全 |

---

## 质量规则

1. 每条线索带来源链接 + 抓取日期
2. 岗位名/薪资来自检索结果，绝不编造
3. 全量纪律：禁止只看第一页
4. 诈骗信号识别后交用户判断，不自动否决
5. 检索不到就说检索不到——「服务不可用」与「该司无在招」严格区分

---

## 文件导航

```
company-jobs/
└── SKILL.md                          ← 本文件（编排层）
```

**复用外部数据**：
- `workspace/career-advisor/companies/[公司名].md` — 已尽调公司档案（canonical 名来源，不重复尽调）
- `workspace/career-advisor/company-pool/[公司名].md` — 候选池条目（canonical 名来源）
- 契约：`docs/contracts/Company-Leaderboard-Contract-v0.1.md` §2.3 / §5
