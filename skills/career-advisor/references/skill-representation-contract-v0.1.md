# Skill Representation Contract v0.1（已冻结，2026-08-08）

> 冻结版（评审裁决：收敛——不做完整「职业语义翻译层」，只落 **Skill Representation
> Layer v0.1**：能力主体/工具/别名的结构拆分；related/partial/推断归 Semantic Translation
> 层 v0.x 预留，需 Evidence Boundary）。
> 背景：博流 JD 匹配 22 个 ✗ 实测暴露——「机械制图与三维建模（SolidWorks/Creo/AutoCAD）」
> 声明无法命中 JD 工具词 SolidWorks。根因不是匹配算法 bug，而是 **PersonSkill 把
> 能力主体+工具+领域压成一个 name 字符串**：两个职业世界（画像声明 / JD 语言）
> 之间没有稳定表达载体。缺的不是翻译能力，是数据模型丢信息。

---

## 1. 定位（冻结级）

**Skill Representation Layer v0.1 解决「同一个人的能力如何被系统用稳定结构表达」，
不解决「所有职业语言如何互相翻译」。**

```
Career OS Skill Model
        │
        ├── Skill Representation（本契约 v0.1）——结构拆分
        │       tools / aliases（确定性派生，Engine）
        │
        └── Semantic Translation（v0.x 预留，不做）——关系层
                related / partial / 迁移 / 推理
```

## 2. 问题（冻结级）

现状 PersonSkill 只有 `name + level`：

```ts
PersonSkill {
  name: "机械制图与三维建模（SolidWorks/Creo/AutoCAD）"   // 三重视信息压扁
  level: 4
}
```

实际包含三个维度：

```
Capability: 机械制图与三维建模
Tools:      SolidWorks / Creo / AutoCAD
Domain:     机械设计
```

JD 提取词 `SolidWorks` 与压扁的 name 无法精确连接 → 词表外技能全部走
「精确名匹配」→ 误报缺口。

## 3. 结构（冻结级）

```ts
PersonSkill {
  name: string           // 能力主体（skill_inventory 原文保留，Engine 不改写画像资产）
  level: number          // 1-5（SFIA 式行为锚点）
  skillId?: string       // skill_inventory provenance 键（已有）
  aliases?: string[]     // 声明侧别名（契约形态；v0.1 无数据源，消费端已支持，来源登记后续）
  tools?: string[]       // 工具词（注册时 Engine 从 name 括号确定性派生）
}
```

括号派生规则（确定性事实，非推理）：

```
"机械制图与三维建模（SolidWorks/Creo/AutoCAD）" → tools: ["SolidWorks", "Creo", "AutoCAD"]
"静应力仿真（Creo）"                            → tools: ["Creo"]
```

- 括号（中文/英文）内按 `/ 、 , ；` 分隔提取，词长 ≥2 且非纯数字
- 无括号 → tools 缺省（不产出）
- name 保留原文含括号——保真（未来括号内出现非工具词不误拆，展示可追溯）

## 4. Producer Boundary（冻结级）

| 环节 | Owner | 说明 |
|------|-------|------|
| Content Producer | 画像采集 Agent | skill_inventory（name/level/usage_context）——画像资产 |
| Registration Owner | **Engine** | tools 括号派生（确定性提取，不是 AI 推理——「Python开发（Django/FastAPI）」里 Django 是工具不是猜的） |
| Consumer | JD Matcher / 差距分析 / 简历导出 | 消费统一 canonical representation |

**tools 派生 = Engine Registration（系统事实）**——匹配结果的可解释来源
（「SolidWorks ✓ 来自 机械制图与三维建模声明」），不是 Agent 提议。

## 5. 消费规则（冻结级）

JD Matcher（computeGap）声明侧索引 = **声明名 + aliases + tools** 三键指向同一 PersonSkill：

```
需求侧：SolidWorks（词表外精确名）
  ↓ 查声明侧索引
声明命中：tools 键 "SolidWorks" → PersonSkill（机械制图与三维建模，level 4）
  ↓
MATCHED（via: "SolidWorks"，UI 显示来源 = 声明名）
```

- 需求侧归一化不变（buildSkillIndex 词表别名）；本轮不动 Skill（词表）契约
- `via` 命中键透传到 GapResult（satisfied/transferable），UI 展示「JD 词 ✓ 来源声明」
- 未命中 → 未声明（missing）——UI 呈现「未覆盖能力/画像未声明」，禁止渲染成「不足」（Claim Strength ≤ Evidence Strength：未声明 ≠ 不会）

## 6. 不做清单（Semantic Translation 层 v0.x 预留，冻结级）

以下全部需要 Evidence Boundary + 关系契约设计，**不混入本层 matcher**：

- ❌ related：故障排查 ≈ 故障诊断（同义关系）
- ❌ partial：方案设计 ⊂ 方案设计与样机调试（包含关系）
- ❌ 迁移：医疗设备机械设计 → 自动化设备设计（行业迁移）
- ❌ 推断：SolidWorks + 非标设备经验 → 可能具备方案设计能力（隐含能力推理）

## 7. 验收标准（冻结后）

- skill_001「机械制图与三维建模（SolidWorks/Creo/AutoCAD）」注册 → tools 派生
  [SolidWorks, Creo, AutoCAD]；skill_007「静应力仿真（Creo）」→ [Creo]；无括号技能 → 空
- 博流 JD 需求 SolidWorks → **MATCHED**（via SolidWorks，来源显示声明名），不再出现在未覆盖
- 未声明技能（泵选型等）→ missing，UI 显示「未覆盖能力/未声明」+ 提示「不代表不具备」
- soft 责任单元（团队协作等）不进匹配（Capability Matching Boundary 已有契约）
- 语义关系（故障排查/方案设计 partial）保持未覆盖——不做，等 v0.x 契约

## 8. 范围边界

- 只动 PersonSkill 结构 + 注册层派生 + 匹配消费 + UI 呈现
- 不改 skill_inventory 文件格式（Agent 画像资产不动，Engine 只派生不改写）
- 不改 Skill（词表）契约、不建关系结构
- source:{type,evidence} 字段记 v0.2 预留（skill_inventory 契约扩展时落）

## 9. 实现顺序（冻结后）

```
PersonSkill 结构（schema：aliases/tools + GapResult via）
      ↓
注册层派生（person-watcher：parseSkillInventory 括号 → tools）
      ↓
匹配消费（gap-calculator：三键索引 + via 透传）
      ↓
UI 呈现（来源显示 + 未覆盖能力文案）
      ↓
测试（派生 / 消费 / soft 过滤 / 未声明语义）
```

## 10. 相关

- Capability Matching Boundary（JD Analysis v2，已冻结）——soft 不消费
- Claim Strength ≤ Evidence Strength（框架原则）——未声明 ≠ 不足
- 记忆：[[jd-analysis-v2-contract-freeze]]
