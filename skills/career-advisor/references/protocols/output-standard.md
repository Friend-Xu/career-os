# 输出标准

> 所有子流程遵守。主 SKILL.md 内嵌精简版，本文件为完整规范。

## 摘要字段标准

| 字段 | 类型 | 必需？ | 说明 |
|------|------|:--:|------|
| `skill` | string | 是 | 来源子流程名称 |
| `direction` | string | 否 | 涉及的方向。career-path/transition/jd-analysis 必填 |
| `direction_match` | percentage | 否 | 匹配度百分比 |
| `direction_confidence` | 高/中/低 | 否 | 方向相关结论的置信度 |
| `city` | string | 否 | 涉及的城市。city-advisor/company-screener 必填 |
| `city_score` | x/10 | 否 | 城市综合评分 |
| `city_confidence` | 高/中/低 | 否 | 城市相关结论的置信度 |
| `companies` | string[] | 否 | 涉及的公司名列表 |
| `company_rating` | 推荐/谨慎推荐/不推荐 | 否 | 公司综合评级 |
| `salary_feasible` | boolean | 否 | 薪资是否可负担 |
| `risk_level` | 低/中/中高/高 | 是 | 该子流程评估的最高风险等级 |
| `key_risk` | string ≤30字 | 是 | 最关键的一个风险点 |
| `status` | complete/partial/draft | 是 | 分析完成度 |
| `protocol_version` | string | 是 | 协议版本号（当前 2.0） |

## 置信度标记规则

- **高**：≥3 个独立来源交叉验证，或官方一手数据
- **中**：1-2 个来源，有推断成分但逻辑自洽
- **低**：单一来源、大量推断、或数据 >1 年

标注方式：`置信度：高/中/低`。禁止使用模糊表述。

## 文件命名约定

| 约定 | 规则 |
|------|------|
| 日期格式 | YYYY-MM-DD（统一使用） |
| decisions/ 命名 | `{YYYY-MM-DD}-{主题}.md`（不可变） |
| exports/ 命名 | `{YYYY-MM-DD}-{主题}.md` |
| 缺失值 | 填 `-`，不填 `暂无`/`N/A` |

## 来源标注规则

1. 每条信号标注来源类型和年份
2. 薪资数据标注年份和来源平台
3. 推断类判断标注 `[推断]`，与事实区分
4. 查不到就说查不到，不编造数据
