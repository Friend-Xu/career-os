/**
 * submit_jd_analysis：JD 分析 Proposal 提交工具（任务协议工具——job_analysis 专属）。
 * 契约 v0.1 冻结（方案 B）：jobs/{id}.md 的写入所有权归 Engine——Agent 无 Artifact 写权限，
 * 只能经 Proposal Channel（jd/analyze-result RPC 的直连等价物）提交候选分析结果。
 * 本工具 = 直连路径下的 Proposal 通道实现：Validator（只答是否符合契约）→ Writer（Engine 写档）
 * → 结果回给模型（written/skipped/issues——成功/降级对 Agent 可见，不静默）。
 * 纪律：与 RPC 通道共用同一校验/写入函数（不复制契约）；JobId 来源 = 任务协议注入的显式上下文。
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { Tool } from 'ai'
import type { JDAnalysisProposal } from '../../ir/schema.ts'
import type { Workspace } from '../../storage/workspace.ts'
import { writeJDAnalysis } from '../../storage/jd-analysis-writer.ts'
import { validateJDAnalysisProposal } from '../../runtime/jd-analysis-validator.ts'

const fieldSchema = z.object({
  value: z.string().min(1),
  source: z.string().min(1),
  confidence: z.enum(['high', 'medium']),
})

const constraintSchema = z.object({
  values: z.array(z.string()).min(1),
  source: z.string().min(1),
  confidence: z.enum(['high', 'medium']),
  matchMode: z.enum(['exact', 'related', 'preferred', 'inferred']).optional(),
})

const capabilitySchema = z.object({
  responsibility: z.string().min(1),
  priority: z.enum(['must', 'nice']),
  category: z.enum(['hard', 'soft', 'preference']),
  capabilities: z.array(z.string()).min(1),
  evidencePatterns: z.array(z.enum(['scope', 'method', 'validation', 'impact', 'adoption'])),
  questions: z.array(z.string()),
})

export function createSubmitJdAnalysisTool(ws: Workspace): Tool<any, any> {
  return tool({
    description:
      '提交 JD 分析结果（Proposal Channel）：岗位理解/岗位门槛/岗位智能——引擎校验后写入岗位档案（jobs 文件）；' +
      '所有字段必须带 JD 原文来源锚点，JD 未写的不提取（反幻觉）。' +
      'jobId = 任务上下文中声明的岗位 ID。analysis 完成后必须调用本工具提交，禁止直接编辑岗位文件。',
    inputSchema: z.object({
      jobId: z.string().min(1).describe('岗位 ID（任务上下文中声明的岗位 ID）'),
      context: z
        .object({
          workMode: z.array(fieldSchema).optional(),
          careerPath: z.array(fieldSchema).optional(),
          industry: z.array(fieldSchema).optional(),
        })
        .optional(),
      constraints: z
        .object({
          education: constraintSchema.optional(),
          major: constraintSchema.optional(),
          experience: constraintSchema.optional(),
        })
        .optional(),
      capabilities: z.array(capabilitySchema).min(1),
    }),
    execute: async (input) => {
      const proposal: JDAnalysisProposal = {
        jobId: input.jobId,
        artifactVersion: 2,
        context: {
          workMode: input.context?.workMode,
          careerPath: input.context?.careerPath,
          industry: input.context?.industry,
        },
        constraints: {
          education: input.constraints?.education,
          major: input.constraints?.major,
          experience: input.constraints?.experience,
        },
        capabilities: input.capabilities as JDAnalysisProposal['capabilities'],
        generatedAt: new Date().toISOString(),
      }
      const issues = validateJDAnalysisProposal(proposal)
      const result = writeJDAnalysis(ws, proposal, issues)
      return JSON.stringify({
        written: result.written,
        skipped: result.skipped,
        issueCount: issues.length,
        issues: issues.slice(0, 12),
      })
    },
  })
}
