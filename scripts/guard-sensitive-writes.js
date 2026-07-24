#!/usr/bin/env node
/**
 * PreToolUse hook for Write/Edit: warns when writing to sensitive directories.
 * Never blocks — only warns (exit 0). The warning goes to stderr as feedback.
 *
 * Exit codes: 0 = allow (with optional stderr warning)
 */

const fs = require('fs');

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const ctx = JSON.parse(input);

  if (ctx.tool_name !== 'Write' && ctx.tool_name !== 'Edit') {
    process.exit(0);
  }

  const filePath = ctx.tool_input?.file_path || '';

  const sensitivePaths = [
    /workspace[/\\]career-advisor[/\\]profiles/,
    /workspace[/\\]career-advisor[/\\]decisions/,
    /workspace[/\\]career-advisor[/\\]INDEX\.md$/,
  ];

  const matched = sensitivePaths.find((p) => p.test(filePath));

  if (matched) {
    process.stderr.write(
      '注意：你正在修改持久化数据（profiles/decisions/INDEX.md）。' +
        '这些是用户的历史分析记录，修改前请确认：\n' +
        '1. 是否有对应的用户指令？\n' +
        '2. 是否会影响其他子流程的数据一致性？\n' +
        '3. 修改后是否需要触发级联更新（偏好变更检测）？'
    );
  }

  process.exit(0);
});
