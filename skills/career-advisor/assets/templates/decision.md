---
person_id: {person_id}
---

# {标题}

## 分析摘要

| 字段 | 值 |
|------|-----|
| skill | {子流程名称} |
| direction | - |
| direction_match | - |
| direction_confidence | - |
| city | - |
| city_score | - |
| city_confidence | - |
| salary_feasible | - |
| risk_level | {低/中/中高/高} |
| key_risk | - |
| status | complete |
| protocol_version | 2.9 |

> **person_id 是系统身份字段（frontmatter，ADR-013/014）**：不是自由填写内容。
> 取值来源 = 任务上下文注入的「当前分析对象」（如 person_XXX），从上下文**复制**到此处，禁止自行编造、禁止填「我」、禁止留空。
> 引擎登记时会校验：缺失或不属于已登记 Person → 决策标 invalid（信息池「⚠ 待人工处理」可见），视图不展示。

> **评估明细段落（v2.8）**：多方向/多城市评估时，摘要表对应标量字段填 `-`，结构化明细写在正文段落——
> `## 方向评估明细`（| 方向 | 匹配度 | 置信度 | 关键优势 | 关键风险 |）或
> `## 城市评估明细`（| 城市 | 得分 | 置信度 | 关键优势 | 关键风险 |，得分填 `X/10`）。
> 优势/风险以 `/`、`、` 分隔；无则填 `-`。段落名不可改名（引擎按名解析）。

---

## 完整报告
{详细分析内容}
