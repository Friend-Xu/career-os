# JD Match Score Contract v0.1（岗位匹配度）

Status:
FROZEN（2026-08-14——DRAFT 后用户评审 2 处校准 → 冻结；实现起点）

Context:
JD 匹配度现状 = Agent 在 jd-analysis 决策摘要表手写 direction_match（52%/55%），
无落盘依据、不可审计、不可复现（skill 有 matching-model.md 加权模型，但每维分数
不落盘，执行不可验证）。公司侧已完成同构问题的引擎化（Company Assessment
Contract v0.1：事实 → 规则表 → 可解释分）。本契约把 matching-model 引擎化：
**Agent 只产事实（JD capabilities / 画像技能 / 门槛），Engine 只算分**。

**冻结前 2 处校准（用户评审）**：① 未纳入维度（差异化优势 15%）→ **85 分制披露**
（score 上限 85，UI 显示「62 / 85」+ 维度明细——未知 ≠ 满分，与 company-assessment
哲学一致；归一 100 与「未知 ≠ 满分」冲突被否）② **方向对齐维度 v1 不做**——岗位
无结构化方向数据（方向只在决策 payload），先补方向登记会翻倍工作量；列为 Known
Future，触发条件 = 岗位方向数据结构化。

**冻结后补充（2026-08-14，行业调研 grounding + 用户评审）**：规则表与行业实践对齐，
调研结论见 §3.4。已知未采纳项：must/plus 2:1 权重（待评审）；语义匹配策略（待研究）。

语义边界（三线分离，继承 company-assessment-contract §1）：

| | 岗位匹配度（本契约） | 公司职业价值 qualityScore | 投递意愿 intent |
|---|---|---|---|
| 回答 | 这个岗位与我匹不匹配 | 作为职业选择对象值不值得关注 | 我是否投递 |
| 依赖 | person | 不依赖人 | 用户 |
| Producer | Engine（确定性计分） | Engine（确定性计分） | User（Confirmation） |
| 归属 | JD Analysis 投影 | Company Intelligence | Decision Record |

匹配度是**派生数据（Projection Artifact）**——随 JD 分析或画像技能变化而变，
Engine 不回写任何 markdown。

---

## 1. 三层模型

```
Layer 1  输入事实（零新采集——全部已有资产）
           JD capabilities（jd-analysis 产物：must/plus + hard/soft）
           画像技能 PersonSkill（persons/ skill_inventory）
           门槛三行 ConstraintMatchRow（学历/专业/经验四态）
           ↓
Layer 2  匹配规则表（Engine 持有：状态向量 → 维度分 1-5，确定性映射）
           ↓
Layer 3  JDMatchScore（Engine 派生：status + score + dimensions + 证据引用）
           ↓
UI 消费（RPC 纯投影，不回写）
```

## 2. 维度口径（继承 matching-model.md 权重，引擎可计算子集）

skill 模型权重：硬技能 25% + 经验 20% + 领域知识 15% + 差异化优势 15% + 软技能/文化 15% + 学历/证书 10%。

引擎化映射：

| 本契约维度 | 权重 | 引擎输入 | 覆盖的 skill 维度 |
|-----------|:---:|---------|------------------|
| 能力覆盖 | 55% | hard capabilities 覆盖三元组（satisfied/transferable/missing） | 硬技能 25 + 领域知识 15 + 软技能 15 |
| 门槛 | 30% | 学历/专业/经验三行四态 | 经验 20 + 学历/证书 10 |
| （未纳入） | 15% | —— | 差异化优势 15（转行背景激活——AI 判断维度，v1 不引擎化） |

口径说明：
- **领域知识并入能力覆盖**：JD 分析中标准/法规/工具类要求（如「容器管道法兰标准」）
  已表达为 hard capabilities，经能力覆盖维度计分——不单独设维度（与 skill 模型
  的"领域知识"输入同源）。
- **软技能不产出硬匹配**（Capability Matching Boundary 既有决策）：soft 责任单元
  不参与 computeJobMatch，person 侧也无软技能声明源——并入能力覆盖但不单独计分。
- **差异化优势 15% 未纳入**：仅转行背景激活，需要 AI 判断"独有优势"——引擎无法
  确定性计算。**未纳入 ≠ 默认满分**：分数上限 85，UI 明示「差异化维度未纳入」。

### 上限口径（已冻结：方案甲——85 分制披露）

score = Σ(维度分 × 权重)，max 85，UI 显示「62 / 85 · 差异化维度未纳入」。
与 company-assessment 哲学一致（未知 ≠ 满分）。

## 3. 规则表（Layer 2，Engine 持有）

### 3.1 能力覆盖维度分（权重 55%，输入 = hard capabilities 三元组）

输入结构（computeJobMatch 既有产物）：
- `satisfied`：声明水平 ≥3（可独立产出）
- `transferable`：声明水平 1-2（有基础需补强）
- `missing`：未声明（需学习）；must missing = 核心要求未声明

| 状态向量（v2 加权口径：must×2 + nice×1） | 维度分 | 语义（对齐 skill 1-5 分制） |
|---------|:-----:|---------------------------|
| weightedMissing=0 且 transferable=0 | 5 | 全覆盖 |
| weightedMissing=0 且 satisfied>0 且 transferable>0 | 4 | 完全满足（核心全声明，有基础项存在） |
| weightedMissing=0 且 satisfied=0（全为 transferable） | 3 | 基本满足（差半级——全是有基础需补强） |
| mustMissing=0 且 weightedMissing>0（缺的全是加分项） | 3 | 核心全覆盖，少量缺口 |
| mustMissing>0 且 weightedMissing≤6 | 2 | 部分满足（差一级；6 = 现行 3 个缺口的核心×2 等价） |
| mustMissing>0 且 weightedMissing>6 | 1 | 不满足（核心大面积缺失） |
| 无 hard capabilities（岗位未分析） | 无数据 | 维度不参与，status 降级 |

> 实现校准（2026-08-14，§8.2 授权「实现时按真实数据校验，分界调整」）：评审版 5 行
> 分界（transferable≤2 / must 全满足且 missing≤3）实现时校准为 6 行 **total 表**——
> 原表两处状态无行可落（missing=0 且 satisfied=0；mustMissing=0 且 missing>3），
> 补行后每个状态恰命中一行（有序求值）。规则行必须 total——不允许状态向量落空。
>
> **v2 修订（2026-08-14，用户评审通过）**：缺口计量从「个数」改为「加权重量」
> （must×2 + nice×1——job-copilot「必需项权重 2、优先项权重 1」）：核心缺口致命一倍，
> 「核心全覆盖、只差加分项」与「加分全覆盖、缺核心」不再同分。满足侧只参与 4/5 行
> 定性判定（规则行未量化满足数，加权无作用点）。ruleVersion = 2026-08-jd-match-v2。

规则 grounding：声明水平语义继承 gap-calculator（满足≥3 / 可迁移 1-2 / 缺失未声明
——skill-inventory v0.1 的水平定义），不新发明分级标准。

### 3.2 门槛维度分（权重 30%，输入 = 三行四态）

| 四态 | 维度分 | 语义 |
|------|:-----:|------|
| MATCHED | 5 | 满足 |
| NOT_DECLARED（岗位未要求该维度） | 中性 | 该行从权重剔除，其余行按权重占比归一 |
| NEEDS_CONFIRMATION（画像缺失或规则未定义） | 3 | 待确认——不判负（Unknown ≠ False） |
| NOT_MATCHED | **硬门槛否决** | 见 §3.3 |

### 3.3 硬门槛一票否决（skill 模型规则引擎化）

matching-model：学历/证书不满足明确「要求」→ 标注硬门槛不满足，不计算综合分。

引擎规则：任一门槛行 status = NOT_MATCHED（画像明确不满足岗位明确要求）→
`status = HARD_GATE_FAILED`，score = null，UI 显示「硬门槛不满足」+ 具体行。
NEEDS_CONFIRMATION 不触发否决（未确认 ≠ 不满足）。

### 3.4 调研 grounding（2026-08-14，规则表行业对齐——不凭经验写分）

完整调研记录见 `jd-match-score-research-2026-08-14.md`（行业做法细节 + 同类项目
ai-job-search 1.5.0 分析 + 开源三派技术路线 + 采纳决策）。本节为压缩版。

| 本契约设计 | 行业依据 | 来源 |
|-----------|---------|------|
| 硬门槛一票否决（§3.3） | 资格不通过 → eligible=false，不进入评分（校招/社招匹配规则）；ATS「硬性门槛一票否决」 | job-copilot 开源匹配规则 / 新东方网 ATS 底层逻辑总结（2026） |
| 有效分母收缩（maxScore：NOT_DECLARED 剔行） | coverage = 有证据的评分项权重 / 全部评分项权重 × 100 | job-copilot 匹配规则 |
| 分数可解释（维度明细 + 证据展开） | 「每个分数需可点开看证据（命中原句、缺口项、待面试确认项）」 | 北森 EHR 简历自动匹配规则 |
| 权重区间（能力 55 / 门槛 30） | 必备技能 30–45%、行业场景经验 15–30%、教育证书 5–15%（能力维度为合并口径，含经验/通用能力） | 北森 EHR 权重建议 |
| 水平分级阈值（满足 ≥3 = 可独立产出） | Level 3 = Capable：培训完成、质量稳定、免检查独立产出；Level 2 = Developing：能独立做但质量不稳定 | Upleashed 0-5 capability framework（基于 ESCO 技能分类数据的行业框架） |
| 关键实践对齐：硬门槛先行（不能用其他优势抵消） | 同左 | job-copilot / 北森 |

**Known Gap（调研发现、本版未采纳——见调研记录 §5 采纳决策）**：

1. **must/plus 权重区分**：已实现（2026-08-14，用户评审通过）——job-copilot「JD 必需项
   权重 2、优先项权重 1」；缺口计量改加权重量（must×2 + nice×1），规则行分界同步换算
   （≤6 = 现行 3 个核心缺口等价），ruleVersion = 2026-08-jd-match-v2（§3.1 v2 修订注记）。
2. **同义匹配（"be generous"）**：行业已从关键词匹配升级到语义（智联双塔 / 大厂 ATS
   语义向量）；开源第三派（受控词表 + 模糊匹配）证明确定性同义归一可行。本系统采用
   第三派：alias/tools 数据层归一——skill_inventory 补 alias（复合技能名拆词）+ 词表
   扩充是 D 类数据修复，匹配侧维持词表精确匹配。调研记录 §5 采纳点 ①。
3. **城市冲突 FLAG**：已实现（2026-08-14）——ai-job-search 的 Location 否决制不适用于
   本系统（其 FAIL 基于 current location 事实；我们的 preference_constraints 是意向软偏好，
   用户行为可能推翻声明）。实现为 `city: { preferred, jobLocation, conflict }` 提示字段：
   conflict=true 仅 UI ⚠ 标注（卡片/tooltip/投决区），**不扣分不出局**；无偏好数据 →
   null 不提示（不知道去哪 = 不提示）。

## 4. 状态模型

```
EVALUATED          核心维度均有数据，score 计算
PARTIAL            能力维度无数据（岗位未分析）或画像技能未登记 → 不计算，诚实标注
HARD_GATE_FAILED   门槛行 NOT_MATCHED → 一票否决，score = null
```

与 company-assessment 的状态模型同构（INSUFFICIENT_DATA 语义并入 PARTIAL——
能力维度无数据与画像无技能合并为「数据不足以计算」）。

## 5. JDMatchScore Schema（Layer 3，纯投影）

```ts
interface JDMatchScore {
  jobId: string
  personId: string
  status: 'EVALUATED' | 'PARTIAL' | 'HARD_GATE_FAILED'
  score: number | null            // 0-85（未纳入维度披露）；HARD_GATE/PARTIAL = null
  dimensions: {
    capability: {
      score: number               // 1-5
      weight: 55
      satisfied: string[]         // 能力名（UI 展开依据）
      transferable: string[]
      missing: string[]           // 含 must 标记
      mustMissing: string[]
    }
    gate: {
      score: number | null        // 1-5；NOT_MATCHED → 触发否决，score 无意义
      weight: 30
      rows: { dim: 'education' | 'major' | 'experience'; status: MatchStatus; requirement: string; person: string }[]
    }
  }
  excluded: { label: string; weight: number }[]  // 未纳入维度披露（差异化优势 15）
  verdict?: string            // 判定档位（EVALUATED 专用）：高度匹配/推荐投递/备选/观望
                              // provisional 借档 job-copilot 阈值（85/70/50），本地数据积累后
                              // Benchmark 校准——档位是 UI 语义层，阈值修订不 bump 规则表版本
  city: { preferred: string; jobLocation: string; conflict: boolean } | null  // 城市冲突 FLAG（非否决）
  ruleVersion: string             // 评分规则版本（历史分数可审计）
  assessedAt: string
}
```

## 6. RPC 与 UI 消费

- RPC：`jobs/match-score { jobId, personId }`——纯投影按需计算（个人工具 JD 量级小，
  侧栏对每个 JD 拉一次，无批量优化）。
- UI 消费点：
  - **JD 池侧栏卡片**：匹配度行改为引擎分数（现 directionMatch 投影移除）。
    「62 / 85」+ tooltip 展开维度明细（依据 = 能力名单/门槛行）。
  - **JD 工作区**：投决区「JD 匹配」旁显示引擎分数 + 维度展开；决策记录区的
    directionMatch 保留原样（历史决策的 AI 判断是记录，不改写）。
  - 刷新时机：JD 分析完成（jd-analysis 决策落盘事件）/ 画像技能变化 → 重拉。
- directionMatch 去留：保留为决策记录的 AI 参考字段（历史兼容），**不再作为
  卡片匹配度数据源**。

## 7. Producer Boundary

| 层 | Producer |
|----|----------|
| JD capabilities / 门槛行 / 画像技能（输入事实） | 既有 Producer 不变（Agent 采集 + Engine 登记） |
| 规则表（维度权重 / 状态向量映射） | Engine（本契约冻结后编码） |
| JDMatchScore（分数 + 维度明细） | Engine 纯投影——Agent 禁止写匹配度结论 |

## 8. 评审点汇总（已冻结 2 项，其余为实现检查点）

1. **上限口径**：已冻结——85 分制披露（§2）
2. **能力维度分映射行**：已完成——实现校准为 6 行 total 表（§3.1 校准注记）
3. **领域知识并入能力覆盖**：已确认（§2——标准/法规类要求已由 hard capabilities 承载）
4. **方向对齐维度**：已冻结——v1 不做，Known Future（触发条件 = 岗位方向数据结构化）
5. **ruleVersion 与 AI 历史分数的并存**：卡片切换数据源后，AI 的 52%/55% 只留在
   决策记录区——历史记录不改写。
