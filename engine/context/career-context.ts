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
      // 条目化段（Entry Contract v0.1）：entries[].bullets 与平铺 bullets 一并反查
      const bullets = [...s.bullets, ...(s.entries ?? []).flatMap((e) => e.bullets)]
      for (const b of bullets) {
        const list = usedByResume.get(b.claimId) ?? []
        if (!list.includes(r.id)) list.push(r.id)
        usedByResume.set(b.claimId, list)
      }
    }
  }

  // Resume Entry Contract v0.2 Option A：workRowRef 投影校验（identity 行 = 唯一事实源）。
  // 语义 = 包含而非相等：证据事件周期必须落在公司行周期内（ST 2024.07-2025.03 ⊂ 2023.07-2025.03 合法）；
  // 越界（归属错公司/周期笔误）→ 警示。日期归一化 YYYYMM，不可解析 → 跳过不误报。
  const periodBounds = (s: string | undefined): [string, string] | undefined => {
    if (!s) return undefined
    const tokens = s.match(/\d{4}\s*[./年-]\s*\d{1,2}/g)
    if (!tokens || tokens.length === 0) return undefined
    const norm = (t: string): string => {
      const [y, m] = t.replace(/\s/g, '').split(/[./年-]/)
      return `${y}${(m ?? '').padStart(2, '0')}`
    }
    return [norm(tokens[0]!), norm(tokens[tokens.length - 1]!)]
  }
  const workRowMismatches: NonNullable<CareerContext['workRowMismatches']> = []
  const workRowsOf = new Map(persons.map((p) => [p.personId, p.experiences ?? []]))
  for (const e of evidence) {
    if (!e.workRowRef) continue
    const rows = workRowsOf.get(e.owner ?? '') ?? []
    const row = rows.find((r) => r.company === e.workRowRef!.company && (r.start ?? '') === e.workRowRef!.start)
    if (!row) {
      workRowMismatches.push({ evidenceId: e.id, company: e.workRowRef.company, reason: 'row_not_found' })
      continue
    }
    const evBounds = periodBounds(e.event.period)
    if (evBounds) {
      const rowStart = periodBounds(row.start)?.[0]
      const rowEnd = periodBounds(row.end)?.[0]
      const outOfBounds = (rowStart && evBounds[0] < rowStart) || (rowEnd && evBounds[1] > rowEnd)
      if (outOfBounds) {
        workRowMismatches.push({
          evidenceId: e.id,
          company: e.workRowRef.company,
          reason: 'period_mismatch',
          ...(e.event.period ? { evidencePeriod: e.event.period } : {}),
          ...(row.start || row.end ? { identityPeriod: [row.start, row.end].filter(Boolean).join('-') } : {}),
        })
      }
    }
  }

  const expressions: CareerContext['expressions'] = []
  for (const r of resumes) {
    r.sections.forEach((s, si) => {
      // 条目化段（Entry Contract v0.1）：entries[].bullets 与平铺 bullets 一并投影
      const bullets = [...s.bullets, ...(s.entries ?? []).flatMap((e) => e.bullets)]
      bullets.forEach((b, bi) => {
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
    ...(workRowMismatches.length > 0 ? { workRowMismatches } : {}),
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
    claims: claims.map((c) => {
      const firstEvidence = evidenceById.get(c.provenance[0]?.evidenceId)
      return {
        id: c.id,
        type: c.claimType,
        statement: c.statement,
        usable: canUseClaim(c, evidenceById),
        usedByResume: usedByResume.get(c.id) ?? [],
        provenance: { evidenceIds: c.provenance.map((p) => p.evidenceId) },
        ...(c.owner ? { owner: c.owner } : {}),
        // 经历分类从 provenance 首个证据派生（确定性投影，不落盘——编辑器模块建议标注的数据基础）
        ...(firstEvidence?.type ? { evidenceType: firstEvidence.type } : {}),
      }
    }),
    expressions,
    resumes: resumes.map((r) => ({
      id: r.id,
      status: r.status,
      ...(r.name ? { name: r.name } : {}),
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
