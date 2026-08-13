/**
 * JD 空间侧栏：JD 池列表（按公司分组 + 投递状态 chip + 岗位匹配度）。
 * 匹配度 = 引擎规则合成投影（jd-match-score-contract-v0.1：能力覆盖 + 门槛四态，85 分制披露）。
 * 点击行 → JD 工作区（selectedJobId）。hover 行尾删除按钮（确认后删 JD 文件，引擎广播重拉）。
 */
import { Box, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import WorkIcon from '@mui/icons-material/Work'
import { useEffect, useMemo } from 'react'
import { useAppStore } from '../../../store/app-store'
import { useToastStore } from '../../../store/toast-store'
import { alpha, COLORS, RISK_COLOR } from '../../../data/constants'
import type { JDMatchScore } from '../../../../engine/runtime/jd-match-score.ts'

const DIM_CN: Record<string, string> = { education: '学历', major: '专业', experience: '经验' }

/** 匹配度 tooltip（可解释依据——能力名单/门槛行/未纳入维度；不显示裸分） */
function matchTooltip(s: JDMatchScore): string {
  const lines: string[] = []
  if (s.status === 'HARD_GATE_FAILED') {
    const veto = s.dimensions.gate.detail.rows.find((r) => r.status === 'NOT_MATCHED')
    lines.push(veto ? `硬门槛不满足：${DIM_CN[veto.dim] ?? veto.dim}要求「${veto.requirement}」，你的情况「${veto.person}」` : '硬门槛不满足')
  } else if (s.status === 'PARTIAL') {
    lines.push('岗位未完成分析——暂无能力覆盖数据')
  } else {
    const cap = s.dimensions.capability
    const gate = s.dimensions.gate
    lines.push(
      `能力覆盖 ${cap.score}/5：声明 ${cap.detail.satisfied.length} · 有基础 ${cap.detail.transferable.length} · 缺口 ${cap.detail.missing.length}${cap.detail.mustMissing.length > 0 ? `（核心缺口 ${cap.detail.mustMissing.length}）` : ''}`,
      gate.score !== null
        ? `门槛 ${gate.score}/5：${gate.detail.rows
            .filter((r) => r.status !== 'NOT_DECLARED')
            .map((r) => `${DIM_CN[r.dim] ?? r.dim} ${r.status === 'MATCHED' ? '✓' : '待确认'}`)
            .join(' · ')}`
        : '岗位未要求门槛',
      '差异化优势维度未纳入（转行场景激活的 AI 判断维度）',
    )
  }
  if (s.city?.conflict) lines.push(`⚠ 城市意向冲突：意向 ${s.city.preferred} · 岗位 ${s.city.jobLocation}（提示不否决——是否接受由你判断）`)
  return lines.join('\n')
}

export function JobsSidebar() {
  const jobs = useAppStore((s) => s.jobs)
  const applications = useAppStore((s) => s.applications)
  const decisions = useAppStore((s) => s.decisions)
  const person = useAppStore((s) => s.currentPerson())
  const jobMatchScores = useAppStore((s) => s.jobMatchScores)
  const fetchJobMatchScore = useAppStore((s) => s.fetchJobMatchScore)
  const selectedJobId = useAppStore((s) => s.selectedJobId)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)
  const setJdAddOpen = useAppStore((s) => s.setJdAddOpen)
  const deleteJob = useAppStore((s) => s.deleteJob)
  const push = useToastStore((s) => s.push)

  // 匹配度拉取：JD 池全量（个人工具量级小）；decisions 变化 = JD 分析落盘信号（capabilities 随之更新 → 重算）
  useEffect(() => {
    if (!person.personId) return
    for (const j of jobs) void fetchJobMatchScore(j.id, person.personId)
  }, [jobs, person.personId, decisions, fetchJobMatchScore])

  const byCompany = useMemo(() => {
    const map = new Map<string, typeof jobs>()
    for (const j of jobs) {
      const list = map.get(j.company)
      if (list) list.push(j)
      else map.set(j.company, [j])
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))
  }, [jobs])

  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', px: 1.25, py: 0.75 }}>
        <WorkIcon sx={{ fontSize: 14, color: COLORS.textMuted }} />
        <Typography
          sx={{
            fontSize: 11,
            fontWeight: 600,
            color: COLORS.textMuted,
            letterSpacing: '0.05em',
            flex: 1,
          }}
        >
          JD 池
        </Typography>
        <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.textMuted }}>
          {jobs.length}
        </Typography>
      </Stack>
      {/* 新增入口：虚线卡片（区别于 JD 实体卡片实线边框 + 白底） */}
      <Box sx={{ px: 1.25, pb: 0.75 }}>
        <Stack
          direction="row"
          spacing={0.75}
          onClick={() => setJdAddOpen(true)}
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
          <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>新增 JD</Typography>
        </Stack>
      </Box>
      <Box sx={{ flex: 1, overflow: 'auto', px: 1.25 }}>
        {jobs.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, px: 1, py: 2, textAlign: 'center' }}>
            暂无 JD
            <br />
            上方「新增 JD」粘贴招聘要求建档
          </Typography>
        ) : (
          byCompany.map(([company, list]) => (
            <Box key={company} sx={{ mb: 1 }}>
              <Typography sx={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, px: 0.5, mb: 0.25 }}>
                {company} · {list.length}
              </Typography>
              {list.map((j) => {
                const active = selectedJobId === j.id
                const app = applications.find((a) => a.jobId === j.id)
                const ms = jobMatchScores[j.id]
                return (
                  <Stack
                    key={j.id}
                    onClick={() => setSelectedJobId(j.id)}
                    sx={{
                      mb: 0.5,
                      px: 1.25,
                      py: 1,
                      borderRadius: '8px',
                      cursor: 'pointer',
                      border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
                      bgcolor: active ? COLORS.accentMuted : COLORS.bg,
                      '&:hover': { bgcolor: active ? COLORS.accentMuted : COLORS.bgHover },
                      '&:hover .card-delete': { opacity: 1 },
                    }}
                  >
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                      <Typography
                        sx={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: active ? COLORS.accent : COLORS.text,
                          flex: 1,
                          minWidth: 0,
                        }}
                        noWrap
                      >
                        {j.title}
                      </Typography>
                      {app && (
                        <Chip
                          size="small"
                          label={app.status}
                          sx={{
                            height: 16,
                            fontSize: 10.5,
                            bgcolor: alpha(COLORS.accent, 0.1),
                            color: COLORS.accent,
                            flexShrink: 0,
                          }}
                        />
                      )}
                      <Box className="card-delete" sx={{ opacity: 0, flexShrink: 0 }}>
                        <IconButton
                          size="small"
                          title="删除 JD"
                          onClick={(e) => {
                            e.stopPropagation()
                            const apps = applications.filter((a) => a.jobId === j.id).length
                            const link = [`投递 ${apps}`].filter((x) => !x.includes(' 0')).join(' · ')
                            const hint = link
                              ? `关联：${link}——删除后投递记录保留但显示「未挂 JD」，决策/简历版本不受影响。`
                              : '决策/投递/简历版本不受影响。'
                            if (!window.confirm(`删除 JD「${j.company} · ${j.title}」？不可恢复。${hint}`)) return
                            void deleteJob(j.id).then(
                              () => push('info', `已删除 JD：${j.company} · ${j.title}`),
                              (err) => push('warning', `删除失败：${err instanceof Error ? err.message : String(err)}`),
                            )
                          }}
                          sx={{ p: 0.25 }}
                        >
                          <DeleteIcon sx={{ fontSize: 13, color: COLORS.textMuted }} />
                        </IconButton>
                      </Box>
                    </Stack>
                    <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }} noWrap>
                      {j.company}
                    </Typography>
                    <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                      {[j.location, j.salary, j.responsibilities.length > 0 ? `${j.responsibilities.length} 项要求` : null]
                        .filter(Boolean)
                        .join(' · ')}
                      {ms && (
                        <>
                          {' · '}
                          <Tooltip title={<Typography sx={{ fontSize: 11, lineHeight: 1.7, whiteSpace: 'pre-line' }}>{matchTooltip(ms)}</Typography>}>
                            <Box
                              component="span"
                              sx={{
                                fontFamily: COLORS.mono,
                                fontWeight: 600,
                                cursor: 'help',
                                color: ms.status === 'EVALUATED' ? COLORS.accent : ms.status === 'HARD_GATE_FAILED' ? RISK_COLOR.high : COLORS.textMuted,
                              }}
                            >
                              {ms.status === 'EVALUATED'
                                ? `匹配度 ${ms.score} / ${ms.maxScore}${ms.verdict ? ` · ${ms.verdict}` : ''}`
                                : ms.status === 'HARD_GATE_FAILED'
                                  ? '硬门槛不满足'
                                  : '待分析'}
                              {ms.city?.conflict && (
                                <Box component="span" sx={{ color: RISK_COLOR.medium, fontWeight: 700 }} title="城市意向冲突（提示不否决）">
                                  {' ⚠'}
                                </Box>
                              )}
                            </Box>
                          </Tooltip>
                        </>
                      )}
                    </Typography>
                  </Stack>
                )
              })}
            </Box>
          ))
        )}
      </Box>
    </Stack>
  )
}
