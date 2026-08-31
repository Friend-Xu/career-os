# Company Assessment Contract v0.1（职业价值评分）

Status:
FROZEN（2026-08-08——DRAFT 后用户评审 6 处校准 → 冻结；实现起点）

Context:
ADR-018 触发条件成立（用户声明「我需要公司评分帮我判断公司情况」），进入
Company Intelligence Layer v0.1。核心语义：**不是「公司好不好」的工商评分，而是
Company Career Quality Score（职业价值评分 / 公司认知质量）**——作为职业选择对象
是否值得进一步关注。同 JD Analysis → Decision 的路径：Company Research → Company Facts
→ Company Assessment → Career Decision。

**冻结前 6 处校准（用户评审）**：① 保留 5 维但 risk → stability（负向因素不同构）
② 基础分受 status 门控（未知 ≠ 中等，NOT_DECLARED ≠ FALSE 原则）③ 增加
AssessmentRule 层（Fact 不直接映射 points，调权重不改事实）④ 重复信号按 Group 去重
（认证取最高级别 / 融资取最新最高轮 / 风险可叠加）⑤ 评估 = 纯 Projection，Engine
**不回写** markdown ⑥ UI 不用星级（Evidence > Impression，分数 + 证据）。

**冻结后修订（2026-08-31，评分链路失效根因修复）**：§4 规则表补 GROWTH 行（契约 §3 维度归属
「成长性 growth | FINANCING / GROWTH」但规则表遗漏 GROWTH——成长性维度无枚举输入，Agent 无法
合规采集）；规则版本升 `2026-08-company-quality-v2`。修订旁证：真机尽调事实段全量 narrative
（枚举外 → 全部 UNKNOWN_VALUE → INSUFFICIENT_DATA → UI「信息不足」）。

**冻结后补充（2026-08-08，调研 grounding + 实现前检查）**：
- **信号调研 grounding**——规则表与数据源对齐主流企业信用评价体系（启信分 6 大类 /
  GB/T 22120-2025《企业信用数据项要求》/ 国务院 2026 企业信用综合评价方案），
  每条信号标注可核查渠道（§4）
- **CompanyFact.id**——稳定引用（同 constraintRef/EvidenceRef 模式）：Assessment signal
  引用 fact / UI 点击查看证据 / 重新评分 diff 都需要
- **Assessment version**——ruleVersion + assessedAt：评分规则一定会变（如 2027 年
  B 轮 +10 → +5），历史分数需要解释「为什么去年 85 现在 78」

---

## 1. 语义边界（继承 ADR-018 + Known Future 三线分离）

| | 职业价值评分 qualityScore | 匹配度 matchScore | 投递意愿 intent |
|---|---|---|---|
| 回答 | 作为职业选择对象，值不值得关注 | 和我的职业方向匹不匹配 | 我是否投递 |
| 依赖 | 不依赖人 | 依赖 person | 用户 |
| Producer | Engine（确定性计分） | Agent（AI 参考） | User（Confirmation） |
| 归属 | Company Intelligence | Career Decision | Decision Record |

**Known Future（冻结记录）**：Company Assessment **不回答「是否值得投递」**，只回答
「公司认知质量」——连接 Career Decision Loop 时，投递走 User Decision（intent 已有），
适配走 matchScore，公司认知走 qualityScore，三线永不合并。禁止 `Company { score: 82 }`
模型（「82 是公司好 / 我适合 / 我该投」三义混淆）。

## 2. 三层模型

```
Layer 1  CompanyFact（事实）      Agent 采集，evidence 必填，markdown 段落
           ↓
Layer 2  AssessmentRule（规则）    Engine 持有：fact → 多维贡献（确定性映射表）
           ↓
Layer 3  CompanyAssessment（评估）  Engine 派生：status + qualityScore + dimensions
           ↓
UI 消费（companies/list RPC 投影）
```

质量分不存在「Agent 拍脑袋写 78」——Agent 只采事实，Engine 计分。分数可追溯到
信号，信号可追溯到来源。**评估是派生数据（Projection Artifact），不是事实资产，
Engine 不回写公司档案 markdown**（§7）。

## 3. CompanyFact Schema（Layer 1，Agent 采集）

```ts
type CompanyFactType =
  | 'CERTIFICATION'   // 企业资质
  | 'FINANCING'       // 融资
  | 'PATENT'          // 专利/技术壁垒
  | 'INDUSTRY_STATUS' // 行业地位
  | 'GROWTH'          // 成长性（营收/团队）
  | 'OPPORTUNITY'     // 职业机会（招聘活跃/岗位）
  | 'RISK'            // 风险（经营异常/诉讼/失信）

interface CompanyFact {
  id: string           // 稳定引用（djb2 哈希 type+value+evidence.source，同 constraintRef 模式）
  type: CompanyFactType
  value: string        // 枚举值域（§4 规则表键，Engine 精确匹配；枚举外 → degraded 不计分）
  evidence: { source: string; url?: string }  // 必填，§6
}
```

维度归属（fact type → 5 维，RISK fact 影响 stability）：

| 维度 | fact type |
|------|-----------|
| 企业可信度 credibility | CERTIFICATION / INDUSTRY_STATUS |
| 成长性 growth | FINANCING / GROWTH |
| 技术价值 technology | PATENT |
| 职业机会 opportunity | OPPORTUNITY |
| 稳定性 stability | RISK |

## 4. AssessmentRule（Signal 权重规则，Engine 持有）

**Fact 不直接映射 points**——事实经规则映射为**多维贡献**。未来调整权重只改规则表，
不修改事实资产。

### 规则表（v0.1 枚举，Engine 精确匹配，含数据源 grounding）

| factType | value 枚举 | 维度贡献 | 数据源（可核查渠道） |
|----------|-----------|----------|--------------------|
| CERTIFICATION | 国家级专精特新小巨人 | growth +5, credibility +5 | 工信部七批名单公示（2019-2025，总量约 1.9 万家）/ 专精特新政策服务网 / IT桔子专题页 |
| CERTIFICATION | 省级专精特新 / 潜在独角兽 | credibility +5 | 省科技厅认定名单 / 长城战略咨询榜单 |
| CERTIFICATION | 高新技术企业 | credibility +5 | 科技部火炬中心认定名单 |
| FINANCING | B 轮及以上（近 3 年） | growth +10 | IT桔子 / 烯牛数据 / 企查查·天眼查融资板块（轮次+时间） |
| FINANCING | A 轮（近 3 年） | growth +5 | 同上 |
| PATENT | 核心专利（产品/工艺相关） | technology +5 | 国家知识产权局专利检索 / 企查查知识产权板块 |
| PATENT | 研发人员占比 ≥ 30% | technology +5 | 年报 / 招聘信息 / 公司公开资料 |
| GROWTH | 营收增长（近 1 年） | growth +5 | 年报 / 公司公开资料（营收同比，需来源引用） |
| INDUSTRY_STATUS | 细分领域头部 / 市占率领先 | credibility +5 | 行业报告 / 公司公开资料（需来源引用） |
| OPPORTUNITY | 招聘活跃（近 3 个月有岗位发布） | opportunity +5 | BOSS直聘 / 猎聘 / 智联 / 公司招聘页 |
| RISK | 经营异常 | stability -20 | 国家企业信用信息公示系统（经营异常名录） |
| RISK | 失信 / 被执行人 | stability -30 | 中国执行信息公开网 / 信用中国 |
| RISK | 大额诉讼 / 劳动纠纷频繁 | stability -10 | 中国裁判文书网 / 公示系统司法信息 |

### 信号 grounding（规则来源依据，不凭经验写分）

规则表与主流企业信用评价体系对齐（调研 2026-08-08）：

- **维度对齐**：启信分 6 大类（公司成长性/资本背景/经营质量/企业规模/知识产权/风险状况，
  千分制）→ 本契约 5 维一一对应；GB/T 22120-2025《企业信用数据项要求》数据项类别
  （司法裁判及执行 / 经营异常名录 / 荣誉信息 / 知识产权）→ RISK / CERTIFICATION / PATENT 对应
- **职业机会维度有依据**：招聘/经营状况是主流评分数据（新华信用：行政许可/年报/招聘/舆情
  属经营信息）——OPPORTUNITY 不是自创维度
- **评分机制选择**：主流采用定性+定量加权（企业信用评价标准：指标权重 ≥70%）或 ML 模型
  （台州双维评价：XGBoost/随机森林）；本契约**保持「基础分 + 信号加减」可解释模型**——
  决策可审计 > 预测精度，符合 Career OS 分水岭（Claim Strength ≤ Evidence Strength）
- **公共信用评价参考**：国务院 2026《企业信用状况综合评价体系实施方案》——公共信用评价
  A/B/C/D 四级、「信用中国」公示；本契约不引用外部评级结果，只采原始信号自行计分

### 计分公式（确定性纯函数）

```
score(facts) = clamp(50 + Σ dimension 贡献, 0, 100)   // 受 status 门控（见 §5）
```

- **基础分 50 的门控**：基础分只在「已确认事实 ≥ 1 条」后参与计算。无任何事实 →
  qualityScore = null（INSUFFICIENT_DATA）——**未知 ≠ 中等**，同 NOT_DECLARED ≠ FALSE。
- 同一组事实永远产出同一分数：无随机、无 AI 判断。

### 重复信号去重（按 Signal Group，非「取最高绝对值」）

| Group | 规则 |
|-------|------|
| Certification | **取最高级别**（国家级 > 省级 > 高新技术企业；国家级 +10 覆盖其余，不叠加） |
| Financing | **取最新最高轮**（C > B > A；B 轮覆盖 A 轮，不叠加） |
| Patent / IndustryStatus / Opportunity | 同类自然单条（一般只写一次） |
| Risk | **可叠加**（经营异常 -20 + 失信 -30 = -50；风险是独立事实，不互斥） |

## 5. CompanyAssessment Schema（Layer 3，Engine 派生）

```ts
type AssessmentStatus = 'EVALUATED' | 'PARTIAL' | 'INSUFFICIENT_DATA'

interface CompanyAssessment {
  version: 'v0.1'             // 评分规则版本（契约冻结时定）
  ruleVersion: string         // 规则表版本标识（如 '2026-08-company-quality-v2'）
  assessedAt: string          // ISO 时间——「为什么去年 85 现在 78」的可审计锚点
  status: AssessmentStatus
  qualityScore: number | null
  dimensions: {
    credibility: number
    growth: number
    technology: number
    opportunity: number
    stability: number
  }
  signals: CompanySignal[]   // 参与计分的信号明细（Group 去重后）
}

interface CompanySignal {
  factId: string        // 引用 CompanyFact.id（稳定回源）
  factType: CompanyFactType
  value: string        // 命中的枚举值
  points: number       // 总分贡献（Σ 该信号维度贡献）
  evidence: { source: string; url?: string }
}
```

**status 判定（v0.1 规则，确定性）**：

| status | 条件 |
|--------|------|
| INSUFFICIENT_DATA | 已确认事实 = 0 条 → qualityScore = null |
| PARTIAL | ≥1 条事实，但覆盖维度 < 3 维 |
| EVALUATED | ≥3 个维度有信号贡献 |

status 是分数可信度标注，不是质量评价：PARTIAL 的 60 分不因「只覆盖 2 维」而贬值，
而是标注「信息尚不完整」。

## 6. Evidence 要求（Claim Strength ≤ Evidence Strength）

- 每条 fact 必带 `evidence.source`（官网/工信部公示/工商信息/新闻等）；**无来源的 fact
  不计分**（degraded，UI 标「待确认」）
- `evidence.url` 可选但鼓励填写（可回源是 Career OS 的分水岭）
- 公司事实证据 = **外部公开来源**，不是 person 画像的 EvidenceRef（内源引用）——
  两类引用不混用

## 7. 存储与写入边界（Artifact Format Rule v0.1）

**companies/{公司名}.md 只新增 `## 公司事实` 段**（Agent 写，table = structured payload），
摘要表不动（SUMMARY_RE / COMPANY_FIELD_MAP 协议风险）：

````markdown
## 公司事实

| 类型 | 内容 | 来源 | 链接 |
|------|------|------|------|
| CERTIFICATION | 国家级专精特新小巨人 | 工信部公示 | https://... |
| FINANCING | B轮（2025-06） | 新闻 | https://... |
````

**段级所有权**：
- Agent（company-research 尽调）写 `## 公司事实`——事实区，Agent owns
- Engine 检测事实段变更 → 计分 → **只进 Projection（CompanyAssessment Projection），
  不回写 markdown**——评估是派生数据（Projection Artifact），回写会长期污染档案
  （事实变更 → watcher → 改写 markdown → git diff 噪音）

### §7.1 CompanyFact Producer（Agent 生产契约）

**允许写**（表格 = structured payload，4 列固定）：

````markdown
## 公司事实

| 类型 | 内容 | 来源 | 链接 |
|------|------|------|------|
| CERTIFICATION | 国家级专精特新小巨人 | 工信部公示 | https://... |
| FINANCING | B轮融资 | 新闻 | https://... |
````

**禁止**：
- **narrative 式事实**——「Company-B是一家非常优秀的成长型企业」不是 fact 是 prose；prose 归
  `## 尽调详情` 正文（untrusted narrative，不参与计分）
- 自造类型或内容——类型必须 ∈ CompanyFactType 枚举；内容必须 ∈ §4 规则表 value 枚举
  （枚举外 → UNKNOWN_VALUE 不计分，UI 标「待确认」；自造信号套分 = 越权）
- **缺来源**——来源列为空 → NO_EVIDENCE 不计分（Claim Strength ≤ Evidence Strength）
- 写 `id`——id 由 Engine 生成（`factIdOf(companyId, type, value)` 稳定哈希），Agent 不写

**来源要求**：外部公开渠道（官网 / 工信部公示 / 新闻 / 公示系统等，见 §4 数据源列）；
来源是 evidence 锚点，不是「听说的」。

### §7.2 CompanyFact Parser（Engine 消费契约）

- 段落定位：`## 公司事实` 标题 → 下一 `##` / `---` / EOF 之间的首个表格
- 列映射：第 1 列类型 / 第 2 列内容 / 第 3 列来源 / 第 4 列链接（可选），跳过表头与分隔行
- 类型列不在枚举 → 该行不产出 fact，进 `unknownRows`（不静默丢，上层可展示/记录）
- id = `factIdOf(companyId, type, value)`——同事实跨次解析 id 稳定（来源变化不改 id，
  事实身份不变；companyId 隔离不同公司）
- 档案无 `## 公司事实` 段 → 返回空数组（不 crash，旧档案兼容）

**Known Future**：未来导出报告（如简历附件/公司报告）时按需生成 `## 公司评估快照`
段落——是导出产物，不是实时写入。

## 8. 投影与 RPC

- company-watcher：检测 `## 公司事实` 段变更 → 触发计分 → 更新投影 → 广播 `data.companies.changed`
- projection：`CompanyRecord` 扩展 `assessment: CompanyAssessment | null`（null = 未评估 → UI「待评估」）
- `companies/list` RPC 返回扩展字段，UI 无新增 RPC（消费同一条链）
- 旧档案（无事实段）不崩：assessment = null
- 事实段 value 枚举外 / 缺 evidence → degraded（不计分），不影响其他事实计分

## 9. UI Projection（Evidence > Impression，不用星级）

```
Company-B 智控

公司职业价值   85/100        ← 新（Engine 计分；null → 「待评估」）
匹配程度      52%            ← 已有（不动）

依据:
✓ 国家级专精特新 · B轮融资 · 招聘活跃      ← 加分信号（Group 去重后）

风险:
⚠ 经营异常                                ← Risk 信号（负向独立展示）
⚠ 信息不足                                ← degraded 事实（枚举外/缺来源）
```

- **不用星级**——星级引入主观消费感，Career OS 一贯 Evidence > Impression
- 质量分 + 匹配度并排展示，各不解释（§1 三线分离）
- PARTIAL 状态标注「信息尚不完整」，INSUFFICIENT_DATA 显示「待评估」
- 匹配度行文案与位置不动（ADR-018 语义冻结）

## 10. v1 边界（不做什么）

- 不做批量筛选排序（「按质量分排公司列表」——用户未声明，触发未到）
- 不做 Decision Confidence（属 Decision Record，另一条线）
- matchScore / 摘要表 / screener 技能层规则不动
- 不做 company_id、不做多主体关系建模（维持各自触发条件）
- 不建第二套公司资产体系（事实段在同一档案内；评估段不落盘）
- 评估不回答「是否值得投递」（Known Future，§1）

---

Related:
- ADR-018（Company Score Semantic Boundary——语义上游；本契约是其 Future 条件的实现）
- ADR-017（Career Decision Loop v1——三层分离路线参照）
- company-file-contract.md（公司档案现有落盘契约——摘要表/尽调详情段不动）
- 记忆：[[company-module-lifecycle-todos]]、[[career-decision-loop-v1]]
