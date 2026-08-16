# Career Profile Artifact Contract（语义冻结 v1）

> 2026-08-07 冻结 | P0.5 第一步（语义层）——本轮只定语义与契约，**不修改 parser/代码**（第二步 parser 收口按此契约执行）
> 背景：某已登记 person（person_XXX）的 career_profile.md 被方向探索 Agent 写成「推荐方向」表（决策结论混入快照）——「目标岗位」语义错位：系统不知道字段代表谁的事实（用户目标 / Agent 推荐 / 决策结果）。本契约把语义钉死，防「推荐」写入「目标」。

## 1. 职责（表达什么）

career_profile.md 表达**用户自身状态与意图**：

| 段 | 内容 | 来源 |
|----|------|------|
| User Career Intent | 用户明确目标岗位（target_role + priority + source） | 用户输入/确认 |
| Personal Summary | 个人状态摘要（当前角色/状态） | 用户输入/确认 |
| References | 经历/技能引用（引用不复制） | snapshot 其他资产 |

## 2. 禁止项（不表达什么）

career_profile.md **不得写入**：

- ❌ AI 推荐方向 → 归 decision artifacts（方向探索结论）
- ❌ 城市机会 → 归 city artifacts
- ❌ 公司机会 → 归 company artifacts
- ❌ 市场判断

**红线：Agent 不得把推荐/决策结论写入 career_profile**——「推荐」≠「目标」。方向探索的产出写 decisions/，不写 snapshot/。

## 3. Producer / Consumer / Registration

| 角色 | 归属 |
|------|------|
| Content Producer | 初始化采集/用户确认流程（Agent 组织内容） |
| Registration Owner | engine person snapshot parser（解析登记，Agent 不创建身份字段） |
| Consumer | Person projection → 画像「职业意向」维度；ledger（目标方向 → decision 单元，随契约演进） |
| **Authority** | **用户确认流程（User Confirmation Flow）——用户明确目标必须经「Candidate → 用户确认 → 登记」，Agent 只提案不写入**（CLAUDE.md 开发原则 8 / Governance 不变量 10） |

## 4. 格式（v2 目标形态，parser 收口按此实现）

```
## User Career Intent

| target_role | priority | source |
|-------------|----------|--------|
| 机器人结构设计 | high | user |
```

- **source 必填**：`user`（用户明确表达，长期稳定，Agent 不可自动修改）/ `recommended`（决策推理，过渡期显式标注）/ `imported`（迁移标注）
- priority：high / medium / low

## 5. 兼容与迁移（parser 收口时执行，本轮不做）

- 旧「推荐方向」表（决策快照投影）：方向探索结论**回归 decision artifacts**；已有快照数据迁移为 `source: recommended` 显式标注（过渡期可见，不冒充用户目标）
- `extractTargetRoles`（期待 `- 方向 xx%` 行）→ 新 `extractCareerIntent`（解析 User Career Intent 表）；旧格式兼容解析保留一版，不静默丢弃
- Person 投影：`targetRoles`（语义模糊）→ `careerIntent`（带 source）；或标记 deprecated，UI 消费新字段

## 6. 数据血缘（验收标准）

```
User Input → career_profile（User Career Intent）→ Person Projection → 画像「职业意向」
Decision Artifact → Recommended Direction Projection → Direction UI（AI 推荐方向）
City/Company/JD Artifact → Market Opportunity Projection → Market UI
```

三条血缘完全分开——画像不再显示「推荐方向」为「目标岗位」。

## 7. 不做什么（本轮边界）

❌ 不新建 CareerProfileV2 ❌ 不大规模迁移 PersonSnapshot ❌ 不引入状态机 ❌ 不改 Agent 推理流程 ❌ 不把推荐结果自动回写画像
