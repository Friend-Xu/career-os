# CLI 兼容性矩阵

career-advisor 的 skill 全部是 Markdown 文件，可以安装到任何支持 agent skills 的 AI CLI。
但各模块对搜索工具的依赖程度不同——用错环境会导致输出质量大幅下降。

安装：`bash scripts/install-to-cli.sh --codex`（或 `--opencode` / `--gemini` / `--agents`）

---

## 各模块的搜索工具依赖

| 模块 | WebSearch | WebFetch | Exa MCP | 无搜索工具时 |
|------|:---------:|:--------:|:-------:|-------------|
| resume-writing | 条件（有 JD 时查公司） | - | - | ✅ 基本完全可用 |
| jd-analysis | 必选（轻量） | 必选 | - | ⚠️ 纯文本 JD 可降级，公司背景缺失 |
| career-path | 必选 | 必选 | 推荐 | ⚠️ 静态画像卡可用，市场数据缺失 |
| career-transition | 必选 | 必选 | 推荐 | ⚠️ 内置降级策略（数据标注为"数据不可得"） |
| city-advisor | 必选 | 必选 | 强烈推荐 | ❌ 城市评分无数据支撑 |
| company-screener | 必选 | 必选 | 强烈推荐 | ❌ 无信号可筛 |
| company-research | 必选（实测常不可用） | 必选 | **强烈推荐（实际主力）** | ❌ 尽调报告缺核心来源 |

## 按 CLI 的场景矩阵

| 场景 | 推荐程度 | 说明 |
|------|:--------:|------|
| **Claude Code** | ✅ 首选 | WebSearch/WebFetch 原生内置，全模块可用 |
| **Codex CLI**（内置 web search） | ✅ 可用 | OpenAI 搜索缓存通道，中英文均可用；需手动安装 skills |
| **其他 CLI + Exa MCP** | ✅ 可用 | Exa 是 HTTP MCP，跨 CLI 通用；中文搜索质量甚至优于 WebSearch |
| **任何 CLI，完全无搜索工具** | ⚠️ 仅部分模块 | 只有 resume-writing 接近完整；决策类模块会缺市场数据 |

## 为什么有的模块强依赖搜索

career-advisor 的定位是**决策层**：选方向、评估城市、筛选公司都需要实时市场数据
（薪资、招聘趋势、融资、政策）。这些数据无法内置于静态文件，只能靠搜索获取。

三个决策类模块（city-advisor / company-screener / company-research）不做搜索
就只剩空壳——这不是设计缺陷，是决策质量的要求：查不到就说查不到，不给虚假希望。

## 非 Claude CLI 上配置 Exa MCP

Exa 是标准 HTTP MCP 服务（免费 key 在 [exa.ai](https://exa.ai) 注册），各 CLI 均可配置：

```bash
# Codex (config.toml)
[mcp_servers.exa]
command = "npx"
args = ["-y", "mcp-remote", "https://mcp.exa.ai/mcp", "-h", "Authorization: Bearer <your-key>"]

# OpenCode (opencode.json)
# "mcp": { "exa": { "type": "http", "url": "https://mcp.exa.ai/mcp",
#                   "headers": { "Authorization": "Bearer <your-key>" } } }
```

## 安装位置对照

| CLI | skills 目录 | 命令 |
|-----|------------|------|
| Claude Code（插件） | 仓库内 `.claude-plugin/` | `claude --plugin-dir .` |
| Claude Code（手动） | `~/.claude/skills/` | `bash scripts/install-to-cli.sh --agents` 后复制，或手动 `cp -R` |
| Codex | `~/.codex/skills/` | `bash scripts/install-to-cli.sh --codex` |
| OpenCode | `~/.config/opencode/skills/` | `bash scripts/install-to-cli.sh --opencode` |
| Gemini CLI | `~/.gemini/skills/` | `bash scripts/install-to-cli.sh --gemini` |
| 项目级（Agent Skill Standard） | `.agents/skills/` | `bash scripts/install-to-cli.sh --agents` |
