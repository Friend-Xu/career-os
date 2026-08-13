/**
 * Resume Assets（M3.5.5）：AI Read Projection Viewer——CareerContext 只读投影。
 * 不做资产管理（无写操作）：Claims（type/usable/usedByResume/provenance）、
 * Evidence（状态）、Exports（ExportRecord 历史）。数据来自引擎投影，UI 不重新 query。
 * P1.2：新增「待确认表达」区（ClaimProposal 用户确认入口——确认后登记为表达资产；
 * 用户语言展示，不暴露 ClaimProposal/生命周期系统概念）。
 */
import { Box, Button, Chip, Stack, Typography } from '@mui/material'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, RISK_COLOR } from '../data/constants'

/** 经历分类用户语言（evidenceType → 展示标注） */
const EVIDENCE_TYPE_LABEL: Record<string, string> = {
  professional_experience: '职责',
  independent_project: '项目',
  learning_record: '学习',
}

export function ResumeAssets() {
  const careerContext = useAppStore((s) => s.careerContext)
  const evidenceItems = useAppStore((s) => s.evidence)
  const claimProposals = useAppStore((s) => s.claimProposals)
  const approveClaimProposal = useAppStore((s) => s.approveClaimProposal)
  const rejectClaimProposal = useAppStore((s) => s.rejectClaimProposal)
  const push = useToastStore((s) => s.push)
  const claims = careerContext?.claims ?? []
  const exports = careerContext?.exports ?? []
  const pendingProposals = claimProposals.filter((p) => p.status === 'pending')

  const titleOf = (id: string) => evidenceItems.find((e) => e.id === id)?.event.title ?? id
  const confirmProposal = async (id: string) => {
    try {
      await approveClaimProposal(id)
      push('success', '已确认——该表达已加入素材库')
    } catch (e) {
      push('warning', e instanceof Error ? e.message : '确认失败')
    }
  }
  const rejectProposal = async (id: string) => {
    try {
      await rejectClaimProposal(id)
      push('info', '已丢弃该表达建议')
    } catch (e) {
      push('warning', e instanceof Error ? e.message : '操作失败')
    }
  }

  return (
    <Stack spacing={2}>
      {/* 待确认表达（P1.2：ClaimProposal 用户确认入口——AI 提案，用户决定，Engine 登记） */}
      {pendingProposals.length > 0 && (
        <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${alpha(COLORS.accent, 0.4)}`, bgcolor: alpha(COLORS.accent, 0.04) }}>
          <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1, color: COLORS.accent }}>
            待确认表达（{pendingProposals.length}）
          </Typography>
          <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 1 }}>
            AI 从你的经历生成的表达建议——确认后成为可复用表达资产，可加入简历
          </Typography>
          <Stack spacing={1}>
            {pendingProposals.map((p) => (
              <Box key={p.id} sx={{ p: 1.25, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
                <Typography sx={{ fontSize: 12.5, color: COLORS.text, lineHeight: 1.6, mb: 0.5 }}>
                  {p.proposedClaim.statement}
                </Typography>
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 1 }}>
                  依据：{p.evidenceRefs.map(titleOf).join('、')}
                </Typography>
                <Stack direction="row" spacing={1}>
                  <Button size="small" variant="contained" onClick={() => void confirmProposal(p.id)} sx={{ fontSize: 11.5 }}>
                    确认加入表达资产
                  </Button>
                  <Button size="small" variant="outlined" onClick={() => void rejectProposal(p.id)} sx={{ fontSize: 11.5, color: COLORS.textMuted, borderColor: alpha(COLORS.border, 0.8) }}>
                    丢弃
                  </Button>
                </Stack>
              </Box>
            ))}
          </Stack>
        </Box>
      )}

      {/* Claims（已确认表达资产） */}
      <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1 }}>已确认表达（可加入简历）</Typography>
        {claims.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>暂无表述——从可信事实生成后出现于此</Typography>
        ) : (
          <Stack spacing={1}>
            {claims.map((c) => {
              const evTitles = c.provenance.evidenceIds.map((eid) => evidenceItems.find((e) => e.id === eid)?.event.title ?? eid)
              return (
                <Box key={c.id} sx={{ p: 1.25, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
                  <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5 }}>
                    <Typography sx={{ fontSize: 12.5, color: COLORS.text, flex: 1, minWidth: 0 }} noWrap>
                      {c.statement}
                    </Typography>
                    <Chip size="small" label={c.type === 'fact' ? '事实' : '归纳'} sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(c.type === 'fact' ? RISK_COLOR.low : RISK_COLOR.medium, 0.1), color: c.type === 'fact' ? RISK_COLOR.low : RISK_COLOR.medium }} />
                    {c.evidenceType && (
                      <Chip size="small" label={EVIDENCE_TYPE_LABEL[c.evidenceType] ?? c.evidenceType} sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.textMuted, 0.1), color: COLORS.textMuted }} />
                    )}
                    <Chip size="small" label={c.usable ? '可消费' : '不可消费'} sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(c.usable ? RISK_COLOR.low : RISK_COLOR.high, 0.1), color: c.usable ? RISK_COLOR.low : RISK_COLOR.high }} />
                  </Stack>
                  <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                    证据：{evTitles.join('、') || '无'}
                    {c.usedByResume.length > 0 ? ` · 被使用于：${c.usedByResume.map((r) => r.slice(-6)).join('、')}` : ' · 未使用'}
                  </Typography>
                </Box>
              )
            })}
          </Stack>
        )}
      </Box>

      {/* Evidence */}
      <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1 }}>事实资产</Typography>
        {evidenceItems.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>暂无事实——通过主动沉淀或 JD 驱动收集</Typography>
        ) : (
          <Stack spacing={1}>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
              有效 · {evidenceItems.filter((e) => e.lifecycle !== 'legacy').length}
            </Typography>
            {evidenceItems.filter((e) => e.lifecycle !== 'legacy').map((e) => (
              <Box key={e.id} sx={{ p: 1.25, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <Typography sx={{ fontSize: 12.5, color: COLORS.text, flex: 1, minWidth: 0 }} noWrap>
                    {e.event.title}
                  </Typography>
                  <Chip size="small" label={e.status} sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(e.status === 'trusted' ? RISK_COLOR.low : COLORS.textMuted, 0.1), color: e.status === 'trusted' ? RISK_COLOR.low : COLORS.textMuted }} />
                </Stack>
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>{e.contribution}</Typography>
              </Box>
            ))}
            {(() => {
              const legacy = evidenceItems.filter((e) => e.lifecycle === 'legacy')
              if (legacy.length === 0) return null
              return (
                <>
                  <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 1 }}>
                    历史（旧版·开发期/历史，不进新表达）· {legacy.length}
                  </Typography>
                  {legacy.map((e) => (
                    <Box key={e.id} sx={{ p: 1.25, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: alpha(COLORS.textMuted, 0.04) }}>
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                        <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted, flex: 1, minWidth: 0 }} noWrap>
                          {e.event.title}
                        </Typography>
                        <Chip size="small" label="旧版" sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.textMuted, 0.1), color: COLORS.textMuted }} />
                      </Stack>
                      <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, opacity: 0.8 }}>{e.contribution}</Typography>
                    </Box>
                  ))}
                </>
              )
            })()}
          </Stack>
        )}
      </Box>

      {/* Exports */}
      <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1 }}>导出历史</Typography>
        {exports.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>暂无导出记录——版本导出成功后才生成 ExportRecord</Typography>
        ) : (
          <Stack spacing={1}>
            {exports.map((e, i) => (
              <Box key={i} sx={{ p: 1.25, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <Typography sx={{ fontSize: 12.5, color: COLORS.text, flex: 1 }}>简历 {e.resumeId.slice(-6)}</Typography>
                  <Chip size="small" label={e.format.toUpperCase()} sx={{ height: 18, fontSize: 10.5 }} />
                </Stack>
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>{e.exportedAt.slice(0, 19).replace('T', ' ')}</Typography>
              </Box>
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  )
}
