/**
 * Resume Studio（M3.5.5）：Artifact Evolution Graph + Human Approval Console。
 * - 四层：Version Timeline（lineage 图）→ 版本详情 + Provenance Panel → Validation / Diff / Export
 * - 操作：clone / submit review / export / archive（按钮状态机 T4）
 * - 禁止：无 Sentence 编辑器 / Claim 选择器 / AI 优化按钮——AI 是解释层（Ask AI）
 * - Provenance 数据来自 CareerContext（UI 不重新查链路）；validation 为 assemble 快照
 */
import { Box, Button, Chip, Dialog, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material'
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, RISK_COLOR } from '../data/constants'
import type { ResumeDiff } from '../../engine/storage/resume-watcher.ts'
import type { ProposalType } from '../../engine/ir/resume.ts'
import PsychologyIcon from '@mui/icons-material/Psychology'
import SaveAltIcon from '@mui/icons-material/SaveAlt'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import ArchiveIcon from '@mui/icons-material/Archive'
import FactCheckIcon from '@mui/icons-material/FactCheck'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  draft: { color: RISK_COLOR.medium, label: '草稿' },
  review: { color: '#8a6d3b', label: '待确认' },
  exported: { color: RISK_COLOR.low, label: '已导出' },
  archived: { color: COLORS.textMuted, label: '已归档' },
}

const VALIDATION_STYLE: Record<string, { color: string; icon: string; label: string }> = {
  valid: { color: RISK_COLOR.low, icon: '✓', label: '有效' },
  warning: { color: RISK_COLOR.medium, icon: '△', label: '警告' },
  invalid: { color: RISK_COLOR.high, icon: '✗', label: '无效' },
}

const PROPOSAL_TYPE_LABEL: Record<ProposalType, string> = {
  improve: '改进',
  adapt_jd: '适配新 JD',
  replace_sentence: '单点替换',
}

export function ResumeStudio() {
  const resumeVersions = useAppStore((s) => s.resumeVersions)
  const careerContext = useAppStore((s) => s.careerContext)
  const evidenceItems = useAppStore((s) => s.evidence)
  const proposals = useAppStore((s) => s.proposals)
  const cloneResume = useAppStore((s) => s.cloneResume)
  const transitionResume = useAppStore((s) => s.transitionResume)
  const exportResume = useAppStore((s) => s.exportResumeVersion)
  const acceptProposal = useAppStore((s) => s.acceptProposal)
  const rejectProposal = useAppStore((s) => s.rejectProposal)
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const push = useToastStore((s) => s.push)

  const [selectedClaim, setSelectedClaim] = useState<string | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffTarget, setDiffTarget] = useState<string | null>(null)
  const [diffResult, setDiffResult] = useState<ResumeDiff | null>(null)
  const [rejectOpen, setRejectOpen] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const selectedResumeId = useAppStore((s) => s.selectedResumeId)
  const selectResume = useAppStore((s) => s.selectResume)

  const selected = useMemo(
    () => resumeVersions.find((r) => r.id === selectedResumeId) ?? resumeVersions[0],
    [resumeVersions, selectedResumeId],
  )

  // Version Timeline：按 generatedAt 排序 + parent 链（lineage 来自引擎，UI 不推导）
  const timeline = useMemo(() => [...resumeVersions].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt)), [resumeVersions])

  // AI 建议（M3.5.6）：pending = Human Approval Console；历史 = 审计可见
  const pendingProposals = useMemo(() => proposals.filter((p) => p.status === 'pending'), [proposals])
  const proposalHistory = useMemo(
    () => proposals.filter((p) => p.status !== 'pending').sort((a, b) => (a.decidedAt ?? '').localeCompare(b.decidedAt ?? '')),
    [proposals],
  )

  const claimsById = useMemo(() => new Map((careerContext?.claims ?? []).map((c) => [c.id, c])), [careerContext])
  const claimOf = (claimId: string) => claimsById.get(claimId)

  useEffect(() => {
    if (selected) setSelectedClaim(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])

  if (resumeVersions.length === 0) {
    return (
      <Box sx={{ p: 3, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg }}>
        <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, mb: 1 }}>
          暂无简历版本——通过岗位页「AI 派生简历版本」或等待 AI 生成 Draft 后自动登记
        </Typography>
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>版本系统：AI 产出草稿清单 → 引擎组装 → 此处可见版本进化</Typography>
      </Box>
    )
  }

  const doClone = async (id: string): Promise<void> => {
    try {
      await cloneResume(id)
      push('success', '已创建变体（新草稿，父版本已记录）')
    } catch {
      push('warning', '克隆失败')
    }
  }

  const doReview = async (id: string): Promise<void> => {
    try {
      await transitionResume(id, 'review')
      push('success', '已提交确认（草稿 → 评审中）')
    } catch (e) {
      push('warning', e instanceof Error ? e.message : '状态转移失败')
    }
  }

  const doExport = async (id: string): Promise<void> => {
    try {
      const { result } = await exportResume(id)
      push('success', `已导出 ${result.fileName}（状态=已导出，绑定导出记录）`)
    } catch (e) {
      push('warning', e instanceof Error ? e.message : '导出失败（未产生 exported 状态）')
    }
  }

  const doArchive = async (id: string): Promise<void> => {
    try {
      await transitionResume(id, 'archived')
      push('success', '已归档（历史保留，不可恢复）')
    } catch (e) {
      push('warning', e instanceof Error ? e.message : '归档失败')
    }
  }

  // ─── AI 建议（M3.5.6：接受 → 引擎确定性应用生成新版本；拒绝 → 审计保留）──

  const doAccept = async (id: string): Promise<void> => {
    try {
      const doc = await acceptProposal(id)
      push('success', `已接受提案 → 新版本 ${doc.id}（衍生父版本已记录，源版本未动）`)
    } catch (e) {
      push('warning', e instanceof Error ? e.message : '接受失败')
    }
  }

  const doReject = async (): Promise<void> => {
    const id = rejectOpen
    if (!id) return
    try {
      await rejectProposal(id, rejectReason.trim() || undefined)
      push('success', '已拒绝提案（审计保留）')
    } catch (e) {
      push('warning', e instanceof Error ? e.message : '拒绝失败')
    }
    setRejectOpen(null)
    setRejectReason('')
  }

  const askProposal = (): void => {
    startAnalysis(
      `请基于当前选中简历版本「${selected?.id ?? '未选中'}」提出改进建议（提案层）：读取 ai/context 与 resumes/get 获取源版本与岗位期望，按 references/proposal-writer.md 契约写 proposals/*.md 提案文件——只写提案，绝不修改 resumes/documents/。`,
    )
    push('info', '已预置「AI 改进建议」上下文')
  }

  return (
    <Box>
      {/* 1. Version Timeline（lineage 图） */}
      <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg, mb: 2 }}>
        <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: 1 }}>版本进化线</Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.5 }}>
          {timeline.map((r, i) => {
            const st = STATUS_STYLE[r.status]
            const active = selected?.id === r.id
            return (
              <Box key={r.id} sx={{ display: 'flex', alignItems: 'center' }}>
                {i > 0 && <Typography sx={{ color: COLORS.textMuted, mx: 0.5, fontSize: 12 }}>→</Typography>}
                <Chip
                  size="small"
                  label={`${r.lineage?.derivationType === 'clone' ? '⧉ ' : r.lineage?.derivationType === 'ai_revision' ? '✎ ' : '⚡ '}${r.id.slice(-4)} · ${st.label}`}
                  onClick={() => selectResume(r.id)}
                  sx={{
                    height: 24,
                    fontSize: 11.5,
                    cursor: 'pointer',
                    bgcolor: active ? alpha(st.color, 0.15) : COLORS.bgHover,
                    color: active ? st.color : COLORS.textSecondary,
                    border: active ? `1px solid ${st.color}` : 'none',
                  }}
                />
              </Box>
            )
          })}
        </Stack>
      </Box>

      {/* 1.5. AI 建议（M3.5.6：Human Approval Console——AI Propose / 用户 Approve / 引擎 Execute） */}
      <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg, mb: 2 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.25 }}>
          <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>AI 建议（{pendingProposals.length}）</Typography>
          <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>AI 只写提案；接受后引擎确定性生成新版本</Typography>
          <Box sx={{ flex: 1 }} />
          <Button size="small" variant="outlined" startIcon={<AutoAwesomeIcon sx={{ fontSize: 14 }} />} onClick={askProposal} sx={{ fontSize: 11.5 }}>
            询问 AI 提出改进建议
          </Button>
        </Stack>
        {pendingProposals.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
            暂无待确认建议——AI 按 proposal-writer 契约写入 proposals/ 后自动出现在这里
          </Typography>
        ) : (
          <Stack spacing={1}>
            {pendingProposals.map((p) => {
              const invalid = p.validation?.status === 'invalid'
              const actionable = !invalid
              return (
                <Box
                  key={p.id}
                  sx={{
                    p: 1.5,
                    borderRadius: '8px',
                    border: `1px solid ${invalid ? RISK_COLOR.high : COLORS.border}`,
                    bgcolor: invalid ? alpha(RISK_COLOR.high, 0.04) : 'transparent',
                  }}
                >
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap', gap: 0.5 }}>
                    <Chip size="small" label={PROPOSAL_TYPE_LABEL[p.type] ?? p.type} sx={{ height: 20, fontSize: 11, bgcolor: alpha(COLORS.accent, 0.12), color: COLORS.accent }} />
                    <Typography sx={{ fontSize: 11.5, color: COLORS.textSecondary }}>
                      {p.id} · 源版本 {p.sourceResumeId.slice(-4)}
                      {p.targetJobId && ` → ${p.targetJobId.slice(-4)}`}
                    </Typography>
                    <Box sx={{ flex: 1 }} />
                    {invalid ? (
                      <Typography sx={{ fontSize: 11, color: RISK_COLOR.high }}>引擎校验未通过（修正后自动登记）</Typography>
                    ) : (
                      actionable && (
                        <>
                          <Button size="small" variant="contained" onClick={() => void doAccept(p.id)} sx={{ fontSize: 11.5, minWidth: 56 }}>
                            接受
                          </Button>
                          <Button size="small" variant="outlined" onClick={() => setRejectOpen(p.id)} sx={{ fontSize: 11.5, minWidth: 56, color: RISK_COLOR.high, borderColor: alpha(RISK_COLOR.high, 0.4) }}>
                            拒绝
                          </Button>
                        </>
                      )
                    )}
                  </Stack>
                  <Stack spacing={0.5}>
                    {p.changes.map((c, i) => (
                      <Box key={i}>
                        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6, textDecoration: 'line-through' }}>{c.oldSentence}</Typography>
                        <Typography sx={{ fontSize: 12, color: COLORS.text, lineHeight: 1.6 }}>
                          → {c.suggestedSentence}
                          <Typography component="span" sx={{ fontSize: 11, color: COLORS.textMuted, ml: 0.75 }}>
                            · 表述 {c.targetClaimId.slice(-4)}
                            {c.expectationId && ` · ${c.expectationId}`}
                          </Typography>
                        </Typography>
                        <Typography sx={{ fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.5 }}>为什么：{c.reason}</Typography>
                      </Box>
                    ))}
                  </Stack>
                  {p.validation?.status === 'warning' && (
                    <Typography sx={{ fontSize: 11, color: RISK_COLOR.medium, mt: 0.75 }}>
                      ⚠ {p.validation.issues.map((i) => `${i.code}（${i.message}）`).join('；')}
                    </Typography>
                  )}
                </Box>
              )
            })}
          </Stack>
        )}
        {proposalHistory.length > 0 && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.5, mt: 1.5 }}>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>历史：</Typography>
            {proposalHistory.map((p) => (
              <Chip
                key={p.id}
                size="small"
                label={`${p.status === 'accepted' ? '✓ 已应用' : '✗ 已拒绝'} ${p.id.slice(-4)}${p.resultResumeId ? ` → ${p.resultResumeId.slice(-4)}` : ''}`}
                onClick={() => p.resultResumeId && selectResume(p.resultResumeId)}
                sx={{
                  height: 20,
                  fontSize: 11,
                  cursor: p.resultResumeId ? 'pointer' : 'default',
                  bgcolor: alpha(p.status === 'accepted' ? RISK_COLOR.low : RISK_COLOR.high, 0.08),
                  color: p.status === 'accepted' ? RISK_COLOR.low : COLORS.textMuted,
                }}
              />
            ))}
          </Stack>
        )}
      </Box>

      {/* 2+3. 版本详情 + Provenance Panel */}
      {selected && (
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 2, mb: 2 }}>
          <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.5, flexWrap: 'wrap' }}>
              <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{selected.id}</Typography>
              <Chip size="small" label={STATUS_STYLE[selected.status].label} sx={{ height: 20, fontSize: 11, bgcolor: alpha(STATUS_STYLE[selected.status].color, 0.12), color: STATUS_STYLE[selected.status].color }} />
              {selected.targetJobId && <Chip size="small" label={`目标岗位 ${selected.targetJobId}`} sx={{ height: 20, fontSize: 11 }} />}
              <Box sx={{ flex: 1 }} />
              {selected.status === 'draft' && selected.validation?.status !== 'invalid' && (
                <Button size="small" variant="outlined" startIcon={<FactCheckIcon sx={{ fontSize: 14 }} />} onClick={() => doReview(selected.id)} sx={{ fontSize: 11.5 }}>
                  提交确认
                </Button>
              )}
              {(selected.status === 'draft' || selected.status === 'review') && (
                <Button size="small" variant="outlined" startIcon={<SaveAltIcon sx={{ fontSize: 14 }} />} onClick={() => doExport(selected.id)} sx={{ fontSize: 11.5 }}>
                  导出 PDF
                </Button>
              )}
              <Button size="small" variant="outlined" startIcon={<ContentCopyIcon sx={{ fontSize: 14 }} />} onClick={() => doClone(selected.id)} sx={{ fontSize: 11.5 }}>
                创建变体
              </Button>
              {selected.status !== 'archived' && (
                <Button size="small" variant="outlined" startIcon={<ArchiveIcon sx={{ fontSize: 14 }} />} onClick={() => doArchive(selected.id)} sx={{ fontSize: 11.5, color: RISK_COLOR.high }}>
                  归档
                </Button>
              )}
            </Stack>

            <Stack spacing={1.5}>
              {selected.sections.map((s) => (
                <Box key={s.type}>
                  <Typography sx={{ fontSize: 12, fontWeight: 600, color: COLORS.textSecondary, mb: 0.5 }}>{s.title}</Typography>
                  <Stack spacing={0.25}>
                    {s.entries && s.entries.length > 0
                      ? s.entries.map((entry, ei) => (
                          <Box key={ei} sx={{ mb: 0.75 }}>
                            <Typography sx={{ fontSize: 12, fontWeight: 600, color: COLORS.text, lineHeight: 1.7 }}>
                              {entry.title}
                              {entry.role ? ` · ${entry.role}` : ''}
                              {entry.period ? `（${entry.period}）` : ''}
                            </Typography>
                            {entry.bullets.map((b, bi) => (
                              <Typography
                                key={bi}
                                onClick={() => setSelectedClaim(b.claimId)}
                                sx={{
                                  fontSize: 12.5,
                                  color: COLORS.text,
                                  lineHeight: 1.7,
                                  cursor: 'pointer',
                                  p: '2px 4px',
                                  borderRadius: '6px',
                                  bgcolor: selectedClaim === b.claimId ? alpha(COLORS.accent, 0.1) : 'transparent',
                                  '&:hover': { bgcolor: COLORS.bgHover },
                                }}
                              >
                                {b.sentence}
                                <Typography component="span" sx={{ fontSize: 11, color: COLORS.textMuted, ml: 0.75 }}>
                                  · 表述 {b.claimId.slice(-4)}
                                </Typography>
                              </Typography>
                            ))}
                          </Box>
                        ))
                      : s.bullets.map((b, bi) => (
                          <Typography
                            key={bi}
                            onClick={() => setSelectedClaim(b.claimId)}
                            sx={{
                              fontSize: 12.5,
                              color: COLORS.text,
                              lineHeight: 1.7,
                              cursor: 'pointer',
                              p: '2px 4px',
                              borderRadius: '6px',
                              bgcolor: selectedClaim === b.claimId ? alpha(COLORS.accent, 0.1) : 'transparent',
                              '&:hover': { bgcolor: COLORS.bgHover },
                            }}
                          >
                            {b.sentence}
                            <Typography component="span" sx={{ fontSize: 11, color: COLORS.textMuted, ml: 0.75 }}>
                              · 表述 {b.claimId.slice(-4)}
                            </Typography>
                          </Typography>
                        ))}
                    {(s.assetRefs ?? []).map((a, ai) => (
                      <Typography key={`a${ai}`} sx={{ fontSize: 12.5, color: COLORS.textSecondary, lineHeight: 1.7 }}>
                        {a} <Typography component="span" sx={{ fontSize: 11, color: COLORS.textMuted }}>· 资产</Typography>
                      </Typography>
                    ))}
                  </Stack>
                </Box>
              ))}
            </Stack>
          </Box>

          {/* Provenance Panel：bullet → claim → evidence → expectation */}
          <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg }}>
            <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: 1 }}>溯源（为什么写这条）</Typography>
            {selectedClaim ? (
              (() => {
                const c = claimOf(selectedClaim)
                if (!c) return <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>表述未找到：{selectedClaim}</Typography>
                return (
                  <Stack spacing={1}>
                    <Box>
                      <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mb: 0.25 }}>表述 · {c.type === 'fact' ? '事实' : '归纳'}</Typography>
                      <Typography sx={{ fontSize: 12.5, color: COLORS.text, lineHeight: 1.6 }}>{c.statement}</Typography>
                    </Box>
                    <Box>
                      <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mb: 0.25 }}>可消费性判定</Typography>
                      <Typography sx={{ fontSize: 12.5, color: c.usable ? RISK_COLOR.low : RISK_COLOR.high }}>{c.usable ? '可消费 ✓' : '不可消费 ✗'}</Typography>
                    </Box>
                    <Box>
                      <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mb: 0.25 }}>支撑证据</Typography>
                      {c.provenance.evidenceIds.map((eid) => {
                        const ev = evidenceItems.find((e) => e.id === eid)
                        return (
                          <Typography key={eid} sx={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                            {ev?.event.title ?? eid}
                          </Typography>
                        )
                      })}
                    </Box>
                    <Box>
                      <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mb: 0.25 }}>被使用于</Typography>
                      <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>{c.usedByResume.length > 0 ? c.usedByResume.join('、') : '无'}</Typography>
                    </Box>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<PsychologyIcon sx={{ fontSize: 14 }} />}
                      onClick={() => {
                        startAnalysis(`请解释简历中这条 bullet 的溯源：表述「${c.statement}」为什么被选中、它对应的岗位期望与证据是什么、是否有更好的表达方式（按 sentence-generator 契约）`)
                        push('info', '已预置「溯源解释」上下文')
                      }}
                      sx={{ fontSize: 11.5 }}
                    >
                      询问 AI
                    </Button>
                  </Stack>
                )
              })()
            ) : (
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>点击左侧条目查看其溯源</Typography>
            )}
          </Box>
        </Box>
      )}

      {/* 4. Validation + Diff + Export 历史 */}
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
        <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg }}>
          <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: 1 }}>校验（组装快照）</Typography>
          {selected?.validation ? (
            <Stack spacing={0.5}>
              <Typography sx={{ fontSize: 12.5, color: VALIDATION_STYLE[selected.validation.status].color }}>
                {VALIDATION_STYLE[selected.validation.status].icon} {VALIDATION_STYLE[selected.validation.status].label}
              </Typography>
              {selected.validation.issues.map((i, idx) => (
                <Typography key={idx} sx={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                  ⚠ {i.code} · {i.message}（{i.target}）
                </Typography>
              ))}
              {selected.validation.issues.length > 0 && (
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<PsychologyIcon sx={{ fontSize: 14 }} />}
                  onClick={() => {
                    startAnalysis(`请解释简历版本「${selected.id}」的校验问题：${selected.validation!.issues.map((i) => `${i.code}（${i.message}）`).join('、')}——为什么出现、如何修正（修正走草稿流程，不直接改版本）`)
                    push('info', '已预置「校验解释」上下文')
                  }}
                  sx={{ fontSize: 11.5, mt: 0.5 }}
                >
                  询问 AI 此问题
                </Button>
              )}
            </Stack>
          ) : (
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>无校验快照（历史版本）</Typography>
          )}
        </Box>
        <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg }}>
          <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: 1 }}>版本内容对比</Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>对比</Typography>
            <Chip size="small" label={selected?.id.slice(-4) ?? '-'} sx={{ height: 20, fontSize: 11 }} />
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>↔</Typography>
            <Chip size="small" label="选择目标版本" onClick={() => setDiffOpen(true)} sx={{ height: 20, fontSize: 11, cursor: 'pointer' }} />
          </Stack>
        </Box>
      </Box>

      {/* Diff Dialog */}
      <Dialog open={diffOpen} onClose={() => setDiffOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontSize: 14, fontWeight: 600, pb: 1 }}>版本差异对比</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
              {timeline
                .filter((r) => r.id !== selected?.id)
                .map((r) => (
                  <Chip
                    key={r.id}
                    size="small"
                    label={`${r.id.slice(-4)} · ${STATUS_STYLE[r.status].label}`}
                    onClick={() => {
                      setDiffTarget(r.id)
                      if (selected) {
                        void useAppStore.getState().diffResumes(selected.id, r.id).then(setDiffResult).catch(() => {})
                      }
                    }}
                    sx={{ height: 22, fontSize: 11, cursor: 'pointer', bgcolor: diffTarget === r.id ? alpha(COLORS.accent, 0.15) : COLORS.bgHover }}
                  />
                ))}
            </Stack>
            {diffResult && (
              <Box>
                {diffResult.added.length > 0 && (
                  <Box sx={{ mb: 1 }}>
                    <Typography sx={{ fontSize: 12, fontWeight: 600, color: RISK_COLOR.low, mb: 0.25 }}>新增（+{diffResult.added.length}）</Typography>
                    {diffResult.added.map((i, idx) => (
                      <Typography key={idx} sx={{ fontSize: 12, color: COLORS.text, lineHeight: 1.6 }}>
                        ✓ {i.sentence} <Typography component="span" sx={{ fontSize: 11, color: COLORS.textMuted }}>· 表述 {i.claimId.slice(-4)}</Typography>
                      </Typography>
                    ))}
                  </Box>
                )}
                {diffResult.removed.length > 0 && (
                  <Box sx={{ mb: 1 }}>
                    <Typography sx={{ fontSize: 12, fontWeight: 600, color: RISK_COLOR.high, mb: 0.25 }}>删除（−{diffResult.removed.length}）</Typography>
                    {diffResult.removed.map((i, idx) => (
                      <Typography key={idx} sx={{ fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6, textDecoration: 'line-through' }}>
                        ✗ {i.sentence}
                      </Typography>
                    ))}
                  </Box>
                )}
                {diffResult.unchanged.length > 0 && (
                  <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>未变化（{diffResult.unchanged.length} 条一致）</Typography>
                )}
              </Box>
            )}
          </Stack>
        </DialogContent>
      </Dialog>
      {/* Reject Dialog（M3.5.6：可选原因——审计保留，帮助 AI 改进后续建议） */}
      <Dialog open={rejectOpen !== null} onClose={() => setRejectOpen(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 14, fontWeight: 600, pb: 1 }}>拒绝提案</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>
              提案将被标记为已拒绝（单向，不重新打开——重新建议 = AI 写新提案）。可选填写原因。
            </Typography>
            <TextField
              size="small"
              fullWidth
              multiline
              minRows={2}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="拒绝原因（可选）"
              sx={{ '& .MuiInputBase-input': { fontSize: 12.5 } }}
            />
            <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
              <Button size="small" onClick={() => setRejectOpen(null)} sx={{ fontSize: 12 }}>
                取消
              </Button>
              <Button size="small" variant="contained" color="error" onClick={() => void doReject()} sx={{ fontSize: 12 }}>
                确认拒绝
              </Button>
            </Stack>
          </Stack>
        </DialogContent>
      </Dialog>
    </Box>
  )
}
