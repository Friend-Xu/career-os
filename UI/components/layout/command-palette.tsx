import {
  Box,
  Dialog,
  TextField,
  Typography,
  Stack,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import type { NavPageId } from '../../types'
import { COLORS } from '../../data/constants'

interface ResultItem {
  id: string;
  label: string;
  group: string;
  page: NavPageId;
  meta?: string;
}

export function CommandPalette() {
  const open = useAppStore((s) => s.commandPaletteOpen)
  const setOpen = useAppStore((s) => s.setCommandPaletteOpen)
  const setPage = useAppStore((s) => s.setPage)
  const setLocateTarget = useAppStore((s) => s.setLocateTarget)
  const decisions = useAppStore((s) => s.decisions)
  const companies = useAppStore((s) => s.companies)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const items: ResultItem[] = [
      { id: 'nav-wb', label: '工作台', group: '导航', page: 'workbench' },
      { id: 'nav-agent', label: '决策 Agent', group: '导航', page: 'agent' },
      { id: 'nav-pool', label: '信息池', group: '导航', page: 'infopool' },
      { id: 'nav-co', label: '公司探索', group: '导航', page: 'companies' },
      { id: 'nav-app', label: '投递管理', group: '导航', page: 'applications' },
      { id: 'nav-cv', label: '简历中心', group: '导航', page: 'resumes' },
      { id: 'nav-set', label: '设置', group: '导航', page: 'settings' },
      ...decisions.map((d) => ({
        id: d.id,
        label: d.title,
        group: '决策记录',
        page: 'agent' as NavPageId,
        meta: d.city || d.direction,
      })),
      ...companies.map((c) => ({
        id: c.id,
        label: c.name,
        group: '公司',
        page: 'companies' as NavPageId,
        meta: `${c.city} · 匹配 ${c.matchScore}`,
      })),
    ]
    if (!q) return items.slice(0, 12)
    return items
      .filter(
        (i) =>
          i.label.toLowerCase().includes(q) ||
          i.group.toLowerCase().includes(q) ||
          (i.meta?.toLowerCase().includes(q) ?? false),
      )
      .slice(0, 20)
  }, [query, decisions, companies])

  useEffect(() => {
    setActiveIdx(0)
  }, [query, open])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const go = (item: ResultItem) => {
    setPage(item.page)
    if (item.group === '决策记录' || item.group === '公司') {
      setLocateTarget(item.id)
    }
    setOpen(false)
  }

  const grouped = results.reduce<Record<string, ResultItem[]>>((acc, item) => {
    (acc[item.group] ??= []).push(item)
    return acc
  }, {})

  let flatIndex = -1

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      fullWidth
      maxWidth="sm"
      slotProps={{
        backdrop: { sx: { bgcolor: 'rgba(0,0,0,0.55)' } },
        paper: {
          sx: {
            mt: '12vh',
            verticalAlign: 'top',
            borderRadius: '12px',
            overflow: 'hidden',
            bgcolor: COLORS.bgElevated,
            border: `1px solid ${COLORS.borderStrong}`,
            boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
          },
        },
      }}
    >
      <Box sx={{ p: 1.5, borderBottom: `1px solid ${COLORS.border}` }}>
        <TextField
          autoFocus
          fullWidth
          placeholder="搜索公司、决策、城市、方向…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActiveIdx((i) => Math.min(i + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActiveIdx((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter' && results[activeIdx]) {
              go(results[activeIdx])
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18, color: COLORS.textMuted }} />
                </InputAdornment>
              ),
              sx: {
                fontSize: 14,
                '& fieldset': { border: 'none' },
              },
            },
          }}
        />
      </Box>

      <Box sx={{ maxHeight: 360, overflow: 'auto', py: 1 }}>
        {results.length === 0 ? (
          <Typography sx={{ p: 3, textAlign: 'center', color: COLORS.textMuted, fontSize: 13 }}>
            无匹配结果
          </Typography>
        ) : (
          Object.entries(grouped).map(([group, items]) => (
            <Box key={group}>
              <Typography
                sx={{
                  px: 2,
                  py: 0.75,
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: COLORS.textMuted,
                  letterSpacing: '0.04em',
                }}
              >
                {group}
              </Typography>
              <List dense disablePadding>
                {items.map((item) => {
                  flatIndex += 1
                  const idx = flatIndex
                  const active = idx === activeIdx
                  return (
                    <ListItemButton
                      key={item.id}
                      selected={active}
                      onClick={() => go(item)}
                      onMouseEnter={() => setActiveIdx(idx)}
                      sx={{
                        mx: 1,
                        borderRadius: '6px',
                        py: 0.75,
                        '&.Mui-selected': {
                          bgcolor: COLORS.accentMuted,
                        },
                      }}
                    >
                      <ListItemText
                        primary={item.label}
                        secondary={item.meta}
                        slotProps={{
                          primary: { sx: { fontSize: 13.5, fontWeight: active ? 600 : 400 } },
                          secondary: { sx: { fontSize: 12 } },
                        }}
                      />
                      <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                        {item.group}
                      </Typography>
                    </ListItemButton>
                  )
                })}
              </List>
            </Box>
          ))
        )}
      </Box>

      <Stack
        direction="row"
        spacing={2}
        sx={{
          px: 2,
          py: 1,
          borderTop: `1px solid ${COLORS.border}`,
          bgcolor: COLORS.bg,
        }}
      >
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>↑↓ 选择</Typography>
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>↵ 跳转</Typography>
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>esc 关闭</Typography>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>⌘B 面板</Typography>
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>⌘N 会话</Typography>
      </Stack>
    </Dialog>
  )
}
