# Automation Integration Language — Mechanical

> 语言族 ID：mechanical.automation
> 锚定岗位：非标自动化设计 / 自动化设备（甲方）/ 产线集成
> 标准版本：CareerContentStandard v1（契约：docs/contracts/CareerContentStandard-v1.md）
> 来源：12 岗位 JD 调研（2026-08-03，docs/career-content/research/mechanical/automation.md）+ 旧 direction-standards 数据迁移（2026-08-03，已复核）
> 置信度总评：High

---

## 1. 语言族定位（Purpose）

本语言族表达**系统集成能力**：把标准件、设备与产线组合为可运行的自动化系统。
核心能力链：方案设计 → 选型计算 → 集成调试 → 验收交付 → 运行改善。

## 2. Signal Coverage

### 2.1 Quality Signals（表达完整性）

| 信号 | Required | 本语言族含义 | Verification Rule |
|------|:--:|------|------|
| Q1 Object | Yes | 明确的对象（设备/产线/工装夹具/末端执行器） | 具体名词；"自动化设备"泛称不达标 |
| Q2 Method | Yes | 选型计算/气动回路/PLC 调试/联调/根因分析 | 具体到工具或方法论（选型计算/5Why/TPM） |
| Q3 Validation | Yes | 验证闭环（装配调试/验收/跑机/试产验证） | 有动作有载体（现场/验收报告/测试数据） |
| Q4 Impact | Preferred | 量化影响（节拍/OEE/交付/成本/良率） | 指标名 + 数值 + 方向，且绑定 Q1 对象 |
| Q5 Scope | Optional | 全流程跨度（方案→验收移交 / 跨部门） | 有边界描述 |

### 2.2 Mandatory Signals（行业硬约束）

| 类别 | 信号 | 覆盖规则 |
|------|------|---------|
| 选型 | 气动（SMC/Festo/亚德客）、伺服/步进电机、导轨/丝杠/直线模组、传感器 | 选型计算与校核是核心动作 |
| 电气 | PLC、HMI、变频器、触摸屏、EtherCAT | 至少一种在项目中出现 |
| 机器人 | FANUC/ABB/KUKA（或国产埃斯顿/新松/拓斯达） | 有集成/调试证据时加分 |
| 运行体系 | TPM、5S、OEE、CMK/GRR、MES/SCADA | 设备岗必须覆盖 OEE/TPM |
| 行业标准 | GB/ISO | 方案与设计引用 |

## 3. 信号标准（Q1-Q5 实例化）

### Q1 Object

**Purpose**：明确的集成对象使项目规模与复杂度可评估。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 对象类型 | Yes | 非标专机/整线/工装/末端执行器 |
| 对象名称 | Yes | 3C 自动锁螺丝机、动力电池装配线、夹爪 |
| 规模 | Preferred | 台套数/产线节拍目标/投资量级 |

**Weak Example**："负责自动化设备的设计。"

**Strong Example**："独立设计动力电池模组自动装配线（12 工位，节拍 18s），含上下料、视觉定位、伺服压装系统。"

**Verification Rule**：对象必须有类型与名称；"自动化设备/系统"无名称不达标。

**Confidence**：High

### Q2 Method

**Purpose**：选型计算与集成方法是 Automation 语言族的专业分水岭。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 选型 | Yes | 气缸/电机/减速机选型计算与校核 |
| 回路/程序 | Yes | 气动回路设计、PLC 程序调试 |
| 集成动作 | Yes | 机械联调、接口定义、视觉集成 |

**Weak Example**："负责设备选型工作。"

**Strong Example**："完成 XX 工位伺服电机选型计算（负载/惯量/加减速校核），并主导整线联调与精度验证。"

**Verification Rule**：选型必须有计算/校核动词；"选型"无计算载体不达标。

**Confidence**：High

### Q3 Validation

**Purpose**：自动化能力的验证 = 现场调试 + 验收 + 运行数据。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 验证动作 | Yes | 现场装配调试、跑机、整线联调、验收 |
| 验证载体 | Yes | 验收报告、调试记录、运行数据 |
| 结果判定 | Preferred | 满足节拍/精度/验收标准 |

**Weak Example**："设备调试完成后交付客户。"

**Strong Example**："主导整线现场联调与节拍优化，验收节拍 18s 达成（目标 20s），按期通过客户验收。"

**Verification Rule**：验证必须有载体（验收/跑机/数据）；"调试完成"无结果判定不达标。

**Confidence**：High

### Q4 Impact

**Purpose**：节拍/OEE/交付是 Automation 语言族最可信的量化锚点。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 指标名 | Yes | 节拍、OEE、UPH、停机率、良率、成本 |
| 数值 | Yes | 节拍 25s→18s、OEE 78%→86% |
| 方向 | Yes | 缩短/提升/降低 |
| 绑定对象 | Yes | 作用于 Q1 的对象 |

**Weak Example**："大幅提高了产线效率。"

**Strong Example**："优化 XX 工序布局与程序时序，产线节拍从 25s 缩短至 18s，UPH 提升 39%。"

**Verification Rule**：Impact 绑定 Q1 对象；无指标名或数值的"大幅提升"不达标。

**Confidence**：High

### Q5 Scope

**Purpose**：从方案到验收的完整交付跨度是集成能力的核心证明。

**Required Evidence**

| Evidence | Required | Example |
|----------|----------|---------|
| 流程跨度 | Yes | 从方案设计到验收移交 |
| 协作范围 | Preferred | 与电气/软件/客户现场配合 |
| 独立程度 | Preferred | 独立承担 / 主导 |

**Weak Example**：（缺失时无此信号）

**Strong Example**："独立承担 XX 设备从方案设计、选型、加工跟进到现场调试、验收移交的全流程，协调电气与软件团队。"

**Verification Rule**：Scope 必须有边界词；"全程参与"无边界不达标。

**Confidence**：Medium

## 4. 量化锚点速查（Q4 Impact 细化）

| 锚点类型 | 示例表述 | 验证要求 |
|---------|---------|---------|
| 节拍 | "产线节拍从 X 秒缩短至 Y 秒" | 有前后对比 |
| OEE | "设备 OEE 从 X% 提升至 Y%（目标 ≥85%）" | 有运行数据 |
| 交付量 | "独立交付 X 台套非标设备" | 有交付记录 |
| 成本 | "单台设备成本降低 X 万元" | 有对比基线 |
| 良率 | "设备运行良率从 X% 提升至 Y%" | 有良率数据 |
| 停机 | "非计划停机时间降低 X%" | 有停机统计 |
| 项目规模 | "主导 X 万元级自动化产线方案设计与交付" | 有合同/项目范围 |

## 5. 动词强度（L1-L4 本语言族应用）

| 层级 | 本语言族动词 | 提级证据（必须显式出现在原始文本） |
|------|------------|--------------------------------|
| L1 参与 | 参与、协助、支持 | 无提级空间 |
| L2 执行 | 设计、选型、调试、编程、出图 | 有交付物（图纸/选型单/程序/调试记录） |
| L3 主导 | 主导、独立完成、推动落地 | 决策权证据：方案定夺、验收通过、客户交付 |
| L4 体系 | 搭建（调试标准/TPM 体系/集成规范） | 体系级证据：标准/流程/团队 |

规则：动词层级 ≤ 证据层级；提级必须标注证据锚点。

## 6. 项目分组惯例

- **命名**：`[行业] [设备类型] — [客户/产线]`，如"3C 电子自动锁螺丝机 — XX 产线"
- **组织**：按行业（3C/锂电/汽配）或设备类型（装配线/检测机/包装线）；集成类按系统（上下料/输送/视觉/控制）或阶段（方案/集成/验收）
- **每项目 2-4 bullet**，交付类项目必须有验收动作

## 7. 关键词覆盖（数据附录，供 ATS 覆盖检查）

**HR 高频关键词**：SolidWorks、AutoCAD、非标设计、气动系统、伺服驱动、传动机构、PLC、传感器、方案设计、BOM、整机设计、产线自动化、节拍优化、工装夹具、装配调试、气缸、电磁阀、丝杆、导轨、同步带、步进电机、伺服电机、CCD 视觉、HMI、机器视觉（Halcon/OpenCV）、工业机器人集成、EtherCAT

**设备/集成补充**：PLC 编程调试、变频器、触摸屏、电气原理图、气路图、TPM、5S、精益生产、OEE、CMK/GRR、5Why、FTA、RCA、MES、SCADA、数据采集、预测性维护、柔性制造、数控机床、机器人上下料、输送系统、机械联调、精度验证、Takt Time、整线验收、陪产、视觉系统集成、FMEA、PMP

**ATS 底线**：SolidWorks, AutoCAD, PLC, 三菱, 西门子, 欧姆龙, 气缸, 伺服电机, 步进电机, 传感器, CCD, 视觉引导, 非标自动化, 产线, 工装夹具, 机电一体化 + 补充：HMI, 变频器, TPM, OEE, MES, SCADA, 机器人（FANUC/ABB/KUKA）, EtherCAT, 节拍, UPH, 柔性制造, FMEA, PMP
