# Evidence Sufficiency Contract v0.1（Proposed，2026-08-26）

> **尚未冻结**：ADR-035 语义冻结通过后本契约方可作为实现依据（Phase 2 task-protocol /
> Phase 3 Validator + Golden Flow 的输入）。
> 定位：**Agent 声明「检索证据状态」的结构化协议**（不是 Prompt 文档，不是分析教程）。
> 前置契约：`docs/ADR/035-agent-evidence-sufficiency-boundary.md`（边界裁定）、
> `agent-task-contract-v0.1.md`（taskType/outputTarget=none）、
> `company-assessment-contract-v0.1.md`（CompanyFact 枚举——本契约的**分离声明**对象）、
> `jd-analysis-agent-output-contract.md`（岗位提取来源锚点——双轨并行，不互相替代）。

---

## A. 适用范围（v0.1 Reference Implementation）

- **试点任务类型（唯一）**：`company_research`（`required(company)`；`outputTarget=none`——纯问答，
  SUFFICIENCY_STATE 随 Agent 最终回答产出，不作为 workspace 资产）。
- **证据通道（按任务注册面）**：WebSearch（hosted）/ WebResearch + WebFetch（exa）/
  QueryMacroStats · CompareRegionProfiles（nbs）。各通道 session 独立预算（config 既有旋钮）。
- **不适用**：`job_analysis`（既有来源锚点契约管辖）、decision 类任务、explanation。
- **泛化条件（试点后评估，不做提前抽象）**：维度清单按任务类型可换；**状态枚举、折叠规则、
  下一动作映射、Validator 检查项不随任务类型而变**——满足才可泛化到
  job_lead_search / salary_benchmark_search / interview_preparation。

## B. Evidence Dimension 定义（检索证据维度，9 维）

**分层声明（与既有概念分离，禁止混用词表）**：

| 层 | 概念 | 回答 | 归属 |
|---|---|---|---|
| 本文 | Evidence Dimension（检索证据维度） | 「这次调查覆盖了什么」 | 本契约 |
| CompanyFact（7 枚举） | 公司价值评分信号 | 「这家公司值不值得关注」 | company-assessment-contract（事实层） |
| evidence coverage（M2） | 岗位要求 ↔ 人证据匹配 | 「这岗位我的证据能不能覆盖」 | evidence-coverage.ts（三态 covered/partial/missing） |

**维度清单（critical = 直接支撑「该不该关注这家公司」结论且结论性强——缺失/冲突会显著影响判断）**：

| key | 中文 | 回答的问题 | critical | 预期证据形式 | 适用通道（优先级） |
|---|---|---|---|---|---|
| company_overview | 公司概况 | 是什么 / 规模 / 成立时间 / 行业地位 | 否 | 官网·百科·工商 | web_search > exa |
| industry | 行业 | 所处行业 / 景气 / 赛道 | 否 | 行业报告·新闻 | exa > web_search |
| products | 产品 | 产品线 / 技术方向 | 否 | 官网·新闻·专利 | web_search > exa |
| business | 业务 | 商业模式 / 客户 / 市场 | 否 | 官网·报告 | web_search > exa |
| hiring | 招聘活跃 | 近期是否招人 / 岗位结构 / 规模 | **是** | 招聘平台·官网招聘页 | web_search > exa |
| salary | 薪资水平 | 岗位薪资区间 / 口径 | **是** | 招聘平台（**必须标注口径**）；NBS 宏观统计 | nbs > web_search > exa |
| financing | 融资 | 轮次 / 时间 / 规模 | 否 | 融资平台·新闻 | web_search > exa |
| risk | 风险 | 经营异常 / 诉讼 / 失信 / 负面舆情 | **是** | 公示系统·裁判文书·信用平台 | exa > web_search |
| career_development | 职业发展 | 晋升 / 培养 / 成长性 | **是** | JD 描述·员工评价·公开资料 | web_search > exa |

- **适用通道 = Standard 声明「这个维度应该去哪里找」**（维度特定，非全局通道优先级——v0.2 修正：
  UNCERTAIN 定向再查不再使用全局 NBS > Exa > WebSearch，改为本表优先序）；
  通道未启用（工具集未注册）/ 预算耗尽 ⇒ `available(dim) = ∅`（§D 的 finalize 路径）。
- **证据性质层级（tier 标注，仅用于 `sources[].tier` 透明度，不驱动通道选择）**：
  `internal`（公司档案/本地资产）> `official` > `statistics` > `recruiting` > `aggregator`。
- 维度**不**等于 CompanyFact 枚举：如 financing 维度与 CompanyFact.FINANCING 同源可互相引用，
  但本契约只描述**检索证据状态**，不参与计分、不写回公司档案。
- 关键性 v0.1 定为：**risk / salary / hiring / career_development**（critical）；其余为背景维度
  （缺失只降叙述深度，不阻止结论）。

## C. Evidence Status 定义（两层级枚举，冻结级）

### C.1 维度状态（`dimensions[].status`，Agent 逐维度标注）

| 枚举 | 含义 |
|---|---|
| `RESOLVED` | ≥1 个来源支撑该维度结论，无未解释冲突、无口径/时效疑问 |
| `UNCERTAIN` | 有来源但不足以支撑强结论：单一来源 / 口径未明 / 样本不足 / 时效存疑 |
| `CONFLICTED` | ≥2 个**独立来源**实质结论不一致，且尚未消解 |
| `UNCOVERED` | 无来源支撑（明确「未获取」；**禁止**填「-」伪装已评估——与 jd 契约「JD 未写不产出」同纪律） |

**独立性定义（确定性）**：registrable domain 不同 ⇒ 独立；同域不同页 / 转载 / 聚合站 ⇒ 不独立
（与 web-search 来源归一 `extractSourceUrls` 同词表）。

### C.2 总体状态（`state`，Agent 按折叠规则声明）

| 枚举 | 含义 |
|---|---|
| `SUFFICIENT` | 所有 critical 维度 RESOLVED，且无未解释的 critical 冲突；**非 critical 维度的 UNCERTAIN/CONFLICTED 不阻止**（须记录，保持透明） |
| `GAP` | 存在 critical 维度 UNCOVERED |
| `CONFLICTED` | 存在 critical 维度 CONFLICTED（未消解） |
| `UNCERTAIN` | 无 GAP/CONFLICTED，但存在 critical 维度 UNCERTAIN |

### C.3 确定性折叠规则（Standard 规则；Validator 可机械校验）

```
只看 critical 维度：
  存在 CONFLICTED    → state = CONFLICTED
  否则 存在 UNCOVERED → state = GAP
  否则 存在 UNCERTAIN → state = UNCERTAIN
  否则                → state = SUFFICIENT
```

- **逐维度语义是 Agent 判断；总体状态是确定性折叠**——总体状态不被 Agent 自由心证，
  这正是「充分性是协议执行，不是感觉」。

## D. 下一动作（`nextAction` = 确定性判定函数，冻结级）

```text
nextAction = derive(state, unresolved, retries, availableChannels, budgetFacts)

输入：
- state              = 声明值（§C.2；合法性由 §C.3 折叠保证）
- unresolved         = critical 维度中 status ≠ RESOLVED 的集合
- retries[dim]       = 每维定向再查次数（§E；值域 {0,1}，Agent 声明）
- available(dim)     = applicableChannels(dim) ∩ 本次执行允许工具集 − budget_facts 中已耗尽的通道
- budgetFacts        = trace 中 budget_exhausted(channel) 的集合（Runtime 事实，§G）

判定（按序，首条命中即输出）：
1. state = SUFFICIENT                                       → stop
2. state = GAP：∃ dim ∈ unresolved(UNCOVERED) ∧ available(dim) ≠ ∅ ∧ retries[dim] = 0
                                                           → continue
   否则                                                     → finalize（limitation: gap）
3. state = CONFLICTED：∃ dim ∈ unresolved(CONFLICTED) ∧ available(dim) ≠ ∅ ∧ retries[dim] = 0
                                                           → continue
   否则                                                     → finalize（limitation: conflict）
4. state = UNCERTAIN：∃ dim ∈ unresolved(UNCERTAIN) ∧ available(dim) ≠ ∅ ∧ retries[dim] = 0
                                                           → continue
   否则                                                     → finalize（limitation: uncertainty）
```

- **一次 continue = 对最需解决的一个维度发起一次定向再查**（按 §B 该维度的适用通道优先序，
  取当前可用且优先级最高者）；`retries[dim] += 1`。
- 通道 = trace 命名空间（web_search / exa / nbs）；`applicableChannels(dim)` 见 §B 表。
- Validator 以本函数做**全量机械校验**（§I.9）：`nextAction == derive(...)`——不是区间、不是解释。

## E. 定向再查规则（bounded retry，冻结级）

**证据策略驱动循环（每 critical 维度有界），MAX_STEPS（runtime 既有）仅作失控保险，不是循环控制机制。**

| 维度状态 | 允许次数 | 再查目标（按 §B 适用通道优先序，取可用通道中的最高优先者） |
|---|---|---|
| `UNCOVERED` | ≤1 | 目标来源直接尝试一次（公示 / 官方 / 招聘站） |
| `UNCERTAIN` | ≤1 | 更高质量来源一次（**维度特定通道优先序，非全局 NBS > Exa > WebSearch**） |
| `CONFLICTED` | ≤1 | 至多 **1 个新的独立来源域**（来源域 ≠ 已引用域） |

- **非 critical 维度 UNCERTAIN/CONFLICTED**：不触发再查（记录 `note`/`conflicts`，保持透明），
  不阻止 SUFFICIENT。
- **再查后状态迁移**：UNCOVERED → RESOLVED / UNCERTAIN / CONFLICTED（按 §C.1 语义）；
  UNCERTAIN → RESOLVED，或仍 UNCERTAIN（finalize），或转 CONFLICTED（转冲突分支）；
  CONFLICTED → 消解（状态改 RESOLVED + conflicts 记录 resolution）或仍冲突（finalize）。
- **通道不可用**：该维度全部适用通道不可用（未启用 / 预算耗尽）→ 不降级重复，直接 finalize
  （limitation 对应类型）——**避免「循环继续」退化为 MAX_STEPS 兜底**。
- **retries 是 Agent 协议声明**（值域 {0,1}）：Validator 校验值域（§I.6）与 finalize 路径
  一致性（§I.11）；**不核对** retries 与 trace 调用的逐次对应——tool call → 维度归属无法机械穷举
  （诚实边界：精确执行靠协议纪律，由真机样本抽查）。

## F. Stop 条件（汇总）

1. **正常停**：`state = SUFFICIENT`——该状态合法性由 §C.3 折叠保证；**无关通道的预算耗尽
   不阻止**（§G——预算事实 ≠ 质量判决）。
2. **充分即停**：停止后不再发起任何检索调用，**无论预算是否仍剩余**。
3. **将就停（finalize）**：GAP / CONFLICTED / UNCERTAIN 的 fallback 路径（§D 判定函数），
   **必须**携带对应 limitations（带缺口/冲突/不确定性结束 ≠ 伪装完成）。
4. **强制停（通道级）**：budget_exhausted → 工具拒绝（Runtime 现有行为）→ 该通道不可用；
   Agent 按 §D 判定：仍有其他适用通道 → continue；否则 → finalize。**不得再调用被拒通道**。

## G. Budget Exhausted 处理

- **事实来源**：通道 session trace 的 `budget_exhausted` 事件（tool-stats `SESSION_EVENT_KEY`
  既有采集，**不新增**）。
- **语义（v0.2 修正）**：预算耗尽**阻止的是 `continue`，不是追溯否定已成立的 SUFFICIENT**。
  预算事实只有两个确定性消费点：
  - **消费点 1（§D derive 的通道可用性）**：`budget_exhausted(channel)` ⇒ 该通道在所有维度的
    `available(dim)` 中视为不可用——影响的是「还能不能继续」，不是「是否充分」；
  - **消费点 2（记录义务）**：本次运行存在的每个 `budget_exhausted(channel)` 必须逐项记录
    （`type: 'budget_exhausted', channel, dimension?, note`）——记录与"该通道是否仍相关"**无关**
    （事实透明）。
  - **SUFFICIENT 合法性由 §C.3 折叠一致性自动保证**：存在未解决 critical 维度 ⇒ fold ≠ SUFFICIENT
    ⇒ 无需「全局一票否决」，也无需「条件化否决」（后者与折叠规则等价，冗余条款不写）。
- **Agent 行为**：收到拒绝后——① 不得再调用该通道；② 若有未解决维度且仍有其他适用通道
  （§D derive = continue）→ 继续；否则 → finalize；③ limitations 逐项记录预算事实。
- **机械校验（Validator/Engine 侧）**：见 §I.10（记录义务）+ §I.9（derive 全量校验）+
  §I.8（折叠一致性——SUFFICIENT 合法性的唯一来源）。

## H. 输出结构（Agent 最终回答末尾，冻结级）

Agent 最终回答的**最后一段**：

````md
## SUFFICIENCY_STATE

```json
{
  "sufficiency": {
    "state": "CONFLICTED",
    "dimensions": [
      { "key": "salary", "status": "CONFLICTED", "retries": 1,
        "sources": [ { "domain": "zhipin.com", "tier": "recruiting" },
                     { "domain": "liepin.com", "tier": "recruiting" } ],
        "note": "口径差异：8-12K 税前月薪 vs 12-18K 年包估算（附来源）" },
      { "key": "risk", "status": "RESOLVED", "retries": 0,
        "sources": [ { "domain": "gsxt.gov.cn", "tier": "official" } ],
        "note": "经营异常名录无记录" },
      { "key": "financing", "status": "UNCERTAIN", "retries": 0,
        "sources": [ { "domain": "itjuzi.com", "tier": "statistics" } ],
        "note": "单来源，近 3 年数据未独立确认" }
    ],
    "conflicts": [ { "dimension": "salary", "note": "税前月薪 vs 年包估算口径不一致" } ],
    "limitations": [],
    "nextAction": "continue"
  }
}
```
````

> **示例为节选**（仅示 3 键示意结构）——实际输出 `dimensions` 必须含全部 9 键（§I.4），
> 未列出的维度同样需要条目（状态可为 UNCOVERED/UNCERTAIN，不得省略）。

**字段定义**：

| 字段 | 类型 | 规则 |
|---|---|---|
| `state` | enum | SUFFICIENT / GAP / CONFLICTED / UNCERTAIN（§C.2） |
| `dimensions[].key` | string | 必须覆盖 §B 全部 9 维（无缺失、无多余） |
| `dimensions[].status` | enum | RESOLVED / UNCERTAIN / CONFLICTED / UNCOVERED（§C.1） |
| `dimensions[].retries` | number | 该维度定向再查次数（§E；值域 {0,1}，Agent 协议声明） |
| `dimensions[].sources[].domain` | string | registrable domain；RESOLVED/UNCERTAIN/CONFLICTED 维度 ≥1 条；UNCOVERED 允许空数组 |
| `dimensions[].sources[].tier` | enum | internal / official / statistics / recruiting / aggregator |
| `dimensions[].note` | string | 口径/时效/缺口说明（UNCOVERED 必须说明「未获取什么/为什么」） |
| `conflicts[].dimension` | string | 必须对应 status=CONFLICTED 的维度（§I.7） |
| `conflicts[].note` | string | 冲突实质（各来源结论 + 差异点） |
| `limitations[]` | enum + 字段 | 见 §G（type: budget_exhausted / gap / conflict / uncertainty；**语义**：budget_exhausted=通道被拒事实；gap=存在 UNCOVERED 关键维度；uncertainty=有来源但样本/口径/时效不足（含非关键维度）；conflict=存在未消解冲突——v0.3 澄清，Golden-D 真机发现误用） |
| `nextAction` | enum | stop / continue / finalize（§D 判定函数） |

- 正文纪律（中文、无过程叙述）沿用 task protocol；SUFFICIENCY_STATE 是**结构化声明**，
  **不是**正文替代——正文给出结论 + 关键来源引用，状态段给出审计声明。
- **SUFFICIENCY_STATE 不是 Evidence Trace 的替代品**：`sources[]` 只保存「哪些域支持这个维度」
  的语义引用摘要（domain + tier），**不承担**证据原文、URL、时间戳或 ToolTrace 的事实存储职责——
  URL 级事实由 Tool Evidence Contract（`tool_done.evidence` / trace 工具调用记录）承载，
  两者是「语义声明」与「事实记录」的关系，禁止互相替代。
- 若 Agent 声明 state=SUFFICIENT：正文结论必须与 dimensions 的 RESOLVED/critical 一致
  （结论不超出已标注状态——Claim Strength ≤ Evidence Strength 同源纪律）。

## I. Validator 检查清单（全部机械、无 LLM 判断）

1. **存在性**：最终回答末尾含 `## SUFFICIENCY_STATE` + json 代码围栏。
2. **解析与字段齐全**：JSON 可解析；state/dimensions/conflicts/limitations/nextAction 存在。
3. **枚举合法性**：state ∈ 4 态；dimension.status ∈ 4 态；tier ∈ 5 枚举；
   nextAction ∈ 3 值；limitations[].type ∈ 4 值。
4. **完整性**：dimensions.key 集合 == §B 9 键（无缺失、无多余）。
5. **来源规则**：RESOLVED/UNCERTAIN/CONFLICTED 维度 sources ≥1（domain 为主域格式）；
   UNCOVERED 维度 sources 为空且 note 非空。
6. **再查配额**：dimensions[].retries ∈ {0,1}（§E）。
7. **冲突一致性**：conflicts[].dimension 对应维度 status == CONFLICTED。
8. **折叠一致性**：`state == fold(critical dimensions)`（§C.3）——不一致 = 违规；
   **SUFFICIENT 合法性的唯一来源**（含「预算耗尽后不得伪造 SUFFICIENT」情形——
   未解决维度存在时 fold 自然不等于 SUFFICIENT，无需独立否决规则）。
9. **下一动作一致性**：`nextAction == derive(state, unresolved, retries, availableChannels,
   budgetFacts)`（§D 判定函数；输入 = 声明 + 执行上下文（允许工具集）+ 预算事实）
   ——全量机械校验，非区间、非解释。
10. **预算事实记录义务**：存在 `budget_exhausted(channel)` ⇒ limitations 含该 channel 条目
    （与"该通道是否仍相关"无关——事实透明，§G）。
11. **陈述交叉一致性**（限结构化段内部，纯枚举比对）：limitation=`conflict` ⇒ conflicts 非空；
    limitation=`uncertainty` ⇒ 存在 status=UNCERTAIN 的维度 **且**（该维度 retries=1 或
    其适用通道均不可用）；limitation=`gap` ⇒ 存在 status=UNCOVERED 的维度。
    **不解析正文语义**——正文与状态段的一致性由「Claim Strength ≤ Evidence Strength」
    纪律约束（§H），不设机械检查（语义判断越界）。

- 违规处理策略：**标记 + 展示「充分性声明无效」**，不自动重跑、不自动修复（无 AI Judge）。
  UI 与执行记录层面保留违规标记，人工/任务重试走后置通道。

## J. 不负责什么（冻结级）

1. **不做 Quality Score**——无评分、无分数、无阈值加权、无「来源数量达标即好」。
2. **不做内容真实性裁判**——来源真假/数据对错不在本契约；独立性与权威层级提供的是
   **透明性**，不是证明。
3. **不替代 Company Assessment**——公司好坏/职业价值 = ADR-018 域（Engine 确定性计分）。
4. **不管理 M2 evidence coverage**——岗位↔人证据匹配是另一个域，术语禁止混用。
5. **不决定 Runtime 预算**——那是 config 旋钮 + session 强制的事。
6. **不修改 Execution 状态机 / 完成枚举**——v0.1 完成语义 = `completed + limitations[]`。
7. **不新增资产域 / 不改 UI 行为**——v0.1 仅协议 + 校验结构。

---

## 附录 A：验收样本（Golden Flow，Phase 3 执行）

| # | 场景 | 注入条件 | 预期 | 验证点 |
|---|---|---|---|---|
| A | 正常充分 | 检索 3 次即获 salary/risk/hiring/career_development 充分来源 | state=SUFFICIENT, nextAction=stop，**提前停止**（预算剩余） | 充分性 = 停止条件，不是「烧完预算」 |
| B | 明显缺口 | 构造 risk 维度无来源 | state=GAP, nextAction=continue（定向再查一次） | 缺口驱动继续，不是次数驱动 |
| C | 来源冲突 | salary 两独立来源口径冲突 | state=CONFLICTED → 继续（独立来源）→ 无法消解 → nextAction=finalize + limitation=conflict + 诚实区间输出 | 冲突 > 次数；诚实输出优于伪精确 |
| D | 预算耗尽（关键） | `agent.search.budgetPerTask=1`（临时配置）；risk/salary 等 critical 未解决 | 第 2 次搜索被拒（被拒通道属未解决维度的适用通道）→ 该通道不可用 → 不得声明 SUFFICIENT（折叠保证）→ finalize 或经其他通道继续，limitations 含 budget_exhausted | **Agent 语义状态与 Runtime 事实分权**（核心验证） |
| E | 通道耗尽但充分成立 | Exa+NBS 已解决全部 critical；WebSearch 随后耗尽（无关通道） | state=SUFFICIENT 合法；limitations 记录 budget_exhausted（事实透明） | **预算事实 ≠ 质量判决**（§G 修正的正例） |

- 执行方式：Validator 单测（A/B/C/D/E 构造输出）+ D、E 样本真机各一次（覆盖真实 rejection /
  无关通道耗尽路径）。
- 验收通过标准：五样本满足预期；其中 **D、E 为红线验收**（若 D 或 E 失败，本契约语义不成立，
  回到 ADR-035 重新评审，不得绕行）。

---

## 修订记录

- v0.1（2026-08-26）：起草（调研验证 + 用户评审脚本；语义冻结后置）。
- v0.2（2026-08-26，用户评审收紧 4 点 + 自检修正）：① budget_exhausted 取消全局一票否决——
  预算事实收敛为两个确定性消费点（derive 通道可用性 + limitations 记录义务）；SUFFICIENT 合法性
  由折叠一致性唯一保证（§G）；② UNCERTAIN 定向再查的通道优先级维度化（§B 适用通道，取消全局
  NBS > Exa > WebSearch）；③ 补充 per-dimension bounded retry（UNCOVERED/UNCERTAIN/CONFLICTED
  各 ≤1，§E）；retries 声明值域 {0,1} 且与 trace 调用不逐次核对（诚实边界）；④ nextAction
  升级为确定性判定函数 `derive(...)`（§D）；⑤ 附录 A 增补 E 样本（无关通道耗尽不阻止 SUFFICIENT）；
  ⑥ SUFFICIENCY_STATE 明确不是 Evidence Trace 替代品（§H）。
- v0.3（2026-08-26，Golden-D 真机发现驱动）：limitations[].type 语义澄清（§H 字段定义）——
  `gap` 仅当存在 UNCOVERED 的关键维度时使用；样本/口径/时效不足一律 `uncertainty`（含非关键维度）；
  §I.11 的 uncertainty 交叉一致性规则只检验**关键** UNCERTAIN 维度（非关键维度不触发再查、不阻止
  finalize——§E 已裁定，不得反向适用），并同步补回归测试（Golden-D 场景）。
- v0.4（2026-08-26，Phase 4 真机发现驱动——完成语义接入首跑）：limitation=uncertainty 语义
  再收紧——**仅当存在状态为 UNCERTAIN 的维度时使用**（声明"该维度带不确定性结束"）；结论内部的
  限定措辞（如"未检索到 ≠ 不存在"）属于维度 note/正文，**不得写入 limitations**（否则 I.11
  交叉一致性判违规——引擎已按此抓出真实声明漂移，语义确认保持）。
