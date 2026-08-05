# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@../CLAUDE.md

Career OS 本地引擎（纯 Node 服务，零依赖）。Node 24 原生 TS（type-stripping，零构建）：仅 erasable syntax（无 enum/namespace/参数属性），相对 import 带 `.ts` 扩展名。方案见 `../docs/CAREER-OS-引擎开发方案-v1.md`。

## 命令

```bash
npm run engine   # 启动引擎（config → workspace → logger 串联；骨架阶段无服务器监听）
npm test         # node:test（--test-isolation=none：本机 node 无 .exe 扩展名，子进程 spawn 失败）
```

## 架构

依赖方向单向：`runtime/ agent/ transport/ → storage/ → ir/` + `config.ts logger.ts`（骨架阶段仅 ir/ + storage/ + config + logger + main）。

- **ir/schema.ts**：引擎 ↔ UI 共享契约源（8 实体 + Validation + AgentError + ProtocolVersion = '2.3'，V2.3 加 Evidence Inventory 实体）。UI 用 `import type` 引用；UI/types/index.ts 将在桥接（第 3 步）时删除、改 import 来源。
- **ir/validator.ts**：合法化 + 降级——必填缺失 → invalid（error）；值域非法 → degraded（warn）保留原值；完全合法不带 validation。`validateByProtocol` 按版本分派。
- **config.ts**：来源优先级 CLI > env（COS_PORT/COS_WORKSPACE/COS_MODEL）> config.json > 默认；fail fast（ConfigError 带字段/当前值/合法值/来源，不静默降级）；首次运行生成 `../career-os.config.json`（gitignored）+ 逐字段说明。
- **storage/workspace.ts**：唯一 fs 出口（paths/read/write/listMarkdown）；`initWorkspace` 建目录树 + `metadata/protocol.json`（引擎单方维护，skill 不读写）；失败抛 WorkspaceError。决策文件名规范见 `storage/decision-registry.ts`（系统 ID 登记，引擎单方命名，不归 Agent）。
- **logger.ts**：应用日志（level + logs/engine.log 持久化 + 10MB×3 轮转）+ traces 接口（`logs/traces/{sessionId}-{ts}.jsonl`，第 2 步填完整轨迹）。
- **main.ts**：启动编排；错误输出 `❌ 模块：字段 = 当前值（合法值：…）`，退出码非 0。

## 落地顺序（已完成 M1→M4，2026-08-05）

```
1. 引擎骨架 ✅：ir/ + config + workspace + logger + main
2. report-watcher ✅：md → IR（一次性目录扫描 + 14 字段解析 + 版本分派校验）——--scan-decisions 验收入口
3. 桥接 ✅：transport/websocket.ts（RPC + 事件广播，契约见 transport/protocol.ts）+ projection.ts（better-sqlite3 5 张投影）+ graph-builder.ts（图谱派生）+ watchDecisions（chokidar）；前端 engine-client.ts 已接线（App 挂载 connectEngine，connected 拉初始数据 + 订阅 data.* 重拉）
4. agent/ 适配层 ✅：agent/adapter/claude.ts（SDK 封装 + 事件归一化（含 **thinking_start/delta/stop**：思考提示源 = system thinking_tokens 实时流，思考文本 = assistant 消息 thinking 块全文，实测 2026-08-03 本机 CLI 整段带全文）+ 权限握手 + resume + **createAgent 回答通道**：AskUserQuestion 经 streamInput 回答，实测 2026-08-03 SDK 0.3.220 形状 = user 消息 tool_use_result.questions[]、ask_user 必须 canUseTool allow 否则 CLI 静默挂起、管道模式提问立即跳过 → askUserQuestionTimeout '10m' + 回答走下一轮送达）+ runtime/agent-runtime.ts（任务注册表 + 权限挂起表 requestId 往返 + cancel）+ WS 桥 agent/start|answer|cancel|permission 四 RPC + agent.event 流式事件——npm run smoke:adapter / smoke:question / tests/agent-bridge-check.mjs 真实 CLI 验证
5. 领域编排 ✅：runtime/decision-runtime.ts（决策链状态机 V1，computeChain 纯投影 + stageOfSkill 映射 + stageProgressed 推进事件）
V1.5 ✅：storage/context-watcher.ts（decision-contexts/{问题}.md 解析 + watch，摘要表协议复用）+ runtime/decision-aggregate.ts（buildAggregates 纯函数组装，只聚合不评分）+ contexts/list RPC + 复盘闭环（## 复盘 段落 → DecisionAggregate.review）
V2（知识层 + Evaluation）✅：storage/knowledge-watcher.ts（knowledge/skills.md 词表 + roles.md 岗位，别名归一化 buildSkillIndex）+ runtime/gap-calculator.ts（computeGap 纯函数：满足≥3/可迁移 1-2/缺失未声明，不自己打分）+ knowledge/graph + knowledge/gap RPC + 图谱 role/skill 节点（雇佣/需求边）
M3 表达链路（M3-0 → M3.5.8）✅：evidence-watcher/claim-watcher（事实双入口）→ claim-policy（可消费性 canUseClaim）→ claim-coverage/claim-selector（表达候选，M3-1）→ resume-watcher（版本系统：documents/drafts/exports + 状态机）→ resume-draft（Draft Manifest → Assembly，AI 只写草稿不写 IR）→ proposal-watcher（AI 建议层：登记 + 12 校验码 + sourceChecksum 强校验 + accept/reject + 决策反馈投影 buildProposalFeedback）→ export/resume-export（PDF 复现三元组）→ context/career-context（AI Read Model）→ 架构总索引（RESUME-ARTIFACT-ARCHITECTURE-M3-v1.0：三层模型 + 七条不变量）
M3-3 Artifact Evolution Benchmark ✅：engine/benchmark（runner/parser/reference-check/provenance-check/report——确定性审计，无 AI Judge、无总分、无 ranking）+ dataset/cases 10 例（gitignored）+ generate-report 出报告
M4 Artifact Evolution ✅：docs/CAREER-ARTIFACT-ADMISSION（C1-C6 准入 + System Invariants）→ ir/portfolio.ts + storage/portfolio-watcher.ts（集合型项目事实：FactItem→Evidence、P-01~P-07、immutable published、draft(v+1) 演化、PortfolioContext 投影）→ ir/interview.ts + storage/interview-watcher.ts（三层问答资产：Fact/Expression/Strategy、I-01~I-08、draft→reviewed→ready、InterviewContext 投影）→ 各 Runtime Validation 5 case（正常演化 / 事实膨胀 Runner PASS / 非法行为无法表达 / immutable / 无锚点拒绝）——测试 290/290
```

**V3 未做（愿景，勿施工）**：Person Model 五维（profiles 协议升级）、决策发现、Career Map——计划见 `../docs/CAREER-OS-V2V3路线计划-v1.md`（V3 部分为愿景预留）。

## 惯例

- 禁止兜底：信任内部契约，仅在系统边界（config.json/env/CLI、文件系统）做校验——fail fast 是边界校验不是兜底。
- 骨架范围外不提前实现：chokidar 监听（第 3 步）、better-sqlite3 projection（第 3 步）、AgentError 实现（第 2 步）、DecisionAggregate/DecisionContext（V1.5 勿提前）。
- 契约改动走版本演进（validator 按 version 分派），UI 无感知。
- 提交信息中文，前缀 feat/fix/refactor/docs。
