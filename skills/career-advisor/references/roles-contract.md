# Roles 生产契约（knowledge/roles.md）

> 2026-08-07 冻结 | P1 roles.md Producer Contract
> 一句话：**roles.md 是「公司岗位实例库」**——每个条目 = 一家公司在招/已分析的具体岗位，
> 不是泛化的市场岗位通识库（那是远期 Career World Model，见开发愿景命名约束）。

## 一、语义边界（是什么 / 不是什么）

**是**：

- 公司岗位实例：`## 岗位名（公司名）` + 技能需求（`essential:` / `nice-to-have:`）+ **来源引用**
- 消费端：信息池图谱 role 节点（雇佣边 → 公司、需求边 → 技能）、差距分析技能矩阵（JD 匹配）
- 判定标准：条目必须能回答「**哪家公司在哪个岗位**」——只有岗位名没有公司的条目无效
  （引擎已按缺公司名 warn）

**不是（禁止）**：

- 泛化市场知识库（「机械工程师一般会什么」——岗位通识归远期 Career World Model，不写这里）
- 个人技能声明（归 skill_inventory / profiles）
- 公司尽调报告（归 companies/{name}.md）

## 二、生产流程（谁在什么时候写）

两条入口，同一契约：

| 入口 | 时机 | 触发者 |
|------|------|--------|
| JD 分析后 | JD 建档/分析完成，岗位需求可提取 | jd-analysis 流程（含 UI 建档后的 Agent 分析） |
| 公司尽调发现岗位 | 尽调报告确认公司在招岗位（如公司官方在招岗位、JD 可见） | company-research 收尾 |

**先查已有条目再写**：同公司同名岗位已登记 → 更新技能需求，不重复建条目
（对齐 Company Artifact Admission：同主体只允许一份档案）。

## 三、Producer Boundary

| 字段 | Producer | 说明 |
|------|----------|------|
| 岗位实例存在（公司+岗位名） | Agent 提议（从 JD/尽调提取）+ **Engine 解析登记** | 存在性来自具体文档，不凭空生成；无来源文档支撑的岗位禁止登记 |
| 技能需求（essential/nice-to-have） | Agent（判断） | 从 JD/档案提取——AI 推理结果 |
| 来源引用（`来源:xxx`） | Agent + **必填** | 证据锚点——需求必须能回溯到文档（Claim Strength ≤ Evidence Strength）；缺来源引擎 warn |
| 岗位 id（`{name}-{company}`） | Engine（派生） | 系统派生，禁止手写 |
| company 引用 | Engine 解析（canonical/alias） | 对齐 Company Reference Closure（1209546） |

## 四、格式与字段规则

````markdown
## 岗位名（公司名）

- essential: 技能名（来源: 文档标识）
- nice-to-have: 技能名（来源: 文档标识）
````

| 规则 | 要求 |
|------|------|
| 岗位名 | 用 JD/尽调中的正式岗位名；同名岗位跨公司各记一条（id 含公司，天然区分） |
| 公司名 | **canonical reference，不是自由文本**——写入前先查 companies/ 档案（对齐 Company Artifact Admission Step 0），岗位标题公司名写**解析后的档案名**；JD 简称/工商全称若与档案名不一致，禁止直接写入（alias 由公司档案声明，岗位清单不发明新名称）。实例：「心玮医疗」是档案名，「上海心玮医疗科技股份有限公司」是 alias——岗位写「管理培训生（心玮医疗）」 |
| 技能名 | 优先词表技能（knowledge/skills.md）；词表外可写（引擎按别名归一化反查，未入表原样保留） |
| 来源标识 | `JD-{公司}-{日期}`（如 `JD-汇川技术-2026-08-02`）/ `公司档案-{公司}`（对齐现有 roles.md 惯例；{公司} 用档案名） |
| 来源必填 | 需求项必须带 `（来源:…）`；不带来源 = 无证据锚点的判断，引擎 warn |

## 五、暂不做（触发条件未到，记录不建）

| 项 | 触发条件 |
|----|----------|
| role_id 系统登记 | 岗位被用于推荐排序/决策引用（skillRefs）落地时 |
| role watcher / 广播 | 岗位变更需要 UI 实时感知时（当前目录扫描式，图谱/gap 每次拉取重扫） |
| role registry（独立身份系统） | 岗位需要跨公司身份（同岗位多名主体建模）时 |
| 市场通识知识库 | Career World Model（远期，独立系统） |

## 六、参考

- 引擎解析实现：`engine/storage/knowledge-watcher.ts`（parseRolesMarkdown）
- 消费端：`engine/storage/graph-builder.ts`（雇佣/需求边）、`engine/runtime/gap-calculator.ts`（技能矩阵）
- 对齐契约：`references/career-profile-contract.md`（语义冻结模式）、`sub-skills/company-research/references/company-file-contract.md`（Producer Boundary 模式）
