/**
 * submit_company_research：公司尽调 Proposal 提交工具（任务协议工具——company_research 专属）。
 * 契约（company-file-contract）：companies/{公司名}.md 的写入所有权归 Engine——Agent 无 Artifact 写权限，
 * 只能经 Proposal Channel（submit_jd_analysis 的 Company 侧对应）提交候选尽调结论。
 * 本工具 = 直连路径下的 Proposal 通道实现：Validator（只答是否符合契约）→ Writer（Engine 写档）
 * → 结果回给模型（written/skipped/issues——成功/降级对 Agent 可见，不静默）。
 * （与 jd-proposal-tool 同构，不复制契约逻辑）
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { Tool } from 'ai'
import type { CompanyResearchProposal } from '../../ir/schema.ts'
import type { Workspace } from '../../storage/workspace.ts'
import { writeCompanyResearch } from '../../storage/company-research-writer.ts'
import { validateCompanyResearchProposal } from '../../runtime/company-research-validator.ts'

const summarySchema = z.object({
  city: z.string().min(1),
  industry: z.string().min(1),
  matchScore: z.string().min(1),
  riskLevel: z.string().min(1),
  source: z.string().min(1),
  tags: z.string().min(1),
  contacted: z.enum(['是', '否']),
  aliases: z.string().optional(),
})

const factSchema = z.object({
  type: z.string().min(1),
  value: z.string().min(1),
  source: z.string().min(1),
  url: z.string().optional(),
})

export function createSubmitCompanyResearchTool(ws: Workspace): Tool<any, any> {
  return tool({
    description:
      '提交公司尽调结果（Proposal Channel）：摘要表（city/industry/match_score/risk_level/source/tags/contacted/aliases，' +
      'match_score 只写 85% 或 8.2/10，contacted 只写 是/否，tags 逗号分隔）+ 尽调详情正文 + 公司事实段（type ∈ 7 枚举，' +
      'value ∈ 评估契约 §4 枚举，来源必填）——引擎校验后写入公司档案（companies 文件）。' +
      'companyId = 任务上下文中声明的公司 ID（读档时确认的公司档案名）。尽调完成后必须调用本工具提交，' +
      '禁止直接编辑公司档案文件。',
    inputSchema: z.object({
      companyId: z.string().min(1).describe('公司档案名（任务上下文中声明的公司 ID，读档确认后使用）'),
      summary: summarySchema,
      detail: z.string().optional().describe('尽调详情正文（完整报告；写 ## 尽调详情 段）'),
      facts: z.array(factSchema).optional().describe('公司事实段（职业价值评估输入；枚举外值不计分）'),
    }),
    execute: async (input) => {
      const proposal: CompanyResearchProposal = {
        companyId: input.companyId,
        artifactVersion: 2,
        summary: input.summary,
        detail: input.detail,
        facts: input.facts,
        generatedAt: new Date().toISOString(),
      }
      const issues = validateCompanyResearchProposal(proposal)
      const result = writeCompanyResearch(ws, proposal, issues)
      return JSON.stringify({
        written: result.written,
        skipped: result.skipped,
        issueCount: issues.length,
        issues: issues.slice(0, 12),
      })
    },
  })
}
