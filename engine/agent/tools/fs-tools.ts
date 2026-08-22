/**
 * Agent 文件工具（直连 AgentRunner 用）：Read/Write/Edit/Grep/Glob 五个工具，
 * 全部经 storage/workspace.ts（引擎唯一 fs 出口），根 = workspace root（对齐旧 CLI 的 cwd）。
 * - 路径安全：resolve 后必须落在 root 内（系统边界校验——Agent 输出视为外部输入）
 * - 工具执行错误以文本结果返回模型（对齐 CLI 工具错误语义），不抛穿 streamText 循环
 */
import { relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { tool } from 'ai'
import type { Tool } from 'ai'
import type { Workspace } from '../../storage/workspace.ts'

/** 规范化并校验：Agent 给的路径必须解析在 workspace root 内；越界抛错（fail fast） */
function safeRelPath(ws: Workspace, input: string): string {
  const rel = input.replace(/\\/g, '/').replace(/^\.?\//, '')
  if (rel.length === 0) throw new Error('路径为空')
  if (rel.includes('..')) throw new Error(`路径越界：${input}`)
  const full = resolve(ws.paths.root, rel)
  const relResolved = relative(ws.paths.root, full)
  if (relResolved.startsWith('..') || relResolved.startsWith(`${sep}..`)) {
    throw new Error(`路径越界：${input}`)
  }
  return relResolved.split(sep).join('/')
}

export function buildFsTools(ws: Workspace): Record<string, Tool<any, any>> {
  return {
    Read: tool({
      description: '读取 workspace 内文件内容（相对路径，如 decisions/2026-08-22-方向.md）',
      inputSchema: z.object({
        file_path: z.string().describe('相对 workspace 根的文件路径'),
      }),
      execute: async ({ file_path }) => {
        try {
          return ws.read(safeRelPath(ws, file_path))
        } catch (err) {
          return `Read 失败：${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),
    Write: tool({
      description: '写入 workspace 内文件（自动创建父目录；覆盖已存在文件）',
      inputSchema: z.object({
        file_path: z.string().describe('相对 workspace 根的文件路径'),
        content: z.string().describe('完整文件内容'),
      }),
      execute: async ({ file_path, content }) => {
        try {
          ws.write(safeRelPath(ws, file_path), content)
          return `已写入 ${file_path}`
        } catch (err) {
          return `Write 失败：${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),
    Edit: tool({
      description: '精确替换文件中的一段文本（old_string 必须唯一出现，否则不改动并报错）',
      inputSchema: z.object({
        file_path: z.string().describe('相对 workspace 根的文件路径'),
        old_string: z.string().min(1).describe('要替换的原文（唯一匹配）'),
        new_string: z.string().describe('替换后的文本'),
      }),
      execute: async ({ file_path, old_string, new_string }) => {
        try {
          const rel = safeRelPath(ws, file_path)
          const text = ws.read(rel)
          const count = text.split(old_string).length - 1
          if (count === 0) return `Edit 失败：未找到 old_string（文件内容未改动）`
          if (count > 1) return `Edit 失败：old_string 出现 ${count} 次，需唯一（文件内容未改动）`
          ws.write(rel, text.replace(old_string, new_string))
          return `已修改 ${file_path}`
        } catch (err) {
          return `Edit 失败：${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),
    Grep: tool({
      description: '在 workspace 文件内容中正则搜索（返回 file:line:内容 列表，最多 50 条）',
      inputSchema: z.object({
        pattern: z.string().min(1).describe('正则表达式'),
        path: z.string().optional().describe('限定搜索目录（相对路径；缺省全 workspace）'),
      }),
      execute: async ({ pattern, path }) => {
        try {
          let regex: RegExp
          try {
            regex = new RegExp(pattern, 'g')
          } catch {
            return `Grep 失败：非法正则 ${pattern}`
          }
          const base = path !== undefined ? safeRelPath(ws, path) : '.'
          const files = ws.listFiles(base).filter((f) => f.endsWith('.md') || f.endsWith('.json') || f.endsWith('.yml') || f.endsWith('.yaml'))
          const hits: string[] = []
          outer: for (const f of files) {
            const text = ws.read(f)
            const lines = text.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (hits.length >= 50) break outer
              if (regex.test(lines[i])) {
                regex.lastIndex = 0
                hits.push(`${f}:${i + 1}:${lines[i].trim().slice(0, 160)}`)
              }
            }
          }
          return hits.length > 0 ? hits.join('\n') : '无匹配'
        } catch (err) {
          return `Grep 失败：${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),
    Glob: tool({
      description: '按 glob 模式列出 workspace 文件（* 通配任意字符；** 跨目录；如 **/*.md）',
      inputSchema: z.object({
        pattern: z.string().min(1).describe('glob 模式（相对 workspace 根）'),
      }),
      execute: async ({ pattern }) => {
        try {
          const files = ws.listFiles('.')
          const regex = new RegExp(
            `^${pattern
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\*\*/g, '\u0000')
              .replace(/\*/g, '[^/]*')
              .replace(/\u0000/g, '.*')}$`,
          )
          const hits = files.filter((f) => regex.test(f)).slice(0, 100)
          return hits.length > 0 ? hits.join('\n') : '无匹配'
        } catch (err) {
          return `Glob 失败：${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),
  }
}

/** 供测试与 runner 使用的路径校验导出 */
export { safeRelPath }
