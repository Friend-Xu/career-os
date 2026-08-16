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

- **ir/schema.ts**：引擎 ↔ UI 共享契约源（实体 + Validation + AgentError + ProtocolVersion = '2.9'；业务协议 2.0/2.8 存量决策记录仍合法）。UI 用 `import type` 引用。
- **ir/validator.ts**：合法化 + 降级——必填缺失 → invalid（error）；值域非法 → degraded（warn）保留原值；完全合法不带 validation。`validateByProtocol` 按版本分派。
- **config.ts**：来源优先级 CLI > env（COS_PORT/COS_WORKSPACE/COS_MODEL）> config.json > 默认；fail fast（ConfigError 带字段/当前值/合法值/来源，不静默降级）；首次运行生成 `../career-os.config.json`（gitignored）+ 逐字段说明。
- **storage/workspace.ts**：唯一 fs 出口（paths/read/write/listMarkdown）；`initWorkspace` 建目录树 + `metadata/protocol.json`（引擎单方维护，skill 不读写）；失败抛 WorkspaceError。决策文件名规范见 `storage/decision-registry.ts`（系统 ID 登记，引擎单方命名，不归 Agent）。
- **logger.ts**：应用日志（level + logs/engine.log 持久化 + 10MB×3 轮转）+ traces 接口（`logs/traces/{sessionId}-{ts}.jsonl`，第 2 步填完整轨迹）。
- **main.ts**：启动编排；错误输出 `❌ 模块：字段 = 当前值（合法值：…）`，退出码非 0。

## 落地状态（权威详情见根 ARCHITECTURE.md §8，此处只列模块相关）

M1→M4 决策/事实/Artifact 体系、M4-5 Artifact Studio、M6 Target Intelligence（协议层 + 引擎 targets 进链）、
M6.5 Person Bootstrap、P3-P6 机会/投递闭环均已完成；引擎测试 683/683（2026-08-16），ProtocolVersion 2.9。
M7（Career Ledger）/ V3（Person Model 五维等）未做——触发条件见 ARCHITECTURE.md「未施工」。

## 惯例

- 禁止兜底：信任内部契约，仅在系统边界（config.json/env/CLI、文件系统）做校验——fail fast 是边界校验不是兜底。
- 骨架范围外不提前实现：chokidar 监听（第 3 步）、better-sqlite3 projection（第 3 步）、AgentError 实现（第 2 步）、DecisionAggregate/DecisionContext（V1.5 勿提前）。
- 契约改动走版本演进（validator 按 version 分派），UI 无感知。
- 提交信息中文，前缀 feat/fix/refactor/docs。
