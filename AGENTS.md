# 职业决策分析系统

本项目是 Claude Code Plugin，入口 `.claude-plugin/plugin.json`，技能文件 `skills/career-advisor/SKILL.md`。

## 使用
- Claude Code: `--plugin-dir .` 加载，或 `/plugin install` 后直接 `/career-advisor`
- 也可直接说"我想转行"/"选方向"/"分析JD"
- 其他工具: 阅读 `skills/career-advisor/SKILL.md` 了解完整协议

## 安装
```
git clone <repo>
claude --plugin-dir .
```
无需 `npm install`，MCP 依赖通过 npx 自动解析。

## 工作目录
运行时数据存储在 `workspace/career-advisor/`（gitignored，首次运行自动创建）。

## 子流程
方向探索 → 转行分析 → 城市评估 → 公司筛选 → 公司尽调 → JD分析 → 综合结论
