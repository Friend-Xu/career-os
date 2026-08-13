# Person Snapshot 身份/偏好键契约（v1）

> 2026-08-13 | 背景：identity.md / preference_constraints.md 由初始化 Agent 以自然中文键写入（经验/现居/期望薪资），引擎投影按英文规范键读取（years_experience/location/salary_range/city）→ 投影静默为空。career_profile.md 有契约（career-profile-contract.md），本文件补齐另两个快照文件的机器可读表约定。

## 1. 机器可读表（summary-table 协议）

- 段落名必须为 `## 分析摘要`——summary-table 协议只识别该段落，其他段落名解析结果为空
- 两列表：`| 字段 | 值 |`（首行表头 `| 字段 | 值 |`）

## 2. 规范键（canonical keys）

**identity.md：**

| 键 | 含义 | 示例 |
|----|------|------|
| years_experience | 工作经验（可含 Gap 说明） | 3 年工作经验（含 2025.04-2026.03 考研备考 Gap） |
| location | 现居/意向城市 | 苏州 |
| current_status | 当前状态（可选） | 在职 / 求职中 |
| education | 学历（可选） | 本科 |
| graduation_year | 毕业年份（可选） | 2023 |

**preference_constraints.md：**

| 键 | 含义 |
|----|------|
| salary_range | 期望薪资 |
| city | 期望城市 |

**identity.md `## 工作经历` 表（简历公司条目头 Candidate——Resume Entry Contract §4）：**

| 键 | 含义 | 示例 |
|----|------|------|
| company | 公司名 | 某医疗器械公司 |
| role | 职位 | 机械工程师 |
| start | 开始（YYYY.MM） | 2023.07 |
| end | 结束（YYYY.MM；在职可空） | 2025.03 |

段落名必须为 `## 工作经历`；表位于该段落内、`###` 小节之前。空值用 `-`。

展示性字段（性别/年龄/求职意向/薪资类型等）无引擎映射，可保留自然标签——只影响人读，不影响投影。

## 3. Producer Boundary

| 角色 | 归属 |
|------|------|
| Content Producer | 初始化采集 Agent（组织用户确认内容写表） |
| Registration Owner | engine person-watcher（snapshotOf → PersonSnapshot.identity / preference 投影） |
| Consumer | UI Person.identity（简历身份 seed 等）；ledger 偏好约束 |
| **Authority** | **用户确认流程（Candidate → 用户确认 → 登记）** |

## 4. 红线

- 键必须用英文规范键——中文键导致投影**静默为空**（2026-08-13 实测：UI 简历身份 seed 缺城市/经验）
- 段落名必须 `## 分析摘要`——改段落名同样导致投影静默为空
- 引擎消费键（上表）之外的字段保持自然标签即可，不要"规范化"成英文
