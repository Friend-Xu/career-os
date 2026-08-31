# Skill Registry Contract v0.3(已冻结,2026-08-31)

> 状态：**已冻结(评审通过)**。评审修订(两轮):四态判定(EXISTING/NEW_PROPOSAL/REGISTERED/REJECTED)、
> 两权分离(Creation ≠ Semantic Origin)、bindable 匹配分级(仅 exact 自动绑定)、形态规则、
> RoleSkill 引用无 creation side effect(模式 A)、soft 过滤归域分类层、单通道硬规则、种子选型暂缓。
> 冻结前提 = skill-representation-contract-v0.1(2026-08-08 冻结)。
> 本契约解决 v0.1 未覆盖的问题:**Skill 的身份层缺位**——`name` 同时承担 规范名/匹配键/图节点键,
> 而生产权在 Agent(roles-contract v0.2 §四 L82「词表外可写」)。
> v0.3 核心:**引入 Skill Registry 作为技能身份的权威层,Agent 只 Discovery/Proposal,Engine 决定 Identity。**

---

## 一、定位(是什么 / 不是什么)

**是**:

- 技能身份的唯一权威层:每个技能一个稳定 `skill_id`,canonical 名称/别名是**属性**,id 是**身份**
- `knowledge/skills.md` 是 **Registry 的投影**(Artifact → Engine → Projection,与 roles.md 同构)
- 消费端(gap 匹配 / 图谱 / 简历导出)一律按 `skill_id` 对齐,字符串仅展示/回溯展示

**不是(禁止)**:

- ❌ 语义翻译层:同义/相关/包含关系自动归并——延续 v0.1 冻结裁定不做(等 Career Ontology v0.x)
- ❌ Agent 发明 canonical 名/id:名称来自提案,id 由 Engine 派生
- ❌ 运行时外部依赖:不调用 ESCO/大典 API,标准本体仅作**初始种子来源**(选型待定,§九)

## 二、三层数据模型在 Skill 域的落地

| 层 | 字段 | Producer |
|---|---|---|
| **Identity** | `skill_id`(Engine 派生,稳定不可变) | Engine Registration |
| **Identity 属性** | `canonical_name`(首次登记定,可变更——名称变更不影响 id) | Agent 提议 / 用户可修正(修正权待定,见 §十) |
| **Reference** | `source_phrase`(来源原文短语)、`evidence`(来源文档+摘录定位) | Agent 提取(必填,Claim ≤ Evidence) |
| **Content** | 锚点描述(`1级:`…`5级:`)、使用场景 | Agent(词表条目内容) |

> 与 v0.1 差异:v0.1 的 `aliases`/`tools` 结构**保留**(供提案阶段候选推荐),
> 但不再承担匹配键职责——匹配只认 `skill_id`。

## 三、Registry 条目模型

```ts
interface SkillRegistryEntry {
  skill_id: string           // skill_00001…（Engine 派生,全局递增;幂等:同 canonical 名+同来源不重复）
  canonical_name: string     // Registry 属性（首次登记的规范名;名称是属性,id 才是身份——可变更,变更不影响 id）
  aliases: string[]          // 别名（同义表达,提案时可增补;仅用于检索候选,不作匹配键）
  anchors?: string[]         // 1-5 级行为锚点（v0.1 结构,可缺省）
  status: 'seed' | 'active' | 'deprecated'  // deprecated 预留（随未来合并功能启用;当前不实现合并操作）
  provenance: {
    proposed_by: 'agent_proposal' | 'seed_standard' | 'user'  // 谁提议（≠谁注册）
    registered_by: 'engine' | 'user'                           // 谁行使登记授权（engine=证据+形态规则通过）
    source: string        // 来源标识（JD-{公司}-{日期} / 标准-{名称} / 用户）
    created_at: string
  }
}
```

> **Proposal ≠ Registration**:`proposed_by` 与 `registered_by` 分离,禁止单字段
> `created_by: agent_proposal`(那会被读成"Agent 创建实体")。
> Agent 能提出"这个东西可能存在",但不能让"这个东西存在"——
> 存在性由 `registered_by=engine` 的证据充分性 + 形态规则(§五)决定。

**skills.md 投影格式(v2 行内元字段,解析器扩展,存量兼容)**:

````markdown
## 机械结构设计
- id: skill_00001
- 别名: 结构设计、机械结构设计方法
- 3级: 能独立完成结构方案并交付图纸
- 5级: 能主导整机结构评审并沉淀设计规范
````

> id 行由 Engine 投影时写入;Agent 直写 skills.md 被禁止(同 roles.md v0.2 纪律)。
> 注意:**同一技能出现多别名(含市场长句)是常态且无害**——别名仅用于提案阶段检索候选,不影响匹配正确性。

## 四、提案通道(SkillProposal——Agent 的唯一入口)

**入口语义:`--skill-submit` = 提交技能候选(≠ 创建技能)**。只有 Engine 行使登记授权后,候选才成为技能。

**前置步骤(必做)**:提交前调用 `--skill-search`(Registry 检索:规范名/别名/子串)。
**返回结构带匹配分级——"搜索到了" ≠ "身份解析成功"**:

| match 分级 | 定义 | 绑定资格 |
|---|---|---|
| `exact-canonical` | 与规范名精确相等 | ✅ bindable → 直接 EXISTING |
| `exact-alias` | 与某别名精确相等 | ✅ bindable → 直接 EXISTING |
| `substring` | 子串/包含关系 | ⚠️ **仅候选展示**——不自动绑定;Agent 可显式 `binds_to_id` 绑定(存在性校验 + 存疑留痕 warn,不静默);不绑定则走 NEW_PROPOSAL |
| `none` | 无结果 | → NEW_PROPOSAL(形态合格 + 证据可溯时) |

> 只有 `exact-*` 才产生自动 EXISTING;`substring` 永不自动绑定(防止"轴承寿命计算" 被
> 子串命中"机械结构设计" 而错误绑定成合法 skill_id——**合法 id 的错误绑定比 missing 更危险**)。

提交通道对齐 role-proposal:`--skill-submit {json}`(CLI 桥)+ 落盘 `skill-proposals/`(审计)+ Engine 判定。

```json
{
  "source_phrase": "机械结构设计方法",
  "proposed_name": "机械结构设计",
  "binds_to_id": "skill_00001",
  "evidence": { "source": "JD-北京环都拓普空调有限公司-2026-08-21", "excerpt": "负责机械结构设计方法…" },
  "aliases": ["机械结构设计方法"]
}
```

**字段规则**:

| 字段 | 必填 | 校验(Engine fail fast) |
|---|---|---|
| `source_phrase` | ✅ | 非空——必须能从来源文档回溯 |
| `proposed_name` | ✅ | 非空;**形态合格**(§五判定表——≤12 字、名词性短语、无工具词括号堆叠、非 soft/非长句) |
| `binds_to_id` | ❌ | 若提供:必须存在于 Registry 且 status≠deprecated(RI)——不存在 → REJECTED |
| `evidence.source` | ✅ | 非空 |
| `aliases` | ❌ | 字符串数组,非空项 |

## 五、Engine 判定表(确定性规则,无语义判断——四态)

| 情形 | 判定 | Engine 动作 |
|---|---|---|
| `binds_to_id` 明确提供且存在(非 deprecated)→ EXISTING(含 Agent 对 substring 候选的显式绑定——存在性校验 + 留痕 warn) | **EXISTING** | 绑定该 skill_id(RoleSkill/PersonSkill 引用) |
| 检索 match = `exact-canonical` / `exact-alias` | **EXISTING** | 自动绑定命中条目 |
| match = `substring` 且未显式绑定 | **不自动绑定** | 候选供 Agent 决策;Agent 不绑定 → 走 NEW_PROPOSAL |
| match = `none`,且**形态合格**且**来源可回溯** | **NEW_PROPOSAL → REGISTERED** | 落案 skill-proposals/ → Engine 登记授权 → 派生 skill_id、provenance {proposed_by: agent_proposal, registered_by: engine}、投影 skills.md |
| 形态不合格(工具词括号堆叠 / 长句 / soft 词 / >12 字) | **REJECTED** | throw,拦截原因含提炼要求(如:「三维 CAD 软件(CATIA/UG/SolidWorks/Pro/E) → 提炼为 三维 CAD」) |
| `evidence.source` 缺失 | REJECTED | throw,错误含拦截原因(Claim ≤ Evidence) |
| `binds_to_id` 不存在 | REJECTED | throw,提示"先 --skill-search 检索或改绑定" |

**soft/非技能词(抗压能力、主动性、沟通能力…)**:不属于 Identity 层问题,是**域分类**
(Capability Matching Boundary v0.1 执行)——**不进 Registry 也不进技能矩阵**,在域分类层过滤(§2.5 正交分层)。

**形态规则(NEW_PROPOSAL 的登记闸门)**,全部确定性可判:

- ✅ `proposed_name` ≤12 字、名词性能力短语
- ❌ 工具词括号堆叠 → 必须提炼("三维 CAD 软件(CATIA/UG/SolidWorks/Pro/E)" → "三维 CAD")
- ❌ 例句长句/责任描述 → 必须提炼("设计改进落地执行" → "设计改进")
- ❌ soft 词 → 域分类层排除(进不了 Registry 也无引用)

> **注册授权 = 证据充分性 + 形态规则**,不依赖人工逐条确认:技能词表是知识层资产(外部可回溯事实,
> 同 role-proposal 语义:可回溯 → Engine 登记,不确认);用户确认流保留给用户画像资产
> (strength-proposal:主观字段)。每个 JD 产生十数个候选,人工逐条确认 = 单用户系统不可承受。
> 语义归类(「机械结构设计方法」与「机械结构设计」是否同义)由 Agent 在 `binds_to_id` 中**推荐**,
> Engine 只做存在性校验——**确定性归 Engine,语义归 Proposal**;两条近似名永远是两个条目(保守,v0.1 纪律),
> 语义绑定质量由 `--skill-search` 分级候选限定 + source_phrase/绑定 id 并存留痕(存疑标 warn,不静默)。
> **诚实披露**:NEW 实体的 canonical_name 首次登记时等于 proposed_name(Agent 语义首创经确定性
> Registration 物化)——语义来源权属 Agent,实体存在权属 Registry(ADR-031 §2.0 两权分离)。

## 六、RoleSkill 新结构(岗位技能需求——Identity/Reference/Content 分离)

```ts
interface RoleSkillEntry {
  skill_id: string        // Identity——匹配键
  canonical_name: string  // 投影冗余,UI 展示
  source_phrase: string   // Reference——JD 原文短语(回溯)
  evidence: string        // Reference——来源文档标识
  essential: boolean      // 需求属性
}
```

**roles.md 投影格式(v2)**:

````markdown
- essential: skill_00001｜机械结构设计（来源: JD-…-2026-08-21；原文: 机械结构设计方法）
````

> 两入口统一:role-proposal 提案与 jd-analysis 自动派生(ensureRoleFromJob)都改走
> 「--skill-search 检索 → 绑定(EXISTING)/ 登记(NEW_PROPOSAL)→ 以 skill_id 登记 role 技能」;
> **原「词表外可写」删除**——需求技能必须能解析到 Registry 条目。
> **引用无 creation side effect(模式 A)**:RoleSkill 自身**永远不创造 Skill**——
> 找不到对应条目 → REJECTED(错误含 --skill-search 与登记动作指引),由编排层
> (jd-analysis 流程)在提交 role 提案**之前**先执行 skill 提案循环(连续两步,非引用字段隐式触发)。
> 即:**先建立身份,再引用身份**(对齐 company 建档前置先例)。
> **soft/非技能词过滤属域分类层(Capability Matching Boundary v0.1)**,在 Registry 之前执行——
> “抗压能力/主动性/诚信踏实”不得进入技能矩阵(现存量 roles.md 已含此类条目,属数据污染,见迁移任务 §九 注记)。

## 七、PersonSkill 绑定

```ts
interface PersonSkill {
  // v0.1 字段保留
  name: string            // 画像原文(用户确认)
  level: number           // 1-5
  skillId?: string        // person 资产 provenance 键(语义不变,勿混淆)
  aliases?: string[]
  tools?: string[]
  // v0.3 新增
  registry_skill_id?: string  // 全局技能身份(绑定 Registry;采集/确认流程登记)
}
```

> **单通道硬规则**:采集/确认流程与 RoleSkill 共用**同一条** Skill Proposal → Registry 生命周期——
> 禁止第二套创建路径(任何来源:JD Agent / 简历 Agent / 用户确认 / 手工种子,
> 候选一律走 `--skill-search` → 绑定/`NEW_PROPOSAL` → 登记)。
> **存量未绑定条目 = 合法**(待迁移,不进匹配的 id 对齐——降级兼容 v0.1 字符串匹配,存量迁移完成前不切断)。

## 八、消费规则更新

| 消费端 | v0.3 行为 |
|---|---|
| gap-calculator | 匹配键 = `registry_skill_id`(声明侧)↔ `RoleSkillEntry.skill_id`(需求侧);双方均缺 id → 降级 v0.1 字符串匹配(兼容期);命中优先口头 evidence 展示 `source_phrase` |
| graph-builder | 技能节点 id = `skill:{skill_id}`;canonical_name 仅 label;「词表外无节点」状态消失(全注册) |
| UI 差距分析 | 展示:canonical_name + 来源短语(「满足:机械结构设计(来自 机械结构设计方法)」);判定分流:未声明(0 绑定)/已声明未命中(id 不相等)/命中 |

## 九、初始种子(**暂缓拍板**——决策点在 Registry lifecycle 验证后)

> **先不选 A/B/C**。无论职业大典 / ESCO / 自建词表,都不影响架构与 lifecycle;
> 先用现有 4 技能(画像)+ 9 岗位(roles.md)数据跑 Golden Flow
> (search → exact/bindable → new proposal → registration → skill_id → gap),
> 稳定后再选型入种子。避免"词表选得漂亮、lifecycle 还有边界问题"的本末倒置。

- **选项 A(推荐)**:国家职业分类大典(2022)相关职业技能体系子集 —— 中文语境权威,免费,含层级
- 选项 B:ESCO 中文子集 —— 国际标准,需筛选
- 选项 C:自建 30-50 条机械域基础词表 —— 最快但无权威性
- 种子条目 `status='seed'`、provenance `{proposed_by: 'seed_standard', registered_by: 'engine'}`;
  Seed 不自动合并用户技能,仅作检索候选池
- **注:存量迁移(复制区 9 岗位 ~200 需求 + 画像 4 技能 + 存量 soft 词清理)为独立任务,
  见 ADR-031 §五 序 5——本契约冻结不阻塞迁移排期**

## 十、暂不做(记录)

- ❌ 语义自动归并/同义合并(近义条目人工合并操作需 `status=deprecated` + id 重绑定,等 Career Ontology)
- ❌ canonical_name 的 Agent 修订权限(名称修正权归用户/Engine,暂不做修正通道——**不设 version 字段**)
- ❌ embedding 检索(可作提案候选推荐 opt-in,不进身份层)
- ❌ 跨语言本体/外部 API 依赖
- ❌ 人工逐条确认 Registration(Registration Authority = 证据+形态规则,见 §五)
- ❌ substring 自动绑定(仅展示候选;显式绑定可(留痕),绝不自动——见 §四 match 分级)

## 十一、验收标准(引擎测试,冻结后执行)

1. `--skill-submit` 提案「机械结构设计方法」binds_to=`skill_00001` → EXISTING;RoleSkill 引用正确
2. 提案 `binds_to_id` 不存在 → REJECTED(错误含原因)
3. 词表外无绑定 + 形态合格 + 来源可溯 → NEW_PROPOSAL → **登记授权通过** → REGISTERED 新条目(id 派生、
   provenance {proposed_by: agent_proposal, registered_by: engine})→ skills.md 投影出现 `- id:`
4. 形态不合格(工具词括号堆叠 / 长句 / soft 词)→ REJECTED,错误含提炼要求
5. `--skill-search "轴承寿命计算"` 子串命中「机械结构设计」→ 返回 `bindable: false` 候选,**不自动 EXISTING**;
   Agent 显式 binds_to 绑定 → 允许但留痕 warn;不绑定 → NEW_PROPOSAL
6. role-proposal 技能需求含自由文本且未绑定 → **拒绝登记**(先 skill-submit;引用无 creation side effect)
7. role-proposal 技能需求含 soft 词(抗压能力等)→ **域分类层过滤**(不进技能矩阵)
8. jd-analysis 自动派生(ensureRoleFromJob):编排 = 先 skill 提案循环(绑定/登记)→ 后 role 引用;
   roles.md 以 id 形态落盘;soft 词自动过滤
9. gap-calculator:PersonSkill.registry_skill_id ↔ RoleSkill.skill_id 相等 → 命中(即使 name/原文不同)
10. graph-builder:节点 id=`skill:{skill_id}`,无词表外丢失
11. 回归:存量无 id 数据(兼容期)匹配仍走 v0.1 字符串(不崩、有明确降级标记)
12. 单通道:PersonSkill 采集流与 RoleSkill 引用流共用同一 lifecycle(无第二套创建路径)

## 十二、参考

- skill-representation-contract-v0.1(冻结前提:aliases/tools 结构、别名归一、via 透传 — 全部保留)
- roles-contract.md v0.2(提案通道模式、company 建档前置先例)
- ADR-031(本契约的架构依据:三层分类、判据、审计表)
- 先例实现:engine/storage/job-watcher.ts(EVIDENCE_PATTERNS_V0 词表→Registry id、词表外过滤)、
  engine/storage/role-proposal-registry.ts(提案→校验→投影 全模式)
