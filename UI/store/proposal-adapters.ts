/**
 * Proposal Diff 投影 adapter（M4-5.2，Concrete First）。
 * Engine Proposal → Adapter → ArtifactDiffViewModel（UI Projection，生命周期只存在于 UI）。
 * 统一的是 Presentation Contract，不统一 Artifact Semantics——四类各自投影，
 * 禁止 Proposal<T> / DiffRenderer<T> / GenericArtifactAdapter<T>。
 */
import type { ResumeProposal, ProposalType } from '../../engine/ir/resume.ts'
import type { PortfolioProposal } from '../../engine/ir/portfolio.ts'
import type { InterviewProposal } from '../../engine/ir/interview.ts'
import type { CoverLetterProposal } from '../../engine/ir/cover-letter.ts'
import type { ArtifactDiffViewModel, DiffChange } from '../types'

const PROPOSAL_TYPE_LABEL: Record<ProposalType, string> = {
  improve: '改进',
  adapt_jd: '适配新 JD',
  replace_sentence: '单点替换',
}

/** pending 且引擎校验通过才可操作（invalid 不可接受，修正后自动重登记） */
function actionable(p: { status: string; validation?: { status: string } }): boolean {
  return p.status === 'pending' && p.validation?.status !== 'invalid'
}

export function projectResumeProposal(p: ResumeProposal): ArtifactDiffViewModel {
  return {
    artifactType: 'resume',
    proposalId: p.id,
    title: `${PROPOSAL_TYPE_LABEL[p.type] ?? p.type} · ${p.sourceResumeId}`,
    changes: p.changes.map((c): DiffChange => ({ before: c.oldSentence, after: c.suggestedSentence, reason: c.reason })),
    anchors: p.changes.map((c) => `claim ${c.targetClaimId.slice(-4)} · ${c.section}`),
    canAccept: actionable(p),
    canReject: p.status === 'pending',
  }
}

export function projectPortfolioProposal(p: PortfolioProposal): ArtifactDiffViewModel {
  return {
    artifactType: 'portfolio',
    proposalId: p.id,
    title: `改写建议 · ${p.projectId}`,
    changes: p.changes.map((c): DiffChange => ({ before: c.old, after: c.new, reason: c.reason })),
    anchors: p.changes.map((c) => `fact ${c.factId}`),
    canAccept: actionable(p),
    canReject: p.status === 'pending',
  }
}

export function projectInterviewProposal(p: InterviewProposal): ArtifactDiffViewModel {
  return {
    artifactType: 'interview',
    proposalId: p.id,
    title: `改写建议 · ${p.qaId}`,
    changes: p.changes.map((c): DiffChange => ({ before: c.old, after: c.new, reason: c.reason })),
    anchors: p.changes.map((c) => `statement ${c.statementId}`),
    canAccept: actionable(p),
    canReject: p.status === 'pending',
  }
}

export function projectCoverLetterProposal(p: CoverLetterProposal): ArtifactDiffViewModel {
  return {
    artifactType: 'cover-letter',
    proposalId: p.id,
    title: `适配建议 · ${p.clId}`,
    changes: p.changes.map((c): DiffChange => ({ before: c.old, after: c.new, reason: c.reason })),
    anchors: p.changes.map((c) => `unit ${c.unitId}`),
    canAccept: actionable(p),
    canReject: p.status === 'pending',
  }
}
