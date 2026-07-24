#!/usr/bin/env node
/**
 * PreToolUse hook for Write: validates decisions/ file naming format.
 *
 * Required format: YYYY-MM-DD-{主题}.md
 *
 * Exit codes: 0 = allow, 2 = block (with stderr feedback)
 */

const fs = require('fs');

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const ctx = JSON.parse(input);

  if (ctx.tool_name !== 'Write') {
    process.exit(0);
  }

  const filePath = ctx.tool_input?.file_path || '';

  // Only validate files in decisions/ directory
  if (!/workspace[/\\]career-advisor[/\\]decisions[/\\]/.test(filePath)) {
    process.exit(0);
  }

  // Extract filename
  const fileName = filePath.replace(/^.*[/\\]/, '');

  // Valid format: YYYY-MM-DD-{主题}.md
  //   YYYY: 2024-2099
  //   MM: 01-12
  //   DD: 01-31
  //   主题: any non-empty string
  const validName = /^\d{4}-\d{2}-\d{2}-.+\.md$/;

  if (!validName.test(fileName)) {
    process.stderr.write(
      `BLOCKED: decisions/ 文件名不符合规范。\n` +
        `  收到: "${fileName}"\n` +
        `  要求: YYYY-MM-DD-{主题}.md\n` +
        `  示例: 2026-07-24-转行可行性分析.md`
    );
    process.exit(2);
  }

  // Validate date is reasonable
  const dateStr = fileName.substring(0, 10);
  const date = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(date.getTime())) {
    process.stderr.write(
      `BLOCKED: decisions/ 文件名日期无效。\n` +
        `  收到: "${dateStr}"\n` +
        `  要求: 合法的 YYYY-MM-DD 日期`
    );
    process.exit(2);
  }

  process.exit(0);
});
