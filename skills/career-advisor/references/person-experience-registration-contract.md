# Person Experience Registration Contract v0.1（已冻结，2026-08-14）

> 冻结（2026-08-14，用户评审通过——与 education 契约同构母本一致，无评审修改）。
> 背景：职业画像审计发现经历数据双真相源——candidates.md（Engine Registration，6 条
> confirmed 经历候选）与 identity.md `## 工作经历` 表（初始化 Agent 直写的快照）并存，
> 互不同步、初始化完成后无登记路径（education 契约 §9 当时明确将 experience 记待办）。
> 同时 JD 门槛匹配的经验维度只认毕业年份（应届类），画像工作经历起止日期不参与判定
> （「3 年以上经验」一律 NEEDS_CONFIRMATION）。
> 本契约 = education 同构方案：Candidate → 用户确认 → Engine 登记 facts/experience.md，
> 并把经验门槛判定（Matcher Policy）扩展到年限类。

---

## 1. 定位

experience 是**用户事实**（原则 8：User Confirmation Flow）。登记属于 Person Aggregate，
与 education 完全同构——`persons/{pid}/facts/experience.md` 为事实层，identity.md
`## 工作经历` 表退为历史遗留投影（展示层），引擎不再解析。

```
Candidate Confirmation（candidates/events，已有 ✅）
      │
      ▼
Person Registration Engine（resolveCandidate 确认 + 结构化 payload → 登记）
      │
      ▼
facts/experience.md（结构化工作经历事实）
      │
      ├── Person.experiences（画像视图 / 简历公司条目头）
      └── JD Matcher 经验维度（应届类 + 年限类，Policy 层）
```

## 2. Experience Candidate Schema（候选 ≠ 事实）

候选阶段结构化（Content Producer 产出；Engine 不解析自由文本）——复用 candidates.md
通用 payload 列（第 6 列），experience 类目键值段：

```
公司=…；岗位=…；起=…；止=…
```

- `公司` 必填（缺失 → 无结构化，content 原文仍在——双层语义同 education）
- `起`/`止` 格式：`YYYY.MM` / `YYYY-MM` / `YYYY`（数字与分隔符，宽松解析）
- 不进入登记范围：项目经历（Portfolio 模块资产）、Gap/比赛类候选（保留为文本候选，
  事实层只登记工作经历行）

## 3. Experience Artifact Schema（登记后）

facts/experience.md 表（引擎单方维护，append-only）：

```
| candidate_id | company | role | start | end | status | source |
```

- status 复用 candidates 状态（pending/confirmed/rejected，不新造状态机）
- 缺件语义：无文件/无行 = 未采集（与「无经历」区分）
- PersonWorkExperience 派生：company/role/start/end + candidateId（provenance）

## 4. Producer Boundary

| 环节 | Owner |
|------|-------|
| Content Producer | 初始化采集 Agent（候选 + 键值段 payload） |
| Registration Owner | Engine（resolveCandidate confirmed + 结构化 → facts/experience.md，幂等） |
| Confirmation Authority | User（candidates flow 已有） |
| Consumer | 画像视图 / 简历 / JD Matcher 经验维度（只读登记事实） |

## 5. 过渡策略（education 契约 §5 同款）

- identity.md `## 工作经历` 表 = **历史遗留数据**：引擎停止解析（删除
  parseWorkExperiences）；展示层保留为叙事镜像（文件头已声明来源 c-001~c-013）
- 迁移方式：已确认候选 c-003 一次性登记为 facts/experience.md 行（一次性迁移脚本，
  workspace 数据域）
- **禁止新增依赖**：任何新功能不得消费 identity.md 工作经历表

## 6. 缺件语义（供 Matcher 派生）

| 档案侧状态 | Matcher 派生 |
|-----------|-------------|
| 无经历条目 | JD 有年限要求 → NEEDS_CONFIRMATION |
| 条目 confirmed（可计算年限） | 按年限比较 → MATCHED / NOT_MATCHED / NEEDS_CONFIRMATION |
| 条目 pending/rejected | NEEDS_CONFIRMATION（Unknown ≠ False） |

## 7. JD Matcher 经验维度 Policy v0.2（constraint-matcher）

输入：档案侧 PersonEducation[]（应届类）+ PersonWorkExperience[]（年限类）+ 门槛侧
experience rawValue。判定顺序：

```
1. 无门槛维度 → NOT_DECLARED
2. 应届类（fresh/应届）→ 毕业年份判定（v0.1 规则不变）：
   最近毕业年份 ≥ 当前年-1 → MATCHED；< → NOT_MATCHED；无毕业年份 → NEEDS_CONFIRMATION
3. 年限类（解析出年限）：
   画像年限 = confirmed 经历行起止区间合并（月精度；end 缺失 → 至今；start 缺失 → 该行不参与）
   - 满足下限（≥ min）且不超上限（≤ max，无 max 忽略）→ MATCHED
   - 低于下限（< min）→ NOT_MATCHED（硬门槛——与应届类否决同语义）
   - 超出上限（> max）→ NEEDS_CONFIRMATION（超年限可能是薪资错配，不是资格不符——不否决）
   - 无经历行/无起止数据 → NEEDS_CONFIRMATION（画像未登记经历——需确认）
4. 其余（无法归一化表述）→ NEEDS_CONFIRMATION（规则未定义，不猜）
```

年限类解析（rawValue → min/max）：
- 区间 `(\d+)\s*[-~—至]\s*(\d+)\s*年` → [min, max]
- `(\d+)\s*年\s*(以上|及以上)` → min
- `(\d+)\s*年\s*(以内|以下|及以下)` → max
- 裸 `(\d+)\s*年` → min（JD「3 年经验」惯例 = 至少 3 年）

- 规则在 Policy 层（未来可变，不污染事实层）；判定规则版本 =
  约束匹配行 ruleVersion 语义继承（matcher 输出四态，不新增字段）

## 8. 验收标准

- Golden Case：档案经历 2023.07-2025.03（confirmed）+ JD「3年以上经验」→ **NOT_MATCHED**
  （硬门槛否决）；JD「1年以上经验」→ **MATCHED**
- 档案无经历条目 + JD 年限要求 → NEEDS_CONFIRMATION（不是 NOT_MATCHED）
- 经历候选确认 → 登记立即生效（无 Agent 中间聚合）
- 引擎不再解析 identity.md 工作经历表；画像视图经历维度 = facts 派生
- 「3-5年」档案 6 年 → NEEDS_CONFIRMATION（超上限不否决）

## 9. 范围边界

- 只处理工作经历——项目经历归属 Portfolio 模块（未来登记路径），Gap/比赛候选保持文本
- 不引入新状态机（复用 candidates status）
- 学历维度不动（education 契约已冻结）

## 10. 相关

- person-education-registration-contract.md（同构母本）
- jd-analysis-contract-v2.md（Matcher 门槛侧）
- jd-match-score-contract-v0.1.md（HARD_GATE_FAILED 否决消费方）
