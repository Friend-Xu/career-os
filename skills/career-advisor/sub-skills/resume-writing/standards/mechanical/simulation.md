# Simulation & Validation Language — Mechanical

> 语言族 ID：mechanical.simulation
> 锚定岗位：结构 CAE 仿真 / 热管理仿真 / 流体仿真（CFD）
> 标准版本：CareerContentStandard v1（契约：docs/contracts/CareerContentStandard-v1.md）
> 来源：12 岗位 JD 调研（2026-08-03，docs/career-content/research/mechanical/simulation.md）+ 旧 direction-standards 数据迁移（2026-08-03，已复核）
> 置信度总评：High

---

## 1. 语言族定位（Purpose）

本语言族表达**分析验证能力**：用数学模型回答"会发生什么"，并以仿真结果指导设计决策。
核心能力链：建模（网格/边界）→ 求解 → 结果解读 → 试验对标 → 设计优化。

## 2. Signal Coverage

### 2.1 Quality Signals（表达完整性）

| 信号 | Required | 本语言族含义 | Verification Rule |
|------|:--:|------|------|
| Q1 Object | Yes | 明确的分析对象（部件/系统/工况） | 具体名词 + 工况；"结构仿真"泛称不达标 |
| Q2 Method | Yes | 工具 + 分析类型（软件/网格/模型/求解设置） | 具体到工具与分析类型（Abaqus 非线性接触/稳态热仿真） |
| Q3 Validation | Yes | 验证闭环（试验对标/模型校准/精度验证） | 有对标动作与结果（误差 X%） |
| Q4 Impact | Preferred | 量化结论（应力/温度/压损/寿命/减重） | 数值 + 判定基准，且绑定 Q1 对象 |
| Q5 Scope | Optional | 全流程（建模→求解→报告→规范建设） | 有边界描述 |

### 2.2 Mandatory Signals（行业硬约束）

| 类别 | 信号 | 覆盖规则 |
|------|------|---------|
| 结构 | ANSYS（Workbench/Mechanical）、Abaqus、HyperMesh/HyperWorks、LS-DYNA、Nastran | 至少一种精通并在项目中体现 |
| 热 | FloTHERM、Icepak、FloEFD、COMSOL | 热岗至少一种 |
| 流体 | Fluent、ANSYS CFX、Star-CCM+ | 流体岗至少一种 |
| 理论 | 材料力学/弹塑性/疲劳理论、传热学、流体力学、湍流模型 | 分析设置体现理论依据 |
| 验证 | 试验对标、模型校准 | 仿真类项目必须含对标或验证动作 |
| 附加 | Python/MATLAB（二次开发）、ROPS/FOPS（结构安全） | 加分项 |

## 3. 信号标准（Q1-Q5 实例化）

### Q1 Object

**Purpose**：明确的分析对象与工况使仿真结论可复现、可质疑。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 对象 | Yes | 电池托盘、涡轮叶片、液冷板 |
| 工况 | Yes | 挤压/冲击、极限载荷、瞬态热冲击 |
| 分析类型 | Yes | 静强度/模态/疲劳/流场/温度场 |

**Weak Example**："负责产品的仿真分析工作。"

**Strong Example**："完成电池托盘多工况挤压仿真（静强度 + 冲击），识别 2 处应力集中风险点。"

**Verification Rule**：对象 + 工况 + 分析类型三者齐备；"仿真分析"无对象无工况不达标。

**Confidence**：High

### Q2 Method

**Purpose**：工具与模型方法证明仿真能力的技术纵深。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 软件 | Yes | ANSYS/Abaqus/Fluent/FloTHERM |
| 建模 | Yes | 网格划分（六面体/边界层）、接触设置、边界条件 |
| 模型/求解 | Preferred | 非线性/湍流/多物理场耦合、收敛控制 |

**Weak Example**："用有限元软件进行了分析。"

**Strong Example**："基于 HyperMesh 完成六面体主导网格划分，在 Abaqus 中建立非线性接触模型并完成收敛调试。"

**Verification Rule**：软件名 + 建模/求解方法缺一不可；"有限元软件"无具体工具不达标。

**Confidence**：High

### Q3 Validation

**Purpose**：试验对标是仿真可信度的唯一外部证明——仿真语言的"验证闭环"。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 对标动作 | Yes | 与试验数据对比、样机测试 |
| 偏差结果 | Yes | 误差 X%（具体数值） |
| 校准 | Preferred | 模型参数修正、二次对标 |

**Weak Example**："仿真结果与实际情况基本一致。"

**Strong Example**："完成仿真与台架试验对标，关键点应力误差 5% 以内，并校准边界条件后二次对标通过。"

**Verification Rule**：对标必须有偏差数值；"基本一致/比较符合"无数值不达标。

**Confidence**：High

### Q4 Impact

**Purpose**：仿真结论必须落地为设计决策或量化改进，否则只是"算过"。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 结论数值 | Yes | 最大应力 X MPa、温升 X℃、压损 X Pa |
| 判定基准 | Yes | 低于许用值/满足降频阈值/对标误差 X% |
| 设计影响 | Preferred | 优化方案落地（减重/降应力/改结构） |

**Weak Example**："仿真结果显示结构性能良好。"

**Strong Example**："关键件最大应力降低 18%（拓扑优化 + 圆角调整），并通过台架试验验证。"

**Verification Rule**：结论必须有数值与判定基准；"性能良好"无数值不达标。

**Impact Evidence Hierarchy**（无数值时的表达层级，不允许跨级推导）：

| Level | 类型 | 示例 | 证据要求 |
|:--:|------|------|---------|
| L1 | 明确量化 | 最大应力降 18% / 温升 X℃ / 误差 5% 内 | 数值 + 指标名 + 对象 |
| L2 | 范围化/阶段化 | 识别风险点 / 完成多工况覆盖 / 通过评审 | 有范围或阶段描述 |
| L3 | 事实结果 | 仿真与试验对标 / 优化方案落地 / 输出报告 | 仅事实 |

规则：**不得从 Level 3 推导 Level 1**（"完成对标" ≠ "误差 3%"）；基线无数值且无范围证据时，允许 L2/L3 表述并标注"建议追问量化"。

**Confidence**：High

### Q5 Scope

**Purpose**：从建模到规范的完整范围证明仿真体系能力。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 流程跨度 | Yes | 建模→求解→报告→评审 |
| 体系建设 | Preferred | 仿真规范/模板/材料数据库/自动化脚本 |

**Weak Example**：（缺失时无此信号）

**Strong Example**："搭建 XX 产品仿真规范与模板，基于 Python 实现后处理自动化脚本，单模型分析周期缩短 40%。"

**Verification Rule**：体系建设必须有交付物（规范/脚本/库）。

**Confidence**：Medium

## 4. 量化锚点速查（Q4 Impact 细化）

| 锚点类型 | 示例表述 | 验证要求 |
|---------|---------|---------|
| 应力/变形 | "最大应力降低 X% / 变形控制在 Xmm 内" | 有分析结果 + 判定基准 |
| 减重 | "拓扑优化减重 X%，通过强度验证" | 有验证闭环 |
| 对标 | "仿真与试验误差 X% 以内" | 有对标数值 |
| 温度/温升 | "最高温度降低 XK / 整机温升降至 X℃" | 有仿真或实测 |
| 热阻 | "接触热阻降低 X%" | 有材料/结构依据 |
| 压损 | "流道压损降低 X%" | 有前后对比 |
| 寿命 | "预测疲劳寿命 X 万次，安全系数 X.X" | 有载荷谱依据 |
| 效率 | "收敛时间缩短 X%" | 有方法依据（参数化/二次开发） |
| 网格 | "完成百万级网格的 XX 模型划分" | 有模型规模数值 |

## 5. 动词强度（L1-L4 本语言族应用）

| 层级 | 本语言族动词 | 提级证据（必须显式出现在原始文本） |
|------|------------|--------------------------------|
| L1 参与 | 参与、协助、支持 | 无提级空间 |
| L2 执行 | 分析、建模、网格划分、求解、写报告 | 有交付物（模型/报告/云图） |
| L3 主导 | 主导、独立完成、推动优化落地 | 责任证据：方案提交与决策、评审通过、设计影响被采纳 |
| L4 体系 | 搭建（仿真规范/模板/自动化流程） | 体系级证据：规范/脚本/库/团队使用 |

规则：动词层级 ≤ 证据层级；提级必须标注证据锚点。

**结果 ≠ 领导责任**（Responsibility Signal Ladder 关键原则）：
- 客户验收通过 ≠ 主导（需责任证据：负责交付 / 协调验收 / 处理验收问题）
- 方案获客户接受 ≠ 主导方案（售前方案认可不构成交付责任）
- 参与测试/评审/试制 ≠ 升主导（参与 FAT 不代表领导责任）
- 提级时输出证据锚点，无法锚定则保留原层级

## 6. 项目分组惯例

- **命名**：`[产品/系统] [分析类型] — [工具]`，如"涡轮叶片 流-热-固耦合 — ANSYS"
- **组织**：按分析类型（结构/流体/热/多物理场）或产品分组
- **每项目 2-4 bullet**，强调工具→方法→结果→验证全链条；仿真类项目必须包含对标或验证动作

## 7. 关键词覆盖（数据附录，供 ATS 覆盖检查）

**HR 高频关键词**：ANSYS、Abaqus、HyperWorks、HyperMesh、ANSA、Optistruct、LS-DYNA、Nastran、Fluent、Star-CCM+、COMSOL、ADAMS、MATLAB、Python、有限元、结构分析、流体仿真、动力学、拓扑优化、轻量化、疲劳分析（Ncode）、热分析、模态分析、多物理场、网格划分、二次开发（Tosca/Isight）

**热补充**：FloTHERM、Icepak、FloEFD、传热学、热阻、温升、结温、风冷/液冷/自然散热、水冷板、VC 均温板、热管、相变材料、红外热像仪、风洞

**流体补充**：ANSYS CFX、湍流模型、多相流、动网格、流固耦合、边界层网格、压损/压降、流场分布、UDF、收敛性

**ATS 底线**：ANSYS, Abaqus, HyperWorks, HyperMesh, LS-DYNA, Nastran, Fluent, Star-CCM+, COMSOL, ADAMS, MATLAB, Python, 有限元, 力学, 仿真, 拓扑优化, 轻量化, 疲劳, 模态 + 热/流体：FloTHERM, Icepak, FloEFD, CFX, 传热学, 热阻, 温升, 液冷, 湍流模型, 多相流, 流固耦合, 压损, 试验对标, UDF
