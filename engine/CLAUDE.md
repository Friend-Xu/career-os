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

- **ir/schema.ts**：引擎 ↔ UI 共享契约源（8 实体 + Validation + AgentError + ProtocolVersion = '2.1'）。UI 用 `import type` 引用；UI/types/index.ts 将在桥接（第 3 步）时删除、改 import 来源。
- **ir/validator.ts**：合法化 + 降级——必填缺失 → invalid（error）；值域非法 → degraded（warn）保留原值；完全合法不带 validation。`validateByProtocol` 按版本分派。
- **config.ts**：来源优先级 CLI > env（COS_PORT/COS_WORKSPACE/COS_MODEL）> config.json > 默认；fail fast（ConfigError 带字段/当前值/合法值/来源，不静默降级）；首次运行生成 `../career-os.config.json`（gitignored）+ 逐字段说明。
- **storage/workspace.ts**：唯一 fs 出口（paths/read/write/listMarkdown + `decisionFileName`）；`initWorkspace` 建目录树 + `metadata/protocol.json`（引擎单方维护，skill 不读写）；失败抛 WorkspaceError。
- **logger.ts**：应用日志（level + logs/engine.log 持久化 + 10MB×3 轮转）+ traces 接口（`logs/traces/{sessionId}-{ts}.jsonl`，第 2 步填完整轨迹）。
- **main.ts**：启动编排；错误输出 `❌ 模块：字段 = 当前值（合法值：…）`，退出码非 0。

## 落地顺序（已完成 1-5 + V1.5，2026-08-03）

```
1. 引擎骨架 ✅：ir/ + config + workspace + logger + main
2. report-watcher ✅：md → IR（一次性目录扫描 + 14 字段解析 + 版本分派校验）——--scan-decisions 验收入口
3. 桥接 ✅：transport/websocket.ts（RPC + 事件广播，契约见 transport/protocol.ts）+ projection.ts（better-sqlite3 5 张投影）+ graph-builder.ts（图谱派生）+ watchDecisions（chokidar）；前端 engine-client.ts 已接线（App 挂载 connectEngine，connected 拉初始数据 + 订阅 data.* 重拉）
4. agent/ 适配层 ✅：agent/adapter/claude.ts（SDK 封装 + 事件归一化 + 权限握手 + resume）——npm run smoke:adapter 真实 CLI 验证
5. 领域编排 ✅：runtime/decision-runtime.ts（决策链状态机 V1，computeChain 纯投影 + stageOfSkill 映射 + stageProgressed 推进事件）
V1.5 ✅：storage/context-watcher.ts（decision-contexts/{问题}.md 解析 + watch，摘要表协议复用）+ runtime/decision-aggregate.ts（buildAggregates 纯函数组装，只聚合不评分）+ contexts/list RPC
```

**V2 未做（勿提前）**：Evaluation/Recommendation Engine、知识层（Company/Role/Skill 领域对象）。review 挂点已留扩展点（context 正文段落按标题正则泛化，`## 复盘` 段落约定即可扩展）。

## 惯例

- 禁止兜底：信任内部契约，仅在系统边界（config.json/env/CLI、文件系统）做校验——fail fast 是边界校验不是兜底。
- 骨架范围外不提前实现：chokidar 监听（第 3 步）、better-sqlite3 projection（第 3 步）、AgentError 实现（第 2 步）、DecisionAggregate/DecisionContext（V1.5 勿提前）。
- 契约改动走版本演进（validator 按 version 分派），UI 无感知。
- 提交信息中文，前缀 feat/fix/refactor/docs。
