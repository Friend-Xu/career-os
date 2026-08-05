/**
 * career-context（M3.5.4）：buildCareerContext 纯函数——Write Model（资产注册表）→ Read Model（AI）。
 * - 不调用 AI、无副作用：same workspace → same context（可测试、可复现）
 * - claims.usable = canUseClaim（引擎派生）；usedByResume 反查简历 bullets
 * - expressions 投影：bullet → { claimId, statement }（AI revision 需要历史表达）
 * - resumes：lifecycle 全可见（archived 不隐藏）；validation 快照（assemble 时持久化）
 * - exports：resumes/exports/*.md（ExportRecord）投影
 * - currentJob：请求带 jobId 时填充（responsibilities + expectations 覆盖三态）
 */
import type { CareerContext } from '../ir/context.ts'
import type { Workspace } from '../storage/workspace.ts'
import { scanClaims } from '../storage/claim-watcher.ts'
import { scanEvidence } from '../storage/evidence-watcher.ts'
import { scanResumes } from '../storage/resume-watcher.ts'
import { scanJobs } from '../storage/job-watcher.ts'
import { canUseClaim, indexEvidence } from '../storage/claim-policy.ts'
import { buildProposalFeedback } from '../storage/proposal-watcher.ts'
import { computeEvidenceCoverage } from '../runtime/evidence-coverage.ts'
import { scanPersons } from '../storage/person-watcher.ts'

export interface CareerContextOptions {
  jobId?: string // 场景上下文（派生流程预置时带）
}

/** 纯函数投影：扫描全部资产注册表 → 组装 CareerContext（不调 AI、无副作用） */
export function buildCareerContext(ws: Workspace, opts: CareerContextOptions = {}, now: Date = new Date()): CareerContext {
  // ADR-011/013：legacy（开发期提取/构造）不进 Agent 输入——只消费 active 事实
  const evidence = scanEvidence(ws).map((p) => p.record).filter((e) => e.lifecycle !== 'legacy')
  const evidenceById = indexEvidence(evidence)
  const claims = scanClaims(ws).map((p) => p.record).filter((c) => c.lifecycle !== 'legacy')
  const resumes = scanResumes(ws).map((p) => p.record)
  const jobs = scanJobs(ws).map((p) => p.record)
  const persons = scanPersons(ws)

  const usedByResume = new Map<string, string[]>()
  for (const r of resumes) {
    for (const s of r.sections) {
      for (const b of s.bullets) {
        const list = usedByResume.get(b.claimId) ?? []
        if (!list.includes(r.id)) list.push(r.id)
        usedByResume.set(b.claimId, list)
      }
    }
  }

  const expressions: CareerContext['expressions'] = []
  for (const r of resumes) {
    r.sections.forEach((s, si) => {
      s.bullets.forEach((b, bi) => {
        expressions.push({
          id: `${r.id}:${si}:${bi}`,
          claimId: b.claimId,
          statement: b.sentence,
          ...(b.metadata?.languageFamily ? { languageFamily: b.metadata.languageFamily } : {}),
        })
      })
    })
  }

  const currentJob = opts.jobId
    ? (() => {
        const job = jobs.find((j) => j.id === opts.jobId)
        if (!job) return undefined
        const coverage = computeEvidenceCoverage(job, evidence)
        const expectationMap = new Map<string, { dimension: string; coverage: 'covered' | 'partial' | 'missing' }>()
        for (const row of coverage) {
          for (const e of row.expectations) {
            expectationMap.set(e.patternId, { dimension: e.dimension, coverage: e.status })
          }
        }
        return {
          id: job.id,
          title: job.title,
          responsibilities: job.responsibilities.map((r) => r.statement),
          expectations: job.responsibilities
            .flatMap((r) => r.evidenceExpectations)
            .filter((e) => expectationMap.has(e.patternId))
            .map((e) => ({ id: e.patternId, ...expectationMap.get(e.patternId)! })),
        }
      })()
    : undefined

  return {
    generatedAt: now.toISOString(),
    workspace: { id: ws.paths.root },
    ...(currentJob ? { currentJob } : {}),
    persons: persons.map((p) => ({
      personId: p.personId,
      name: p.name,
      ...(p.identity ? { identity: p.identity } : {}),
      experiences: evidence
        .filter((e) => e.owner === p.personId && e.type)
        .map((e) => ({
          evidenceId: e.id,
          type: e.type!,
          title: e.event.title,
          ...(e.event.period ? { period: e.event.period } : {}),
          ...(e.role ? { role: e.role } : {}),
          ...(e.contribution ? { contribution: e.contribution } : {}),
        })),
    })),
    claims: claims.map((c) => ({
      id: c.id,
      type: c.claimType,
      statement: c.statement,
      usable: canUseClaim(c, evidenceById),
      usedByResume: usedByResume.get(c.id) ?? [],
      provenance: { evidenceIds: c.provenance.map((p) => p.evidenceId) },
    })),
    expressions,
    resumes: resumes.map((r) => ({
      id: r.id,
      status: r.status,
      ...(r.targetJobId ? { targetJobId: r.targetJobId } : {}),
      ...(r.lineage ? { lineage: { ...(r.lineage.parentResumeId ? { parent: r.lineage.parentResumeId } : {}), derivationType: r.lineage.derivationType } } : {}),
      validation: { status: r.validation?.status ?? 'valid' },
    })),
    exports: ws.listMarkdown('resumes/exports').map((f) => parseExportRecord(ws.read(`resumes/exports/${f}`))).filter((e): e is CareerContext['exports'][number] => e !== null),
    ...buildProposalFeedback(ws), // M3.5.7：决策反馈投影（proposals/ 即历史，不建存储）
  }
}

/** ExportRecord md → 投影（摘要表解析；缺关键字段返回 null 跳过） */
function parseExportRecord(md: string): CareerContext['exports'][number] | null {
  const m = md.match(/##\s*分析摘要\s*\n((?:\|[^\n]*\|\n)+)/)
  if (!m) return null
  const fields: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const r = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|$/)
    if (r && r[1].trim() !== '字段') fields[r[1].trim()] = r[2].trim()
  }
  if (!fields.document_id || !fields.format || !fields.exported_at) return null
  return { resumeId: fields.document_id, format: fields.format as 'pdf' | 'markdown' | 'html', exportedAt: fields.exported_at }
}
