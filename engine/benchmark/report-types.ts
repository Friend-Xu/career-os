/**
 * Benchmark Runner 报告类型（M3-3.3，契约 BENCHMARK-RUNNER-M3-v0.1）。
 * Runner 是确定性审计执行器——输出多维风险信号，不生成总分。
 */
export interface ParsedChange {
  changeId: string // change001…（按 proposal 内顺序）
  targetClaimId: string
  section: string
  oldSentence: string
  suggestedSentence: string
  reason: string
  expectationId?: string
}

export interface ParseOutcome {
  success: boolean // proposal 可解析（changes 非空且非 invalid）
  warnings: string[]
  changes: ParsedChange[]
  /** 全文宽松扫描的 claim_/evidence_ 引用（含非法格式——reference check 素材） */
  rawRefs: string[]
}

export interface ReferenceCheckResult {
  invalidClaimRefs: string[]
  invalidExpectationRefs: string[]
  invalidEvidenceRefs: string[]
}

export interface ProvenanceCheckResult {
  oldSentenceMismatch: { changeId: string; expected: string; actual: string }[]
  claimRetentionRate: number
  mergedClaims: string[]
  lostClaims: string[]
  warnings: string[]
}

export interface ArtifactEvolutionRun {
  benchmarkVersion: string
  datasetVersion: string
  caseId: string
  parser: {
    success: boolean
    warnings: string[]
  }
  deterministicChecks: {
    references: ReferenceCheckResult
    provenance: {
      oldSentenceMismatch: { changeId: string; expected: string; actual: string }[]
      claimRetentionRate: number
      mergedClaims: string[]
      lostClaims: string[]
    }
  }
  riskSignals: {
    invalidClaim: number
    sourceMismatch: number
    provenanceLoss: number
  }
  /** M3-3.4 Report 阶段聚合；Runner 不产生 */
  humanProjection?: undefined
}
