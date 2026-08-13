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
import { alpha, COLORS, LAYOUT, SKILL_VIEW_LABEL } from '../../data/constants'
import { belongsToPerson } from '../../utils/ownership'
import { latestPersonDirection } from '../../utils/direction-state'
import type { DecisionView } from '../../store/engine-client'
import { ThemeToggle } from './theme-toggle'

export function TopBar() {
  const currentPerson = useAppStore((s) => s.currentPerson())
  const persons = useAppStore((s) => s.persons).filter((p) => !p.archived)
  const setPerson = useAppStore((s) => s.setPerson)
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen)
  const setPersonCreateDialogOpen = useAppStore((s) => s.setPersonCreateDialogOpen)
  const decisions = useAppStore((s) => s.decisions)
  const engineStatus = useAppStore((s) => s.engineStatus)
  const setPage = useAppStore((s) => s.setPage)
  const setWorkbenchView = useAppStore((s) => s.setWorkbenchView)
  const [anchor, setAnchor] = useState<null | HTMLElement>(null)

  // ADR-008：探索记录（决策链语义降级）——按决策类型计数，非阶段推进
  const exploration = useMemo(() => {
    const mine = decisions.filter((d) => belongsToPerson(d, currentPerson))
    const counts = new Map<string, number>()
    for (const d of mine) {
      const type = SKILL_VIEW_LABEL[d.skill] ?? d.skill
      counts.set(type, (counts.get(type) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [decisions, currentPerson.personId, currentPerson.name])

  const explorationLabel = useMemo(() => {
    const shown = exploration.slice(0, 2).map(([k, v]) => `${k}×${v}`).join(' ')
    if (!shown) return '探索记录：暂无'
    return `探索记录：${shown}${exploration.length > 2 ? ` 等 ${exploration.length} 类` : ''}`
  }, [exploration])

  // 决策展开的方向名集合：方向评估明细（v2.8 payload）逐方向；城市评估用口径方向；旧协议单字符串
  const dirsOf = (d: DecisionView): string[] => {
    if (d.payload?.type === 'direction' && d.payload.directions.length > 0) return d.payload.directions.map((x) => x.name)
    if (d.payload?.type === 'city' && d.payload.direction) return [d.payload.direction]
    return d.direction ? [d.direction] : []
  }

  // 当前方向 = 当前人已确定的方向（优先方向探索明细主方向，跨决策回退非空 direction；后续空方向决策不覆盖）
  const currentDirection = useMemo(
    () => latestPersonDirection(decisions, currentPerson),
    [decisions, currentPerson.personId, currentPerson.name],
  )

  // 方向数（聚合维度：该人决策记录展开方向去重；无方向的决策不计入）
  const directionCount = useMemo(() => {
    const mine = decisions.filter((d) => belongsToPerson(d, currentPerson))
    return new Set(mine.flatMap(dirsOf)).size
  }, [decisions, currentPerson.personId, currentPerson.name])

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
            本地版 v1.0
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
              {explorationLabel}
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

      {/* 当前方向胶囊（6.7：状态层，无边框无底色，视觉让位于操作与进度；点击 → 工作台方向视图） */}
      {currentDirection && (
        <Stack
          direction="row"
          spacing={0.75}
          sx={{ alignItems: 'center', cursor: 'pointer', py: 0.5, px: 0.5, borderRadius: '6px' }}
          onClick={() => {
            setPage('workbench')
            setWorkbenchView('directions')
          }}
          title="查看方向视图（按方向聚合的决策时间线）"
        >
          <Box sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: COLORS.textMuted }} />
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
            方向 · {currentDirection}
          </Typography>
          {directionCount > 1 && (
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, opacity: 0.8 }}>
              · {directionCount} 个方向
            </Typography>
          )}
        </Stack>
      )}

      <Box sx={{ flex: 1 }} />

      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mr: 0.5 }}>
        <CircleIcon
          sx={{ fontSize: 8, color: engineStatus === 'connected' ? COLORS.riskLow : COLORS.riskHigh }}
        />
        <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>
          {engineStatus === 'connected' ? '引擎在线' : engineStatus === 'connecting' ? '引擎连接中' : '引擎离线'}
        </Typography>
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
