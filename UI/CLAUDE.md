# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@../CLAUDE.md

Career OS 本地工作台前端。Vite + React 19 + MUI 9 + zustand 5 + TypeScript。**Agent 对话已接真实 LLM**（引擎 agent 通道：Claude CLI 流式回复/提问卡片/权限弹窗，离线降级 mock）；数据视图（决策链/公司/图谱/聚合/知识层）接引擎真实数据，其余演示数据 mock。方案书见 `../docs/CAREER-OS-开发方案-v1.md`。

## 命令

```bash
npm run dev        # Vite dev server（端口 5288；端口被占用时换端口）
npm run typecheck  # tsc --noEmit（改代码后必跑）
npm run build      # 生产构建
npm run preview    # 预览构建产物
```

## 架构

依赖方向单向：`pages/ components/ → store/ → data/ → types/`（页面 → store → 数据 → 常量 → 类型），禁止反向依赖与循环依赖。

```
App.tsx = AppShell + ToastHost
AppShell 组装：top-bar（人选择/当前方向胶囊/决策链胶囊） · icon-nav（7 页导航）
  · secondary-sidebar（每页的列表/过滤器，按当前页切换内容）
  · 主区（按 currentPage 渲染 pages/* 对应页面）
  · agent-panel（常驻 AI 面板，350px） · status-bar
  + command-palette（⌘K 全局搜索） + person-create-dialog（创建人向导：基本信息→画像采集→目标岗位推荐）
```

- **store/app-store.ts**：唯一全局状态。`persist` 的 `partialize` 白名单持久化人/决策/公司/投递/UI 偏好；`sessions` 故意不持久化。persist `version: 2`，模型 B 后旧 schema 直接重置。
- **data/mock-data.ts**：全部演示数据唯一来源（人/决策/公司/投递/图谱节点/简历版本/目标岗位推荐）。新增演示数据在此，不散落页面内。
- **data/constants.ts**：设计 token。`COLORS.*` 是 CSS 变量引用（index.css 定义 .light/.dark 两套）——**不能拼 hex alpha 后缀**，透明色一律用 `alpha(COLORS.x, 0.15)`；`RISK_COLOR.*` 是 solid hex，可拼后缀。`EASE` 统一缓动曲线。
- **主题联动**：当前人的 `color` 由 app-shell 注入 `--cos-accent/--cos-accent-muted/--cos-on-accent`（luminance 判定文字深浅）——换人即换全局强调色（400ms 全站过渡，`.cos-theme-transition`）。浅色为默认（index.tsx `defaultMode="light"`）。

## 关键交互模式（跨文件才能理解）

- **会话延续（轻→深）**：agent-panel 与 agent-page 共享 `currentSessionId`，是同一会话——面板发起的对话，切到 Agent 页可见完整历史；面板「展开到全屏」续同一会话。会话消息写入 `sessions[currentSessionId].messages`。
- **真实 Agent 流**：`sendAgentMessage` 引擎在线 → `agent/start`（task = 用户消息，Agent 在 workspace 根自读信息池；带 `sdkSessionId` resume 续接会话）→ 占位消息 + 事件流（`agentTasks` Map 按 taskId 路由：text_delta 累积 / toolChips 流转 / question_request 提问卡片 / permission_request 复用 `requestPermission` 弹窗决策回传 / done / error 错误卡）；离线 → mock 回复降级。**AskUserQuestion 注意**：CLI 管道模式提问后立即跳过（tool_use_result 已含 "did not answer"），回答走下一轮文本送达——用户点击时任务通常已结束，`answerQuestion` 用 resume 续接原会话发送回答（engine-client 的 `agent.event` 帧 taskId 在顶层，已合并进 data 才能路由）。
- **决策链推进**：`addDecision` 写入时自动把当前 stage 置 completed、下一 pending 置 current；写入后从 `personStages` 读 current 拼 toast（"决策链推进至 X"）。顶栏「当前方向」胶囊 = 当前人最新决策的 direction（方案 A：跟随决策链，纯展示非切换器）。
- **按人过滤（模型 B：角色 = 人）**：视图数据按 `currentPerson()` 过滤（decisions 按 `profile === person.name`、applications 按 `personId`、简历按 `personId`）；切换人 → 全部视图/主题色/决策链跟随。岗位无独立实体：画像 targetRoles（有名目）+ 决策 direction（有评估）+ 投递 position（有记录）。
- **预置上下文**：`startAnalysis(prompt)` 设置 agentDraft + pendingPrompt → AI 面板聚焦 + 「已预置上下文」胶囊。所有"唤起 AI"的按钮都走这个入口（Next Action / 时间线重新评估 / 尽调 / JD 派生…）。
- **划词 AI 改写**（resumes-page）：MUI 的 onSelect 不透传到 textarea 且 select 不冒泡 → 必须用 `inputRef` + 原生 `addEventListener('select')`；textarea 选区的 `getBoundingClientRect()` 返回 0×0 → 回退元素 rect。选中即显浮动 ✨ 按钮（非模态，`document mousedown` 关闭）。
- **非模态浮层**：MUI Popover 默认 modal 会吞掉第一次外部点击 → 需要"点外部关闭"的浮层用 fixed 定位 div + `document mousedown` + ref.contains 判断（AI 改写候选卡、右键菜单用 MUI Menu 则无此问题）。
- **信息池图谱**：react-force-graph-2d 力导向布局（语义预设坐标作种子；**标签框矩形碰撞力防文字重叠**（position-based AABB 硬约束）+ **链接长度随标签宽自适应**；搜索/类型过滤重算布局并重新模拟）；节点 7 类（person/decision/direction/city/company/role/skill）分色，**孤立节点虚线标记**（健康角标真实计算，桥接真实数据后自动生效）；右键操作**仅对 company 节点**开放（尽调/投递），其余节点只有查看详情/重新评估。
- **状态流转闭环**：公司「标记已联系」→ 投递管理同步；「写入决策记录」→ 工作台时间线 + 决策链推进；投递看板按人过滤。所有跨页联动都带 toast 反馈。

## 惯例

- 演示模式诚实：不能兑现的功能用 toast 标注「阶段 3 接入」，不假装可用。
- 页面数据来自 store 或 mock-data，禁止页面内写死业务数据。
- 浏览器验证：dev server + Playwright（MCP）跑真实交互（划词/右键/人切换/写入决策），typecheck 只验类型不验功能。
- 提交信息中文，前缀 feat/fix/refactor/docs。
