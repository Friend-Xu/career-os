# 证据资产（Evidence Inventory）

> 本文件是 career-advisor skill 的子模块。由主 SKILL.md 路由加载，不作为独立 skill 运行。
> 对应 M2 文档 `EVIDENCE-MODEL-M2-v0.1.md`——把"我有什么证明"从对话里捞出来，沉淀为长期资产。

**Career OS 三大平行实体：Job（岗位要什么证明）／ Decision（为什么选）／ Evidence（我有什么证明）。本模块管理 Evidence。**

---

## 入口分流

```
"我想整理一个项目经历"          → create-evidence.md（入口 A：主动沉淀）
"这个岗位的证明要求我有什么？"   → discover-evidence-from-job.md（入口 B：JD 驱动）
```

两个 contract **输入与 prompt 完全不同**（用户叙述 vs 岗位智能表），共享输出契约 `evidence-output-schema.md`。

---

## 核心纪律

| 纪律 | 说明 |
|------|------|
| 维度词表固定 5 个 | scope / method / validation / impact / adoption——禁止发明维度（引擎过滤词表外） |
| 不编造 | 用户没说"结果/验证"就不填该维度；没有就是没有（不编"我可以学"） |
| 半写合法 | raw / candidate 状态是常态，不强行补全 |
| trusted = 可表达授权 | 仅用户确认后的条目可被简历/面试消费（Claim Strength ≤ Evidence Strength） |
| role ≠ 岗位责任 | role 是"我在事件中的身份"，contribution 是"我实际做了什么" |
| 文件写 evidence/ | 暂存名 `{日期}-{事件名}.md`，引擎登记系统 ID（写入方不命名） |

---

## 文件导航

```
evidence/
├── SKILL.md                         ← 本文件（路由）
├── create-evidence.md               ← 入口 A：主动沉淀（六问引导）
├── discover-evidence-from-job.md    ← 入口 B：JD 缺口驱动
└── evidence-output-schema.md        ← 输出契约（与引擎解析器一致）
```

**复用外部数据**：
- `../jd-analysis/references/output-template.md` — 岗位智能表（入口 B 的缺口来源）
- `../../references/` — 职业方向画像（如适用）
- `workspace/career-advisor/evidence/` — 证据库存（读写）
