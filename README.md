# career-advisor

**Claude Code 插件 — 职业决策分析系统。**

一句话输入，输出可执行的职业决策。从方向探索到 JD 分析，覆盖求职决策全链路。

## 功能

```
方向探索 → 转行分析 → 城市评估 → 公司筛选 → 公司尽调 → JD分析 → 综合结论
```

| 步骤 | 你能问 | 输出 |
|------|--------|------|
| 方向探索 | "我该做什么方向？" / "我是机械专业的" | 职业方向排序 + 匹配度 |
| 转行分析 | "机械设计转机器人可行吗" | 技能审计 + 差距分析 + 行动计划 |
| 城市评估 | "机械工程师去苏州还是深圳" | 城市评分 + 产业匹配 + 薪资对比 |
| 公司筛选 | "苏州有什么好公司" | 专精特新/融资/招聘多维信号公司清单 |
| 公司尽调 | "这家公司怎么样" | 7 章节背调报告 + 面试反问 + 风险提示 |
| JD 分析 | "分析这个 JD" | 匹配度 + 靠谱判断 + 面试预测 |
| 综合结论 | "出个结论" | 汇总矩阵 + 一致性检查 + 最终建议 |

## 快速开始

### 安装

```bash
git clone https://github.com/Friend-Xu/career-advisor.git
cd career-advisor
claude --plugin-dir .
```

或在 Claude Code 中 `/plugin install` 后输入 `/career-advisor`。

### 使用

直接说你的需求，不需要唤醒词：

```
"我该做什么方向"
"机械设计转机器人可行吗"
"去哪个城市发展比较好"
"苏州有什么好公司"
"帮我查一下 XX 公司"
"分析一下这个 JD"
```

首次使用系统会自动创建工作目录，无需手动配置。

## 架构

### 管理层 + 信息池

```
用户输入 → 主 SKILL.md (路由)
               ├── career-path       → 写 decisions/
               ├── career-transition → 写 decisions/ + profiles/
               ├── city-advisor      → 写 decisions/
               ├── company-screener  → 写 decisions/
               ├── company-research  → 写 decisions/ + companies/
               └── jd-analysis       → 读 companies/，写 decisions/
                                          ↓
               综合评估 ← 读所有 decisions/ → exports/
```

6 个子模块**不直接通信**。所有数据通过 `workspace/career-advisor/`（信息池）中转。每个子模块结束输出固定 14 字段摘要表格，供后续模块消费。

### 数据保护

3 个 PreToolUse Hook 防止误操作：

| Hook | 作用 |
|------|------|
| `block-delete-workspace.js` | 阻止 AI 直接删除 workspace/ 目录 |
| `guard-sensitive-writes.js` | 修改 profiles/decisions 时给出确认提示 |
| `validate-decision-name.js` | 强制决策文件命名格式 `YYYY-MM-DD-{主题}.md` |

### 会话恢复

每次启动自动执行：

1. 检查工作目录是否存在 → 不存在则初始化
2. 扫描未完成的分析（status=partial）→ 提供继续/重新/忽略选项
3. 读取 INDEX.md 了解当前进度
4. 检测用户偏好变更 → 输出级联影响清单

## 项目结构

```
career-advisor/
├── .claude-plugin/
│   └── plugin.json              ← 插件定义
├── .claude/
│   └── settings.local.json      ← Hook 配置
├── skills/career-advisor/
│   ├── SKILL.md                 ← 主入口（路由 + 输出标准 + 汇总协议）
│   ├── sub-skills/              ← 6 个子模块
│   │   ├── career-path/         ┐
│   │   ├── career-transition/   │
│   │   ├── city-advisor/        ├─ 每个含 SKILL.md + references/
│   │   ├── company-screener/    │
│   │   ├── company-research/    │
│   │   └── jd-analysis/         ┘
│   ├── references/              ← 各模块共享的参考数据
│   │   ├── protocols/           ← 输出标准、一致性检查、决策汇总
│   │   └── directions/          ← 8 个专业的职业画像卡
│   ├── assets/templates/        ← workspace 初始化模板
│   └── examples/                ← 完整示例（虚拟用户"李明"）
├── scripts/                     ← Hook 脚本
├── AGENTS.md                    ← 项目入口
└── CLAUDE.md
```

## 依赖

| 工具 | 用途 | 来源 |
|------|------|------|
| WebSearch | 中文搜索 | Claude Code 内置 |
| WebFetch | 深度阅读 | Claude Code 内置 |
| Exa (MCP) | 语义搜索（推荐） | ECC 插件 或 exa.ai 自行配置 |

Exa MCP 可选但强烈推荐。在 `.mcp.json` 或 `~/.claude.json` 中配置：

```json
{
  "mcpServers": {
    "exa": {
      "type": "http",
      "url": "https://mcp.exa.ai/mcp",
      "headers": { "Authorization": "Bearer <your-key>" }
    }
  }
}
```

免费 API Key 在 [exa.ai](https://exa.ai) 注册。

## License

MIT
