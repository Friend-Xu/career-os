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
import PersonAddAltIcon from '@mui/icons-material/PersonAddAlt'
import { useMemo, useState, type MouseEvent } from 'react'
import { useAppStore } from '../../store/app-store'
import { alpha, COLORS, LAYOUT } from '../../data/constants'
import { ThemeToggle } from './theme-toggle'

export function TopBar() {
  const currentPerson = useAppStore((s) => s.currentPerson())
  const persons = useAppStore((s) => s.persons).filter((p) => !p.archived)
  const setPerson = useAppStore((s) => s.setPerson)
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen)
  const setPersonCreateDialogOpen = useAppStore((s) => s.setPersonCreateDialogOpen)
  const personStages = useAppStore((s) => s.personStages[currentPerson.id])
  const decisions = useAppStore((s) => s.decisions)
  const [anchor, setAnchor] = useState<null | HTMLElement>(null)

  const stages = personStages ?? []
  const completed = stages.filter((s) => s.status === 'completed').length
  const total = stages.length
  const currentStage = stages.find((s) => s.status === 'current')

  // 当前方向 = 当前人最新决策的 direction（方案 A：跟随决策链，纯展示非切换器）
  const currentDirection = useMemo(() => {
    const mine = decisions.filter((d) => d.profile === currentPerson.name)
    if (mine.length === 0) return undefined
    return [...mine].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0].direction
  }, [decisions, currentPerson.name])

  const openPersonMenu = (e: MouseEvent<HTMLElement>) => setAnchor(e.currentTarget)
  const closePersonMenu = () => setAnchor(null)

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
        onClick={openPersonMenu}
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
            bgcolor: currentPerson.color,
            mr: 0.5,
          }}
        />
        <Typography sx={{ fontSize: 12.5, fontWeight: 500 }}>
          {currentPerson.emoji} {currentPerson.name}
        </Typography>
      </Button>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={closePersonMenu}>
        {persons.map((person) => (
          <MenuItem
            key={person.id}
            selected={person.id === currentPerson.id}
            onClick={() => {
              setPerson(person.id)
              closePersonMenu()
            }}
          >
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: person.color }} />
              <span>
                {person.emoji} {person.name}
              </span>
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted, ml: 1 }}>
                匹配 {person.matchScore}%
              </Typography>
            </Stack>
          </MenuItem>
        ))}
        <MenuItem
          onClick={() => {
            setPersonCreateDialogOpen(true)
            closePersonMenu()
          }}
        >
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <PersonAddAltIcon sx={{ fontSize: 16, color: COLORS.textMuted }} />
            <Typography sx={{ fontSize: 13, color: COLORS.textSecondary }}>创建新人…</Typography>
          </Stack>
        </MenuItem>
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

      {/* 当前方向胶囊（6.7：状态层，无边框无底色，视觉让位于操作与进度） */}
      {currentDirection && (
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <Box sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: COLORS.textMuted }} />
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
            方向 · {currentDirection}
          </Typography>
        </Stack>
      )}

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
