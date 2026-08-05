/**
 * 简历空间侧栏（M3.5.5）：三空间导航 + 按区上下文列表。
 * - workspace：草稿列表（旧 ResumeVersion——普通草稿/未资产化，UI 不暴露 Legacy 概念）
 * - studio：引擎版本列表（状态色/目标岗位/派生链/validation/claims 数——Artifact 语义）
 * - assets：资产概览（Claims/Evidence/Exports 计数——CareerContext 投影）
 */
import { Box, IconButton, Stack, Typography } from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import { useMemo } from 'react'
import { useAppStore } from '../../../store/app-store'
import { useToastStore } from '../../../store/toast-store'
import { alpha, COLORS, RISK_COLOR } from '../../../data/constants'

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  draft: { color: RISK_COLOR.medium, label: '草稿' },
  review: { color: '#8a6d3b', label: '待确认' },
  exported: { color: RISK_COLOR.low, label: '已导出' },
  archived: { color: COLORS.textMuted, label: '已归档' },
}

const VALIDATION_LABEL: Record<string, string> = {
  valid: '✓ Valid',
  warning: '△ Warning',
  invalid: '✗ Invalid',
}

export function ResumesSidebar() {
  const person = useAppStore((s) => s.currentPerson())
  const resumes = useAppStore((s) => s.resumes)
  const activeResumeId = useAppStore((s) => s.activeResumeId)
  const setActiveResumeId = useAppStore((s) => s.setActiveResumeId)
  const deleteResumeVersion = useAppStore((s) => s.deleteResumeVersion)
  const resumesView = useAppStore((s) => s.resumesView)
  const setResumesView = useAppStore((s) => s.setResumesView)
  const selectResume = useAppStore((s) => s.selectResume)
  const selectedResumeId = useAppStore((s) => s.selectedResumeId)
  const resumeVersions = useAppStore((s) => s.resumeVersions)
  const careerContext = useAppStore((s) => s.careerContext)
  const push = useToastStore((s) => s.push)

  const personResumes = useMemo(() => resumes.filter((r) => r.personId === person.id), [resumes, person.id])
  const sortedDrafts = useMemo(
    () => [...personResumes].sort((a, b) => Number(b.name.includes('原始简历')) - Number(a.name.includes('原始简历'))),
    [personResumes],
  )
  const versions = useMemo(() => [...resumeVersions].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt)), [resumeVersions])
  const claimsOf = (id: string): number => {
    const v = resumeVersions.find((r) => r.id === id)
    return v ? new Set(v.sections.flatMap((s) => s.bullets.map((b) => b.claimId))).size : 0
  }

  const NAV = [
    { key: 'workspace' as const, label: '草稿' },
    { key: 'studio' as const, label: '版本' },
    { key: 'assets' as const, label: '资产' },
  ]

  return (
    <Stack sx={{ p: 1.25 }}>
      {/* 三空间导航 */}
      <Stack direction="row" spacing={0.5} sx={{ mb: 1, px: 0.5 }}>
        {NAV.map((n) => (
          <Box
            key={n.key}
            onClick={() => setResumesView(n.key)}
            sx={{
              flex: 1,
              textAlign: 'center',
              py: 0.7,
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              bgcolor: resumesView === n.key ? alpha(COLORS.accent, 0.12) : 'transparent',
              color: resumesView === n.key ? COLORS.accent : COLORS.textSecondary,
              '&:hover': { bgcolor: resumesView === n.key ? alpha(COLORS.accent, 0.12) : COLORS.bgHover },
            }}
          >
            {n.label}
          </Box>
        ))}
      </Stack>

      {/* ── workspace：草稿列表（普通草稿/未资产化）── */}
      {resumesView === 'workspace' && (
        <>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5, px: 1 }}>
            <DescriptionOutlinedIcon sx={{ fontSize: 14, color: COLORS.textMuted }} />
            <Typography sx={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, letterSpacing: '0.05em', flex: 1 }}>草稿</Typography>
            <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.textMuted }}>{personResumes.length}</Typography>
          </Stack>
          {sortedDrafts.length === 0 ? (
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, px: 1, py: 2, textAlign: 'center' }}>
              暂无草稿——编辑产物是普通草稿（未资产化，不进入版本空间）
            </Typography>
          ) : (
            sortedDrafts.map((r) => {
              const active = r.id === activeResumeId
              const target = [r.targetPosition, r.targetCompany].filter(Boolean).join(' · ')
              return (
                <Stack key={r.id} onClick={() => setActiveResumeId(r.id)} sx={{ mb: 0.5, px: 1.25, py: 1, borderRadius: '8px', cursor: 'pointer', border: `1px solid ${active ? COLORS.accent : COLORS.border}`, bgcolor: active ? COLORS.accentMuted : COLORS.bg, '&:hover': { bgcolor: active ? COLORS.accentMuted : COLORS.bgHover }, '&:hover .card-delete': { opacity: 1 } }}>
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <Typography sx={{ fontSize: 12.5, fontWeight: active ? 600 : 500, color: active ? COLORS.accent : COLORS.text, flex: 1, minWidth: 0 }} noWrap>
                      {r.name}
                    </Typography>
                    <Box className="card-delete" onClick={(e) => e.stopPropagation()} sx={{ opacity: 0, flexShrink: 0 }}>
                      <IconButton size="small" title="删除草稿" onClick={() => { if (!window.confirm(`删除草稿「${r.name}」？不可恢复。`)) return; deleteResumeVersion(r.id); push('info', `已删除草稿：${r.name}`) }} sx={{ p: 0.25 }}>
                        <DeleteIcon sx={{ fontSize: 13, color: COLORS.textMuted }} />
                      </IconButton>
                    </Box>
                  </Stack>
                  <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>
                    {r.updatedAt.slice(5)}
                    {target ? ` · ${target}` : ''}
                    {' · 未资产化'}
                  </Typography>
                </Stack>
              )
            })
          )}
        </>
      )}

      {/* ── studio：引擎版本列表（Artifact 语义）── */}
      {resumesView === 'studio' && (
        <>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5, px: 1 }}>
            <DescriptionOutlinedIcon sx={{ fontSize: 14, color: COLORS.textMuted }} />
            <Typography sx={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, letterSpacing: '0.05em', flex: 1 }}>版本空间</Typography>
            <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.textMuted }}>{versions.length}</Typography>
          </Stack>
          {versions.length === 0 ? (
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, px: 1, py: 2, textAlign: 'center' }}>
              暂无资产版本——AI 产出 Draft 后自动登记（Claim 驱动，可追溯）
            </Typography>
          ) : (
            versions.map((r) => {
              const active = r.id === selectedResumeId
              const st = STATUS_STYLE[r.status]
              const vStatus = r.validation?.status ?? 'valid'
              return (
                <Stack key={r.id} onClick={() => selectResume(r.id)} sx={{ mb: 0.5, px: 1.25, py: 1, borderRadius: '8px', cursor: 'pointer', border: `1px solid ${active ? COLORS.accent : COLORS.border}`, bgcolor: active ? COLORS.accentMuted : COLORS.bg, '&:hover': { bgcolor: active ? COLORS.accentMuted : COLORS.bgHover } }}>
                  <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                    <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: st.color, flexShrink: 0 }} />
                    <Typography sx={{ fontSize: 12.5, fontWeight: active ? 600 : 500, color: active ? COLORS.accent : COLORS.text, flex: 1, minWidth: 0 }} noWrap>
                      {r.id.slice(-6)} · {st.label}
                    </Typography>
                    <Typography sx={{ fontSize: 11, fontFamily: COLORS.mono, color: vStatus === 'valid' ? RISK_COLOR.low : vStatus === 'warning' ? RISK_COLOR.medium : RISK_COLOR.high }}>
                      {VALIDATION_LABEL[vStatus]}
                    </Typography>
                  </Stack>
                  <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>
                    {r.lineage?.parentResumeId ? `派生自 ${r.lineage.parentResumeId.slice(-6)}（${r.lineage.derivationType}）` : `⚡ ${r.lineage?.derivationType ?? 'jd_generate'}`}
                    {r.targetJobId ? ` · ${r.targetJobId.slice(-8)}` : ''}
                    {' · '}
                    {claimsOf(r.id)} claims
                  </Typography>
                </Stack>
              )
            })
          )}
        </>
      )}

      {/* ── assets：资产概览（CareerContext 投影，只读）── */}
      {resumesView === 'assets' && (
        <>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5, px: 1 }}>
            <DescriptionOutlinedIcon sx={{ fontSize: 14, color: COLORS.textMuted }} />
            <Typography sx={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, letterSpacing: '0.05em', flex: 1 }}>资产空间</Typography>
          </Stack>
          <Stack spacing={0.5} sx={{ px: 1 }}>
            <Box sx={{ px: 1.25, py: 1, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
              <Typography sx={{ fontSize: 12, fontWeight: 600 }}>Claims（可消费表达）</Typography>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                共 {(careerContext?.claims ?? []).length} 条 · 可消费 {(careerContext?.claims ?? []).filter((c) => c.usable).length} 条
              </Typography>
            </Box>
            <Box sx={{ px: 1.25, py: 1, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
              <Typography sx={{ fontSize: 12, fontWeight: 600 }}>Evidence（事实资产）</Typography>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>{useAppStore.getState().evidence.length} 条</Typography>
            </Box>
            <Box sx={{ px: 1.25, py: 1, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
              <Typography sx={{ fontSize: 12, fontWeight: 600 }}>Exports（导出历史）</Typography>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                {(careerContext?.exports ?? []).length} 次 · {(careerContext?.exports ?? []).map((e) => `${e.resumeId.slice(-6)}(${e.format})`).join('、') || '无'}
              </Typography>
            </Box>
          </Stack>
        </>
      )}
    </Stack>
  )
}
