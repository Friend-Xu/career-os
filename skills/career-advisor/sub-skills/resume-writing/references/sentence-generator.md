# Sentence Generator 契约（M3-1 Step 4）

> resume-writing 子模块（M3 表达链路消费端）。对应 RESUME-EXPRESSION-M3-v0.1.md §5。
> 输入 = ExpressionCandidate（引擎 `claims/select` 输出）；规则 = CareerContentStandard v1.2（standards/mechanical/*.md）；输出 = Sentence（临时，不落盘）。

**职责边界**：本契约管"怎么说"（把 Claim 的 statement 按场景改写为 Sentence）。Claim 的生成与可信度不由本模块负责——输入必须来自引擎 `claims/select`（消费前置已由引擎保证）。

---

## 1. 输入（必须来自引擎，禁止自行组装）

```
ExpressionCandidate[]（claims/select，per-responsibility）
  ├─ claimId / claimType（fact | interpretation）
  ├─ priority（引擎可解释排序）
  └─ reason（expectationId / matchedDimension / coverageStatus——"为什么选它"）

+ 语言族标准：standards/mechanical/{design|automation|simulation|manufacturing}.md
  （岗位 → 语言族路由见 references/direction-standards/机械工程.md）

+ JD 上下文：目标岗位的 responsibilities / 语言
```

禁止：直接读 claims/ 或 evidence/ 自行选材——选择必须走引擎 `claims/select`（规则进代码，不靠消费者自律）。

## 2. 生成规则（来自 CareerContentStandard v1.2）

| 规则 | 来源 | 执行 |
|------|------|------|
| 动词层级 ≤ 证据层级 | v1 §5 动词强度 L1-L4 | 提级必须能锚定 Claim 原文；seniorityLevel 是上限约束，不是升级通道 |
| 量化锚点绑定对象 | v1 §4 Q4（Impact 必须绑定 Object） | 保留 Claim 原有数值与对象；无数值不补数字 |
| fact 主体 / interpretation 辅助 | v1.2 §8.3 | Resume bullet 以 fact 为主体；interpretation 仅作辅助（不单独成 bullet 主体） |
| 不产生新事实 | v1.2 §9 / P1 | Sentence 只重组 statement，禁止添加结果/数字/责任升级 |
| 不落盘、不反写 | v1.2 §8.4 / §9 | Sentence 即用即弃；禁止写回 claims/ 或 evidence/ |

## 3. 输出

```
ExpressionSentence { claimId, statement }（临时；供 Resume Assembly 消费）
```

## 4. 质量检查（Evaluate 与 Transform 共用标准）

逐条生成后检查（与 star-reconstructor 质量检查一致的标准）：

1. 可追溯：每条 Sentence 能对应到 ExpressionCandidate.claimId + reason
2. 无编造：没有 Claim 中不存在的事实（结果/数字/责任升级）
3. 动词合规：层级 ≤ 证据层级；seniorityLevel 上限内
4. 类型合规：fact 为主体、interpretation 不单独作 bullet 主体
5. 语言族对齐：动词/量化/关键词符合 standards/mechanical/{族}.md

## 5. 与上游 Producer 的边界

- star-reconstructor（ADR-022 P1.3）是 **Claim Producer**——素材池 → 候选表达（claim-proposals/），
  用户确认后登记为 CareerClaim；本模块消费端输入为 ExpressionCandidate（claims/select）
- 生产（素材 → Claim）与消费（Claim → Sentence）分离：Sentence 生成不承担素材整理，
  Claim 登记不承担岗位表达（各层职责单一）
