import {
  Box,
  Button,
  Chip,
  Menu,
  MenuItem,
  Stack,
  Typography,
  Tooltip,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import CircleIcon from '@mui/icons-material/Circle'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import { useState, type MouseEvent } from 'react'
import { useAppStore } from '../../store/app-store'
import { ROLES, STAGES } from '../../data/mock-data'
import { alpha, COLORS, LAYOUT } from '../../data/constants'
import { ThemeToggle } from './theme-toggle'

export function TopBar() {
  const currentRole = useAppStore((s) => s.currentRole())
  const setRole = useAppStore((s) => s.setRole)
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen)
  const [anchor, setAnchor] = useState<null | HTMLElement>(null)

  const completed = STAGES.filter((s) => s.status === 'completed').length
  const total = STAGES.length
  const currentStage = STAGES.find((s) => s.status === 'current')

  const openRoleMenu = (e: MouseEvent<HTMLElement>) => setAnchor(e.currentTarget)
  const closeRoleMenu = () => setAnchor(null)

  return (
    <Box
      component="header"
      sx={{
        height: LAYOUT.topBar,
        minHeight: LAYOUT.topBar,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 2,
        borderBottom: `1px solid ${COLORS.border}`,
        bgcolor: alpha(COLORS.bg, 0.78),
        backdropFilter: 'blur(14px) saturate(160%)',
        WebkitBackdropFilter: 'blur(14px) saturate(160%)',
        zIndex: 20,
      }}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minWidth: 140 }}>
        <Box
          sx={{
            width: 28,
            height: 28,
            borderRadius: '8px',
            background: `linear-gradient(135deg, ${COLORS.accent} 0%, #59C2FF 100%)`,
            display: 'grid',
            placeItems: 'center',
            fontSize: 14,
            fontWeight: 700,
            color: '#fff',
          }}
        >
          C
        </Box>
        <Box>
          <Typography sx={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.01em' }}>
            Career OS
          </Typography>
          <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, lineHeight: 1.2 }}>
            本地版 v2.0
          </Typography>
        </Box>
      </Stack>

      <Button
        onClick={openRoleMenu}
        endIcon={<KeyboardArrowDownIcon sx={{ fontSize: 16 }} />}
        sx={{
          color: COLORS.text,
          bgcolor: COLORS.bgHover,
          border: `1px solid ${COLORS.border}`,
          px: 1.5,
          gap: 0.5,
          '&:hover': { bgcolor: COLORS.bgActive, borderColor: COLORS.borderStrong },
        }}
      >
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: currentRole.color,
            mr: 0.5,
          }}
        />
        <Typography sx={{ fontSize: 12.5, fontWeight: 500 }}>
          {currentRole.emoji} {currentRole.name}
        </Typography>
      </Button>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={closeRoleMenu}>
        {ROLES.filter((r) => !r.archived).map((role) => (
          <MenuItem
            key={role.id}
            selected={role.id === currentRole.id}
            onClick={() => {
              setRole(role.id)
              closeRoleMenu()
            }}
          >
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: role.color }} />
              <span>
                {role.emoji} {role.name}
              </span>
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted, ml: 1 }}>
                匹配 {role.matchScore}%
              </Typography>
            </Stack>
          </MenuItem>
        ))}
      </Menu>

      <Chip
        size="small"
        label={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography component="span" sx={{ fontSize: 12, fontWeight: 500 }}>
              {currentStage?.label ?? '未开始'}
            </Typography>
            <Typography component="span" sx={{ fontSize: 12, color: COLORS.textMuted }}>
              ·
            </Typography>
            <Typography
              component="span"
              sx={{ fontSize: 12, fontFamily: COLORS.mono, color: COLORS.accent }}
            >
              {completed}/{total}
            </Typography>
          </Stack>
        }
        sx={{
          height: 28,
          bgcolor: COLORS.accentMuted,
          border: `1px solid ${COLORS.accent}59`,
          color: COLORS.text,
          '& .MuiChip-label': { px: 1.5 },
        }}
      />

      <Box sx={{ flex: 1 }} />

      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mr: 0.5 }}>
        <CircleIcon sx={{ fontSize: 8, color: COLORS.riskLow }} />
        <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>Agent 在线</Typography>
      </Stack>

      <ThemeToggle />

      <Tooltip title="全局搜索 ⌘K">
        <Button
          onClick={() => setCommandPaletteOpen(true)}
          startIcon={<SearchIcon sx={{ fontSize: 16 }} />}
          sx={{
            color: COLORS.textSecondary,
            bgcolor: COLORS.bgHover,
            border: `1px solid ${COLORS.border}`,
            px: 1.5,
            minWidth: 160,
            justifyContent: 'flex-start',
            '&:hover': { bgcolor: COLORS.bgActive, borderColor: COLORS.borderStrong },
          }}
        >
          <Typography sx={{ fontSize: 12, flex: 1, textAlign: 'left' }}>搜索…</Typography>
          <Typography
            sx={{
              fontSize: 11,
              fontFamily: COLORS.mono,
              color: COLORS.textMuted,
              border: `1px solid ${COLORS.border}`,
              borderRadius: '4px',
              px: 0.75,
              py: 0.25,
            }}
          >
            ⌘K
          </Typography>
        </Button>
      </Tooltip>
    </Box>
  )
}
