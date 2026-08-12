# Person Education Registration Contract v0.1（已冻结，2026-08-07）

> 冻结版（评审通过：rejected 语义保持 NEEDS_CONFIRMATION / 提取端结构化 + Candidate
> Proposal 边界 / 拒绝过渡 A 直接实现 B / 增加 Candidate Schema / period 规则归 Matcher）。
> 背景：Step 0 调查确认 education 事实登记缺口——用户确认存在（candidates/events ✅）、
> 事实来源存在（简历/用户 ✅）、事件记录存在（events ✅）、**结构化登记不存在 ❌**
> （identity.md 自由文本段落由初始化 Agent 直写，引擎 scanPersons 实测 identity: {} 全空）。
> 本契约是 JD Analysis v2 Matcher 的档案侧输入基础（Matcher 两侧必须都是登记事实）。

---

## 1. 定位（冻结级）

education 是**用户事实**（原则 8：User Confirmation Flow——Candidate → 用户确认 → 登记），
登记属于 Person Aggregate，不属于 identity.md。identity.md 退为投影（展示层），
不再承担事实存储职责。

**三者边界（冻结级）：**

```
Agent ≠ Fact Owner（只提议）
Engine ≠ Truth Creator（只登记）
User = Confirmation Authority（唯一确认权）
```

```
Candidate Confirmation（candidates/events，已有 ✅）
      │
      ▼
Person Registration Engine（本契约：登记端）
      │
      ▼
Person Aggregate（education 结构化事实）
      │
      ├── identity projection（identity.md 展示，非事实源）
      ├── resume export
      └── JD Matcher（v2 Constraint Match 档案侧）
```

## 2. Education Candidate Schema（候选 ≠ 事实，冻结级）

候选阶段结构化（Content Producer 产出；Engine 不解析自由文本）：

```yaml
education_candidate:
  id: c-001                     # 对应 extraction/candidates.md 条目
  school:
    value: University-A
    confidence: high            # high | medium（来源明确度）
  major:
    value: 机械工程
  degree:
    value: 本科                  # 归一化枚举：高中/大专/本科/硕士/博士
  period:
    start_year: 2019
    end_year: 2023
  evidence:
    source: resume.pdf           # 非结构化来源（简历/用户口述）
    quote: "University-A机械工程本科（2019-2023）"   # 原文锚点（Claim Strength ≤ Evidence Strength）
  status: pending               # pending | confirmed | rejected
```

- **候选携带原文 quote**——确认/登记可溯源；禁止引擎从自由文本自行拆解
- 未来 experience/project/skill/certificate 复用同一形态（Evidence → Candidate →
  Confirmation → Registration）

## 3. Education Artifact Schema（登记后，Person Aggregate）

```yaml
education:
  - school: University-A            # 学校（必填）
    major: 机械工程              # 专业（可选）
    degree: 本科                # 归一化枚举：高中/大专/本科/硕士/博士
    graduation_year: 2023      # 事实层存毕业年份（届别派生规则不在本层）
    status: confirmed          # pending | confirmed | rejected（复用 candidates 状态，不新造状态机）
    source: resume             # resume | user_reported
    candidate_id: c-001        # 溯源
```

- status 语义：`pending` = 已发现待确认；`confirmed` = 用户确认；`rejected` = 用户否认；
  条目缺失 = 未采集（与 rejected 区分——后者有候选痕迹但被否认）
- **period 分层**：事实层只存 `graduation_year`；「fresh/2024-2027 届」等派生判定
  属于 Constraint Matcher Policy（规则未来可变，不污染事实层）

## 4. Producer Boundary（冻结级）

| 环节 | Owner | 说明 |
|------|-------|------|
| Content Producer | 初始化采集 Agent | **生成 Education Candidate Proposal**（结构化候选 + 原文锚点）——提议，不是事实 |
| Registration Owner | **Engine** | candidate resolve（用户确认）→ 登记结构化 education 到 Person Aggregate |
| Confirmation Authority | **User** | 确认/否认候选（candidates flow 已有） |
| Projection | Engine | identity.md 教育段由登记派生（展示），非事实源 |
| Consumer | JD Matcher / 画像视图 / Resume 导出 | 只读登记事实 |

**实现前置**：现状 candidates.md 的 education 类目 content 是自由文本——候选载荷
需结构化（提取端结构化：Agent 产出 Candidate Schema，确认流不变）。

## 5. 过渡策略（冻结级：拒绝过渡 A）

**不实现「identity.md 表格化 + parseIdentity」过渡路径**——那会形成
「Agent 写 Markdown → parser 猜结构」的 Markdown Parser System 惯性（JD v1 反面），
且新增 parser 会成为新事实源的诱惑。

- 现有 identity.md 自由文本 = **历史遗留数据**（Emergency Compatibility Layer）：
  存在但不作为新功能基础，不建立解析路径
- 迁移方式：登记流程落地后，已确认候选（c-001 等）一次性登记为结构化事实，
  identity.md 教育段由投影重写
- **禁止新增依赖**：任何新功能不得消费 identity.md 教育段落

## 6. 缺件语义（供 Matcher 派生，冻结级）

| 档案侧状态 | 含义 | Matcher 派生 |
|-----------|------|-------------|
| 无 education 条目 | 未采集 | JD 有要求 → NEEDS_CONFIRMATION |
| 条目 status: pending | 已发现待确认 | NEEDS_CONFIRMATION |
| 条目 status: confirmed | 用户确认 | MATCHED / NOT_MATCHED（按 degree 比较） |
| 条目 status: rejected | 用户否认该事实 | **NEEDS_CONFIRMATION**（否认 ≠ 低学历；Unknown ≠ False，不产生 NOT_MATCHED） |

## 7. JD Matcher 输入契约（档案侧，冻结级）

```
档案侧：degree（confirmed，枚举）   vs   门槛侧：education 值集（分析产物枚举）
→ 无档案条目/pending/rejected + JD 有要求 → NEEDS_CONFIRMATION
→ degree ∈ 值集 → MATCHED；degree ∉ 值集 → NOT_MATCHED
→ JD 无该维度 → NOT_DECLARED
```

- 比较逻辑归 Engine（UI 不拥有语义判断权，原则 16）
- 届别/应届派生（graduation_year vs fresh 规则）→ Matcher Policy 层，冻结时不定规则

## 8. 验收标准（冻结后）

- Company-A Golden Case：档案 degree=本科（confirmed）+ JD 学历 本科;硕士;博士 → **MATCHED**
- 档案无 education 条目 + JD 有学历要求 → **NEEDS_CONFIRMATION**（不是 NOT_MATCHED）
- 档案 pending / rejected + JD 有学历要求 → NEEDS_CONFIRMATION
- 教育候选确认 → 登记立即生效（无 Agent 中间聚合、无 parse 路径）
- 任何新功能不消费 identity.md 教育段落

## 9. 范围边界

- **只处理 education**——不顺便重构 Person（experience/location/constraint 同类问题
  记待办，不在本契约范围）
- 不引入新状态机（复用 candidates status）
- 不实现代码（冻结后按实现顺序推进）

## 10. 实现顺序（冻结后）

```
Education Candidate Contract（提取端结构化载荷）
      ↓
Registration Engine（candidate resolve → 登记）
      ↓
Person Aggregate education（schema + 缺件语义）
      ↓
JD Analysis v2 Matcher（Constraint Match 档案侧）
```

## 11. 相关

- JD Analysis Artifact Contract v2.0（已冻结）——Matcher 门槛侧
- 原则 16（外部非结构化输入 Artifact Contract）——本契约是用户事实侧的对应物
- 记忆：[[jd-analysis-v2-contract-freeze]]
