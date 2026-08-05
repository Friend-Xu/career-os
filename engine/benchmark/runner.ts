/**
 * Benchmark Runner（M3-3.3，契约 BENCHMARK-RUNNER-M3-v0.1）。
 * 确定性审计执行器——只回答契约问题，不评分、不判语义。
 * 输入：case 目录（context/evidence/claims/resume_v1/proposal_ai）；
 * 禁止读取 proposal_origin（破坏 replay）与 human_label（不参与判断）。
 * 纯函数：same case → same output（可重放）。
 */
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { ArtifactEvolutionRun } from './report-types.ts'
import { parseProposalAi } from './parser.ts'
import { checkReferences } from './reference-check.ts'
import { checkProvenance, type ResumeBulletRef } from './provenance-check.ts'

export interface RunnerOptions {
  datasetVersion?: string
}

export function runBenchmarkCase(caseDir: string, opts: RunnerOptions = {}): ArtifactEvolutionRun {
  const read = (f: string): string => readFileSync(join(caseDir, f), 'utf8')
  const context = JSON.parse(read('context.json')) as {
    job?: { expectations?: { patternId: string }[] }
  }
  const claims = JSON.parse(read('claims.json')) as { id: string }[]
  const evidence = JSON.parse(read('evidence.json')) as { id: string }[]
  const resume = JSON.parse(read('resume_v1.json')) as {
    sections: { type: string; bullets: { claimId: string; sentence: string; metadata?: { expectationId?: string } }[] }[]
  }
  const proposalMd = read('proposal_ai.md')

  const parsed = parseProposalAi(proposalMd)
  const references = checkReferences({
    changes: parsed.changes,
    rawRefs: parsed.rawRefs,
    claimIds: new Set(claims.map((c) => c.id)),
    evidenceIds: new Set(evidence.map((e) => e.id)),
    expectationIds: new Set((context.job?.expectations ?? []).map((e) => e.patternId)),
  })
  const resumeBullets: ResumeBulletRef[] = resume.sections.flatMap((s) =>
    s.bullets.map((b) => ({ claimId: b.claimId, section: s.type, sentence: b.sentence, ...(b.metadata?.expectationId ? { expectationId: b.metadata.expectationId } : {}) })),
  )
  const provenance = checkProvenance({ changes: parsed.changes, resumeBullets })

  return {
    benchmarkVersion: '0.1',
    datasetVersion: opts.datasetVersion ?? '0.1',
    caseId: basename(caseDir),
    parser: { success: parsed.success, warnings: [...parsed.warnings, ...provenance.warnings] },
    deterministicChecks: {
      references,
      provenance: {
        oldSentenceMismatch: provenance.oldSentenceMismatch,
        claimRetentionRate: provenance.claimRetentionRate,
        mergedClaims: provenance.mergedClaims,
        lostClaims: provenance.lostClaims,
      },
    },
    riskSignals: {
      invalidClaim: references.invalidClaimRefs.length,
      sourceMismatch: provenance.oldSentenceMismatch.length,
      provenanceLoss: provenance.lostClaims.length,
    },
  }
}
