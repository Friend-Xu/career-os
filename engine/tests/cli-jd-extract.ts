/**
 * CLI JD 提取（legacy 基准，仅 manually-run 的 benchmark 使用——ADR-030 Step 6：
 * 生产运行时唯一路径 = runtime/jd-extract.ts 的 extractJdFieldsDirect；本文件随保留位一并
 * 处置（H 收尾后删除，历史锚点 tag pre-provider-decoupling）。
 */
import { createAgent } from '../agent/adapter/claude.ts'
import type { Logger } from '../logger.ts'
import type { JdExtractResult } from '../runtime/jd-extract.ts'
import { parseJdJson } from '../runtime/jd-extract.ts'

const EXTRACT_TASK = (jd: string) =>
  `你是 JD 信息提取器。从下面的 JD 原文提取结构化信息，只输出一个 JSON 对象，不要任何其他文字、注释或 markdown 围栏：
{"company": "公司名称（未出现则为空字符串）", "title": "岗位名称", "location": "工作地点（未出现则省略该字段）", "salary": "薪资范围原文（未出现则省略该字段）", "requirements": ["技能/经验要求1", "技能/经验要求2"]}

JD 原文：
---
${jd}
---`

/** CLI 路径提取（bench-extract.mjs 回归基准；运行时已不走此路径，ADR-030 Step 6）。
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
