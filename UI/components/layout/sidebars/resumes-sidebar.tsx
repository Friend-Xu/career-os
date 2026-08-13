/**
 * 简历工作台侧栏（ADR-021 R0）：四空间导航（编辑/优化/历史/素材）+ 按区上下文列表。
 * - 编辑：草稿列表（普通草稿/未资产化——Unbound Draft，ADR-021 §8）
 * - 优化：空态（R2 实现 Resume Alignment Projection，R0 只给定位文案）
 * - 历史：引擎版本列表（状态色/目标岗位/派生链/validation/claims 数——Artifact 语义）
 * - 素材：资产概览（Claims/Evidence/Exports 计数——CareerContext 投影）
 */
import { Box, Stack, Typography } from '@mui/material'
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import HistoryIcon from '@mui/icons-material/History'
import CollectionsIcon from '@mui/icons-material/Collections'
import AddIcon from '@mui/icons-material/Add'
import { useMemo, type ReactNode } from 'react'
import { useAppStore } from '../../../store/app-store'
import { useToastStore } from '../../../store/toast-store'
import { workingCopyLabel } from '../../../utils/resume-label'
import { alpha, COLORS, RISK_COLOR } from '../../../data/constants'
import { resumeVersionLabel } from '../../../utils/resume-label'
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

/** 空间卡片（与工作台侧栏同构——icon + 标题 + 描述 + 边框选中；工作台 = Dashboard 落地页） */
const SPACES: { key: ResumeWorkspaceView; label: string; desc: string; icon: ReactNode }[] = [
  { key: 'dashboard', label: '工作台', desc: '当前状态与下一步', icon: <DashboardOutlinedIcon sx={{ fontSize: 15 }} /> },
  { key: 'edit', label: '编辑', desc: '修改内容 · AI 润色', icon: <DescriptionOutlinedIcon sx={{ fontSize: 15 }} /> },
  { key: 'optimize', label: '优化', desc: '对齐岗位要求', icon: <AutoAwesomeIcon sx={{ fontSize: 15 }} /> },
  { key: 'history', label: '历史', desc: '版本演化与对比', icon: <HistoryIcon sx={{ fontSize: 15 }} /> },
  { key: 'library', label: '素材', desc: '事实与表达资产', icon: <CollectionsIcon sx={{ fontSize: 15 }} /> },
]

export function ResumesSidebar() {
  const person = useAppStore((s) => s.currentPerson())
  const workingCopies = useAppStore((s) => s.workingCopies)
  const jobs = useAppStore((s) => s.jobs)
  const activeWorkingCopyId = useAppStore((s) => s.activeWorkingCopyId)
  const setActiveWorkingCopy = useAppStore((s) => s.setActiveWorkingCopy)
  const resumeWorkspaceView = useAppStore((s) => s.resumeWorkspaceView)
  const setResumeWorkspaceView = useAppStore((s) => s.setResumeWorkspaceView)
  const selectResume = useAppStore((s) => s.selectResume)
  const selectedResumeId = useAppStore((s) => s.selectedResumeId)
  const resumeVersions = useAppStore((s) => s.resumeVersions)
  const careerContext = useAppStore((s) => s.careerContext)
  const derivationProposals = useAppStore((s) => s.derivationProposals)
  const promoteWorkingCopy = useAppStore((s) => s.promoteWorkingCopy)
  const push = useToastStore((s) => s.push)

  /** 派生副本标记：acceptedWcId 关联（引擎 accept 时登记的事实投影——不为副本新增身份字段） */
  const derivedCopyIds = useMemo(
    () => new Set(derivationProposals.filter((p) => p.acceptedWcId).map((p) => p.acceptedWcId as string)),
    [derivationProposals],
  )

  /** 创建版本（promote 当前工作副本 → ResumeDocument Candidate；无副本 → 提示先创作） */
  const createVersion = async () => {
    const copy = personWorkingCopies.find((w) => w.id === activeWorkingCopyId) ?? personWorkingCopies[0]
    if (!copy) {
      push('warning', '暂无工作副本——先在编辑空间创作内容')
      return
    }
    try {
      const doc = await promoteWorkingCopy(copy.id)
      push('success', `已创建版本 ${doc.id.slice(-6)}（未资产化内容已标注）`)
    } catch (e) {
      push('warning', e instanceof Error ? e.message : '创建版本失败')
    }
  }

  const personWorkingCopies = useMemo(() => workingCopies.filter((w) => w.owner === person.personId), [workingCopies, person.personId])
  const versions = useMemo(() => [...resumeVersions].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt)), [resumeVersions])
  const claimsOf = (id: string): number => {
    const v = resumeVersions.find((r) => r.id === id)
    return v ? new Set(v.sections.flatMap((s) => s.bullets.map((b) => b.claimId))).size : 0
  }

  /** 四空间卡片导航（与工作台「驾驶舱」同构——统一风格；ADR-021 §1） */
  return (
    <Stack sx={{ p: 1.25 }}>
      <Typography
        sx={{
          fontSize: 11,
          fontWeight: 600,
          color: COLORS.textMuted,
          letterSpacing: '0.05em',
          px: 1,
          mb: 0.5,
        }}
      >
        简历工作台
      </Typography>
      {SPACES.map((v) => {
        const active = resumeWorkspaceView === v.key
        return (
          <Stack
            key={v.key}
            onClick={() => setResumeWorkspaceView(v.key)}
            sx={{
              mb: 0.5,
              px: 1.25,
              py: 1,
              borderRadius: '8px',
              cursor: 'pointer',
              border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
              bgcolor: active ? COLORS.accentMuted : COLORS.bg,
              '&:hover': { bgcolor: active ? COLORS.accentMuted : COLORS.bgHover },
            }}
          >
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
              <Box sx={{ display: 'flex', color: active ? COLORS.accent : COLORS.textMuted }}>{v.icon}</Box>
              <Typography sx={{ fontSize: 12.5, fontWeight: active ? 600 : 500, color: active ? COLORS.accent : COLORS.text }}>
                {v.label}
              </Typography>
            </Stack>
            <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>{v.desc}</Typography>
          </Stack>
        )
      })}

      {/* ── 编辑：工作副本列表（P2.3——用户创作对象，unbound 合法）── */}
      {resumeWorkspaceView === 'edit' && (
        <>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5, px: 1 }}>
            <DescriptionOutlinedIcon sx={{ fontSize: 14, color: COLORS.textMuted }} />
            <Typography sx={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, letterSpacing: '0.05em', flex: 1 }}>工作副本</Typography>
            <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.textMuted }}>{personWorkingCopies.length}</Typography>
          </Stack>
          {personWorkingCopies.length === 0 ? (
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, px: 1, py: 2, textAlign: 'center' }}>
              暂无工作副本——从现有简历初始化，或 AI 生成后自动登记
            </Typography>
          ) : (
            personWorkingCopies.map((w) => {
              const active = w.id === activeWorkingCopyId
              const boundBlocks = w.sections.reduce((n, s) => n + s.blocks.filter((b) => b.provenanceLinks && b.provenanceLinks.length > 0).length, 0)
              const totalBlocks = w.sections.reduce((n, s) => n + s.blocks.length, 0)
              return (
                <Stack key={w.id} onClick={() => setActiveWorkingCopy(w.id)} sx={{ mb: 0.5, px: 1.25, py: 1, borderRadius: '8px', cursor: 'pointer', border: `1px solid ${active ? COLORS.accent : COLORS.border}`, bgcolor: active ? COLORS.accentMuted : COLORS.bg, '&:hover': { bgcolor: active ? COLORS.accentMuted : COLORS.bgHover } }}>
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <Typography sx={{ fontSize: 12.5, fontWeight: active ? 600 : 500, color: active ? COLORS.accent : COLORS.text, flex: 1, minWidth: 0 }} noWrap>
                      {workingCopyLabel(w, jobs)}
                    </Typography>
                    {derivedCopyIds.has(w.id) && (
                      <Box
                        component="span"
                        sx={{
                          flexShrink: 0,
                          fontSize: 10,
                          px: 0.6,
                          py: 0.1,
                          borderRadius: '4px',
                          bgcolor: alpha(COLORS.accent, 0.1),
                          color: COLORS.accent,
                          lineHeight: '15px',
                          fontWeight: 600,
                        }}
                        title="由 JD 派生生成（接受派生提案后创建的副本）"
                      >
                        已优化
                      </Box>
                    )}
                    <Typography sx={{ fontSize: 11, color: w.status === 'promoted' ? COLORS.textMuted : COLORS.accent, flexShrink: 0 }}>
                      {w.status === 'promoted' ? '已发布' : '编辑中'}
                    </Typography>
                  </Stack>
                  <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>
                    {w.updatedAt.slice(5, 16).replace('T', ' ')}
                    {' · '}
                    {boundBlocks === totalBlocks && totalBlocks > 0 ? `${totalBlocks} 行均有来源` : `${boundBlocks}/${totalBlocks} 行有来源`}
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
          {/* 创建版本入口：虚线卡片（与新增 JD/新建会话同构——版本空间的「生产入口」，promote 当前工作副本） */}
          <Box sx={{ px: 1.25, pb: 0.75 }}>
            <Stack
              direction="row"
              spacing={0.75}
              onClick={() => void createVersion()}
              sx={{
                alignItems: 'center',
                justifyContent: 'center',
                px: 1.25,
                py: 1.1,
                borderRadius: '8px',
                cursor: 'pointer',
                border: `1px dashed ${alpha(COLORS.accent, 0.45)}`,
                bgcolor: alpha(COLORS.accent, 0.05),
                color: COLORS.accent,
                '&:hover': { bgcolor: alpha(COLORS.accent, 0.12) },
              }}
            >
              <AddIcon sx={{ fontSize: 16 }} />
              <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>创建版本</Typography>
            </Stack>
          </Box>
          {versions.length === 0 ? (
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, px: 1, py: 2, textAlign: 'center', lineHeight: 1.7 }}>
              暂无资产版本
              <br />
              上方「创建版本」发布当前工作副本
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
                      {resumeVersionLabel(r, jobs)}
                    </Typography>
                    <Typography sx={{ fontSize: 11, fontFamily: COLORS.mono, color: vStatus === 'valid' ? RISK_COLOR.low : vStatus === 'warning' ? RISK_COLOR.medium : RISK_COLOR.high }}>
                      {VALIDATION_LABEL[vStatus]}
                    </Typography>
                  </Stack>
                  <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>
                    {r.lineage?.parentResumeId ? `派生自 ${r.lineage.parentResumeId}（${r.lineage.derivationType}）` : `⚡ ${r.lineage?.derivationType ?? 'jd_generate'}`}
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
