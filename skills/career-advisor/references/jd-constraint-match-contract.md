# JD Constraint Match Engine Contract v0.2（已冻结，2026-08-07）

> 冻结版（评审通过 4 项修正：Artifact/IR 分层 + normalizationStatus / minimum requirement
> 语义显式化 / rejected 保持 NEEDS_CONFIRMATION / 多学历 confirmed-only）。
> 定位：Matcher = 两份已冻结契约的汇合点——门槛侧（JD Analysis Contract v2.0 的
> `## 岗位门槛` Constraint Artifact）+ 档案侧（Person Education Registration
> Contract v0.1 的 facts/education.md）。两侧都是登记事实，无一侧是 Markdown 猜测。
> 本契约冻结：Constraint IR schema / 学历层级 Match Policy / 四态派生规则 /
> Derived Data 边界 / 范围（第一批只 education）。

---

## 1. 定位（冻结级）

```
JD Analysis v2（门槛侧）          Person Fact（档案侧）
  Constraint Artifact               facts/education.md
  education: [本科;硕士;博士]        degree: 本科, status: confirmed
        │                                │
        └────────────┬───────────────────┘
                     ▼
              Match Engine（纯函数，无落盘）
                     │
                     ▼
           MATCHED / NOT_MATCHED / NOT_DECLARED / NEEDS_CONFIRMATION
```

- Match Engine = 纯派生（无副作用、不写 Artifact、不写事实）——四态结果是投影
- 比较逻辑归 Engine（UI 不拥有语义判断权，原则 16）；**UI 不自己解释——Engine 输出
  evidence 解释（person/requirement），UI 只渲染结果与原因**

## 2. 输入 Schema（Artifact 层 ≠ IR 层，冻结级）

### 档案侧（PersonEducation，已冻结）

```ts
interface PersonEducation {
  school: string
  major?: string
  degree: string        // 枚举：高中/大专/本科/硕士/博士
  startYear?: number
  graduationYear?: number
  status: 'pending' | 'confirmed' | 'rejected'
  source: 'user_reported' | 'resume'
  candidateId?: string
}
```

### 门槛侧 IR（Constraint Artifact → Parser → IR——归一化不覆盖原文）

**Artifact 层**（`## 岗位门槛` 表格）保存 JD 原文枚举（Derived Data Separation）。
**IR 层**（Parser 产物）显式分层：

```ts
type NormalizationStatus = 'NORMALIZED' | 'NEEDS_CONFIRMATION'

interface JDConstraintEducationIR {
  rawValues: string[]          // 原文枚举（「硕士及以上」「本科;硕士;博士」原文形态）
  normalizedDegrees?: string[] // 归一化后学历枚举（可归一化时；「及以上」展开）
  normalizationStatus: NormalizationStatus
  confidence: 'high' | 'medium'
  source: string               // 原文锚点
}
```

例：「硕士及以上」→ `{ rawValues: ['硕士及以上'], normalizedDegrees: ['硕士', '博士'], normalizationStatus: 'NORMALIZED' }`——
**rawValues 永远保留**（未来「本科优先，硕士更佳」等语义不因归一化丢失）。

其他维度（schema 预留，规则后续）：`major?: { rawValues; fuzzy?; ... }`、`experience?: { rawValue; ... }`。

## 3. Match Policy（学历层级，冻结级）

degree 层级（Matcher Policy 常量）：

```
高中(0) < 大专(1) < 本科(2) < 硕士(3) < 博士(4)
```

**v1 education policy 仅支持「最低学历模型」，不支持偏好权重**（显式禁止误解）：

| JD 表述 | 归一化 | 语义 |
|---------|--------|------|
| 「本科及以上」/「必须本科」 | → [本科;硕士;博士]（或下限展开） | **minimum requirement**（进 hard match） |
| 「硕士优先」/「本科以上，硕士优先」 | 不进 hard match | **preferred**（不参与 v1 硬匹配；未来偏好模型） |
| 「应届」「不限」 | normalizationStatus=NEEDS_CONFIRMATION | 无法归一化，不猜 |

- `min_rank = min(rank(normalizedDegrees))`——**匹配时派生（Derived Data），禁止写回 Artifact**
- 无法归一化（NEEDS_CONFIRMATION）→ 该维度一律 NEEDS_CONFIRMATION，Parser 不猜

## 4. 四态派生规则（写死表，冻结级）

**Match candidate set = status=confirmed 的 education 条目（仅此）**——pending/rejected
不参与最高学历计算（「本科 confirmed + 博士 pending」→ 按本科算，博士忽略）。

| 档案侧 | 门槛侧 | 结果 |
|--------|--------|------|
| —（JD 无 education 维度） | — | NOT_DECLARED |
| confirmed 集合为空（无条目 / pending / rejected） | education 有要求 | NEEDS_CONFIRMATION |
| confirmed 集合非空，max(rank) ≥ min_rank | education 有要求（NORMALIZED） | MATCHED |
| confirmed 集合非空，max(rank) < min_rank | education 有要求（NORMALIZED） | NOT_MATCHED |
| 任意 | education normalizationStatus=NEEDS_CONFIRMATION | NEEDS_CONFIRMATION |

- **Unknown ≠ False**：档案缺失/pending/rejected 一律 NEEDS_CONFIRMATION，不产生
  NOT_MATCHED（否认 ≠ 低学历——契约 §6 已冻结，保持）
- 多学历取 confirmed 集合中 rank 最高者（本科+硕士 → 按硕士）

## 5. Engine 接口（冻结级）

```ts
interface EducationMatchResult {
  status: 'MATCHED' | 'NOT_MATCHED' | 'NOT_DECLARED' | 'NEEDS_CONFIRMATION'
  evidence: { person?: string; requirement: string }  // 解释：UI 渲染「因为」原因，不自行解释
}

matchEducation(
  personEducation: PersonEducation[],
  constraint: JDConstraintEducationIR | undefined,
): EducationMatchResult
```

例：`{ status: 'MATCHED', evidence: { person: '本科', requirement: '本科及以上' } }`

## 6. 范围（第一批，冻结级）

**只实现 education 维度匹配**。暂缓：
- major（专业）匹配——fuzzy 语义（「相关专业」）走 User Confirmation 的设计待定
- experience / 届别匹配——graduation_year 与 fresh 规则归 Matcher Policy 未来
- soft/preference Capability——不进入 Match Engine（v2 契约已冻结）
- 偏好权重模型（PREFERRED/EXACT）——v1 不支持，禁止把偏好当硬门槛
- UI 岗位门槛区——等 Match Engine 稳定后接（Step 2.4）

## 7. 实现顺序（冻结后）

```
2.1 Constraint Artifact Parser   岗位门槛表格 → JDConstraint IR（rawValues 保留 + 归一化 +
                                 normalizationStatus）
2.2 Requirement Normalizer       min_rank 派生（Derived Data，不落盘）
2.3 Match Engine 纯函数          matchEducation（四态 + evidence 解释）
2.4 Projection                   UI 岗位门槛区（表格卡片：维度/门槛值/你的情况/四态结果）
```

## 8. 验收标准（Golden Case）

| Case | 档案侧（confirmed 集合） | 门槛侧 | 预期 |
|------|------------------------|--------|------|
| 1 Company-A | degree=本科 | education=[本科;硕士;博士] NORMALIZED | MATCHED |
| 2 JD 未写学历 | 任意 | 无 education 维度 | NOT_DECLARED |
| 3 档案缺失 | 空集合 | education=[本科;硕士] | NEEDS_CONFIRMATION |
| 4 无法归一化 | 任意 | education=[应届] NEEDS_CONFIRMATION | NEEDS_CONFIRMATION |
| 5 低于要求 | degree=大专 | education=[本科;硕士;博士] | NOT_MATCHED |
| 6 多学历 | 本科+硕士（均 confirmed） | education=[本科;硕士] | MATCHED（取最高） |
| 7 多学历含 pending | 本科 confirmed + 博士 pending | education=[硕士] | NOT_MATCHED（pending 不参与） |
| 8 归一化 | degree=本科 | 「硕士及以上」→ [硕士;博士] | NOT_MATCHED（本科 < 硕士下限） |
| 9 偏好表述 | degree=本科 | 「硕士优先」→ 不进 hard match | NOT_DECLARED（v1 无偏好模型） |

## 9. 相关

- JD Analysis Artifact Contract v2.0（已冻结）——门槛侧
- Person Education Registration Contract v0.1（已冻结）——档案侧
- 记忆：[[jd-analysis-v2-contract-freeze]]
