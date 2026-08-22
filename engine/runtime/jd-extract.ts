/**
 * JD 信息提取（一次性）：粘贴 JD 原文 → 提取结构化字段 → JSON 回填建档表单。
 * - 运行时唯一路径（ADR-030 Step 6）：StructuredExtractor + generateObject（schema 下发 + 校验重试 + 类型直达）
 * - extractJdFields / parseJdJson / EXTRACT_TASK：仅 A/B benchmark 使用（tests/bench-extract.mjs，
 *   Claude adapter 回归基准）——运行时不再走 CLI
 */
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import { createAgent } from '../agent/adapter/claude.ts'
import { createStructuredExtractor } from '../agent/capability/structured-extractor.ts'
import type { Logger } from '../logger.ts'

export interface JdExtractResult {
  company: string
  title: string
  location?: string
  salary?: string
  requirements: string[]
}

/** JD 结构化契约（generateObject 的 schema = 类型 = 校验规则，三者同源） */
export const JdSchema = z.object({
  company: z.string().default(''),
  title: z.string(),
  location: z.string().optional(),
  salary: z.string().optional(),
  requirements: z.array(z.string()).default([]),
})

const EXTRACT_SYSTEM =
  '你是 JD 信息提取器。从 JD 原文提取结构化信息：company=公司名称（未出现则空字符串）；title=岗位名称；' +
  'location=工作地点（未出现则省略）；salary=薪资范围原文（未出现则省略）；requirements=技能/经验/职责要求列表。\n' +
  '要求范围：requirements 必须覆盖「职位描述」与「任职要求」两个区——职责里要求的技能/领域/工具同样是要求（如"负责电气原理图设计、PLC程序编写"应产出"电气原理图设计""PLC程序编写"）。\n' +
  '保真规则：' +
  '① 品牌/型号/标准号/参数（如 PLC（西门子/三菱）、GMP、ISO 13485、SolidWorks、3年以上）必须保留在对应要求条目内；' +
  '② 可选替代"或/至少/优先"保留原样，"或"两端拆成独立条目；' +
  '③ 一条 JD 语句可拆多条要求，但不得合并删除语义；' +
  '④ requirements 逐条用原文表述，完整保留限定词，宁多勿少。'

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

/** 直连结构化提取（运行时唯一路径：generateObject；75s 超时防慢端点拖住建档流程） */
export async function extractJdFieldsDirect(jdText: string, model: LanguageModel, logger: Logger): Promise<JdExtractResult> {
  const extractor = createStructuredExtractor(model)
  const result = await extractor.extract<JdExtractResult>(
    { text: jdText.slice(0, 6000), system: EXTRACT_SYSTEM, timeoutMs: 75_000, maxRetries: 3, maxOutputTokens: 2_048 },
    JdSchema,
  )
  logger.info(`jd-extract(direct) 解析：company=${result.company} title=${result.title} req=${result.requirements.length} loc=${result.location ?? '-'} salary=${result.salary ?? '-'}`)
  return {
    company: result.company.trim(),
    title: result.title.trim(),
    ...(result.location !== undefined && result.location.trim() !== '' ? { location: result.location.trim() } : {}),
    ...(result.salary !== undefined && result.salary.trim() !== '' ? { salary: result.salary.trim() } : {}),
    requirements: result.requirements.filter((r) => r.trim().length > 0).map((r) => r.trim()),
  }
}

/** 【仅 benchmark 使用】CLI 路径提取（tests/bench-extract.mjs 回归基准；运行时已不走此路径，ADR-030 Step 6）。
 *  apiKey/baseUrl 传则直连 API 模式；留空复用 CLI 登录态。 */
export async function extractJdFields(
  jdText: string,
  opts: { cwd: string; model?: string; apiKey?: string; baseUrl?: string; logger: Logger },
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
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        // 直连模式隔离本机 settings env（代理 baseURL 劫持防护，hotfix H-001）
        settingSources: opts.apiKey ? [] : undefined,
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
