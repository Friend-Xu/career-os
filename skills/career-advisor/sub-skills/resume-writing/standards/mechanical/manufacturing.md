# Manufacturing Improvement Language — Mechanical

> 语言族 ID：mechanical.manufacturing
> 锚定岗位：机加工艺 / 注塑工艺 / 装配制程（PE）
> 标准版本：CareerContentStandard v1.3（契约：docs/contracts/CareerContentStandard-v1.md）
> 来源：12 岗位 JD 调研（2026-08-03，docs/career-content/research/mechanical/manufacturing.md）+ 旧 direction-standards 数据迁移（2026-08-03，已复核）
> 修订（2026-08-13，v1.3）：撰写规范调研（writing-norms.md）——量化锚点可得性标注 + 「负责」警示
> 置信度总评：High

---

## 1. 语言族定位（Purpose）

本语言族表达**制造改善能力**：把"怎么造"变成可执行、可验证、可持续改善的工艺体系。
核心能力链：工艺设计 → 试产验证 → 数据监控（SPC）→ 根因改善 → 体系固化。

## 2. Signal Coverage

### 2.1 Quality Signals（表达完整性）

| 信号 | Required | 本语言族含义 | Verification Rule |
|------|:--:|------|------|
| Q1 Object | Yes | 明确的对象（产品/制程/工序/产线） | 具体名词；"生产工艺"泛称不达标 |
| Q2 Method | Yes | 工艺方法与工具（SOP/PFMEA/SPC/DOE/防错/编程） | 具体到工具与方法论名称 |
| Q3 Validation | Yes | 验证闭环（试产/首件/工艺验证 PV/SPC 监控） | 有动作有载体（试产报告/首件记录/控制图） |
| Q4 Impact | Preferred | 量化影响（良率/Cpk/节拍/成本/换型时间） | 指标名 + 数值 + 方向，且绑定 Q1 对象 |
| Q5 Scope | Optional | 全流程跨度（试产→量产 / 体系覆盖） | 有边界描述 |

### 2.2 Mandatory Signals（行业硬约束）

| 类别 | 信号 | 覆盖规则 |
|------|------|---------|
| 体系 | IATF16949/ISO9001、APQP、PPAP、VDA6.3 | 汽车件岗位必须覆盖 |
| 质量工具 | PFMEA、SPC、8D、5Why、DOE、控制计划（CP）、Minitab | 至少三种在项目中出现 |
| 精益 | 精益生产、VSM、5S、Kaizen、六西格玛、SMED | 改善项目引用 |
| 工艺专项 | 机加：UG/Mastercam/PowerMill、CAM、刀具、尺寸链；注塑：试模/Moldflow/参数调试；装配：防错/线平衡/伺服压装/电动拧紧 | 按岗位类型覆盖 |
| 数据 | Cpk、良率、UPH、标准工时 | 改善必须有数据支撑 |

## 3. 信号标准（Q1-Q5 实例化）

### Q1 Object

**Purpose**：明确的制程对象使改善成果可定位、可复用。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 对象类型 | Yes | 产品/制程/工序/产线 |
| 对象名称 | Yes | XX 注塑件良率、XX 装配线 XX 工序、XX 零件 CAM 编程 |
| 约束 | Preferred | 节拍要求、材料、设备类型 |

**Weak Example**："负责生产工艺优化工作。"

**Strong Example**："主导 XX 精密注塑件（PA+GF 材料）制程优化，解决缩水与翘曲缺陷。"

**Verification Rule**：对象必须有类型与名称；"生产工艺"无对象不达标。

**Confidence**：High

### Q2 Method

**Purpose**：工艺方法的专业性体现在工具与体系的运用深度。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 工艺工具 | Yes | SOP/PFMEA/SPC/DOE/防错/控制计划 |
| 体系动作 | Yes | APQP/PPAP 提交、NPI 导入 |
| 专项方法 | Yes | 参数调试/模流分析/CAM 编程/线平衡 |

**Weak Example**："改进生产工艺，提升质量。"

**Strong Example**："通过 DOE 优化注塑参数（保压/模温），并更新 PFMEA 与控制计划。"

**Verification Rule**：方法必须有具体工具名；"优化工艺"无工具不达标。

**Confidence**：High

### Q3 Validation

**Purpose**：制程改善必须经过验证闭环，否则是未落地的方案。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 验证动作 | Yes | 试产/首件检验/工艺验证（PV）/SPC 监控 |
| 验证载体 | Yes | 试产报告/首件记录/控制图/8D 报告 |
| 结果判定 | Preferred | 达到目标（Cpk≥X / 良率≥Y%） |

**Weak Example**："改进方案已应用到产线。"

**Strong Example**："改善后连续 5 批试产验证，关键尺寸 Cpk 从 1.1 提升至 1.45，通过 PPAP 审核。"

**Verification Rule**：验证必须有载体与结果判定；"已应用"无验证数据不达标。

**Confidence**：High

### Q4 Impact

**Purpose**：良率/Cpk/节拍/成本是 Manufacturing 语言族最可信的量化锚点。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 指标名 | Yes | 良率、Cpk、节拍、UPH、成本、换型时间、异常数 |
| 数值 | Yes | 良率 92%→96%、Cpk 1.1→1.45 |
| 方向 | Yes | 提升/降低/缩短 |
| 绑定对象 | Yes | 作用于 Q1 的对象 |

**Weak Example**："产品质量得到显著提升。"

**Strong Example**："根因分析定位夹具定位缺陷，重新设计定位方式，3 个月内良率从 92% 提升至 96%。"

**Verification Rule**：Impact 绑定 Q1 对象；无指标名或数值的"显著提升"不达标。

**Impact Evidence Hierarchy**（无数值时的表达层级，不允许跨级推导）：

| Level | 类型 | 示例 | 证据要求 |
|:--:|------|------|---------|
| L1 | 明确量化 | 良率 92%→96% / Cpk 1.1→1.45 | 数值 + 指标名 + 对象 |
| L2 | 范围化/阶段化 | 消除瓶颈工序 / 完成防错覆盖 / 通过试产验证 | 有范围或阶段描述 |
| L3 | 事实结果 | 通过 PPAP 审核 / 解决缺陷 / 编制 SOP 落地 | 仅事实 |

规则：**不得从 Level 3 推导 Level 1**（"通过 PPAP 审核" ≠ "良率提升 10%"）；基线无数值且无范围证据时，允许 L2/L3 表述并标注"建议追问量化"。

**可得性档位规则（v1.3）**：良率/Cpk/节拍多为**工程指标档**（制程数据自己统计所得）；成本节省属业务结果档，组织数据不透明时不编。结果未知 → 写确定性终点（通过试产验证/PPAP 提交）。**无证据数字 = 最严重违规**。

**Confidence**：High

### Q5 Scope

**Purpose**：从试产到量产的跨度与体系覆盖证明工艺管理能力。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 流程跨度 | Yes | 试产（NPI）→ 量产爬坡 |
| 体系覆盖 | Preferred | SOP 覆盖 X 条产线 / 标准工时体系 |

**Weak Example**：（缺失时无此信号）

**Strong Example**："主导 XX 产品 NPI 试产到量产（60 天），编制 SOP 12 份，覆盖 3 条产线。"

**Verification Rule**：Scope 必须有边界词。

**Confidence**：Medium

## 4. 量化锚点速查（Q4 Impact 细化）

| 锚点类型 | 示例表述 | 验证要求 | 可得性档位 |
|---------|---------|---------|:--:|
| 良率 | "良率从 X% 提升至 Y%" | 有前后数据 + 时间范围 | 工程指标 |
| Cpk | "关键尺寸 Cpk 从 X 提升至 Y" | 有控制图/PPAP 依据 | 工程指标 |
| 节拍/UPH | "XX 工序节拍从 X 秒优化至 Y 秒 / UPH 提升 X%" | 有节拍测算 | 工程指标 |
| 成本 | "国产化替代年度节省 X 万元 / 单件成本降 X%" | 有对比基线 | 业务结果 |
| 换型 | "SMED 换型从 X 分钟降至 Y 分钟" | 有前后对比 | 工程指标 |
| 异常 | "累计解决制程异常 X+ 项" | 有记录 | 交付物 |
| 标准化 | "编制 SOP X+ 份，覆盖 X 条产线" | 有交付物 | 交付物 |
| 刀具 | "刀具寿命从 X 件提升至 Y 件" | 有寿命记录 | 工程指标 |

## 5. 动词强度（L1-L4 本语言族应用）

| 层级 | 本语言族动词 | 提级证据（必须显式出现在原始文本） |
|------|------------|--------------------------------|
| L1 参与 | 参与、协助、支持 | 无提级空间 |
| L2 执行 | 编制、调试、分析、编程、检验 | 有交付物（SOP/程序/报告/记录） |
| L3 主导 | 主导、独立完成、推动闭环 | 责任证据：方案决策、改善闭环责任、PPAP 提交责任 |
| L4 体系 | 搭建（工艺标准/防错库/改善体系） | 体系级证据：标准/库/流程/团队 |

规则：动词层级 ≤ 证据层级；提级必须标注证据锚点。

**结果 ≠ 领导责任**（Responsibility Signal Ladder 关键原则）：
- 客户验收通过 ≠ 主导（需责任证据：负责交付 / 协调验收 / 处理验收问题）
- 方案获客户接受 ≠ 主导方案（售前方案认可不构成交付责任）
- 参与测试/评审/试制 ≠ 升主导（参与 FAT 不代表领导责任）
- 提级时输出证据锚点，无法锚定则保留原层级

**「负责」警示（v1.3）**：「负责」×3 以上 = HR 跳过信号——只描述职责范围非个人贡献。职责范围 → 条目头/description；bullet 用成果式动词（独立完成/主导/优化/重构）+ 方法 + 量化结果。动词与职级匹配：执行层「协助/参与/完成」、骨干「主导/编制/优化」——层级错配反向扣分。

## 6. 项目分组惯例

- **命名**：`[产品/产线] — [制程阶段/问题]`，如"XX 产品注塑制程 — 良率提升"
- **组织**：按产品线或制程类型（注塑/机加工/焊接/装配）
- **每项目 2-4 bullet**，制程改善项目按"问题 → 根因 → 对策 → 验证"闭环组织

## 7. 关键词覆盖（数据附录，供 ATS 覆盖检查）

**HR 高频关键词**：SOP、工艺流程、PFMEA、SPC、DOE、8D、PDCA、控制计划（CP）、CAD、SolidWorks、良率、制程优化、NPI（EVT/DVT/PVT）、DFM、工装夹具、BOM、标准工时、Minitab、机加工、注塑、焊接、钣金、表面处理、装配工艺、精益生产（VSM/5S/Kaizen）、六西格玛、MES、IATF 16949、ISO 9001

**机加补充**：UG/NX、Mastercam、PowerMill、CAM 编程、工艺路线、工序卡、切削参数、走刀路径、刀具寿命、夹具/检具、尺寸链、形位公差、数控车/加工中心/龙门铣/镗床/磨床、APQP、CAPP/PLM

**注塑补充**：注塑机（海天/震雄/发那科/ENGEL/住友）、工艺参数（温度/压力/速度/保压/背压）、模具（浇口/流道/冷却/顶出）、试模、Moldflow、缺陷（气泡/缩水/变形/披锋/熔接痕/翘曲/银纹）、材料（PP/ABS/PC/PEEK/PA+GF）、PPAP

**装配补充**：线平衡、节拍（Takt）、UPH、防错（Poka-Yoke）、伺服压装、电动拧紧、扭矩清单、极限样件/防错样件、VDA6.3、工艺验证（PV）

**ATS 底线**：SOP, PFMEA, SPC, DOE, 8D, PDCA, Minitab, CAD, SolidWorks, NPI, DFM, IATF 16949, ISO 9001, ISO 14001, Cpk, 良率, 制程, 工艺, 工业工程 + 机加：UG, Mastercam, PowerMill, CAM, 刀具, 夹具, 尺寸链, APQP, 数控 + 注塑：注塑, 试模, Moldflow, 模具, PPAP, PEEK, PPSU + 装配：VDA6.3, 防错, Poka-Yoke, 线平衡, UPH, 标准工时, 伺服压装, 电动拧紧
