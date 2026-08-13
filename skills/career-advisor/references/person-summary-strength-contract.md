# Person Summary Strength Contract v0.2（DRAFT，2026-08-14）

> 背景：CareerContentStandard v1.4 引入摘要区块规范（个人优势 = 结论 + 证据对，摘要不产生新事实）。
> 市场调研（writing-norms.md §11）确认双层模型：平台档案级「优势亮点」（猎聘，跨投递复用）
> vs 简历级「个人优势」段（per-application 定制）。本契约补档案级缺口——
> **优势亮点是引用型资产：锚 claims/evidence，不复制事实**。
>
> **v0.2 修订（2026-08-14，用户实测数据驱动）**：v0.1 单 claim 锚有粒度错配——claim 是
> 「经历级」资产（一次经历一条），优势是「能力维度级」表达（一个维度横跨多条经历）。
> 用户 4 条实测优势中 3.5 条不适配单锚（技能型/奖项型/跨经历综合型）。
> 修订：**结论句独立 + 支撑引用数组（claimIds + evidenceIds 混合多锚；引用可空 = 软性条目）**。

---

## 1. 定位

优势亮点是**用户事实**（User Confirmation Flow——用户选择哪些优势 + 结论表达 = 确认），
登记属于 Person Aggregate（`snapshot/current/summary_strengths.md`）。

**引用型设计（核心决策）**：优势条目内容与 claims/evidence 高度重叠（蒸馏），
建独立事实链 = 单侧使用冲突 + 双维护。因此条目 = 结论句 + 支撑引用，
锚定链不重复：`优势条目 → claim/evidence → 事实`。

**粒度语义（v0.2 修订）**：
- claim = 经历级表达资产（一次经历一条）
- 优势亮点 = 能力维度级表达（一个维度横跨多条经历/技能/奖项）
- 支撑引用因此是**数组**，claimIds 与 evidenceIds 混合：
  - 经历型支撑 → claimIds（canUseClaim 校验）
  - 技能型/奖项型支撑 → evidenceIds（canConsumeEvidence 校验——技能/奖项的佐证事实）

```
claims（表达资产）  evidence（事实）          evidence（技能/奖项事实）
        ▲                  ▲                        ▲
        └──────── 优势亮点条目（profile 层，User Confirmation）──┐
                                                           │
WC 个人优势段行（组装层）── 资产面板添加 → 多锚行 ─────────────┘
```

**三者边界（与 education 契约一致）**：

```
Agent ≠ Fact Owner（只提议）
Engine ≠ Truth Creator（只登记 + 校验）
User = Confirmation Authority（唯一确认权）
```

## 2. Schema（v0.2）

```markdown
---
id: {person_id}
---
# 优势亮点 — {person_id}

## 分析摘要

| 字段 | 值 |
|------|-----|
| version | 1 |

## 优势条目

- {结论句}（claims: {claimId1}, {claimId2}）（evidence: {evidenceId1}）
- {软性条目——无支撑标注可省略}
```

- `结论句`：**必填**——能力维度 + 具体能力的优势表达（如「动手与落地：从方案设计到样机调试的全流程独立开发能力」），单行
- `claims:` 标注：经历型支撑（可多、可空）
- `evidence:` 标注：技能/奖项型支撑（可多、可空）
- 两标注均可空 = **软性条目**（主观优势）——允许但 UI 降级标注「无证据支撑」；引擎不拒绝（市场规范 3 硬 1 软）
- 无生命周期字段——条目是引用不是事实，删除 = 物理移除（无损）

## 3. Producer Boundary

| 角色 | 职责 |
|------|------|
| Agent | 提议（AI 建议候选——结论句 + 支撑引用；可总结但不可登记） |
| UI | 候选编辑（用户增删改） |
| Engine | Registration Owner：`person/summary-strengths/upsert` RPC 写文件 + 校验（引用存在 + 可消费） |
| User | Confirmation Authority：保存 = 确认 |

**AI 总结边界**：AI 可从 claims/evidence 池蒸馏优势候选（走提案），但优势是用户自我定位——
登记必须经用户确认；AI 直接写优势条目 = 越权。

## 4. 校验（引擎，边界 fail fast）

1. 结论句非空（软性条目也必须有文本）
2. claimIds 逐条：存在（scanClaims）+ canUseClaim（证据 trusted）
3. evidenceIds 逐条：存在（scanEvidence）+ canConsumeEvidence（status trusted）
4. 非法引用拒绝（fail fast），不静默丢弃

## 5. 消费场景

1. **WC 个人优势段**（已实现）：资产面板「优势」区 → 加入 → 多锚行（provenanceLinks = claimIds 全量，
   promote 主锚 = 第一条），evidence 支撑作为行元数据
2. 平台投递素材 / 打招呼语（future，触发未到）
3. AI Read Model：CareerContext 纳入（Agent 提案时可读）

## 6. 边界（v0.2 不做）

- 条目生命周期/版本演化：引用型资产删除无损，不需要 immutable/演化机制
- JD 定制变体：per-version 定制留在 WC/版本层，不进 profile 资产
- 支撑引用的证据链可视化（图谱）——CareerContext 已含支撑引用，可视化是 UI 层 future
