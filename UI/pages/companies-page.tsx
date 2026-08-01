import {
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
  InputAdornment,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import CloseIcon from '@mui/icons-material/Close'
import MapIcon from '@mui/icons-material/Map'
import ViewListIcon from '@mui/icons-material/ViewList'
import { useEffect, useMemo, useState } from 'react'
import { PARKS } from '../data/mock-data'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, EASE, RISK_COLOR, RISK_LABEL } from '../data/constants'
import type { Company } from '../types'

export function CompaniesPage() {
  const [tab, setTab] = useState(0)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Company | null>(null)
  const [parkId, setParkId] = useState<number | null>(null)
  const setPage = useAppStore((s) => s.setPage)
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const companies = useAppStore((s) => s.companies)
  const markCompanyContacted = useAppStore((s) => s.markCompanyContacted)
  const companiesFilter = useAppStore((s) => s.companiesFilter)
  const locateTarget = useAppStore((s) => s.locateTarget)
  const setLocateTarget = useAppStore((s) => s.setLocateTarget)
  const push = useToastStore((s) => s.push)

  useEffect(() => {
    if (!locateTarget) return
    document
      .getElementById(`company-${locateTarget}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setLocateTarget(null)
  }, [locateTarget, setLocateTarget])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const base = q
      ? companies.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.city.includes(q) ||
            c.industry.includes(q) ||
            c.tags.some((t) => t.includes(q)),
        )
      : companies
    switch (companiesFilter) {
    case 'sz':
      return base.filter((c) => c.city === '深圳')
    case 'sh':
      return base.filter((c) => c.city === '上海')
    case 'hz':
      return base.filter((c) => c.city === '杭州')
    case 'bj':
      return base.filter((c) => c.city === '北京')
    case 'robot':
      return base.filter((c) => c.industry.includes('机器人'))
    case 'contacted':
      return base.filter((c) => c.contacted)
    default:
      return base
    }
  }, [search, companiesFilter, companies])

  const activePark = PARKS.find((p) => p.id === parkId)

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', p: 2, gap: 1.5, overflow: 'hidden' }}>
      <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1.5}>
        <Typography sx={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>公司探索</Typography>
        <Chip size="small" label={`${companies.length} 家档案`} sx={{ height: 22, fontSize: 12 }} />
        <Box sx={{ flex: 1 }} />
        <TextField
          size="small"
          placeholder="搜索公司 / 城市 / 产业…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 16, color: COLORS.textMuted }} />
                </InputAdornment>
              ),
            },
          }}
          sx={{ width: 220, '& .MuiOutlinedInput-root': { height: 30, fontSize: 12 } }}
        />
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 30 }}>
          <Tab icon={<MapIcon sx={{ fontSize: 16 }} />} iconPosition="start" label="园区地图" sx={{ minHeight: 30 }} />
          <Tab icon={<ViewListIcon sx={{ fontSize: 16 }} />} iconPosition="start" label="公司清单" sx={{ minHeight: 30 }} />
        </Tabs>
      </Stack>

      {tab === 0 ? (
        <Box
          sx={{
            flex: 1,
            position: 'relative',
            borderRadius: '10px',
            border: `1px solid ${COLORS.border}`,
            bgcolor: COLORS.canvas,
            overflow: 'hidden',
          }}
        >
          {/* Simplified park map */}
          <svg width="100%" height="100%" viewBox="0 0 900 520" preserveAspectRatio="xMidYMid meet">
            {/* grid */}
            {Array.from({ length: 10 }).map((_, i) => (
              <line
                key={`h${i}`}
                x1={0}
                y1={i * 52}
                x2={900}
                y2={i * 52}
                stroke={alpha(COLORS.text, 0.06)}
              />
            ))}
            {Array.from({ length: 12 }).map((_, i) => (
              <line
                key={`v${i}`}
                x1={i * 75}
                y1={0}
                x2={i * 75}
                y2={520}
                stroke={alpha(COLORS.text, 0.06)}
              />
            ))}
            {/* city labels approx */}
            {[
              { name: '北京', x: 520, y: 80 },
              { name: '上海', x: 700, y: 260 },
              { name: '杭州', x: 640, y: 340 },
              { name: '深圳', x: 620, y: 440 },
            ].map((c) => (
              <text key={c.name} x={c.x} y={c.y} fill={COLORS.textMuted} fontSize={11} textAnchor="middle">
                {c.name}
              </text>
            ))}
          </svg>

          {PARKS.map((park, i) => {
            // Map lat/lon roughly into viewBox
            const x = ((park.lon - 113) / 5) * 700 + 80
            const y = ((41 - park.lat) / 12) * 420 + 40
            const active = parkId === park.id
            return (
              <Box
                key={park.id}
                onClick={() => setParkId(active ? null : park.id)}
                sx={{
                  position: 'absolute',
                  left: x,
                  top: y,
                  transform: 'translate(-50%, -50%)',
                  px: 1.5,
                  py: 1,
                  borderRadius: '10px',
                  bgcolor: active ? COLORS.accentMuted : COLORS.bgElevated,
                  border: `1.5px solid ${active ? COLORS.accent : COLORS.border}`,
                  cursor: 'pointer',
                  animation: `fade-in 0.35s ${EASE} ${i * 0.08}s both`,
                  '&:hover': { borderColor: COLORS.accent },
                  minWidth: 120,
                  textAlign: 'center',
                }}
              >
                <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{park.name}</Typography>
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 0.25 }}>
                  {park.city} · {park.companies.length} 家 · {park.year}
                </Typography>
              </Box>
            )
          })}

          {activePark && (
            <Box
              sx={{
                position: 'absolute',
                right: 16,
                top: 16,
                width: 260,
                p: 2,
                borderRadius: '10px',
                bgcolor: alpha(COLORS.bgElevated, 0.95),
                border: `1px solid ${COLORS.borderStrong}`,
              }}
            >
              <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
                <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{activePark.name}</Typography>
                <IconButton size="small" onClick={() => setParkId(null)}>
                  <CloseIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Stack>
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1.5 }}>
                {activePark.industry} · 来源 {activePark.source} ({activePark.year})
              </Typography>
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mb: 0.75 }}>入驻企业</Typography>
              <Stack spacing={0.5}>
                {activePark.companies.map((name) => {
                  const co = companies.find((c) => c.name === name)
                  return (
                    <Box
                      key={name}
                      onClick={() => co && setSelected(co)}
                      sx={{
                        px: 1,
                        py: 0.75,
                        borderRadius: '6px',
                        bgcolor: COLORS.bgHover,
                        cursor: co ? 'pointer' : 'default',
                        '&:hover': co ? { bgcolor: COLORS.bgActive } : {},
                      }}
                    >
                      <Typography sx={{ fontSize: 12 }}>{name}</Typography>
                      {co && (
                        <Typography sx={{ fontSize: 11.5, color: COLORS.accent }}>
                          匹配 {co.matchScore}
                        </Typography>
                      )}
                    </Box>
                  )
                })}
              </Stack>
            </Box>
          )}
        </Box>
      ) : (
        <Box
          sx={{
            flex: 1,
            overflow: 'auto',
            borderRadius: '10px',
            border: `1px solid ${COLORS.border}`,
            bgcolor: COLORS.bgElevated,
          }}
        >
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: '1.4fr 0.7fr 1fr 0.6fr 0.5fr 0.5fr',
              px: 2,
              py: 1,
              borderBottom: `1px solid ${COLORS.border}`,
              position: 'sticky',
              top: 0,
              bgcolor: COLORS.bgElevated,
              zIndex: 1,
            }}
          >
            {['公司', '城市', '产业', '匹配', '风险', '状态'].map((h) => (
              <Typography key={h} sx={{ fontSize: 12, color: COLORS.textMuted, fontWeight: 600 }}>
                {h}
              </Typography>
            ))}
          </Box>
          {filtered.map((c) => (
            <Box
              key={c.id}
              id={`company-${c.id}`}
              role="button"
              tabIndex={0}
              onClick={() => setSelected(c)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelected(c)
                }
              }}
              sx={{
                display: 'grid',
                gridTemplateColumns: '1.4fr 0.7fr 1fr 0.6fr 0.5fr 0.5fr',
                px: 2,
                py: 1.25,
                borderBottom: `1px solid ${COLORS.border}`,
                cursor: 'pointer',
                alignItems: 'center',
                '&:hover': { bgcolor: COLORS.bgHover },
                '&:focus-visible': {
                  outline: `2px solid ${COLORS.accent}`,
                  outlineOffset: -2,
                },
              }}
            >
              <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{c.name}</Typography>
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>{c.city}</Typography>
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }} noWrap>
                {c.industry}
              </Typography>
              <Typography sx={{ fontSize: 12, fontFamily: COLORS.mono, color: COLORS.accent }}>
                {c.matchScore}
              </Typography>
              <Typography sx={{ fontSize: 12, color: RISK_COLOR[c.riskLevel] }}>
                {RISK_LABEL[c.riskLevel]}
              </Typography>
              <Typography sx={{ fontSize: 12, color: c.contacted ? COLORS.riskLow : COLORS.textMuted }}>
                {c.contacted ? '已联系' : '未联系'}
              </Typography>
            </Box>
          ))}
        </Box>
      )}

      <Drawer
        anchor="right"
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        slotProps={{
          paper: {
            sx: {
              width: 380,
              bgcolor: COLORS.bgElevated,
              borderLeft: `1px solid ${COLORS.border}`,
              backgroundImage: 'none',
            },
          },
        }}
      >
        {selected && (
          <Box sx={{ p: 2.5 }}>
            <Stack direction="row" sx={{ alignItems: 'center', mb: 2 }}>
              <Typography sx={{ fontSize: 16, fontWeight: 600, flex: 1 }}>{selected.name}</Typography>
              <IconButton size="small" onClick={() => setSelected(null)}>
                <CloseIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Stack>

            <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', gap: 0.5 }}>
              {selected.tags.map((t) => (
                <Chip key={t} size="small" label={t} sx={{ height: 22, fontSize: 12 }} />
              ))}
            </Stack>

            <Box
              sx={{
                p: 1.5,
                borderRadius: '8px',
                bgcolor: COLORS.bgHover,
                border: `1px solid ${COLORS.border}`,
                mb: 2,
              }}
            >
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1 }}>尽调摘要</Typography>
              <Stack spacing={1}>
                <Row label="城市" value={selected.city} />
                <Row label="产业" value={selected.industry} />
                <Row label="匹配度" value={`${selected.matchScore}%`} color={COLORS.accent} />
                <Row label="风险" value={RISK_LABEL[selected.riskLevel]} color={RISK_COLOR[selected.riskLevel]} />
                <Row label="来源" value={selected.source} />
              </Stack>
            </Box>

            <Stack spacing={1}>
              <Button
                variant="contained"
                fullWidth
                onClick={() => {
                  startAnalysis(
                    `请对「${selected.name}」（${selected.city} · ${selected.industry}）开展公司尽调：背调、风险、竞争力与入职建议`,
                  )
                  push('info', '已预置「公司尽调」上下文')
                }}
              >
                开始尽调
              </Button>
              <Button
                variant="outlined"
                fullWidth
                onClick={() => {
                  markCompanyContacted(selected.id)
                  push('success', `已标记「${selected.name}」为已联系 · 投递管理已同步`)
                  setSelected(null)
                  setPage('applications')
                }}
              >
                标记已联系 → 投递管理
              </Button>
            </Stack>
          </Box>
        )}
      </Drawer>
    </Box>
  )
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
      <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>{label}</Typography>
      <Typography sx={{ fontSize: 12, fontWeight: 500, color: color ?? COLORS.text }}>{value}</Typography>
    </Stack>
  )
}
