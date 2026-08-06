/**
 * 工作台空间侧栏：驾驶舱内部导航（Dashboard / 职业画像 / 方向 / 城市 / 决策记录）——
 * 与系统设置同构：侧栏选子项，主区切换对应视图界面（非弹窗）。
 */
import { Box, Stack, Typography } from '@mui/material'
import DashboardIcon from '@mui/icons-material/Dashboard'
import Person2OutlinedIcon from '@mui/icons-material/Person2Outlined'
import ExploreIcon from '@mui/icons-material/Explore'
import LocationCityIcon from '@mui/icons-material/LocationCity'
import HistoryIcon from '@mui/icons-material/History'
import type { ReactNode } from 'react'
import { COLORS } from '../../../data/constants'
import { useAppStore } from '../../../store/app-store'

const VIEWS: { id: 'dashboard' | 'directions' | 'cities' | 'decisions' | 'profile'; label: string; desc: string; icon: ReactNode }[] = [
  { id: 'dashboard', label: 'Dashboard', desc: '驾驶舱总览', icon: <DashboardIcon sx={{ fontSize: 15 }} /> },
  { id: 'profile', label: '职业画像', desc: '系统对你的理解状态', icon: <Person2OutlinedIcon sx={{ fontSize: 15 }} /> },
  { id: 'directions', label: '方向', desc: '按方向聚合的决策时间线', icon: <ExploreIcon sx={{ fontSize: 15 }} /> },
  { id: 'cities', label: '城市', desc: '城市评估与对比', icon: <LocationCityIcon sx={{ fontSize: 15 }} /> },
  { id: 'decisions', label: '决策记录', desc: '全部决策历史', icon: <HistoryIcon sx={{ fontSize: 15 }} /> },
]

export function WorkbenchSidebar() {
  const view = useAppStore((s) => s.workbenchView)
  const setView = useAppStore((s) => s.setWorkbenchView)

  return (
    <Stack sx={{ p: 1.25 }}>
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
            onClick={() => setView(v.id)}
            sx={{
              mb: 0.5,
              px: 1.25,
              py: 1,
              borderRadius: '8px',
              cursor: 'pointer',
              border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
              bgcolor: active ? COLORS.accentMuted : COLORS.bg,
              '&:hover': { bgcolor: active ? COLORS.accentMuted : COLORS.bgHover },
            }}
          >
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
              <Box sx={{ display: 'flex', color: active ? COLORS.accent : COLORS.textMuted }}>{v.icon}</Box>
              <Typography sx={{ fontSize: 12.5, fontWeight: active ? 600 : 500, color: active ? COLORS.accent : COLORS.text }}>
                {v.label}
              </Typography>
            </Stack>
            <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>{v.desc}</Typography>
          </Stack>
        )
      })}
    </Stack>
  )
}
