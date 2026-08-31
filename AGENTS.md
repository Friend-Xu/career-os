# 职业决策分析系统

Career OS 是本地工作台：`engine/`（Node 24 原生 TS 零构建引擎：markdown 真相源 → IR 契约 → WebSocket RPC/事件）+ `UI/`（Vite + React 19 工作台）+ `skills/career-advisor/`（协议与知识资产——Agent 运行时不直读，引擎按需注入协议段）。**已非 Claude Code 插件体系**（ADR-030 H：运行时直连 LLM 服务商，claude-agent-sdk / CLI 登录态全部退役）。

## 使用
- 启动：`node runtime/supervisor.mjs`（或双击 StartWebUI.bat）→ 打开 http://localhost:5288
- 引擎 WS：ws://127.0.0.1:5289（仅本机回环）
- 配置：`career-os.config.json`（首次运行自动生成；来源优先级 CLI > env > 文件 > 默认）

## 工作目录
运行时数据存储在 `workspace/career-advisor/`（gitignored，首次运行自动创建）。

## 子流程
方向探索 → 转行分析 → 城市评估 → 公司筛选 → 公司尽调 → JD分析 → 综合结论

## 数据边界（Agent Safety Rules）

Career OS 区分**系统资产**（engine/ skills/ 可执行逻辑与框架）与**用户资产**（workspace/ 职业数据）。系统可升级，个人资产永远独立。

Agent 必须（must）：
- 将 `workspace/` 视为私人用户数据——职业经历、成果证据、个人决策、薪资目标、面试记录
- 系统资产与用户资产分离存放，不混合
- 写入 profiles/、decisions/ 等敏感文件时遵守 PreToolUse 钩子确认

Agent 禁止（must not）：
- 建议或执行把 `workspace/` 内容提交到 git（尤其公开仓库）
- 将用户职业记录移入 examples/ 或任何公开可见文件
- 生成含私人信息（薪资、联系方式、面试记录）的公开产物

## 数据与架构隔离（Data Source Boundary）

真实职业数据与架构代码存在**硬边界**，不是"推送前检查一下"的软约定：

- **Real Data Domain = workspace/ + 本地 career-os.config.json**（均 gitignored）——真实职业数据唯一允许存在的位置
- **Architecture = Data-Shape Domain**——engine/ skills/ docs/ 只描述结构（CompanyRecord、JDConstraint 等类型），不携带真实实例
- **Synthetic Fixture**——测试/契约/示例数据必须是独立构造、与 workspace 任何真实实体**零语义关联**的数据（`Company-A`/`City-X`/`University-A`）；禁止"真实数据改名"式匿名化（匿名化仍把真实结构复制进架构）
- 真实实体（背调公司名、学校名、项目代号、用户偏好短语如通勤圈）**禁止写入架构文件**；用户偏好数据（如通勤圈城市）写入本地 career-os.config.json，代码从配置读取，不硬编码
- **sanitize 是最后一道泄漏检测，不是数据架构**：`scripts/sanitize-check.mjs` 扫描 git 跟踪文件（真实实体清单 + 手机/邮箱/身份证），pre-commit 与 npm test 均拦截；发现命中 → 修复架构文件（真实数据回 workspace/），不要绕行
