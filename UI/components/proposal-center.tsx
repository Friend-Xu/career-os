/**
 * Proposal Center（M4-5.2，契约 M4-5-ARTIFACT-STUDIO-UI-v0.3 §3.1）。
 * 统一评审四 Artifact 的 AI 提案——统一的是 Review Workflow，不统一 Proposal Domain Model；
 * Diff 统一的是 Presentation Contract（ArtifactDiffViewModel），不统一 Artifact Semantics
 * （四 adapter Concrete First：projectResumeProposal 等）。
 * 只读评审：无 inline edit / 无修改 proposal / 无修改 anchor / 无修改 sourceRefs（§5 Interaction Boundary）。
 * Accept/Reject 走各 Artifact 原 RPC：UI 不知道如何改文件/生成 transition/验证 old match。
 */
import { Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material'
import { useState } from 'react'
import type { ResumeProposal } from '../../engine/ir/resume.ts'
import type { PortfolioProposal } from '../../engine/ir/portfolio.ts'
import type { InterviewProposal } from '../../engine/ir/interview.ts'
import type { CoverLetterProposal } from '../../engine/ir/cover-letter.ts'
import type { ArtifactType } from '../types'
import type { ArtifactDiffViewModel } from '../types'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { projectCoverLetterProposal, projectInterviewProposal, projectPortfolioProposal, projectResumeProposal } from '../store/proposal-adapters'
import { alpha, COLORS, RISK_COLOR } from '../data/constants'

interface ProposalListItem {
  vm: ArtifactDiffViewModel
  status: string
  createdAt?: string
}

const TYPE_LABEL: Record<ArtifactType, string> = {
  resume: 'Resume',
  portfolio: 'Portfolio',
  interview: 'Interview',
  'cover-letter': 'Cover Letter',
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: '待确认', color: COLORS.accent },
  accepted: { label: '已接受', color: RISK_COLOR.low },
  rejected: { label: '已拒绝', color: RISK_COLOR.high },
}

const TYPE_FILTERS: { value: 'all' | ArtifactType; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'resume', label: 'Resume' },
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'interview', label: 'Interview' },
  { value: 'cover-letter', label: 'Cover Letter' },
]

const STATUS_FILTERS: { value: 'all' | 'pending' | 'accepted' | 'rejected'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待确认' },
  { value: 'accepted', label: '已接受' },
  { value: 'rejected', label: '已拒绝' },
]

function FilterChips<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
      {options.map((o) => (
        <Chip
          key={o.value}
          size="small"
          label={o.label}
          onClick={() => onChange(o.value)}
          sx={{
            height: 24,
            fontSize: 11.5,
            cursor: 'pointer',
            bgcolor: value === o.value ? alpha(COLORS.accent, 0.12) : COLORS.bgHover,
            color: value === o.value ? COLORS.accent : COLORS.textSecondary,
            border: value === o.value ? `1px solid ${alpha(COLORS.accent, 0.4)}` : 'none',
          }}
        />
      ))}
    </Box>
  )
}

/** 四类 proposal 合并投影为统一列表（Concrete First——各 adapter 独立投影，UI 只做编排） */
function buildList(params: {
  proposals: ResumeProposal[]
  portfolioProposals: PortfolioProposal[]
  interviewProposals: InterviewProposal[]
  coverLetterProposals: CoverLetterProposal[]
}): ProposalListItem[] {
  const items: ProposalListItem[] = [
    ...params.proposals.map((p) => ({ vm: projectResumeProposal(p), status: p.status, createdAt: p.createdAt })),
    ...params.portfolioProposals.map((p) => ({ vm: projectPortfolioProposal(p), status: p.status, createdAt: p.createdAt })),
    ...params.interviewProposals.map((p) => ({ vm: projectInterviewProposal(p), status: p.status, createdAt: p.createdAt })),
    ...params.coverLetterProposals.map((p) => ({ vm: projectCoverLetterProposal(p), status: p.status, createdAt: p.createdAt })),
  ]
  return items.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
}

export function ProposalCenter() {
  const proposals = useAppStore((s) => s.proposals)
  const portfolioProposals = useAppStore((s) => s.portfolioProposals)
  const interviewProposals = useAppStore((s) => s.interviewProposals)
  const coverLetterProposals = useAppStore((s) => s.coverLetterProposals)
  const engineStatus = useAppStore((s) => s.engineStatus)
  const acceptProposal = useAppStore((s) => s.acceptProposal)
  const rejectProposal = useAppStore((s) => s.rejectProposal)
  const acceptPortfolioProposal = useAppStore((s) => s.acceptPortfolioProposal)
  const rejectPortfolioProposal = useAppStore((s) => s.rejectPortfolioProposal)
  const acceptInterviewProposal = useAppStore((s) => s.acceptInterviewProposal)
  const rejectInterviewProposal = useAppStore((s) => s.rejectInterviewProposal)
  const acceptCoverLetterProposal = useAppStore((s) => s.acceptCoverLetterProposal)
  const rejectCoverLetterProposal = useAppStore((s) => s.rejectCoverLetterProposal)
  const push = useToastStore((s) => s.push)

  const [typeFilter, setTypeFilter] = useState<'all' | ArtifactType>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'accepted' | 'rejected'>('pending')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [rejectOpen, setRejectOpen] = useState<ProposalListItem | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const all = buildList({ proposals, portfolioProposals, interviewProposals, coverLetterProposals })
  const filtered = all.filter(
    (p) => (typeFilter === 'all' || p.vm.artifactType === typeFilter) && (statusFilter === 'all' || p.status === statusFilter),
  )
  const selected = all.find((p) => p.vm.proposalId === selectedId) ?? null

  const doAccept = async (item: ProposalListItem): Promise<void> => {
    try {
      switch (item.vm.artifactType) {
      case 'resume':
        await acceptProposal(item.vm.proposalId)
        break
      case 'portfolio':
        await acceptPortfolioProposal(item.vm.proposalId)
        break
      case 'interview':
        await acceptInterviewProposal(item.vm.proposalId)
        break
      case 'cover-letter':
        await acceptCoverLetterProposal(item.vm.proposalId)
        break
      }
      push('success', `已接受提案 ${item.vm.proposalId}（引擎确定性应用，transition 已追加）`)
    } catch (e) {
      push('warning', e instanceof Error ? e.message : '接受失败')
    }
  }

  const doReject = async (): Promise<void> => {
    const item = rejectOpen
    if (!item) return
    try {
      const reason = rejectReason.trim() || undefined
      switch (item.vm.artifactType) {
      case 'resume':
        await rejectProposal(item.vm.proposalId, reason)
        break
      case 'portfolio':
        await rejectPortfolioProposal(item.vm.proposalId, reason)
        break
      case 'interview':
        await rejectInterviewProposal(item.vm.proposalId, reason)
        break
      case 'cover-letter':
        await rejectCoverLetterProposal(item.vm.proposalId, reason)
        break
      }
      push('success', '已拒绝提案（审计保留，单向不 reopen）')
    } catch (e) {
      push('warning', e instanceof Error ? e.message : '拒绝失败')
    }
    setRejectOpen(null)
    setRejectReason('')
  }

  if (all.length === 0) {
    return (
      <Box sx={{ py: 6, textAlign: 'center' }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600, color: COLORS.text }}>暂无 AI 提案</Typography>
        <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, mt: 0.75 }}>
          {engineStatus === 'connected'
            ? 'AI 按各 Artifact 契约写提案文件后自动出现在这里（统一评审中心）'
            : '引擎离线（Proposal Center 不可用）'}
        </Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 2, mt: 1 }}>
      {/* 左：Filter + List */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <FilterChips options={TYPE_FILTERS} value={typeFilter} onChange={setTypeFilter} />
        <FilterChips options={STATUS_FILTERS} value={statusFilter} onChange={setStatusFilter} />
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mt: 0.5 }}>
          {filtered.length === 0 && (
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, py: 2, textAlign: 'center' }}>无匹配提案</Typography>
          )}
          {filtered.map((p) => {
            const active = selected?.vm.proposalId === p.vm.proposalId
            const st = STATUS_META[p.status] ?? { label: p.status, color: COLORS.textMuted }
            return (
              <Box
                key={p.vm.proposalId}
                onClick={() => setSelectedId(p.vm.proposalId)}
                sx={{
                  p: 1.5,
                  borderRadius: 2,
                  cursor: 'pointer',
                  border: `1px solid ${active ? alpha(COLORS.accent, 0.5) : COLORS.border}`,
                  bgcolor: active ? alpha(COLORS.accent, 0.06) : COLORS.bg,
                  '&:hover': { bgcolor: active ? alpha(COLORS.accent, 0.06) : COLORS.bgHover },
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <Chip size="small" label={TYPE_LABEL[p.vm.artifactType]} sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.accent, 0.1), color: COLORS.accent }} />
                  <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: st.color }} />
                  <Typography sx={{ fontSize: 12, fontWeight: 600, color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.vm.title}
                  </Typography>
                </Box>
                <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mt: 0.5 }}>
                  {p.vm.proposalId} · {p.vm.changes.length} 处变更
                </Typography>
              </Box>
            )
          })}
        </Box>
      </Box>

      {/* 右：Diff Panel（只读——Before/After/Anchors + Accept/Reject） */}
      <Box>
        {selected ? (
          <Box sx={{ p: 2.5, borderRadius: 3, border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bgElevated }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
              <Typography sx={{ fontSize: 14, fontWeight: 700 }}>{selected.vm.title}</Typography>
              <Chip size="small" label={TYPE_LABEL[selected.vm.artifactType]} sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.accent, 0.1), color: COLORS.accent }} />
              <Chip
                size="small"
                label={STATUS_META[selected.status]?.label ?? selected.status}
                sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(STATUS_META[selected.status]?.color ?? COLORS.textMuted, 0.1), color: STATUS_META[selected.status]?.color ?? COLORS.textMuted }}
              />
              <Typography sx={{ ml: 'auto', fontSize: 11.5, color: COLORS.textMuted }}>{selected.vm.proposalId}</Typography>
            </Box>

            {selected.vm.anchors && selected.vm.anchors.length > 0 && (
              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1.5 }}>
                {selected.vm.anchors.map((a) => (
                  <Chip key={a} size="small" label={a} sx={{ height: 20, fontSize: 10.5, bgcolor: COLORS.bgHover, color: COLORS.textSecondary }} />
                ))}
              </Box>
            )}

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              {selected.vm.changes.map((c, i) => (
                <Box key={i} sx={{ p: 1.5, borderRadius: 2, bgcolor: COLORS.bg, border: `1px solid ${COLORS.border}` }}>
                  <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted, lineHeight: 1.6, textDecoration: 'line-through' }}>{c.before}</Typography>
                  <Typography sx={{ fontSize: 12.5, color: COLORS.text, lineHeight: 1.6, mt: 0.25 }}>→ {c.after}</Typography>
                  {c.reason && (
                    <Typography sx={{ fontSize: 11.5, color: COLORS.textSecondary, lineHeight: 1.5, mt: 0.5 }}>为什么：{c.reason}</Typography>
                  )}
                </Box>
              ))}
            </Box>

            <Box sx={{ display: 'flex', gap: 1, mt: 2, alignItems: 'center' }}>
              {selected.vm.canAccept ? (
                <Button size="small" variant="contained" onClick={() => void doAccept(selected)} sx={{ fontSize: 12 }}>
                  接受
                </Button>
              ) : selected.status === 'pending' ? (
                <Typography sx={{ fontSize: 11.5, color: RISK_COLOR.high }}>引擎校验未通过（修正后自动重登记）</Typography>
              ) : (
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>已评审（审计保留，不可重开）</Typography>
              )}
              {selected.vm.canReject && (
                <Button size="small" variant="outlined" onClick={() => setRejectOpen(selected)} sx={{ fontSize: 12, color: RISK_COLOR.high, borderColor: alpha(RISK_COLOR.high, 0.4) }}>
                  拒绝
                </Button>
              )}
            </Box>
          </Box>
        ) : (
          <Box sx={{ py: 8, textAlign: 'center', border: `1px dashed ${COLORS.border}`, borderRadius: 3 }}>
            <Typography sx={{ fontSize: 13, color: COLORS.textMuted }}>从左侧选择提案查看 Diff</Typography>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 0.5 }}>评审只看表达变化与理由——不接受在评审中直接编辑</Typography>
          </Box>
        )}
      </Box>

      {/* Reject 原因（可选，审计保留——Human Preference Signal 与 acceptReason 对称） */}
      <Dialog open={rejectOpen !== null} onClose={() => setRejectOpen(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontSize: 14, fontWeight: 700 }}>拒绝提案</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mb: 1.5 }}>
            {rejectOpen?.vm.proposalId} —— 拒绝原因写入提案审计（单向不 reopen）
          </Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={2}
            size="small"
            placeholder="原因（可选）"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setRejectOpen(null)} sx={{ fontSize: 12 }}>
            取消
          </Button>
          <Button size="small" color="error" variant="contained" onClick={() => void doReject()} sx={{ fontSize: 12 }}>
            确认拒绝
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
