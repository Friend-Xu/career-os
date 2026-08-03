<div align="center">

# Career OS

**求职最贵的不是投简历，是选错方向。**

一句话描述你的处境，输出有数据支撑、可执行的职业决策——
从方向探索到简历撰写，覆盖求职决策全链路。

[![License](https://img.shields.io/badge/License-GPLv3-blue)](LICENSE)
![Version](https://img.shields.io/badge/version-2.1.0-blue)

[中文](README.md) | [English](README.en.md)

</div>

---

## 你能得到什么

| 你说 | 系统做什么 | 你得到 |
|------|-----------|--------|
| "帮我写简历" | frontier 追问挖掘经历 → STAR 重构 → 按方向标准定制 | 含量化成就、可直接投递的简历 |
| "看看这个 JD 靠不靠谱" | 匹配度计算 + 委婉语翻译 + 面试预测 | JD 的真实意图 + 你的胜算 |
| "我该做什么方向" | 技能 / 兴趣 / 市场三维画像 → ikigai 匹配 | 排序后的候选方向 |
| "机械设计转机器人可行吗" | 技能重叠度 + 财务模型 + 风险调节 | 能不能转、怎么转、第一步做什么 |
| "去苏州还是深圳" | 城市评分 + 产业匹配 + 薪资对比 | 有数据支撑的城市选择 |
| "苏州有什么好公司" | 专精特新 / 融资 / 招聘多维信号 | 目标公司信号清单 |
| "这家公司怎么样" | 7 章节背调 + 面试反问十问 | 尽调报告 |
| "出个结论" | 汇总矩阵 + 一致性检查 | 最终建议 |

## 一个走完的决策链

**李明，28 岁，非标自动化机械工程师（常州），10 个月考研 Gap 后想转机器人方向。**
用 career-advisor 走完：转行可行性分析（75% 匹配，苏州软着陆）→ 城市评估（苏州 8.2/10）→
公司筛选 → 公司尽调 → 综合结论。

→ 阅读完整案例：[docs/case-studies/2026-07-李明-非标自动化转机器人.md](docs/case-studies/2026-07-李明-非标自动化转机器人.md)

## 界面预览

<table>
<tr>
<td><img src="docs/screenshots/01-workbench.png" alt="工作台" width="100%"/><br/><sub>工作台：决策链 + 下一步行动</sub></td>
<td><img src="docs/screenshots/02-agent.png" alt="决策 Agent" width="100%"/><br/><sub>决策 Agent：真实 LLM 对话（流式回复 / 提问卡片 / 权限弹窗）</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/03-infopool.png" alt="信息池" width="100%"/><br/><sub>信息池：决策 / 公司 / 方向 / 城市图谱</sub></td>
<td><img src="docs/screenshots/04-companies.png" alt="公司探索" width="100%"/><br/><sub>公司探索：目标公司列表 + 尽调入口</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/05-applications.png" alt="投递管理" width="100%"/><br/><sub>投递管理：申请进度看板</sub></td>
<td><img src="docs/screenshots/06-resumes.png" alt="简历中心" width="100%"/><br/><sub>简历中心：划词 AI 改写 + 基于 JD 派生</sub></td>
</tr>
</table>

## 快速开始

**方式一：本地工作台（推荐）**

```bash
git clone https://github.com/Friend-Xu/career-os.git
cd career-os
node start-all.mjs     # Windows 也可双击 StarWebtUI.bat（内置便携 node，无需系统 Node）
```

打开 **http://localhost:5288**：决策链、信息池图谱、公司尽调、投递看板全部可视化；右上角「决策 Agent」直接与真实 LLM 对话（复用本机 Claude CLI 登录态，支持流式回复 / 提问卡片 / 权限弹窗 / 思考过程）。

首次使用自动创建 `workspace/` 工作目录，无需配置。完整工作流见 [ARCHITECTURE.md](ARCHITECTURE.md)。

**方式二：Claude Code 插件（可选）**

```bash
claude --plugin-dir .
```

在 Claude Code 中直接说需求：`"帮我写简历"` / `"分析一下这个 JD"` / `"我该做什么方向"` / `"去哪个城市发展比较好"` / `"出个结论"`。

## 引擎与数据

引擎（Node 24 原生 TS，`engine/`）解析 markdown 真相源并提供 WebSocket 桥（:5289）；UI（Vite，`UI/`）为可视化工作台（:5288）。项目内置便携 node（`.local/node/`），不依赖系统 Node/PATH。

**端口与配置**：

| 项 | 值 |
|----|----|
| UI | http://localhost:5288 |
| 引擎 WS | ws://127.0.0.1:5289（占用时自动 +1 递增重试，最多 5 次；仅本机回环） |
| 配置 | `career-os.config.json`（首次运行生成，来源优先级 CLI > env > 文件 > 默认） |
| 日志 | `logs/engine.log`（10MB×3 轮转）+ `logs/traces/`（会话轨迹 jsonl） |
| 数据 | `workspace/career-advisor/`（profiles/ decisions/ companies/，gitignored） |

**数据协议**：决策/公司档案均为 markdown，摘要表（`## 分析摘要` 两列：字段 | 值）是解析源；缺必填字段或表格缺失 → 档案标 `invalid` 并出现在信息池「⚠ 待人工处理」列表（不崩、不进图谱），补全摘要表即恢复。

## 我们相信什么

职业决策是低频、高影响的事——所以质量规则被写进每个模块：

- **不做心理按摩，不给虚假希望**——难就是难，给"怎么开始"而不是"可以实现"
- **人在环**——AI 分析、你决策；诊断出"先别转"时，警告持续显示，不可绕过
- **财务约束最硬**——存款不足 3 个月 + 有家庭负担时，不推荐裸辞
- **查不到就说查不到**——每条数据标注来源与年份，推断标注 `[推断]`

完整原则见 [docs/PRINCIPLES.md](docs/PRINCIPLES.md)。

## 在其他 AI CLI 中使用

career-advisor 的 skill 全部是 Markdown，可复制到任何支持 agent skills 的 CLI：

```bash
bash scripts/install-to-cli.sh --codex   # 复制到 Codex skills 目录
```

各 CLI 的搜索工具支持不同，见 [CLI 兼容性矩阵](docs/CLI-COMPATIBILITY.md)。

## 隐私边界（Privacy Notice）

Career OS 将**系统资产**与**个人职业数据**严格分离：

- **仓库包含**：schema、模板、工作流、Agent 定义、引擎与工作台代码
- **工作区包含**（`workspace/`，gitignored）：职业经历、成果证据、个人决策、薪资目标、面试记录

**绝不把 `workspace/` 提交到公开仓库。** 你的职业记录是私人数字资产，永远只属于你本地。完整数据边界定义见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## License

[GNU GPL v3](LICENSE)
