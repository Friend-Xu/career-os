/**
 * Artifact Summary 聚合入口（M4-5.1）：一次扫描组装四类类级 summary。
 * - 四 adapter 独立计算（Concrete First）：单 Artifact 损坏（scan 容错出 issues）不污染其它类
 * - UI projection endpoint：RPC artifacts/summaries 消费，UI 不读文件
 */
import type { Workspace } from '../storage/workspace.ts'
import { scanResumes } from '../storage/resume-watcher.ts'
import { scanProposals } from '../storage/proposal-watcher.ts'
import { scanPortfolioProjects, scanPortfolioProposals } from '../storage/portfolio-watcher.ts'
import { scanInterviewQas, scanInterviewProposals } from '../storage/interview-watcher.ts'
import { scanCoverLetters, scanCoverLetterProposals } from '../storage/cover-letter-watcher.ts'
import type { ArtifactSummary } from '../ir/artifact-summary.ts'
import { buildResumeSummary } from './resume-summary.ts'
import { buildPortfolioSummary } from './portfolio-summary.ts'
import { buildInterviewSummary } from './interview-summary.ts'
import { buildCoverLetterSummary } from './cover-letter-summary.ts'

export function buildArtifactSummaries(ws: Workspace): ArtifactSummary[] {
  return [
    buildResumeSummary(
      // 输入边界：parse 无 `## 分析摘要` 的文件返回空 record（validation invalid，sections 缺失）——
      // 损坏实体不进 summary（不可用资产），其余三类 parse 恒结构完整（record 形态安全，不过滤）
      scanResumes(ws).filter((r) => r.validation?.status !== 'invalid').map((r) => r.record),
      scanProposals(ws).map((p) => p.record),
    ),
    buildPortfolioSummary(
      scanPortfolioProjects(ws).map((p) => p.record),
      scanPortfolioProposals(ws).map((p) => p.record),
    ),
    buildInterviewSummary(
      scanInterviewQas(ws).map((q) => q.record),
      scanInterviewProposals(ws).map((p) => p.record),
    ),
    buildCoverLetterSummary(
      scanCoverLetters(ws).map((c) => c.record),
      scanCoverLetterProposals(ws).map((p) => p.record),
    ),
  ]
}
