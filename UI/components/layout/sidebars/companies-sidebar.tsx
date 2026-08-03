/**
 * 公司空间侧栏：公司列表（搜索 + 城市/产业过滤）。
 * 点击行 → 档案 Dialog（selectedCompanyId 驱动）；locateTarget 定位滚动。
 */
import { Box, Chip, InputAdornment, Stack, TextField, Typography } from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../../store/app-store'
import { COLORS, RISK_COLOR } from '../../../data/constants'

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'sz', label: '深圳' },
  { id: 'sh', label: '上海' },
  { id: 'hz', label: '杭州' },
  { id: 'bj', label: '北京' },
  { id: 'robot', label: '机器人产业' },
  { id: 'contacted', label: '已联系' },
]

export function CompaniesSidebar() {
  const companies = useAppStore((s) => s.companies)
  const companiesFilter = useAppStore((s) => s.companiesFilter)
  const setCompaniesFilter = useAppStore((s) => s.setCompaniesFilter)
  const selectedCompanyId = useAppStore((s) => s.selectedCompanyId)
  const setSelectedCompanyId = useAppStore((s) => s.setSelectedCompanyId)
  const locateTarget = useAppStore((s) => s.locateTarget)
  const setLocateTarget = useAppStore((s) => s.setLocateTarget)
  const [search, setSearch] = useState('')

  // 跨空间定位（信息池「更新尽调」菜单 → 选中档案 + 侧栏滚动到行）
  useEffect(() => {
    if (!locateTarget) return
    setSelectedCompanyId(locateTarget)
    setTimeout(() => {
      document
        .getElementById(`company-${locateTarget}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 0)
    setLocateTarget(null)
  }, [locateTarget, setLocateTarget, setSelectedCompanyId])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const base = q
      ? companies.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            (c.city ?? '').includes(q) ||
            (c.industry ?? '').includes(q) ||
            (c.tags ?? []).some((t) => t.includes(q)),
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
      return base.filter((c) => c.industry?.includes('机器人'))
    case 'contacted':
      return base.filter((c) => c.contacted)
    default:
      return base
    }
  }, [search, companiesFilter, companies])

  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Box sx={{ p: 1.25, pb: 0.5 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 1 }}>
          <Typography
            sx={{
              fontSize: 11,
              fontWeight: 600,
              color: COLORS.textMuted,
              letterSpacing: '0.05em',
              flex: 1,
            }}
          >
            公司
          </Typography>
          <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.textMuted }}>
            {companies.length}
          </Typography>
        </Stack>
        <TextField
          size="small"
          placeholder="搜索公司…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 15, color: COLORS.textMuted }} />
                </InputAdornment>
              ),
            },
          }}
          sx={{ width: '100%', mb: 1, '& .MuiOutlinedInput-root': { height: 28, fontSize: 12 } }}
        />
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          {FILTERS.map((f) => {
            const active = companiesFilter === f.id
            return (
              <Chip
                key={f.id}
                size="small"
                label={f.label}
                onClick={() => setCompaniesFilter(f.id)}
                sx={{
                  height: 20,
                  fontSize: 11,
                  bgcolor: active ? COLORS.accentMuted : COLORS.bgHover,
                  color: active ? COLORS.accent : COLORS.textSecondary,
                  border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
                  cursor: 'pointer',
                }}
              />
            )
          })}
        </Stack>
      </Box>
      <Stack spacing={0.25} sx={{ flex: 1, overflow: 'auto', px: 1 }}>
        {filtered.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, px: 1, py: 2, textAlign: 'center' }}>
            无匹配公司
          </Typography>
        ) : (
          filtered.map((c) => {
            const active = selectedCompanyId === c.id
            const v = c.validation
            const vColor =
              v?.status === 'invalid' ? RISK_COLOR.high : v?.status === 'degraded' ? RISK_COLOR.medium : undefined
            return (
              <Stack
                key={c.id}
                id={`company-${c.id}`}
                onClick={() => setSelectedCompanyId(c.id)}
                sx={{
                  px: 1,
                  py: 0.6,
                  borderRadius: '6px',
                  cursor: 'pointer',
                  bgcolor: active ? COLORS.accentMuted : 'transparent',
                  '&:hover': { bgcolor: active ? COLORS.accentMuted : COLORS.bgHover },
                }}
              >
                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                  <Typography
                    sx={{
                      fontSize: 12.5,
                      fontWeight: active ? 600 : 500,
                      color: active ? COLORS.accent : COLORS.text,
                      flex: 1,
                      minWidth: 0,
                    }}
                    noWrap
                  >
                    {c.name}
                  </Typography>
                  {vColor && <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: vColor, flexShrink: 0 }} />}
                  {c.matchScore > 0 && (
                    <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.accent }}>
                      {c.matchScore}
                    </Typography>
                  )}
                </Stack>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <Typography sx={{ fontSize: 11, color: COLORS.textMuted, flex: 1, minWidth: 0 }} noWrap>
                    {c.city ?? ''}
                    {c.industry ? ` · ${c.industry}` : ''}
                  </Typography>
                  {c.contacted && (
                    <Typography sx={{ fontSize: 11, color: COLORS.riskLow }}>已联系</Typography>
                  )}
                </Stack>
              </Stack>
            )
          })
        )}
      </Stack>
    </Stack>
  )
}
