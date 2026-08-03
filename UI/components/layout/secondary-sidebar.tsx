/**
 * 侧栏（Finder 式固定导航）：领域导航 + 决策记录库入口——所有页面统一，不随当前页变化。
 * - 领域：Dashboard / 方向 / 城市 / 公司 / 岗位 / 投递 / 面试 / 决策记录
 * - 点击领域 → 对应空间页；方向/城市/决策记录 → 方向视图（决策记录库）
 * - 各页过滤（公司城市/投递状态/图谱节点）已移入页面内；会话历史在 Agent 页内
 */
import { Box, Stack, Typography } from '@mui/material'
import DashboardIcon from '@mui/icons-material/Dashboard'
import ExploreIcon from '@mui/icons-material/Explore'
import LocationCityIcon from '@mui/icons-material/LocationCity'
import BusinessIcon from '@mui/icons-material/Business'
import WorkIcon from '@mui/icons-material/Work'
import OutboxIcon from '@mui/icons-material/Outbox'
import MicIcon from '@mui/icons-material/Mic'
import HistoryIcon from '@mui/icons-material/History'
import { useState, type ReactNode } from 'react'
import { useAppStore } from '../../store/app-store'
import { COLORS, LAYOUT } from '../../data/constants'
import { DirectionViewDialog } from '../direction-view-dialog'

interface NavItem {
  id: string
  label: string
  icon: ReactNode
  page?: string
  /** 非页面导航（打开视图） */
  view?: 'directions'
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <DashboardIcon sx={{ fontSize: 16 }} />, page: 'workbench' },
  { id: 'directions', label: '方向', icon: <ExploreIcon sx={{ fontSize: 16 }} />, view: 'directions' },
  { id: 'cities', label: '城市', icon: <LocationCityIcon sx={{ fontSize: 16 }} />, view: 'directions' },
  { id: 'companies', label: '公司', icon: <BusinessIcon sx={{ fontSize: 16 }} />, page: 'companies' },
  { id: 'jobs', label: '岗位', icon: <WorkIcon sx={{ fontSize: 16 }} />, page: 'jobs' },
  { id: 'applications', label: '投递', icon: <OutboxIcon sx={{ fontSize: 16 }} />, page: 'applications' },
  { id: 'interviews', label: '面试', icon: <MicIcon sx={{ fontSize: 16 }} />, page: 'applications' },
  { id: 'decisions', label: '决策记录', icon: <HistoryIcon sx={{ fontSize: 16 }} />, view: 'directions' },
]

export function SecondarySidebar() {
  const setPage = useAppStore((s) => s.setPage)
  const currentPage = useAppStore((s) => s.currentPage)
  const [dirViewOpen, setDirViewOpen] = useState(false)

  const activate = (item: NavItem): void => {
    if (item.view === 'directions') setDirViewOpen(true)
    else if (item.page) setPage(item.page as never)
  }

  const isActive = (item: NavItem): boolean => {
    if (item.view) return false
    return currentPage === item.page
  }

  return (
    <Box
      sx={{
        width: LAYOUT.secondaryDefault,
        minWidth: LAYOUT.secondaryDefault,
        borderRight: `1px solid ${COLORS.border}`,
        bgcolor: COLORS.bgElevated,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
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
          空间
        </Typography>
        {NAV_ITEMS.slice(0, 7).map((item) => (
          <Stack
            key={item.id}
            direction="row"
            spacing={1}
            onClick={() => activate(item)}
            sx={{
              alignItems: 'center',
              px: 1,
              py: 0.75,
              borderRadius: '6px',
              cursor: 'pointer',
              bgcolor: isActive(item) ? COLORS.accentMuted : 'transparent',
              color: isActive(item) ? COLORS.accent : COLORS.text,
              '&:hover': { bgcolor: isActive(item) ? COLORS.accentMuted : COLORS.bgHover },
            }}
          >
            {item.icon}
            <Typography sx={{ fontSize: 13, fontWeight: isActive(item) ? 600 : 400 }}>
              {item.label}
            </Typography>
          </Stack>
        ))}
        <Typography
          sx={{
            fontSize: 11,
            fontWeight: 600,
            color: COLORS.textMuted,
            letterSpacing: '0.05em',
            px: 1,
            mb: 0.5,
            mt: 1.5,
          }}
        >
          记录
        </Typography>
        <Stack
          direction="row"
          spacing={1}
          onClick={() => activate(NAV_ITEMS[7])}
          sx={{
            alignItems: 'center',
            px: 1,
            py: 0.75,
            borderRadius: '6px',
            cursor: 'pointer',
            '&:hover': { bgcolor: COLORS.bgHover },
          }}
        >
          {NAV_ITEMS[7].icon}
          <Typography sx={{ fontSize: 13 }}>{NAV_ITEMS[7].label}</Typography>
        </Stack>
      </Stack>

      <DirectionViewDialog open={dirViewOpen} onClose={() => setDirViewOpen(false)} />
    </Box>
  )
}
