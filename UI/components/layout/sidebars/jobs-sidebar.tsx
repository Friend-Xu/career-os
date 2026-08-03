/**
 * 岗位空间侧栏：岗位池列表（按公司分组 + 投递状态 chip）。
 * 点击行 → 岗位工作区（selectedJobId）。
 */
import { Box, Chip, Stack, Typography } from '@mui/material'
import WorkIcon from '@mui/icons-material/Work'
import { useMemo } from 'react'
import { useAppStore } from '../../../store/app-store'
import { alpha, COLORS } from '../../../data/constants'

export function JobsSidebar() {
  const jobs = useAppStore((s) => s.jobs)
  const applications = useAppStore((s) => s.applications)
  const selectedJobId = useAppStore((s) => s.selectedJobId)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)

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
          岗位池
        </Typography>
        <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.textMuted }}>
          {jobs.length}
        </Typography>
      </Stack>
      <Box sx={{ flex: 1, overflow: 'auto', px: 1.25 }}>
        {jobs.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, px: 1, py: 2, textAlign: 'center' }}>
            暂无岗位
            <br />
            投递管理 → 新增投递时粘贴 JD
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
                    direction="row"
                    spacing={0.75}
                    onClick={() => setSelectedJobId(j.id)}
                    sx={{
                      alignItems: 'center',
                      px: 1,
                      py: 0.6,
                      borderRadius: '6px',
                      cursor: 'pointer',
                      bgcolor: active ? COLORS.accentMuted : 'transparent',
                      '&:hover': { bgcolor: active ? COLORS.accentMuted : COLORS.bgHover },
                    }}
                  >
                    <Typography
                      sx={{
                        fontSize: 12.5,
                        fontWeight: active ? 600 : 400,
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
