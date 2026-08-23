/**
 * JD 信息提取（一次性）：粘贴 JD 原文 → 提取结构化字段 → JSON 回填建档表单。
 * - 运行时唯一路径（ADR-030 Step 6）：StructuredExtractor + generateObject（schema 下发 + 校验重试 + 类型直达）
 * - CLI 适配路径已随保留位删除（历史锚点 tag pre-provider-decoupling；ADR-030 Step 6：
 *   运行时唯一路径 = 本文件 direct 提取）
 */
import type { LanguageModel } from 'ai'
import { z } from 'zod'
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
