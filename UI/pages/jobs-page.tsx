/**
 * JD 空间主区：JD 工作区（详情/操作）。
 * JD 池列表在侧栏（JobsSidebar）——导航 → 列表 → 详情三层分工；
 * 「增加 JD」是建档入口（粘贴 JD → 引擎建 Job 实体）。
 */
import { Box, Button, Stack, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { COLORS } from '../data/constants'
import { JobWorkspace } from '../components/job-workspace'
import { AddJdDialog } from '../components/add-jd-dialog'

export function JobsPage() {
  const jobs = useAppStore((s) => s.jobs)
  const selectedJobId = useAppStore((s) => s.selectedJobId)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)
  const [addOpen, setAddOpen] = useState(false)

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
        <Button
          size="small"
          variant="contained"
          startIcon={<AddIcon sx={{ fontSize: 15 }} />}
          onClick={() => setAddOpen(true)}
          sx={{ fontSize: 12.5, bgcolor: COLORS.accent, color: COLORS.onAccent, '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 } }}
        >
          增加 JD
        </Button>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {selected ? (
          <JobWorkspace key={selected.id} jobId={selected.id} />
        ) : (
          <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
            <Stack spacing={1.5} sx={{ alignItems: 'center', textAlign: 'center', maxWidth: 320 }}>
              <Typography sx={{ fontSize: 14, fontWeight: 600 }}>JD 池还是空的</Typography>
              <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted, lineHeight: 1.7 }}>
                从「增加 JD」粘贴招聘要求建档，
                <br />
                之后就能分析匹配、尽调公司、发起投递
              </Typography>
              <Button
                size="small"
                variant="contained"
                startIcon={<AddIcon sx={{ fontSize: 15 }} />}
                onClick={() => setAddOpen(true)}
                sx={{ fontSize: 12.5, bgcolor: COLORS.accent, color: COLORS.onAccent, '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 } }}
              >
                增加 JD
              </Button>
            </Stack>
          </Box>
        )}
      </Box>

      <AddJdDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </Box>
  )
}
