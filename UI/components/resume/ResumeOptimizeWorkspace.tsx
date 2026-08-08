/**
 * 优化空间（R2.2）：Resume Alignment Projection 消费视图——四态 Requirement Card。
 * 契约：docs/domain/resume-alignment-projection-v0.1.md（resumes/alignment RPC，纯投影不落盘）。
 * P2.4：输入从「版本 × JD」迁移为「工作副本 × JD」——优化检查当前创作对象（ADR-023 §6），
 * 非历史版本；诊断引擎不变（working-copies/alignment 复用 computeResumeAlignment）。
 * - 四态：已覆盖 / 表达缺口 / 证据不足声明（红线）/ 能力缺口
 * - R2.2 边界：只展示四态 + 可追溯引用；不做 AI 改写 / 提案创建（P3 Opportunity Loop）
 */
import { Box, Chip, MenuItem, Select, Stack, Typography, Button, CircularProgress } from '@mui/material'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import { alpha, COLORS } from '../../data/constants'
import type { AlignmentState, ResumeAlignmentProjection } from '../../../engine/runtime/resume-alignment.ts'
import type { Opportunity } from '../../../engine/runtime/opportunity.ts'

const STATE_META: Record<AlignmentState, { icon: string; label: string; color: string }> = {
  covered: { icon: '✓', label: '已覆盖', color: COLORS.riskLow },
  expressive_gap: { icon: '△', label: '表达缺口', color: COLORS.riskMedium },
  unsupported_claim: { icon: '⚠', label: '证据不足声明', color: COLORS.riskHigh },
  capability_gap: { icon: '○', label: '能力缺口', color: COLORS.textMuted },
}

/** P3.5 UI Contract：机会用户语言映射——不暴露内部治理字段（claim/evidence/state） */
const OPPORTUNITY_META: Record<string, { icon: string; tag: string; color: string }> = {
  'improve_value': { icon: '🔴', tag: '提升表达覆盖', color: COLORS.riskMedium },
  'reduce_risk': { icon: '🔴', tag: '可信度检查', color: COLORS.riskHigh },
  'activate_asset': { icon: '🟡', tag: '可利用经历', color: COLORS.riskLow },
}

/** 影响范围（applyTarget 用户语言——不显示 blockId 系统标识） */
const TARGET_TEXT: Record<string, string> = {
  insert: '新增一条表达',
  rewrite: '改写已有表达',
  delete: '处理已有表达',
}

export function ResumeOptimizeWorkspace() {
  const workingCopies = useAppStore((s) => s.workingCopies)
  const activeWorkingCopyId = useAppStore((s) => s.activeWorkingCopyId)
  const person = useAppStore((s) => s.currentPerson())
  const jobs = useAppStore((s) => s.jobs)
  const evidenceItems = useAppStore((s) => s.evidence)
  const engineStatus = useAppStore((s) => s.engineStatus)
  const fetchWorkingCopyAlignment = useAppStore((s) => s.fetchWorkingCopyAlignment)
  const fetchWorkingCopyOpportunities = useAppStore((s) => s.fetchWorkingCopyOpportunities)
  const generateOpportunityProposals = useAppStore((s) => s.generateOpportunityProposals)
  const [wcId, setWcId] = useState('')
  const [jobId, setJobId] = useState('')
  const [projection, setProjection] = useState<ResumeAlignmentProjection | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [opportunities, setOpportunities] = useState<Opportunity[] | null>(null)
  const [genState, setGenState] = useState<{ oppId: string; phase: string } | null>(null)
  const [genTick, setGenTick] = useState(0)

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

  /** 机会投影（P3.6：一等对象「为什么值得改」——选择变化/生成完成后重拉） */
  useEffect(() => {
    if (!wcId || !jobId || engineStatus !== 'connected') return
    let cancelled = false
    fetchWorkingCopyOpportunities(wcId, jobId)
      .then((ops) => {
        if (!cancelled) setOpportunities(ops)
      })
      .catch(() => {
        if (!cancelled) setOpportunities(null)
      })
    return () => {
      cancelled = true
    }
  }, [wcId, jobId, engineStatus, fetchWorkingCopyOpportunities, genTick])

  const titleOf = (eid: string) => evidenceItems.find((e) => e.id === eid)?.event.title ?? eid
  const selectedJob = jobs.find((j) => j.id === jobId)

  /** 机会卡片标题（P3.5：用户语言——不暴露 state 内部名） */
  const opportunityTitle = useCallback(
    (o: Opportunity): string => {
      if (o.intent === 'improve_value') {
        const stmt =
          o.anchor.kind === 'alignment'
            ? jobs.find((j) => j.id === o.anchor.jobId)?.responsibilities.find((r) => r.id === o.anchor.responsibilityId)?.statement
            : undefined
        return `提升「${stmt ?? '岗位要求'}」的表达覆盖`
      }
      if (o.intent === 'reduce_risk') return '这段经历缺少当前岗位方向的支撑依据'
      return '岗位相关的经历尚未形成表达资产'
    },
    [jobs],
  )

  const opportunityReason = useCallback(
    (o: Opportunity): string => {
      if (o.intent === 'reduce_risk') {
        const stmt =
          o.anchor.kind === 'alignment'
            ? jobs.find((j) => j.id === o.anchor.jobId)?.responsibilities.find((r) => r.id === o.anchor.responsibilityId)?.statement
            : undefined
        return `简历中有表达与「${stmt ?? '岗位要求'}」相关，但缺少当前岗位方向的支撑依据——建议补充证据或调整表达。`
      }
      if (o.intent === 'activate_asset') {
        return `已有 ${o.refs.evidenceIds.length} 条经历与岗位相关，但尚未成为可引用的表达资产。`
      }
      return `${o.refs.evidenceIds.length} 条相关经历已有，但当前简历未体现——可在不新增事实的前提下补齐表达。`
    },
    [jobs],
  )

  const generate = async (o: Opportunity) => {
    setGenState({ oppId: o.id, phase: '生成改写方案中…' })
    try {
      await generateOpportunityProposals(o.id, wcId, String(person.id))
      // 任务完成后轮询候选（agent 提交经引擎登记——以提案出现为完成信号）
      const deadline = Date.now() + 90_000
      const poll = async (): Promise<void> => {
        const proposals = await useAppStore.getState().listOpportunityProposals()
        if (proposals.some((p) => p.opportunityId === o.id)) {
          setGenState(null)
          setGenTick((t) => t + 1)
          return
        }
        if (Date.now() > deadline) {
          setGenState(null)
          return
        }
        setTimeout(() => void poll(), 2500)
      }
      void poll()
    } catch (e: unknown) {
      setGenState(null)
      setError(e instanceof Error ? e.message : '候选生成失败')
    }
  }

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

      {/* 发现机会（P3.6——契约 opportunity-ui-contract：系统发现「值得考虑的变化」，用户语言四段卡片） */}
      {wcId && jobId && (
        <Box sx={{ mt: 3 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 700 }}>发现机会</Typography>
            <Chip
              size="small"
              label={`${opportunities?.length ?? 0} 项值得考虑的变化`}
              sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.accent, 0.1), color: COLORS.accent }}
            />
          </Stack>
          {!opportunities || opportunities.length === 0 ? (
            <Box
              sx={{
                p: 2,
                borderRadius: '10px',
                border: `1px dashed ${alpha(COLORS.border, 0.9)}`,
                textAlign: 'center',
              }}
            >
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>当前工作副本与目标岗位无待处理变化</Typography>
            </Box>
          ) : (
            <Stack spacing={1}>
              {opportunities.map((o) => {
                const meta = OPPORTUNITY_META[o.intent] ?? { icon: '•', tag: o.intent, color: COLORS.textMuted }
                return (
                  <Box
                    key={o.id}
                    sx={{
                      p: 1.5,
                      borderRadius: '10px',
                      border: `1px solid ${alpha(meta.color, 0.3)}`,
                      bgcolor: 'transparent',
                      boxShadow: COLORS.cardShadow,
                    }}
                  >
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
                      <Typography sx={{ fontSize: 12, flexShrink: 0 }}>{meta.icon}</Typography>
                      <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0 }}>{opportunityTitle(o)}</Typography>
                      <Chip size="small" label={meta.tag} sx={{ height: 20, fontSize: 11, bgcolor: alpha(meta.color, 0.12), color: meta.color }} />
                    </Stack>
                    <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>{opportunityReason(o)}</Typography>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.75, flexWrap: 'wrap', gap: 0.5 }}>
                      <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                        影响：{o.applyTarget ? TARGET_TEXT[o.applyTarget.action] : '形成表达资产（走素材通道）'}
                      </Typography>
                      <Button
                        size="small"
                        disabled={genState?.oppId === o.id}
                        onClick={() => void generate(o)}
                        sx={{
                          ml: 'auto',
                          fontSize: 11.5,
                          textTransform: 'none',
                          color: COLORS.accent,
                          border: `1px solid ${alpha(COLORS.accent, 0.35)}`,
                          borderRadius: '8px',
                          px: 1.25,
                          py: 0.25,
                          '&:hover': { bgcolor: alpha(COLORS.accent, 0.08) },
                        }}
                      >
                        {genState?.oppId === o.id ? <CircularProgress size={12} sx={{ mr: 0.75 }} /> : null}
                        {genState?.oppId === o.id ? genState.phase : o.intent === 'activate_asset' ? '生成表达资产' : '生成改写方案'}
                      </Button>
                    </Stack>
                  </Box>
                )
              })}
            </Stack>
          )}
        </Box>
      )}
    </Box>
  )
}
