/**
 * 优化空间（R2.2）：Resume Alignment Projection 消费视图——四态 Requirement Card。
 * 契约：docs/domain/resume-alignment-projection-v0.1.md（resumes/alignment RPC，纯投影不落盘）。
 * - 只消费引擎 ResumeDocument × 已建档 JD（不消费 mock 草稿——ADR-021 §7）
 * - 四态：已覆盖 / 表达缺口 / 证据不足声明（红线）/ 能力缺口
 * - R2.2 边界：只展示四态 + 可追溯引用；不做 AI 改写 / 提案创建（R2.3 Rewrite Bridge）
 */
import { Box, Chip, MenuItem, Select, Stack, Typography } from '@mui/material'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import { alpha, COLORS } from '../../data/constants'
import { resumeVersionLabel } from '../../utils/resume-label'
import type { AlignmentState, ResumeAlignmentProjection } from '../../../engine/runtime/resume-alignment.ts'

const STATE_META: Record<AlignmentState, { icon: string; label: string; color: string }> = {
  covered: { icon: '✓', label: '已覆盖', color: COLORS.riskLow },
  expressive_gap: { icon: '△', label: '表达缺口', color: COLORS.riskMedium },
  unsupported_claim: { icon: '⚠', label: '证据不足声明', color: COLORS.riskHigh },
  capability_gap: { icon: '○', label: '能力缺口', color: COLORS.textMuted },
}

export function ResumeOptimizeWorkspace() {
  const resumeVersions = useAppStore((s) => s.resumeVersions)
  const jobs = useAppStore((s) => s.jobs)
  const evidenceItems = useAppStore((s) => s.evidence)
  const engineStatus = useAppStore((s) => s.engineStatus)
  const fetchResumeAlignment = useAppStore((s) => s.fetchResumeAlignment)
  const [versionId, setVersionId] = useState('')
  const [jobId, setJobId] = useState('')
  const [projection, setProjection] = useState<ResumeAlignmentProjection | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!versionId || !jobId || engineStatus !== 'connected') return
    let cancelled = false
    setLoading(true)
    setError('')
    fetchResumeAlignment(versionId, jobId)
      .then((p) => {
        if (!cancelled) setProjection(p)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setProjection(null)
          setError(e instanceof Error ? e.message : '对齐计算失败')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [versionId, jobId, engineStatus, fetchResumeAlignment])

  const titleOf = (eid: string) => evidenceItems.find((e) => e.id === eid)?.event.title ?? eid
  const versions = resumeVersions.filter((v) => v.status !== 'archived')

  return (
    <Box sx={{ p: 2, maxWidth: 860, mx: 'auto' }}>
      {/* 选择区：引擎版本 × 目标 JD（不消费 mock 草稿） */}
      <Box
        sx={{
          p: 1.5,
          mb: 2,
          borderRadius: '10px',
          border: `1px solid ${alpha(COLORS.border, 0.8)}`,
          boxShadow: COLORS.cardShadow,
          bgcolor: COLORS.bgElevated,
        }}
      >
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}>
          <AutoAwesomeIcon sx={{ fontSize: 15, color: COLORS.accent }} />
          <Typography sx={{ fontSize: 12.5, fontWeight: 600, mr: 0.5 }}>对齐分析</Typography>
          <Select
            size="small"
            displayEmpty
            value={versionId}
            onChange={(e) => {
              setVersionId(e.target.value as string)
              setProjection(null)
            }}
            sx={{ minWidth: 190, '& .MuiSelect-select': { fontSize: 12.5, py: 0.75 } }}
          >
            <MenuItem value="" disabled>
              选择简历版本
            </MenuItem>
            {versions.map((v) => (
              <MenuItem key={v.id} value={v.id} sx={{ fontSize: 12.5 }}>
                {resumeVersionLabel(v, jobs)}
              </MenuItem>
            ))}
          </Select>
          <Select
            size="small"
            displayEmpty
            value={jobId}
            onChange={(e) => {
              setJobId(e.target.value as string)
              setProjection(null)
            }}
            sx={{ minWidth: 220, '& .MuiSelect-select': { fontSize: 12.5, py: 0.75 } }}
          >
            <MenuItem value="" disabled>
              选择目标岗位
            </MenuItem>
            {jobs.map((j) => (
              <MenuItem key={j.id} value={j.id} sx={{ fontSize: 12.5 }}>
                {j.company} · {j.title}
              </MenuItem>
            ))}
          </Select>
          {engineStatus !== 'connected' && (
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>引擎离线——对齐计算不可用</Typography>
          )}
        </Stack>
      </Box>

      {/* 引导态：未选择 */}
      {!versionId || !jobId ? (
        <Box
          sx={{
            p: 3,
            borderRadius: '10px',
            border: `1px dashed ${alpha(COLORS.border, 0.9)}`,
            textAlign: 'center',
          }}
        >
          <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, mb: 0.5 }}>
            选择简历版本与目标岗位，查看岗位要求覆盖情况
          </Typography>
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>
            对齐分析基于已有事实——检查「要求是否被可信表达覆盖」，不预测招聘系统
          </Typography>
        </Box>
      ) : loading ? (
        <Box sx={{ p: 3, textAlign: 'center' }}>
          <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted }}>对齐计算中…</Typography>
        </Box>
      ) : error ? (
        <Box
          sx={{
            p: 2,
            borderRadius: '8px',
            bgcolor: alpha(COLORS.riskHigh, 0.08),
            border: `1px solid ${alpha(COLORS.riskHigh, 0.3)}`,
          }}
        >
          <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary }}>{error}</Typography>
        </Box>
      ) : projection && projection.rows.length === 0 ? (
        <Box
          sx={{
            p: 3,
            borderRadius: '10px',
            border: `1px dashed ${alpha(COLORS.border, 0.9)}`,
            textAlign: 'center',
          }}
        >
          <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, mb: 0.5 }}>
            该岗位尚未完成 JD 分析（无证据期望）
          </Typography>
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
            先在 JD 空间完成分析后，此处可对齐岗位要求
          </Typography>
        </Box>
      ) : (
        projection && (
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>岗位要求覆盖</Typography>
              <Chip
                size="small"
                label={`${projection.rows.length} 项责任`}
                sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.accent, 0.1), color: COLORS.accent }}
              />
            </Stack>
            {projection.rows.map((row) => {
              const meta = STATE_META[row.state]
              return (
                <Box
                  key={row.responsibilityId}
                  sx={{
                    p: 1.5,
                    borderRadius: '10px',
                    border: `1px solid ${alpha(meta.color, row.state === 'unsupported_claim' ? 0.5 : 0.3)}`,
                    bgcolor:
                      row.state === 'unsupported_claim'
                        ? alpha(COLORS.riskHigh, 0.05)
                        : row.state === 'capability_gap'
                          ? alpha(COLORS.bgHover, 0.5)
                          : 'transparent',
                    boxShadow: COLORS.cardShadow,
                  }}
                >
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
                    <Typography sx={{ fontSize: 11, fontFamily: COLORS.mono, color: meta.color, flexShrink: 0 }}>
                      {meta.icon}
                    </Typography>
                    <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0 }}>
                      {row.statement}
                    </Typography>
                    <Chip
                      size="small"
                      label={meta.label}
                      sx={{ height: 20, fontSize: 11, bgcolor: alpha(meta.color, 0.12), color: meta.color }}
                    />
                  </Stack>
                  <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                    {row.explanation}
                  </Typography>
                  {(row.evidenceRefs.length > 0 || row.claimRefs.length > 0) && (
                    <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mt: 0.5, lineHeight: 1.5 }}>
                      {row.evidenceRefs.length > 0 && `依据事实：${row.evidenceRefs.map(titleOf).join('、')}`}
                      {row.evidenceRefs.length > 0 && row.claimRefs.length > 0 ? ' · ' : ''}
                      {row.claimRefs.length > 0 && `${row.claimRefs.length} 条表达资产`}
                      {row.bulletRefs.length > 0 && ` · 简历表达：「${row.bulletRefs.join('；')}」`}
                    </Typography>
                  )}
                </Box>
              )
            })}
          </Stack>
        )
      )}
    </Box>
  )
}
