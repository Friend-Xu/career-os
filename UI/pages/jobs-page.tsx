/**
 * 岗位池（master-detail）：左侧岗位列表（按公司/方向分组过滤）+ 右侧岗位工作区。
 * - 浏览（发现）→ 列表；理解/操作（任务）→ 工作区；编辑 → 居中 Dialog（决策编辑）
 */
import { Box, Chip, Stack, Typography } from '@mui/material'
import WorkIcon from '@mui/icons-material/Work'
import { useEffect, useMemo } from 'react'
import { useAppStore } from '../store/app-store'
import { alpha, COLORS } from '../data/constants'
import { JobWorkspace } from '../components/job-workspace'

export function JobsPage() {
  const jobs = useAppStore((s) => s.jobs)
  const applications = useAppStore((s) => s.applications)
  const selectedJobId = useAppStore((s) => s.selectedJobId)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)

  // 选中：优先 selectedJobId；否则第一项
  const selected = jobs.find((j) => j.id === selectedJobId) ?? jobs[0]

  // 分组（按公司）展示用
  const byCompany = useMemo(() => {
    const map = new Map<string, typeof jobs>()
    for (const j of jobs) {
      const list = map.get(j.company)
      if (list) list.push(j)
      else map.set(j.company, [j])
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))
  }, [jobs])

  useEffect(() => {
    if (selectedJobId && !jobs.some((j) => j.id === selectedJobId)) {
      setSelectedJobId(null)
    }
  }, [jobs, selectedJobId, setSelectedJobId])

  return (
    <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
      {/* Master：岗位列表 */}
      <Box
        sx={{
          width: 280,
          minWidth: 280,
          borderRight: `1px solid ${COLORS.border}`,
          overflow: 'auto',
          p: 1.25,
        }}
      >
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', px: 0.5, mb: 1 }}>
          <WorkIcon sx={{ fontSize: 14, color: COLORS.textMuted }} />
          <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1 }}>岗位池</Typography>
          <Typography sx={{ fontSize: 12, fontFamily: 'var(--cos-mono, monospace)', color: COLORS.textMuted }}>
            {jobs.length}
          </Typography>
        </Stack>
        {jobs.length === 0 ? (
          <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted, px: 0.5, py: 2, textAlign: 'center' }}>
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
                const active = selected?.id === j.id
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

      {/* Detail：岗位工作区 */}
      <Box sx={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        {selected ? (
          <JobWorkspace key={selected.id} jobId={selected.id} />
        ) : (
          <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
            <Typography sx={{ fontSize: 13, color: COLORS.textMuted }}>选择左侧岗位查看工作区</Typography>
          </Box>
        )}
      </Box>
    </Box>
  )
}
