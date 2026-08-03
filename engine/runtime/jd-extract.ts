/**
 * JD 信息提取（一次性）：粘贴 JD 原文 → Claude 提取结构化字段 → JSON 回填建档表单。
 * - 复用 agent/adapter/claude.ts（createAgent）：无工具、单轮、bypass 权限，收集 text_delta 至 done
 * - 契约：只输出一个 JSON 对象；parseJdJson 容错（剥离围栏/杂质，字段级降级）
 */
import { createAgent } from '../agent/adapter/claude.ts'
import type { Logger } from '../logger.ts'

export interface JdExtractResult {
  company: string
  title: string
  location?: string
  salary?: string
  requirements: string[]
}

const EXTRACT_TASK = (jd: string) =>
  `你是 JD 信息提取器。从下面的 JD 原文提取结构化信息，只输出一个 JSON 对象，不要任何其他文字、注释或 markdown 围栏：
{"company": "公司名称（未出现则为空字符串）", "title": "岗位名称", "location": "工作地点（未出现则省略该字段）", "salary": "薪资范围原文（未出现则省略该字段）", "requirements": ["技能/经验要求1", "技能/经验要求2"]}

JD 原文：
---
${jd}
---`

/** 解析提取结果 JSON（容错：剥离 markdown 围栏与前后杂质；字段级降级） */
export function parseJdJson(text: string): JdExtractResult {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('未提取到 JSON 对象')
  const raw = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  return {
    company: typeof raw.company === 'string' ? raw.company.trim() : '',
    title: typeof raw.title === 'string' ? raw.title.trim() : '',
    ...(typeof raw.location === 'string' && raw.location.trim() ? { location: raw.location.trim() } : {}),
    ...(typeof raw.salary === 'string' && raw.salary.trim() ? { salary: raw.salary.trim() } : {}),
    requirements: Array.isArray(raw.requirements)
      ? raw.requirements
          .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
          .map((r) => r.trim())
      : [],
  }
}

/** 一次性 JD 信息提取（真实 LLM；失败抛错由 RPC 边界转 internal_error） */
export async function extractJdFields(
  jdText: string,
  opts: { cwd: string; model?: string; logger: Logger },
): Promise<JdExtractResult> {
  const abort = new AbortController()
  // 兜底：CLI 挂起（adapter 提问超时 10m 等）不拖住建档流程——75s 未完成即终止
  const timer = setTimeout(() => abort.abort(), 75_000)
  try {
    const handle = createAgent(
      {
        task: EXTRACT_TASK(jdText.slice(0, 6000)),
        cwd: opts.cwd,
        permissionMode: 'bypassPermissions',
        allowedTools: [],
        maxTurns: 1,
        model: opts.model,
        abortController: abort,
        logger: opts.logger,
        onPermissionRequest: () => Promise.resolve(false),
      },
      () => {},
    )
    let text = ''
    for await (const ev of handle.events) {
      if (ev.type === 'text_delta') text += ev.text
      // 提取任务是确定性指令：CLI 提问 → 直接回答"按指令执行"（不等 UI 往返）
      if (ev.type === 'question_request') handle.answer('不需要提问，直接按指令输出 JSON')
      if (ev.type === 'error') throw new Error(`JD 提取失败：${ev.error.message}`)
    }
    if (!text.trim()) throw new Error('JD 提取无返回内容')
    opts.logger.info(`jd-extract 原始返回：${text.slice(0, 300)}`)
    const result = parseJdJson(text)
    opts.logger.info(`jd-extract 解析：company=${result.company} title=${result.title} req=${result.requirements.length} loc=${result.location ?? '-'} salary=${result.salary ?? '-'}`)
    return result
  } finally {
    clearTimeout(timer)
  }
}
