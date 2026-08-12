# Career OS 架构与现状总览

> 2026-08-06 | 反映当前实现状态（M6 Target Intelligence + M6.5 User Foundation 方向），非愿景

## 0. 一句话概括

Career OS 是一个**基于证据链的职业决策 + Artifact Evolution 系统**（Decision → Evolution Pipeline）：输入方向/JD/公司/行业信息，经分析、映射、验证、决策，输出可验证职业资产（Resume / Portfolio / Interview）。三件套：`skills/`（Claude Code 插件：知识与分析协议源）+ `engine/`（本地 Node 引擎：markdown 真相源 → IR 契约 → SQLite 投影 → WebSocket RPC/事件）+ `UI/`（React 工作台：可视化 + 常驻 AI 面板）。

```mermaid
flowchart LR
    subgraph 技能层["skills/ 插件层（Claude Code）"]
        SK["SKILL.md 意图路由 + 子流程"]
        DIR["references/directions/ 8 方向画像卡"]
        PROT["references/protocols/ 输出协议"]
    end

    subgraph 引擎["engine/ 本地引擎（Node 24 原生 TS，零构建）"]
        WS["transport/websocket.ts<br/>WS 桥 :5289"]
        IR["ir/schema.ts 契约源"]
        PROJ["storage/projection.ts<br/>better-sqlite3 投影"]
        WATCH["report-watcher / context-watcher<br/>knowledge-watcher"]
        RUNTIME["runtime/ 决策历史投影 + Agent 运行时 + 差距分析"]
        AGENT["agent/adapter/claude.ts<br/>claude-agent-sdk 封装"]
    end

    subgraph 前端["UI/ 工作台（Vite + React 19 + MUI）"]
        SHELL["AppShell：顶栏 + 导航 + 侧栏 + 主区"]
        PANEL["agent-panel 常驻 AI 面板"]
        STORE["store/app-store.ts（zustand）"]
        CLIENT["store/engine-client.ts WS 客户端"]
        PAGES["7 页面：工作台/Agent/信息池/公司/投递/简历/设置"]
    end

    subgraph 运行时["runtime/ 运行时层（Runtime Safety Layer v1）"]
        SUP["supervisor.mjs<br/>生命周期守护 + 端口预检 + 崩溃恢复"]
        STORE2["state/runtime.json<br/>owner / 进程 PID / 端口（gitignored）"]
        DOCTOR["doctor.mjs / stop-all.mjs"]
    end

    subgraph 数据["workspace/career-advisor/（markdown 真相源）"]
        MD["profiles/ + decisions/ + companies/ + decision-contexts/<br/>knowledge/ + jobs/(M6 迁入 targets/) + evidence/ + claims/ +<br/>resumes/ + proposals/ + portfolio/ + interviews/ +<br/>targets/（M6 机会资产：公司×岗位）+ persons/（M6.5 主体资产：person_001）"]
    end

    SK -->|读取| DIR
    SK -->|生成| MD
    WATCH -->|监听扫描| MD
    IR -.->|契约类型| PAGES
    WS -->|RPC + 事件| CLIENT
    CLIENT --> STORE
    STORE --> SHELL
    SHELL --> PAGES
    SUP -->|spawn + 树清理| WS
    SUP -->|spawn + 树清理| SHELL
    SUP --> STORE2
    DOCTOR -.->|读取/清理| STORE2
    SHELL --> PANEL
    AGENT -->|spawn| CLI["本机 Claude CLI<br/>（复用登录态）"]
    WS --> RUNTIME --> AGENT
    PROJ --> IR
    RUNTIME --> IR
```

## 1. 三层职责

| 层 | 目录 | 职责 | 关键点 |
|----|------|------|--------|
| 技能层 | `skills/career-advisor/` | 分析协议与知识源：意图路由、7 子流程、8 方向画像卡、14 字段摘要协议 | Claude Code 插件，`--plugin-dir .` 加载；产出 markdown 真相源 |
| 引擎层 | `engine/` | markdown 真相源 → IR 契约 → SQLite 投影 → WS RPC/事件；Agent 对话通道；**Artifact 演化（Resume/Portfolio/Interview：Fact → Proposal → 用户决策 → 版本）** | Node 24 原生 TS（type-stripping，零构建、仅 erasable syntax）；**零依赖外部服务**（除 better-sqlite3/chokidar/ws/SDK） |
| 前端层 | `UI/` | 工作台可视化 + AI 对话 | React 19 + Vite 5 + MUI + zustand 5；浅色瑞士风默认 |
| 运行时层 | `runtime/` | 应用生命周期守护（横切启动层）：supervisor（recovery → 端口预检 → spawn → 统一关闭）+ stop-all + doctor | Node 24 原生 ESM，零依赖；runtime.json 原子写（gitignored）；可复用为 CodeNarrator / Translate-video-WebUI 共用运行时 |

## 1.5 系统定位：Decision → Evolution Pipeline

Career OS 不是"决策分析系统"或"简历工具"的单一职责，而是**决策入口 + 资产演化出口**的闭环：

```
输入：方向 / JD / 公司 / 行业信息
        ↓
Decision Layer（分析、映射、验证、决策）
        ↓
Target Intelligence（M6：目标环境模型——Company Identity → Target 机会资产 → Context → Compatibility）
        ↓
Evidence Mapping（evidence/claims 事实层）
        ↓
Artifact Layer（可验证职业资产演化）
        ↓
输出：Resume / Portfolio / Interview
```

| 层 | 职责 | 资产 |
|----|------|------|
| Decision Layer | JD 分析、公司尽调、方向评估、差距分析、推荐 | decisions/ companies/ jobs/(→targets/) knowledge/ |
| Target Intelligence（M6） | 目标环境模型：谁在招 / 岗位要什么 / 我怎么证明（Compatibility） | companies/company_001/（实体资产）targets/target_001/（机会资产） |
| User Intelligence（M6.5 冻结：Person Intelligence Bootstrap） | 用户主体模型：我是谁 / 我做过什么 / 技能边界 / 偏好限制——Snapshot + Events + Owner Protocol | persons/person_001/（snapshot/identity、career_profile、skill_inventory、preference_constraints + events/ + experience/） |
| Evidence Mapping | 事实层——分析结论落为可消费事实，Artifact Fact 锚定于此 | claims/ evidence/ |
| Artifact Layer | 同一治理范式（Fact Preservation + Controlled Evolution + Projection）的独立实例 | resumes/ portfolio/ interviews/ |

- 依赖单向：Decision → Evidence → Artifact；Artifact 演化不反向修改分析资产
- Artifact 间引用（Artifact Reference Protocol）**尚未设计**（M4-4 待决）；Cover Letter 需求出现前不做通用引用协议（Concrete first）

## 2. 引擎架构

**单向依赖**（自上而下）：`transport/ runtime/ agent/ → storage/ → ir/` + `config.ts logger.ts`

```
engine/
├── main.ts                 启动编排：config → workspace → logger → 投影 → WS 桥 → watcher
├── config.ts               CLI > env > config.json > 默认；fail fast（ConfigError）
├── logger.ts               应用日志（logs/engine.log，10MB×3 轮转）+ traces（logs/traces/）
├── ir/
│   ├── schema.ts           ★ 契约源：8 实体 + Validation + AgentError/AgentQuestion + ProtocolVersion（引擎单方维护）
│   ├── resume.ts           ResumeDocument IR（claimId 必填主链 + M3.5 版本/Proposal IR）
│   ├── portfolio.ts        Portfolio Artifact IR（M4-1：FactItem→Evidence 模型）
│   └── interview.ts        Interview Artifact IR（M4-2：Fact/Expression/Strategy 三层）
├── ir/validator.ts         合法化 + 降级（必填缺失→invalid；值域非法→degraded）
├── storage/                markdown 真相源唯一出口
│   ├── workspace.ts        目录树 + metadata/protocol.json
│   ├── report-watcher.ts   decisions/*.md → IR（扫描 + chokidar 监听）
│   ├── context-watcher.ts  decision-contexts/{问题}.md 解析 + 监听
│   ├── knowledge-watcher.ts knowledge/skills.md + roles.md 词表（别名归一化）
│   ├── evidence-watcher.ts / claim-watcher.ts   evidence/ claims/ → IR（M2/M3-0 事实层）
│   ├── job-watcher.ts      jobs/ → IR + 建档（M1）
│   ├── resume-watcher.ts   resumes/ 版本系统（M3.5：documents/drafts/exports + 状态机）
│   ├── proposal-watcher.ts proposals/ AI 建议层（M3.5.6：登记 + 12 校验码 + accept/reject + 决策反馈投影）
│   ├── portfolio-watcher.ts portfolio/ 项目事实治理（M4-1：P-01~P-07 + immutable published）
│   ├── interview-watcher.ts interviews/ 问答资产治理（M4-2：I-01~I-08 + draft→reviewed→ready）
│   ├── resume-draft.ts     Draft Manifest → ResumeDocument 组装（Assembly，AI 只写草稿不写 IR）
│   ├── artifact-registry.ts 系统 ID 登记（决策/证据/Claim/简历/项目/QA 共用）
│   ├── projection.ts       better-sqlite3 5 张投影表
│   └── graph-builder.ts    图谱派生（pool/graph）
├── benchmark/              M3-3 Artifact Evolution Benchmark：runner/parser/reference-check/
│                           provenance-check/report（确定性审计，无 AI Judge、无总分、无 ranking）
├── context/career-context.ts AI Read Model（CareerContext 投影——AI 不直接读 IR）
├── runtime/
│   ├── decision-runtime.ts 决策历史投影（按类型分组，无推进语义）
│   ├── decision-aggregate.ts 聚合视图（contexts/list，只聚合不评分）
│   ├── gap-calculator.ts   差距分析（满足≥3/可迁移 1-2/缺失，不打分）
│   ├── claim-coverage.ts / claim-selector.ts  表达候选选择（M3-0/M3-1，可解释 priority）
│   ├── evidence-coverage.ts 岗位证据覆盖（M2，三态不做匹配分）
│   └── agent-runtime.ts    Agent 任务注册表 + 权限挂起表（requestId 往返）+ cancel
├── export/resume-export.ts Resume PDF 导出（Edge headless，复现三元组 + checksum）
├── feedback/writer.ts      rewrite/feedback 事件记录（只记录不学习）
├── health/checker.ts       健康投影（--doctor 与 system/health 同一计算源）
├── agent/adapter/claude.ts claude-agent-sdk 封装：事件归一化 + 权限握手 + resume + 回答通道 + 思考事件
└── transport/
    ├── protocol.ts         ★ RPC 方法清单 + 事件清单（见下）
    └── websocket.ts        WS 桥 :5289（RPC + 事件广播 + 优雅关闭）
```

**WS 协议**（`transport/protocol.ts`，35 个 RPC + 6 类事件）：

| RPC | 方法 | 说明 |
|-----|------|------|
| `system/init` | 握手 | 协议/版本/工作区路径 |
| `decisions/list` `decisions/rescan` `decision/history` | 决策 | 全量 IR（含 validation）→ 重扫 → 决策历史投影（按类型分组） |
| `contexts/list` | 聚合 | 决策上下文按需组装 |
| `knowledge/graph` `knowledge/gap` | 知识层 | 技能/岗位图谱 + 差距分析 |
| `companies/list` `persons/list` `pool/graph` | 视图数据 | 公司/人/信息池图谱 |
| `agent/start` `agent/answer` `agent/cancel` `agent/permission` | Agent | 任务启停 + 提问回答 + 权限决策回传 |
| `resumes/list|get|clone|transition|diff|export` | 简历版本 | M3.5 版本系统（状态机 + 导出） |
| `proposals/list|accept|reject` | AI 建议层 | M3.5.6 提案闭环（checksum 强校验 + 决策反馈） |
| `portfolio/*` | Portfolio | M4-1：项目/提案列表、transition、accept/reject |
| `interviews/*` | Interview | M4-2：QA/提案列表、transition、accept/reject |
| `ai/context` | AI Read Model | CareerContext 全资产投影 |
| `jobs/*` `evidence/list` `claims/list|coverage|select` | 事实层 | 建档 + 事实/表达候选 |

事件：`data.decisions.changed` / `data.pool.changed` / `data.jobs.changed` / `data.evidence.changed` / `data.claims.changed` / `data.resumes.changed` / `data.proposals.changed` / `data.portfolio.changed` / `data.interviews.changed`（变更信号，客户端重拉快照）、`error.engine`、`agent.event`（Agent 流式事件，见 §4）。

## 2.5 Architecture Evolution（M3/M4 演进）

### Phase 1：Decision Intelligence（M1/M2）

JD → Decision → Career Mapping——决策分析为主（方向/城市/公司/JD 分析闭环）。

### Phase 2：Artifact Evolution（M3/M4）

Fact Layer → Proposal → Human Decision → Artifact Version

三个 Artifact 不是三个功能模块，而是**同一个治理范式的三次实例化**：

| 治理原则 | 含义 |
|----------|------|
| Fact Preservation | 事实层不可被 AI 修改——非法行为在 schema/parser/apply 中不存在（非运行时拦截） |
| Controlled Evolution | AI 只能经 Proposal 通道，用户确认后引擎确定性应用（append-only，永不覆盖） |
| Projection | 引擎确定性聚合（CareerContext/PortfolioContext/InterviewContext），不成为事实存储 |

当前 Artifact：**Resume**（职业经历演化）/ **Portfolio**（项目事实演化）/ **Interview**（经验表达演化）；Cover Letter（M4-3）为下一环。

## 2.6 决策链六阶段体系建设现状（2026-08-06 盘点）

决策链 = 方向探索 → 转行评估 → 城市评估 → 公司筛选 → JD分析 → 简历定制。**前 3 阶段（JD 之前）长期未建设**——只有技能层协议与决策文本记录，无资产体系/引擎解析/真实 UI；后 3 阶段为 M1-M4 完整体系。

| 阶段 | skill 映射 | 技能层协议 | workspace 资产 | 引擎支持 | UI |
|------|-----------|-----------|---------------|---------|-----|
| 方向探索 | career-path | ✅ 8 方向画像卡 + path-scoring-model | ✅ profiles/我.md 目标方向 + 方向决策记录（机器人 82%/CAE 78%/流体 74%） | ⚠️ 仅决策记录解析进链（无 profile watcher） | ⚠️ 工作台方向视图（mock 数据） |
| 转行评估 | career-transition | ✅ transition-model/gap-analysis/motivation-check | ✅ 决策记录（转行评估） | ⚠️ 同上 | 决策链阶段展示 |
| 城市评估 | city-advisor | ✅ city-scoring-model/advisor-template | ❌ **cities/ 空目录**（无任何城市资产落盘） | ❌ 无 | ⚠️ 工作台城市热力图（mock 数据） |
| 公司筛选 | company-screener | ✅ | ✅ companies/ 旧扁平档案 + company_001（M6 实体资产，identity locked） | ✅ companies/list（旧格式解析；company_001 未解析） | ✅ 公司页（接引擎） |
| JD分析 | jd-analysis | ✅ | ✅ **jobs/ 已清空** → targets/target_001/（M6：target/jd/requirement_matrix/company/product/industry_context + compatibility） | ❌ **targets/ 无 watcher**——M6 资产引擎侧断链，UI jobs 页失去真实数据源 | jobs 页（接引擎旧 jobs/ 解析） |
| 简历定制 | resume-writing | ✅ CareerContentStandard | ✅ resumes/ + evidence/(3) + claims/(9) + proposals/ + portfolio/ + interviews/ | ✅ 全链路（M3/M4 + resume target_id 契约） | ✅ 简历中心 + Artifact Studio |

**结论**：
1. **M6.5 Person Intelligence 是前 3 阶段的地基**——方向探索/转行评估/城市评估的输入正是"我是谁/我做过什么/我的边界"；决策链已降级为决策历史视图（ADR-008），四模块是分析视图非流程步骤（ADR-010）
2. **M6 遗留架构缺口**：targets/ 资产无引擎 watcher（M6 是协议 + 文档资产 + 消费产物层）；Resume 已按 target_id 契约升级但引擎无 target 实体
3. **Person 真相源断裂**：profiles/ 无引擎解析，UI Person 为 mock 种子（含指向不存在文件的家人A），INDEX.md 用户画像表空行——M6.5 以 persons/person_001/ Snapshot + Owner Protocol 修复（ADR-009）
4. **cities/ 与方向资产缺口**：城市评估零落盘；方向画像卡是技能层知识，未与决策/User 数据打通

## 3. 前端架构

**单向依赖**：`pages/ components/ → store/ → data/ → types/`

```
UI/
├── App.tsx              AppShell + ToastHost
├── components/layout/   AppShell（顶栏/图标导航/次侧栏/主区/status-bar）+ agent-panel（常驻 350px AI 面板）
├── pages/               7 页：workbench（工作台）agent（决策 Agent）infopool（信息池图谱）
│                        companies（公司探索）applications（投递管理）resumes（简历中心）settings
├── store/app-store.ts   唯一全局状态（zustand + persist 白名单，sessions 不持久化）
├── store/engine-client.ts WS 客户端（连接/重连/离线降级）
├── data/mock-data.ts    演示数据唯一来源（真实接线的数据源除外）
├── data/constants.ts    设计 token（COLORS 是 CSS 变量引用，RISK_COLOR 是 solid hex）
└── types/index.ts       契约引用（import type 自 engine/ir/schema.ts，仅 UI 扩展字段本地定义）
```

关键交互：换人即换全局强调色（主题联动）；`startAnalysis(prompt)` 预置上下文 → AI 面板聚焦（所有"唤起 AI"入口走它）；agent-panel 与 agent 页共享同一会话（`currentSessionId`）。

## 4. Agent 通道（真实 Claude CLI 对话）

```
UI 消息 → agent/start → engine agent-runtime → SDK query（spawn 本机 Claude CLI，复用登录态）
        → stream_event/assistant 消息 → 归一化 AgentEvent → agent.event 广播 → UI 流式渲染
```

事件流（`ir/schema.ts` AgentRuntimeEvent）：`text_delta` 流式文本 / `tool_start|tool_done` 工具 chips / `thinking_start|thinking_delta|thinking_stop` 思考指示器 + 折叠思考块 / `permission_request`（requestId 往返，前端弹窗决策）/ `question_request` AskUserQuestion 卡片 / `session_id`（resume 凭据）/ `done|error`。

已实测的 SDK 行为（SDK 0.3.220，管道模式）：
- AskUserQuestion 形状 = user 消息 `tool_use_result.questions[]`；`ask_user` 必须 canUseTool allow 否则 CLI 静默挂起
- 管道模式提问立即跳过 → 回答走下一轮文本送达（`answer()` streamInput 通道 + resume 续接兜底）
- 思考：`system thinking_tokens` 实时进度（指示器源）+ assistant 消息 thinking 块全文（折叠展示）

## 5. 数据流

```
markdown 真相源（workspace/career-advisor/）
  → watcher 监听（chokidar）→ 全量重扫 → IR 解析 + 校验（version 分派）
  → SQLite 投影同步 → 广播变更信号 → UI 重拉快照（RPC）
```

- 引擎是投影方：markdown 是真源，SQLite 只是查询投影（可重建）
- 契约改动走版本演进（validator 按 version 分派），UI 无感知
- UI 离线（引擎未启动）→ 降级 mock 数据 + 状态栏"引擎离线"

## 5.5 数据边界：System Domain vs Workspace Domain

Career OS 分两个域，**系统可升级，个人资产永远独立**：

| 域 | 内容 | 位置 | git |
|----|------|------|-----|
| **System Domain**（系统域） | 可执行逻辑、schema、工作流、prompt、模板 | `engine/` `skills/` `UI/`（代码） | 入库 |
| **Workspace Domain**（工作区域） | 用户职业数据：profiles/ decisions/ companies/ decision-contexts/ knowledge/ cities/ | `workspace/` | **永不提交**（gitignored） |

隐私红线：职业经历、成果证据、个人决策、薪资目标、面试记录是私人数字资产，**绝不进公开仓库**。Agent 行为约束见 AGENTS.md「数据边界」。

## 5.6 Runtime Health（健康投影）

统一健康报告层，**Health Engine（`engine/health/checker.ts`）是唯一计算源**——CLI 与 UI 禁止各自实现健康计算。

- 四维度投影：workspace / decisions / graph / knowledge（`HealthReport` 契约 v1，`ir/schema.ts`）
- Consumers：`--doctor` CLI（启动参数一次性输出）、`system/health` RPC、WebUI 角标（工作台卡片 / 信息池 / status-bar）
- 报告**一致性/完整性问题**（invalid、孤立节点、缺失文件），**不执行自动修复或数据迁移**（Detection ≠ Remediation）
- 空数据源按空维度 score=100 诚实处理（缺数据 ≠ 脏数据）

## 5.7 Resume Export（简历产物出口）

简历编辑工作流 → 可拿走的人工产物（PDF）：

- 前端组装打印 HTML（HTML 转义防注入）→ `resume/export` RPC → 引擎 spawn Windows 自带 Edge `--headless --print-to-pdf`（零依赖，借鉴 md-to-pdf 工具链）→ base64 返回 → 前端 Blob 下载
- 离线/Edge 缺失 → 降级 `window.print()`（Print CSS 隐藏应用壳）
- **不包含**：evidence-driven 简历组合、career graph 推理、版本化简历产物（V3，ADR-003/005 defer）

## 6. 部署与进程生命周期

```
StartWebUI.bat（双击）→ runtime/supervisor.mjs（Runtime Safety Layer v1）
  ├─ engine:  .local/node/node.exe main.ts   → WS :5289
  └─ ui:      .local/node/node.exe vite      → :5288（strictPort）
```

- **环境隔离**：内置便携 node `.local/node/node.exe`（不依赖系统 PATH）；一切运行时/依赖在项目根内
- **Runtime Safety Layer v1**：supervisor 持有生命周期——`runtime.json` 原子写（state/，gitignore）记录 owner/进程真实 PID/端口；SIGINT/SIGBREAK/SIGHUP 统一关闭（running → stopping → taskkill 树 → 删 state = 干净关闭标记）；启动自愈（recovery：owner PID 存活拒双实例，残留按"PID 存活 + 命令行归属验证"才 kill，防 PID 复用误杀）；**端口预检**（spawn 前查 5288/5289 占用者：项目孤儿 → 清理；外部程序 → 明确报错拒绝，不 EADDRINUSE 崩溃）；`stop-all.bat` 显式停止；`node runtime/doctor.mjs` 诊断
- **进程树杀**：任一子进程退出 → 联动关闭全部；taskkill /PID /T /F（固定用法，绝不 /IM）
- 引擎优雅关闭：SIGINT/SIGTERM → `handle.shutdown()`（中止活跃 Agent 任务）→ 800ms 后退出
- 端口：5288（UI）/ 5289（引擎 WS），strictPort 防漂移
- Job Object（父死必清）为 Future Enhancement：`runtime/native/windows-job-object.md`——Node 无原生实现，启用需 native addon，随桌面化/商业发行再投入

## 7. 测试与验证

| 层 | 手段 | 入口 |
|----|------|------|
| 引擎 | node:test + 真实 CLI smoke | `npm test`（290 用例，2026-08-05）、`npm run smoke:bridge/handlers/question`、`tests/agent-bridge-check.mjs`（WS 全链路）、`tests/thinking-adapter-smoke.mjs`（思考事件） |
| Benchmark | engine/benchmark 确定性审计 + dataset/cases 10 例 | runner.caseXXX / report 测试（无 AI Judge、无总分）；`dataset/tools/generate-report.mjs` 出报告 |
| 前端 | tsc --noEmit | `npm run typecheck` |
| 端到端 | Playwright（MCP）驱动真实浏览器 + 真实 CLI | 手工驱动；进/出页面白屏回归、Agent 流式/提问/权限/思考验证 |
| 数据 | `--scan-decisions` 验收入口 | 一次性扫描 → 控制台 IR + Validation |

## 8. 落地状态与路线

**已完成**：引擎骨架（1）→ 决策解析（2）→ 桥接+投影（3）→ Agent 适配层（4）→ 决策链状态机（5）→ V1.5 上下文聚合 + 复盘闭环 → V2 知识层 + 差距分析 → Agent 通道（提问/权限/回答/resume）→ 思考过程（指示器 + 折叠块）→ 进程生命周期 + 一键启动 → 健康投影（契约 v1 + --doctor + RPC）→ 简历改写（指令式 Revision Request，审计闭环）→ 简历 PDF 导出（Edge headless，零依赖）→ 文档权威链 + ADR 登记 → **Runtime Safety Layer v1**（supervisor 生命周期 + runtime.json 所有权追踪 + 崩溃恢复 + 统一关闭 + 端口预检 + doctor 诊断）。
→ **M3 表达链路（M3-0 → M3.5.8）**：Claim/Evidence 双入口 → 表达候选选择 → Resume Assembly → Proposal Layer（AI 只能写提案）→ 决策反馈投影 → 架构总索引（三层模型 + 七条不变量）
→ **M3-3 Artifact Evolution Benchmark v0.1**：10 case 数据集 → Runner 确定性审计 → Report Projection（无总分/无 ranking/无 AI Judge）
→ **M4 Artifact Evolution**：Admission Contract（C1-C6 准入 + System Invariants）→ Portfolio（项目事实治理：P-01~P-07、immutable published、draft(v+1)）→ Interview（三层问答资产：I-01~I-08、draft→reviewed→ready）→ Cover Letter（第一个 Projection Artifact：NarrativeUnit 引用源 Fact Layer，adapt only）→ Artifact Reference Protocol（宪法层：Owner + Target Fact Locator + Relation，resolveLocator 只答存在性，无 registry）→ 各 Runtime Validation（引擎测试 351/351 全绿）
→ **M4-5 Artifact Studio（Governance UI）**：四 slice——Assets 概览（ArtifactSummary 类级投影：Engine Context → Cards，无 version）→ Proposal Center（统一评审 Workflow，Diff 只统一 Presentation Contract；领域层四 adapter Concrete First，Accept/Reject 走原 watcher）→ Evolution Timeline（ArtifactTimelineEvent 确定性投影：at → append order → id，Proposal 是 source 非事件）→ Fact Traceability（Cover Letter 表达单元 → sourceRefs → Resolved Fact 只读定位，断链显式无 fallback）。治理闭环：**Decision → Evidence → Artifact Evolution → Controlled Composition → Reference Protocol → Governance UI**
→ **M6 Target Intelligence Layer（2026-08-06）**：协议层（M6-PLAN v0.4 冻结：Identity 实体资产 vs Target 机会资产、状态机、Ready Check 能力矩阵、research_scope、Compatibility Analysis 非推荐系统）+ Company-D 迁移试点（company_001 identity locked + target_001 全 context ready + compatibility v2 五段式）+ 三投影升级（Interview 8 题 A/B/C + AnswerMode；Resume v7 定位升级 + target_id 契约入引擎；Decision 事实→影响→用户决策点）——**协议与文档资产完成，引擎 targets/ watcher 未建（见 §2.6 缺口 2）**
→ **M6.5 Person Intelligence Bootstrap（2026-08-06 协议冻结）**：从"User Foundation 文件建设"升级为**主体模型建设**——语义校准（Semantic Alignment）：Career OS 原本已有 Decision Intelligence 碎片被 UI workflow 误解释成 pipeline（ADR-010），与 Artifact Evolution 的发现同构。冻结：Phase 0 Person Identity（Snapshot Projection + Change Events + Owner Protocol 回挂 3 Evidence + 9 Claims）→ Phase 1 Experience Foundation（Experience Index，三层分离，M4 Portfolio 待激活）→ Phase 2 Skill Intelligence（Evidence 聚合 + 锚点，反向生成）→ Phase 3 Constraint Foundation（Preference/Constraint 分离）。决策链降级为决策历史视图（ADR-008）；schema 演进（Evidence owner + epistemic_status confirmed/inferred/reconstructed，ADR-009）。不做：Agent 自动化 / Evidence 扩张 / Career Ledger（M7）/ Career Graph（M8）。

**未施工（勿提前）**：V3 愿景——Person Model 五维、决策发现、Career Map、Evidence 原子模型 / Workflow Contract / Career Graph 推理层（后三者 ADR-003/004/005 登记 defer，触发条件未到）。

**已完成（2026-08-03）**：Career Expression Standard Phase 1（机械工程）——12 岗位 JD 调研 → Signal Taxonomy → CareerContentStandard 契约 v1.1 → `standards/mechanical/` 4 语言族 → Benchmark v0.1 验证（TP/DF 20/20，防虚高红线全量生效）→ 失败归因链 A/B/C/D（ADR-006）。其余 7 方向为 Data Layer 待迁移。

**已完成（2026-08-03）**：Career Claim Intelligence 验证（H1/H2/E1）——H1 证明标准价值在"防虚构"而非"更漂亮"（表面质量无差异，TP 差异显著）；E1+H2 验证"职业证据提取与缺口识别"为差异化价值（Evidence Discovery Gain 0 vs 7，路径从"删风险"变为"补证据"）。沉淀为 `evidence-patterns/`（Knowledge Artifact 层：evidence-types / gap-taxonomy / elicitation-patterns / golden-cases——**文档层知识资产，inform 标准演进，非运行时层**，ADR-003 仍冻结）。

**进行中（Phase 2 Resume Intelligence Runtime）**：2A 标准路由（`Resume-Standard-Routing-v1` 契约 + 13 条 JD 路由验证 13/13 PASS）与 2B 反馈事件链路（`rewrite/feedback` RPC → `logs/feedback/`，只记录不学习）已完成；2C 观察窗口（真实 UI 使用 → 入口形态决策）待用户使用。

## 9. 开发原则（CLAUDE.md 摘要）

1. 高内聚：模块职责单一，逻辑聚合在所属模块
2. 低耦合：模块间稳定接口，不渗透实现细节
3. 单向依赖：页面 → store → 数据层 → 常量，禁反向/循环
4. 禁止兜底：只在系统边界（用户输入、外部 API）校验，信任内部契约
5. 环境隔离：运行时与依赖必须在项目根内（`.local/`、`node_modules/`）；禁全局安装、禁改系统 PATH
6. 标准优先于 Prompt：Agent 行为问题优先通过知识资产与规则修正，不靠 Prompt 堆叠；失败先分类（A 标准缺失/B 标准歧义/C 链路/D 数据）再修（ADR-006）

## 10. 文档权威链（Documentation Authority）

文档分层治理，防止多份文档各自演化：**方案描述方向，契约约束实现。**

| 层 | 来源 | 回答 |
|----|------|------|
| L0 Product Intent | `docs/CAREER-OS-开发方案-v1.md` | 为什么存在 |
| L1 Architecture | 本文档（根目录 ARCHITECTURE.md） | 系统如何组织 |
| L1.5 Module Conventions | `engine/CLAUDE.md` `UI/CLAUDE.md` | 模块级实现约定 |
| L2 Implementation Contracts | `docs/contracts/*-contract-vN.md` | 当前这块怎么实现 |
| Decision Records | `docs/ADR/` | 为什么选/为什么延期/何时 revisit |

**冲突解决**：Contract > 模块约定 > Architecture > 产品意图；历史文档仅作参考。
**边界**：`docs/` 为内部工程资产（gitignored，不入公开仓库）；公开仓库 = 产品面（README + 本文档 + 代码）。完整规则见 `docs/README.md`。

**本文档描述当前已实现的系统边界；未来方向由 ADR 单独登记**——不是 roadmap，不被当作愿景讨论区。
