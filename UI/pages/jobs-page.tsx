/**
 * 岗位空间主区：岗位工作区（详情/操作）。
 * 岗位池列表在侧栏（JobsSidebar）——导航 → 列表 → 详情三层分工。
 */
import { Box, Typography } from '@mui/material'
import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'
import { COLORS } from '../data/constants'
import { JobWorkspace } from '../components/job-workspace'

export function JobsPage() {
  const jobs = useAppStore((s) => s.jobs)
  const selectedJobId = useAppStore((s) => s.selectedJobId)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)

  // 选中：优先 selectedJobId；否则第一项
  const selected = jobs.find((j) => j.id === selectedJobId) ?? jobs[0]

  useEffect(() => {
    if (selectedJobId && !jobs.some((j) => j.id === selectedJobId)) {
      setSelectedJobId(null)
    }
  }, [jobs, selectedJobId, setSelectedJobId])

  return (
    <Box sx={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
      {selected ? (
        <JobWorkspace key={selected.id} jobId={selected.id} />
      ) : (
        <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
          <Typography sx={{ fontSize: 13, color: COLORS.textMuted }}>
            暂无岗位——投递管理新增投递时粘贴 JD，自动建档
          </Typography>
        </Box>
      )}
    </Box>
  )
}
