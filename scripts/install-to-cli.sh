#!/usr/bin/env bash
# 把 career-advisor 安装到其他 AI CLI 的 skills 目录。
# 用法: bash scripts/install-to-cli.sh --codex   (或 --opencode / --gemini / --agents / --list)
set -euo pipefail

SOURCE="$(cd "$(dirname "$0")/.." && pwd)/skills/career-advisor"
[ -d "$SOURCE" ] || { echo "错误: 找不到 $SOURCE"; exit 1; }

case "${1:-}" in
  --codex)    TARGET="${CODEX_HOME:-$HOME/.codex}/skills/career-advisor" ;;
  --opencode) TARGET="${OPENCODE_CONFIG:-$HOME/.config/opencode}/skills/career-advisor" ;;
  --gemini)   TARGET="$HOME/.gemini/skills/career-advisor" ;;
  --agents)   TARGET="$(pwd)/.agents/skills/career-advisor" ;;
  --list)
    echo "可用目标:"
    echo "  --codex       Codex CLI 全局 skills 目录 (~/.codex/skills)"
    echo "  --opencode    OpenCode 配置目录 skills (~/.config/opencode/skills)"
    echo "  --gemini      Gemini CLI skills 目录 (~/.gemini/skills)"
    echo "  --agents      当前项目 .agents/skills (Agent Skill Standard, 随仓库分发)"
    exit 0
    ;;
  *)
    echo "用法: bash scripts/install-to-cli.sh [--codex|--opencode|--gemini|--agents|--list]"
    exit 1
    ;;
esac

if [ -d "$TARGET" ]; then
  echo "已存在: $TARGET"
  echo "覆盖前自动备份到: ${TARGET}.bak-$(date +%Y%m%d%H%M%S)"
  mv "$TARGET" "${TARGET}.bak-$(date +%Y%m%d%H%M%S)"
fi

mkdir -p "$(dirname "$TARGET")"
cp -R "$SOURCE" "$TARGET"

echo "✓ career-advisor 已安装到: $TARGET"
echo ""
echo "注意: 各模块对搜索工具的依赖不同 (WebSearch/WebFetch/Exa MCP)。"
echo "在非 Claude CLI 上使用前，请阅读 docs/CLI-COMPATIBILITY.md 的兼容性矩阵。"
