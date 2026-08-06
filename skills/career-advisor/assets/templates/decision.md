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
| protocol_version | 2.0 |

> **person_id 是系统身份字段（frontmatter，ADR-013/014）**：不是自由填写内容。
> 取值来源 = 任务上下文注入的「当前分析对象」（如 person_003），从上下文**复制**到此处，禁止自行编造、禁止填「我」、禁止留空。
> 引擎登记时会校验：缺失或不属于已登记 Person → 决策标 invalid（信息池「⚠ 待人工处理」可见），视图不展示。

---

## 完整报告
{详细分析内容}
