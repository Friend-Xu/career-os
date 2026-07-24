#!/usr/bin/env node
/**
 * PreToolUse hook for Bash: blocks deletion of workspace/ directory.
 *
 * Exit codes: 0 = allow, 2 = block (with stderr feedback to Claude)
 */

const fs = require('fs');

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const ctx = JSON.parse(input);

  // Only handle Bash tool
  if (ctx.tool_name !== 'Bash') {
    process.exit(0);
  }

  const cmd = (ctx.tool_input?.command || '').toLowerCase();

  // Patterns that indicate workspace deletion
  const blockPatterns = [
    /rm\s+.*workspace/,
    /rmdir\s+.*workspace/,
    /del\s+.*workspace/,
    /remove-item\s+.*workspace/i,
    /rm\s+-rf\s+.*career-advisor/,
    /git\s+clean\s+.*workspace/,
  ];

  const blocked = blockPatterns.some((p) => p.test(cmd));

  if (blocked) {
    process.stderr.write(
      'BLOCKED: workspace/career-advisor/ 是插件的数据存储目录，不允许通过 AI 工具删除。' +
        '如需清理数据，请手动操作或使用 workspace 内的文件管理命令。'
    );
    process.exit(2);
  }

  process.exit(0);
});
