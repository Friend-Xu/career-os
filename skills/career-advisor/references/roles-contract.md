# Roles 生产契约（knowledge/roles.md）

> 2026-08-07 冻结 v0.1 → 2026-08-21 修订 v0.2（Producer Boundary 落地）
> 一句话：**roles.md 是「公司岗位实例库」**——每个条目 = 一家公司在招/已分析的具体岗位，
> 不是泛化的市场岗位通识库（那是远期 Career World Model，见开发愿景命名约束）。
> v0.2 变更：roles.md 由 **Engine 投影落盘（Registration）**，Agent 不再直写文件——
> 全部登记走 `role-proposals/` 提案通道（CLI 桥 `--role-submit {json}`），Engine 校验后投影。

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

## 二、生产流程（谁在什么时候写）——v0.2 提案通道

**Agent 禁止直写 `knowledge/roles.md`**（引擎投影单方维护，直写会被下一次投影覆盖）。
两条入口，同一提案通道：

| 入口 | 时机 | 触发者 | 通道 |
|------|------|--------|------|
| JD 分析后 | JD 建档/分析完成，岗位需求可提取 | jd-analysis 流程（含 UI 建档后的 Agent 分析） | CLI 桥 `--role-submit {json}` |
| 公司尽调发现岗位 | 尽调报告确认公司在招岗位（如公司官方在招岗位、JD 可见） | company-research 收尾 | CLI 桥 `--role-submit {json}` |

**提交载荷（RoleProposalInput，JSON）**：

```json
{
  "company": "Company-A 医疗",
  "name": "管理培训生",
  "source": "JD-Company-A 医疗-2026-08-07",
  "skills": [
    { "name": "办公软件", "essential": true },
    { "name": "机械/材料专业背景", "essential": false }
  ]
}
```

**先查已有条目再提交**：同 roleId（`{name}-{company}`）已登记 → 更新技能需求，不重复建条目
（引擎幂等：同 id 覆盖更新；对齐 Company Artifact Admission：同主体只允许一份档案）。

## 三、Producer Boundary——v0.2 登记闭环

| 字段 | Producer | Engine 校验（登记时 fail fast，失败 throw） | 说明 |
|------|----------|---------------------------------------------|------|
| 岗位实例存在（公司+岗位名） | Agent 提议（从 JD/尽调提取） | ✅ company 已登记档案（`companies/` 简称/全称双向容错） | 存在性来自具体文档，不凭空生成；无来源文档支撑的岗位禁止登记 |
| 技能需求（essential/nice-to-have） | Agent（判断） | ✅ 数组非空 + 每项技能名非空 | 从 JD/档案提取——AI 推理结果 |
| 来源引用（`来源:xxx`） | Agent + **必填** | ✅ 格式合法（`JD-{公司}-{日期}` / `公司档案-{公司}` 前缀） | 证据锚点——需求必须能回溯到文档（Claim Strength ≤ Evidence Strength）；非法拒绝登记 |
| 岗位 id（`{name}-{company}`） | Engine（派生） | ✅ 系统派生，禁止手写 | 提案落盘时生成 roleId |
| company 引用 | Engine 解析（canonical/alias） | ✅ 校验 companies/ 档案存在 | 对齐 Company Reference Closure（1209546） |
| **roles.md 投影** | **Engine（Registration Owner）** | — | Agent 禁止直写；提案登记后 Engine 重写 roles.md（序列化契约格式，英文冒号） |

**为什么 v0.2 从"解析登记"升级为"登记闭环"**：v0.1 引擎只做宽容解析（LLM 自由文本直写 +
事后解析），来源格式错误（如英文/全角冒号不一致）静默吞掉，岗位索引断裂无感。
v0.2 把角色反转：**Agent 提议（结构化 JSON）→ Engine 校验（fail fast）→ 登记投影**——
索引的完整性与格式由 Engine 保证，Agent 不再拥有 roles.md 写入权。

## 四、格式与字段规则

**roles.md 由 Engine 投影，产出契约格式（解析器兼容中英文冒号，存量全角写法仍可读）**：

````markdown
## 岗位名（公司名）

- essential: 技能名（来源: 文档标识）
- nice-to-have: 技能名（来源: 文档标识）
````

| 规则 | 要求 |
|------|------|
| 岗位名 | 用 JD/尽调中的正式岗位名；同名岗位跨公司各记一条（id 含公司，天然区分） |
| 公司名 | **canonical reference，不是自由文本**——提交前先查 companies/ 档案（对齐 Company Artifact Admission Step 0），岗位标题公司名写**解析后的档案名**；JD 简称/工商全称若与档案名不一致，禁止直接写入（alias 由公司档案声明，岗位清单不发明新名称）。实例：「Company-A 医疗」是档案名，「Company-A 医疗科技股份有限公司」是 alias——岗位写「管理培训生（Company-A 医疗）」 |
| 技能名 | 优先词表技能（knowledge/skills.md）；词表外可写（引擎按别名归一化反查，未入表原样保留） |
| 来源标识 | `JD-{公司}-{日期}`（如 `JD-Company-F 技术-2026-08-02`）/ `公司档案-{公司}`（对齐现有 roles.md 惯例；{公司} 用档案名） |
| 来源必填 | 需求项必须带 `（来源:…）`；不带来源 = 无证据锚点的判断，引擎拒绝登记 |

## 五、暂不做（触发条件未到，记录不建）

| 项 | 触发条件 |
|----|----------|
| ~~role_id 系统登记~~ | **v0.2 已落地**：roleId = `{name}-{company}` 提案登记时派生（跨公司同名天然区分；跨公司同岗位多名主体建模仍需独立身份系统） |
| role watcher / 广播 | v0.2 已落地：role-proposals/ watcher + poolChanged 广播；UI 实时感知已具备 |
| role registry（独立身份系统） | 岗位需要跨公司身份（同岗位多名主体建模）时 |
| 市场通识知识库 | Career World Model（远期，独立系统） |

## 六、参考

- 引擎实现：`engine/storage/knowledge-watcher.ts`（parseRolesMarkdown / serializeRolesMarkdown）、
  `engine/storage/role-proposal-registry.ts`（提案登记 + 投影）
- 提交通道：CLI 桥 `--role-submit {json}`（main.ts；校验失败 throw → 错误给 Agent 看拦截原因）
- 消费端：`engine/storage/graph-builder.ts`（雇佣/需求边）、`engine/runtime/gap-calculator.ts`（技能矩阵）
- 对齐契约：`references/career-profile-contract.md`（语义冻结模式）、`sub-skills/company-research/references/company-file-contract.md`（Producer Boundary 模式）
