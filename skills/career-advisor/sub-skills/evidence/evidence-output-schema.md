# 证据输出契约（EvidenceItem markdown）

> 共享契约：create-evidence（入口 A）与 discover-evidence-from-job（入口 B）共用。
> **与引擎 `parseEvidenceMarkdown` 解析器严格一致**——引擎只认这个格式，偏离即解析失败或降级。

---

## 文件位置与命名

```
workspace/career-advisor/evidence/{日期}-{事件名}.md
```

- 写入暂存名（`{日期}-{事件名}`）即可，**引擎登记为系统 ID**（`evidence_{YYYYMMDD}_{NNNNN}`）——文件名由引擎决定，写入方不命名（M1.6 纪律）
- 重复整理同一事件 → 引擎自动生成新 ID，历史不覆盖

---

## 格式

```markdown
# {事件名}

## 分析摘要

| 字段 | 值 |
|------|-----|
| role | {我在事件中的职责身份} |
| contribution | {我实际做了什么贡献} |
| period | {时间，可选} |
| source_type | {user_input / resume / document / conversation / decision} |
| captured_at | {ISO 时间戳} |
| confidence | {high / medium / low，可选} |
| status | {raw / candidate / trusted / archived} |

## 事件

{背景（可选，一段话）}

## 证据

### scope
- {负责/设计的范围}
- {可多条}

### method
- {采用的方法/工具}

### validation
- {如何验证有效}

### impact
- {改善的指标/结果}

### adoption
- {是否被采纳应用}

## 来源

{溯源说明（可选）：来自哪次对话/哪个文档}
```

---

## 规则（强制）

1. **维度词表固定 5 个**：`scope` / `method` / `validation` / `impact` / `adoption`——**禁止发明维度**（如 leadership/innovation 不是证据维度；引擎会过滤词表外小节）
2. **一维度可多条证明**（`- ` 行），如 validation 下可同时有"样机测试"与"EMC 测试"
3. **没有的维度不出现**：用户没说"结果/验证"就**整节省略**该维度——禁止空小节（`### impact` 下无内容）也禁止 `- ` 占位行。`-` 是摘要表协议的缺失惯例，**证据段不适用**：每个 `- ` 行必须是有内容的证明（引擎会过滤 `-` 值）
4. **内容必须来自用户口述或已有素材，禁止编造**——用户没说"结果/验证"就不填该维度（Anti-Hallucination）
5. **半写状态合法**：用户只说了经历没确认细节 → `status: candidate`，不强行补全
6. **trusted 仅在用户明确确认后**：确认时写 `verification_type: user_confirmed` + `confirmed_at`
7. **`role` ≠ 岗位责任**：role 是"我在事件中是什么身份"（如"机械结构负责人"），不是 JD 要求的责任
8. `source_type` 默认 `user_input`（JD 驱动入口产生的条目内容也来自用户口述）
9. **维度只记口述明确的证据，禁止推导归属**：adoption（被采纳应用）只记口述**明确说明**的采纳事实（"方案被采纳"/"已量产"/"客户验收"/"正式上线"）；禁止从 impact 指标变化（如"产能提升"）推断"已投产使用"——指标变化是 impact 的证据，投产是 adoption 的证据，口述没明确说就不记
