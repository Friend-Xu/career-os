/**
 * 简历工作台侧栏（ADR-021 R0）：四空间导航（编辑/优化/历史/素材）+ 按区上下文列表。
 * - 编辑：草稿列表（普通草稿/未资产化——Unbound Draft，ADR-021 §8）
 * - 优化：空态（R2 实现 Resume Alignment Projection，R0 只给定位文案）
 * - 历史：引擎版本列表（状态色/目标岗位/派生链/validation/claims 数——Artifact 语义）
 * - 素材：资产概览（Claims/Evidence/Exports 计数——CareerContext 投影）
 */
import { Box, IconButton, Stack, Typography } from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import HistoryIcon from '@mui/icons-material/History'
import CollectionsIcon from '@mui/icons-material/Collections'
import { useMemo } from 'react'
import { useAppStore } from '../../../store/app-store'
import { useToastStore } from '../../../store/toast-store'
import { alpha, COLORS, RISK_COLOR } from '../../../data/constants'
import type { ResumeWorkspaceView } from '../../../store/app-store'

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  draft: { color: RISK_COLOR.medium, label: '草稿' },
  review: { color: '#8a6d3b', label: '待确认' },
  exported: { color: RISK_COLOR.low, label: '已导出' },
  archived: { color: COLORS.textMuted, label: '已归档' },
}

const VALIDATION_LABEL: Record<string, string> = {
  valid: '✓ 有效',
  warning: '△ 警告',
  invalid: '✗ 无效',
}

/** 空间图标（编辑=主图标；优化/历史/素材 = 任务语义图标） */
const SPACE_ICON: Record<ResumeWorkspaceView, typeof AutoAwesomeIcon> = {
  dashboard: DescriptionOutlinedIcon,
  edit: DescriptionOutlinedIcon,
  optimize: AutoAwesomeIcon,
  history: HistoryIcon,
  library: CollectionsIcon,
}

export function ResumesSidebar() {
  const person = useAppStore((s) => s.currentPerson())
  const resumes = useAppStore((s) => s.resumes)
  const activeResumeId = useAppStore((s) => s.activeResumeId)
  const setActiveResumeId = useAppStore((s) => s.setActiveResumeId)
  const deleteResumeVersion = useAppStore((s) => s.deleteResumeVersion)
  const resumeWorkspaceView = useAppStore((s) => s.resumeWorkspaceView)
  const setResumeWorkspaceView = useAppStore((s) => s.setResumeWorkspaceView)
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

  /** 四空间导航（Dashboard 是落地页不占 tab——ADR-021 §1） */
  const NAV: { key: ResumeWorkspaceView; label: string }[] = [
    { key: 'edit', label: '编辑' },
    { key: 'optimize', label: '优化' },
    { key: 'history', label: '历史' },
    { key: 'library', label: '素材' },
  ]

  return (
    <Stack sx={{ p: 1.25 }}>
      {/* 四空间导航 */}
      <Stack direction="row" spacing={0.5} sx={{ mb: 1, px: 0.5 }}>
        {NAV.map((n) => {
          const Icon = SPACE_ICON[n.key]
          const active = resumeWorkspaceView === n.key
          return (
            <Box
              key={n.key}
              onClick={() => setResumeWorkspaceView(n.key)}
              sx={{
                flex: 1,
                textAlign: 'center',
                py: 0.7,
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 600,
                bgcolor: active ? alpha(COLORS.accent, 0.12) : 'transparent',
                color: active ? COLORS.accent : COLORS.textSecondary,
                '&:hover': { bgcolor: active ? alpha(COLORS.accent, 0.12) : COLORS.bgHover },
              }}
            >
              <Stack direction="row" spacing={0.4} sx={{ alignItems: 'center', justifyContent: 'center' }}>
                <Icon sx={{ fontSize: 13 }} />
                <span>{n.label}</span>
              </Stack>
            </Box>
          )
        })}
      </Stack>

      {/* ── 编辑：草稿列表（Unbound Draft——可编辑可导出，不参与溯源投影）── */}
      {resumeWorkspaceView === 'edit' && (
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

      {/* ── 优化：空态（R2 实现 Alignment Projection，R0 只给定位文案）── */}
      {resumeWorkspaceView === 'optimize' && (
        <>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5, px: 1 }}>
            <AutoAwesomeIcon sx={{ fontSize: 14, color: COLORS.textMuted }} />
            <Typography sx={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, letterSpacing: '0.05em', flex: 1 }}>岗位优化</Typography>
          </Stack>
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, px: 1, py: 1, lineHeight: 1.6 }}>
            将当前简历与目标岗位要求匹配，发现表达缺口并基于已有经历提出优化建议。
          </Typography>
          <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, px: 1, lineHeight: 1.6, opacity: 0.85 }}>
            需要先关联岗位（草稿「基于 JD 派生」或从 Dashboard 选择）。
          </Typography>
        </>
      )}

      {/* ── 历史：引擎版本列表（Artifact 语义）── */}
      {resumeWorkspaceView === 'history' && (
        <>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5, px: 1 }}>
            <HistoryIcon sx={{ fontSize: 14, color: COLORS.textMuted }} />
            <Typography sx={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, letterSpacing: '0.05em', flex: 1 }}>版本空间</Typography>
            <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.textMuted }}>{versions.length}</Typography>
          </Stack>
          {versions.length === 0 ? (
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, px: 1, py: 2, textAlign: 'center' }}>
              暂无资产版本——AI 产出草稿后自动登记（表述驱动，可追溯）
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
                    {claimsOf(r.id)} 条表述
                  </Typography>
                </Stack>
              )
            })
          )}
        </>
      )}

      {/* ── 素材：资产概览（CareerContext 投影，只读）── */}
      {resumeWorkspaceView === 'library' && (
        <>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5, px: 1 }}>
            <CollectionsIcon sx={{ fontSize: 14, color: COLORS.textMuted }} />
            <Typography sx={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, letterSpacing: '0.05em', flex: 1 }}>素材库</Typography>
          </Stack>
          <Stack spacing={0.5} sx={{ px: 1 }}>
            <Box sx={{ px: 1.25, py: 1, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
              <Typography sx={{ fontSize: 12, fontWeight: 600 }}>已有表达</Typography>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                共 {(careerContext?.claims ?? []).length} 条 · 可消费 {(careerContext?.claims ?? []).filter((c) => c.usable).length} 条
              </Typography>
            </Box>
            <Box sx={{ px: 1.25, py: 1, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
              <Typography sx={{ fontSize: 12, fontWeight: 600 }}>可用经历</Typography>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                有效 {useAppStore.getState().evidence.filter((e) => e.lifecycle !== 'legacy').length} 条 · 历史 {useAppStore.getState().evidence.filter((e) => e.lifecycle === 'legacy').length} 条
              </Typography>
            </Box>
            <Box sx={{ px: 1.25, py: 1, borderRadius: '8px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
              <Typography sx={{ fontSize: 12, fontWeight: 600 }}>导出历史</Typography>
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
