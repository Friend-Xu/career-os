# {标题}

## 分析摘要

| 字段 | 值 |
|------|-----|
| person_id | {person_id} |
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

> **person_id 是系统注入字段（ADR-013 单身份源）**：不允许 Agent 自行生成或猜测。
> 取值来源 = 当前 Person 上下文的 `personId`（persons/{person_id}/manifest.md 的 id，如 person_003）。
> 缺失 person_id 的决策将无法归属到 Person，视图层不展示。

---

## 完整报告
{详细分析内容}
