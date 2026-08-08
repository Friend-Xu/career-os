/**
 * 优化空间（R2.2）：Resume Alignment Projection 消费视图——四态 Requirement Card。
 * 契约：docs/domain/resume-alignment-projection-v0.1.md（resumes/alignment RPC，纯投影不落盘）。
 * P2.4：输入从「版本 × JD」迁移为「工作副本 × JD」——优化检查当前创作对象（ADR-023 §6），
 * 非历史版本；诊断引擎不变（working-copies/alignment 复用 computeResumeAlignment）。
 * - 四态：已覆盖 / 表达缺口 / 证据不足声明（红线）/ 能力缺口
 * - R2.2 边界：只展示四态 + 可追溯引用；不做 AI 改写 / 提案创建（P3 Opportunity Loop）
 */
import { Box, Chip, MenuItem, Select, Stack, Typography } from '@mui/material'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import { alpha, COLORS } from '../../data/constants'
import type { AlignmentState, ResumeAlignmentProjection } from '../../../engine/runtime/resume-alignment.ts'

const STATE_META: Record<AlignmentState, { icon: string; label: string; color: string }> = {
  covered: { icon: '✓', label: '已覆盖', color: COLORS.riskLow },
  expressive_gap: { icon: '△', label: '表达缺口', color: COLORS.riskMedium },
  unsupported_claim: { icon: '⚠', label: '证据不足声明', color: COLORS.riskHigh },
  capability_gap: { icon: '○', label: '能力缺口', color: COLORS.textMuted },
}

export function ResumeOptimizeWorkspace() {
  const workingCopies = useAppStore((s) => s.workingCopies)
  const activeWorkingCopyId = useAppStore((s) => s.activeWorkingCopyId)
  const person = useAppStore((s) => s.currentPerson())
  const jobs = useAppStore((s) => s.jobs)
  const evidenceItems = useAppStore((s) => s.evidence)
  const engineStatus = useAppStore((s) => s.engineStatus)
  const fetchWorkingCopyAlignment = useAppStore((s) => s.fetchWorkingCopyAlignment)
  const [wcId, setWcId] = useState('')
  const [jobId, setJobId] = useState('')
  const [projection, setProjection] = useState<ResumeAlignmentProjection | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const personWorkingCopies = workingCopies.filter((w) => w.owner === String(person.id))
  const wc = personWorkingCopies.find((w) => w.id === wcId) ?? personWorkingCopies.find((w) => w.id === activeWorkingCopyId)

  useEffect(() => {
    if (!wcId || !jobId || engineStatus !== 'connected') return
    let cancelled = false
    setLoading(true)
    setError('')
    fetchWorkingCopyAlignment(wcId, jobId)
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
  }, [wcId, jobId, engineStatus, fetchWorkingCopyAlignment])

  const titleOf = (eid: string) => evidenceItems.find((e) => e.id === eid)?.event.title ?? eid
  const selectedJob = jobs.find((j) => j.id === jobId)

  return (
    <Box sx={{ p: 2, maxWidth: 860, mx: 'auto' }}>
      {/* 选择区：工作副本 × 目标 JD（P2.4——优化检查当前创作对象，非历史版本） */}
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
            value={wcId}
            onChange={(e) => {
              setWcId(e.target.value as string)
              setProjection(null)
            }}
            sx={{ minWidth: 190, '& .MuiSelect-select': { fontSize: 12.5, py: 0.75 } }}
          >
            <MenuItem value="" disabled>
              选择工作副本
            </MenuItem>
            {personWorkingCopies.map((w) => (
              <MenuItem key={w.id} value={w.id} sx={{ fontSize: 12.5 }}>
                {w.id.slice(-10)} · {w.status === 'promoted' ? '已发布' : '编辑中'}
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
        {wc && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>当前分析对象：</Typography>
            <Chip
              size="small"
              label={`${wc.id.slice(-10)} · 更新 ${wc.updatedAt.slice(5, 16).replace('T', ' ')}`}
              sx={{ height: 20, fontSize: 11, bgcolor: alpha(COLORS.accent, 0.1), color: COLORS.accent }}
            />
            {selectedJob && (
              <Chip size="small" label={`目标岗位 ${selectedJob.company} · ${selectedJob.title}`} sx={{ height: 20, fontSize: 11, bgcolor: COLORS.bgHover, color: COLORS.textSecondary }} />
            )}
            <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>诊断基于当前编辑内容（未资产化内容不参与证据投影）</Typography>
          </Stack>
        )}
      </Box>

      {/* 引导态：未选择 */}
      {!wcId || !jobId ? (
        <Box
          sx={{
            p: 3,
            borderRadius: '10px',
            border: `1px dashed ${alpha(COLORS.border, 0.9)}`,
            textAlign: 'center',
          }}
        >
          <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, mb: 0.5 }}>
            选择工作副本与目标岗位，查看岗位要求覆盖情况
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
