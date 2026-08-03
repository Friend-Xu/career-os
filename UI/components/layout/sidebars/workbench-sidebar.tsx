/**
 * 工作台空间侧栏：驾驶舱内部导航（Dashboard / 方向 / 城市 / 决策记录）——
 * 与系统设置同构：侧栏选子项，主区切换对应视图界面（非弹窗）。
 */
import { Stack, Typography } from '@mui/material'
import DashboardIcon from '@mui/icons-material/Dashboard'
import ExploreIcon from '@mui/icons-material/Explore'
import LocationCityIcon from '@mui/icons-material/LocationCity'
import HistoryIcon from '@mui/icons-material/History'
import type { ReactNode } from 'react'
import { COLORS } from '../../../data/constants'
import { useAppStore } from '../../../store/app-store'

const VIEWS: { id: 'dashboard' | 'directions' | 'cities' | 'decisions'; label: string; icon: ReactNode }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <DashboardIcon sx={{ fontSize: 15 }} /> },
  { id: 'directions', label: '方向', icon: <ExploreIcon sx={{ fontSize: 15 }} /> },
  { id: 'cities', label: '城市', icon: <LocationCityIcon sx={{ fontSize: 15 }} /> },
  { id: 'decisions', label: '决策记录', icon: <HistoryIcon sx={{ fontSize: 15 }} /> },
]

export function WorkbenchSidebar() {
  const view = useAppStore((s) => s.workbenchView)
  const setView = useAppStore((s) => s.setWorkbenchView)

  return (
    <Stack spacing={0.25} sx={{ p: 1.25 }}>
      <Typography
        sx={{
          fontSize: 11,
          fontWeight: 600,
          color: COLORS.textMuted,
          letterSpacing: '0.05em',
          px: 1,
          mb: 0.5,
        }}
      >
        工作台
      </Typography>
      {VIEWS.map((v) => {
        const active = view === v.id
        return (
          <Stack
            key={v.id}
            direction="row"
            spacing={1}
            onClick={() => setView(v.id)}
            sx={{
              alignItems: 'center',
              px: 1,
              py: 0.75,
              borderRadius: '6px',
              cursor: 'pointer',
              bgcolor: active ? COLORS.accentMuted : 'transparent',
              color: active ? COLORS.accent : COLORS.text,
              '&:hover': { bgcolor: active ? COLORS.accentMuted : COLORS.bgHover },
            }}
          >
            {v.icon}
            <Typography sx={{ fontSize: 13, fontWeight: active ? 600 : 400 }}>{v.label}</Typography>
          </Stack>
        )
      })}
    </Stack>
  )
}
