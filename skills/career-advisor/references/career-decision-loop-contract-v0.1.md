# Career Decision Loop Contract v0.1（岗位决策闭环）

Status:
FROZEN（2026-08-08——Step 0 摸底 → 校准 4 点（引用不复制/EvidenceRef/DecisionQuestion/userReason）→ 冻结；Step 2 实现起点）

Context:
JD Analysis v1 已冻结为输入基础设施（ADR-016）。岗位匹配结果不再停在报告——
四态差距（匹配行）→ 决策候选 → 用户决策 → 行动（简历定制/投递）。
本契约是**决策编排层（orchestration layer）**：连接已有模块，不建新模块。
核心不变量：AI 建立「你为什么做这个决定」的可追溯证据链，人不被 AI 替做职业决策。

---

## 1. 复用确认（Step 0 摸底结论，2026-08-08）

| 资产 | 现状 | 结论 |
|------|------|------|
| Decision Record | `workspace/career-advisor/decisions/` 9 份记录；引擎 `engine/storage/decision-registry.ts`（M1.6 登记 `decision_{YYYYMMDD}_{序号}`）；jd-analysis 决策记录已存在（`type: jd-analysis` + `subject_id` 前置元数据） | **复用骨架**——frontmatter + 14 字段摘要表 + 专属明细段落 + 正文；岗位决策新增 `## 岗位差距明细` 段落（模式同 `## 方向评估明细` / `## 城市评估明细`），**不建第二套决策资产体系** |
| Resume Rewrite | `sub-skills/resume-writing/` + jd-analysis 阶段 4b `resume-tailoring-guide.md`（L1-L4 定制指令） | **复用**——岗位决策记录与差距明细作为定制上下文输入 |
| Application Tracking | **不存在**——skills/ 与 engine/ 均无投递跟踪模块 | **future module**——本契约只预留 intent 状态槽（见 §8） |

---

## 2. Producer Boundary（本层核心）

```
JD Matcher（事实所有者）
   │ owns
   ▼
ConstraintMatchRow（门槛：education/major/experience，含稳定 constraintRef + EvidenceRef）
能力匹配行（岗位智能 hard capabilities，含稳定 constraintRef + EvidenceRef）
   │ 引用（不复制）
   ▼
DecisionCandidate { jobId, gaps: GapRow[] }        ← Engine 投影（RPC）
   │
User（决策权威）
   ▼
UserDecision { intent, userReason, confirmedAt }    ← User 填写
   │
Agent（内容生产者，enrichment only）
   ▼
决策正文 / 准备建议 / 简历定制方案（显式标注 AI 参考）
```

禁止：
- **复制事实**——Decision Layer 不复制 requirement/status/personEvidence，只引用稳定 ID
- Agent 修改 gap 语义（四态 → 「缺少/不足/经验不足」类翻译 = 重造 22 ✗ 误报）
- Agent 决定投递（intent 归 User Confirmation）
- AI 推断（匹配度 %、方向建议）作为系统事实进入匹配/差距数据

## 3. 引用模型（Decision 不拥有事实）

上游匹配行有两个来源，**均须携带稳定 constraintRef**（Step 2 由 Engine 确定性生成，如 `education:本科` / `capability:泵选型`——维度前缀 + 原文哈希，非 Agent 生成）：

```
门槛匹配行（ConstraintMatchRow）     能力匹配行（computeJobMatch 输出）
   │                                   │
   └─────────── constraintRef ─────────┘
                     │ 投影
                     ▼
           DecisionCandidate { gaps }
```

- 未来 ConstraintMatchRow v0.2 增字段（matchMode / evidenceRefs / normalizationStatus）时，**Decision Layer 不需要同步**——它只引用 ID
- 决策记录明细段的展示列（requirement/status）是写时快照（人读友好），**权威语义一律经 constraintRef 回源 RPC**——快照不构成事实所有权

## 4. GapRow Schema（引用 + 决策层语义，非事实拷贝）

```ts
interface GapRow {
  constraintRef: string              // 引用上游匹配行（不复制 requirement/status）
  actionCategory: GapActionCategory  // 维度级确定性映射（见下）
  question: DecisionQuestion         // 确定性派生（见 §5）
}

type GapActionCategory =
  | 'SKILL_GAP'        // capability 未声明 → 技能缺口（动作方向：补充/学习）
  | 'BACKGROUND_RISK'  // major 待确认/不匹配 → 背景风险（动作方向：确认档案/评估）
  | 'POLICY_UNDEFINED' // experience 规则未定义 → 政策未定义（动作方向：确认档案）
```

- 维度级映射是**确定性分类**（不是职业判断）：
  - `capability` NOT_DECLARED → SKILL_GAP
  - `major` NEEDS_CONFIRMATION / NOT_MATCHED → BACKGROUND_RISK
  - `experience` NEEDS_CONFIRMATION（政策未定义）→ POLICY_UNDEFINED
- **「岗位偏差/是否值得」不自动分类**——判断某能力是否岗位核心需要语义理解，属 Career Ontology 冻结区（ADR-016 Known Future）；v1 只能由 User 表达

## 5. DecisionQuestion（事实派生，禁止 Agent 生成）

```ts
interface DecisionQuestion {
  type: 'CONFIRM_CAPABILITY' | 'CONFIRM_BACKGROUND' | 'CONFIRM_EXPERIENCE'
  targetId: string    // = constraintRef
  template: string    // 确定性模板填充
}
```

status × dimension → type/template 映射（固定表，Engine 实现）：

| 行状态 | 类型 | 模板 |
|--------|------|------|
| capability NOT_DECLARED | CONFIRM_CAPABILITY | 是否具备「{requirement}」？ |
| major NEEDS_CONFIRMATION | CONFIRM_BACKGROUND | 请确认「{requirement}」相关情况 |
| experience NEEDS_CONFIRMATION | CONFIRM_EXPERIENCE | 请确认毕业年份/经验情况 |

Agent 永不生成问题文本（禁止 Agent 侧「你可能缺少流体设备设计经验」类推断混入）。

## 6. EvidenceRef（延续 Claim Strength ≤ Evidence Strength）

```ts
interface EvidenceRef {
  source: 'skill_inventory' | 'education' | 'identity'
  id: string            // skillId / 教育候选 ID / 段落 ID
}
```

- personEvidence 由**上游匹配行**携带（Engine 解析 PersonSnapshot 生成），Decision Layer 只透传引用
- 显示语义：有引用 → 「来源：技能画像·电气制图与接线设计·已确认」；无引用 → 未声明（不代表不具备）
- 禁止自由文本（「电气制图与接线设计（SolidWorks/Creo）」作为 personEvidence 字符串 = 无法回源，拒绝）

## 7. DecisionCandidate（Engine 输出）

```ts
interface DecisionCandidate {
  jobId: string
  gaps: GapRow[]
}
```

- Producer = Engine（RPC `jobs/decision-draft` 投影：读岗位匹配行 → 派生 actionCategory/question → 输出）
- Agent 可读作上下文，**不可改写后回写**；UI 只投影展示

## 8. UserDecision（User 填写，Confirmation Authority）

```ts
interface UserDecision {
  intent: 'APPLY' | 'TAILORED_APPLY' | 'WATCH' | 'SKIP' | 'PENDING'
  userReason: string     // 用户自己的理由——禁止写入 Agent 建议文本
  confirmedAt: string    // ISO 时间
}
```

- 枚举对齐 jd-analysis 阶段 4a 现有词汇（投 / 定制后投 / 观望 / 跳过）+ PENDING（待定）
- Agent 阶段 4 的「投递决策 + 理由」= AI 参考建议（正文段，显式标注），**永不写入 userReason**
- Application Tracking 未来模块读取 intent 作为起点状态

## 9. Agent 位置（enrichment，不越权）

可以：
- 总结岗位价值（阶段 1-2 正文，已有）
- 生成准备建议（阶段 3 差距补课计划，已有——保持 AI 参考标注）
- 帮助写简历调整方案（阶段 4b，已有）

不可以：
- 判断你适不适合（匹配度 % 是 AI 推理参考，非系统事实）
- 自动决定投递（intent 归 User）
- 修改 gap 语义（§4 禁止项）

## 10. 数据落位（复用现有记录体系）

- 决策记录：沿用 `decisions/` 骨架；`type: jd-analysis` + `subject_id` 已有；新增 `## 岗位差距明细` 段落（GapRow 投影表：constraintRef + 展示列 + actionCategory + question）
- **JobDecisionPayload 独立设计**——不向 DecisionPayload 追加 type 分支（city/direction 边界冻结不变，见记忆 [[decision-payload-boundary]]）
- 摘要表 14 字段标量不动；`key_risk` 现有差距描述保持 AI 参考语义

### Writer 解析边界不变量（Step 3 实测教训，2026-08-08）

> **Markdown 是存储格式，不是展示文本**——Writer MUST preserve parser-owned structural boundaries。

- `## 分析摘要` 头与表格之间**禁止插入任何中间行**（`ir/summary-table.ts` SUMMARY_RE 协议——标记行插入 → 解析失败 → title undefined → 投影 NOT NULL 崩溃，实测踩坑）
- narrative **禁含引擎事实区标题**（岗位差距明细 / 城市评估明细 / 方向评估明细——防事实区伪造 + parsePayload 污染）
- Writer 输出必须可被现有投影协议回读（title/摘要表解析不失效）——**writer 输出即契约测试断言**（decision-writer.test.ts Case A 锁定）

### Artifact Format Rule v0.1（通用——所有 Markdown Artifact）

> 文档结构由 Contract 定义，不由视觉格式定义（parseNarrativeSections m 标志 bug 的深层教训——Markdown 已进入 Document Artifact 阶段）。

所有 Markdown Artifact：
- **heading 是 schema boundary**——解析以标题分节，标题文本是契约的一部分，writer 不得插入/挪动
- **table 是 structured payload**——表结构受 Parser 协议约束（如 SUMMARY_RE：表头后首个表格），中间行破坏解析
- **prose 是 untrusted narrative**——正文视为不可信叙述（AI 参考标注），不进入系统事实

## 11. v1 边界（不做什么）

- 不做「岗位偏差」自动分类（Career Ontology 冻结区）
- 不自动生成投递建议为系统事实（AI 参考除外）
- 不扩 DecisionPayload；不建 `job-decisions/` 第二套体系
- 不做 Application Tracking 实现（future module，仅预留 intent 状态槽）

## 12. Resume Rewrite Context（Step 4 适配层）

```
Decision Record → Decision Context Adapter（Engine）→ ResumeRewriteContext → resume-writing
```

- **消费通道**：Engine 投影——`decision/resume-context` RPC（params: { id: decisionId, personId }）与 `node engine/main.ts --resume-context {decisionId} {personId}` CLI 同一计算源；**resume-writing 只消费结构化上下文，不解析 decisions/ markdown**（存储格式归 Engine）
- **语义边界**：`GapReference { dimension, requirement, status, evidence: EvidenceRef[] }`——传维度/要求/状态/证据引用，**禁止「缺少流体机械经验」类自由文本判断**；叙述段（AI 参考）以 `AIReference[]` 结构化携带（preparationNotes），标注参考语义
- **简历表达**：差距行保持四态原文（NOT_DECLARED = 未声明不代表不具备 / NEEDS_CONFIRMATION = 待确认）；未声明能力 →「若候选人实际具备，可加入技能区」（人工确认式建议），**不自动添加技能**；待确认项转面试准备问题，不写进简历

---

Related:
- ADR-016（JD Analysis Data Pipeline v1 Freeze——本契约的上游输入层）
- skill-representation-contract-v0.1（PersonSkill 结构——EvidenceRef 的 skill_inventory 来源）
- jd-constraint-match-contract（四态与 ConstraintMatchRow——门槛行上游）
- 记忆：[[decision-payload-boundary]]、[[jd-analysis-v2-contract-freeze]]、[[career-decision-loop-v1]]
