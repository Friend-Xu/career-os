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
