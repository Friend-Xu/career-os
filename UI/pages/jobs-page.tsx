/**
 * JD 空间主区：JD 工作区（详情/操作）。
 * JD 池列表在侧栏（JobsSidebar）——导航 → 列表 → 详情三层分工；
 * 「增加 JD」是建档入口（粘贴 JD → 引擎建 Job 实体）。
 */
import { Box, Stack, Typography } from '@mui/material'
import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'
import { COLORS } from '../data/constants'
import { JobWorkspace } from '../components/job-workspace'
import { AddJdDialog } from '../components/add-jd-dialog'

export function JobsPage() {
  const jobs = useAppStore((s) => s.jobs)
  const selectedJobId = useAppStore((s) => s.selectedJobId)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)
  const jdAddOpen = useAppStore((s) => s.jdAddOpen)
  const setJdAddOpen = useAppStore((s) => s.setJdAddOpen)

  // 选中：优先 selectedJobId；否则第一项
  const selected = jobs.find((j) => j.id === selectedJobId) ?? jobs[0]

  useEffect(() => {
    if (selectedJobId && !jobs.some((j) => j.id === selectedJobId)) {
      setSelectedJobId(null)
    }
  }, [jobs, selectedJobId, setSelectedJobId])

  return (
    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 2, py: 1.25, borderBottom: `1px solid ${COLORS.border}` }}>
        <Typography sx={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em', flex: 1 }}>
          JD 工作区
        </Typography>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {selected ? (
          <JobWorkspace key={selected.id} jobId={selected.id} />
        ) : (
          <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
            <Stack spacing={1.5} sx={{ alignItems: 'center', textAlign: 'center', maxWidth: 320 }}>
              <Typography sx={{ fontSize: 14, fontWeight: 600 }}>JD 池还是空的</Typography>
              <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted, lineHeight: 1.7 }}>
                从侧栏「新增 JD」粘贴招聘要求建档，
                <br />
                之后就能分析匹配、尽调公司、发起投递
              </Typography>
            </Stack>
          </Box>
        )}
      </Box>

      <AddJdDialog open={jdAddOpen} onClose={() => setJdAddOpen(false)} />
    </Box>
  )
}
