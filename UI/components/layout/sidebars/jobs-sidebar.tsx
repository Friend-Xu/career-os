/**
 * JD 空间侧栏：JD 池列表（按公司分组 + 投递状态 chip）。
 * 点击行 → JD 工作区（selectedJobId）。hover 行尾删除按钮（确认后删 JD 文件，引擎广播重拉）。
 */
import { Box, Chip, IconButton, Stack, Typography } from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import WorkIcon from '@mui/icons-material/Work'
import { useMemo } from 'react'
import { useAppStore } from '../../../store/app-store'
import { useToastStore } from '../../../store/toast-store'
import { alpha, COLORS } from '../../../data/constants'

export function JobsSidebar() {
  const jobs = useAppStore((s) => s.jobs)
  const applications = useAppStore((s) => s.applications)
  const selectedJobId = useAppStore((s) => s.selectedJobId)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)
  const deleteJob = useAppStore((s) => s.deleteJob)
  const push = useToastStore((s) => s.push)

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
      <Box sx={{ flex: 1, overflow: 'auto', px: 1.25 }}>
        {jobs.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, px: 1, py: 2, textAlign: 'center' }}>
            暂无 JD
            <br />
            主区「增加 JD」粘贴招聘要求建档
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
                      {[j.location, j.salary, j.requirements.length > 0 ? `${j.requirements.length} 项要求` : null]
                        .filter(Boolean)
                        .join(' · ')}
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
