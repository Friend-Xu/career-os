import { Box, Button, Stack, Typography } from '@mui/material'
import CircleIcon from '@mui/icons-material/Circle'
import { useState } from 'react'
import { COLORS, LAYOUT } from '../../data/constants'
import { WORKSPACE_PATH, POOL_HEALTH } from '../../data/mock-data'
import { useAppStore } from '../../store/app-store'
import { SearchStatsDialog } from './search-stats-dialog'

export function StatusBar() {
  // 数据健康度：引擎 health RPC（契约 v1 单一计算源）；引擎在线但无报告 → 诚实空态「—」；offline → mock 演示兜底
  const health = useAppStore((s) => s.health)
  const engineStatus = useAppStore((s) => s.engineStatus)
  const decisions = useAppStore((s) => s.decisions)
  const searchStats = useAppStore((s) => s.searchStats)
  const [statsOpen, setStatsOpen] = useState(false)
  const healthPercent = health ? health.overallScore : engineStatus === 'connected' ? null : POOL_HEALTH.healthPercent
  // 上次决策写入：取真实决策最新一条（decisions 头部为最新）；空 → 「暂无决策写入」
  const lastWrite = decisions.length > 0 ? decisions[0]?.createdAt : null
  // WebSearch 指标（P3 指标板）：仅 connected 时可信；空 trace → 0 为真实值不隐藏
  const statsLabel =
    engineStatus === 'connected' && searchStats
      ? `搜索 ${searchStats.searches} · 缓存 ${searchStats.cacheHits}`
      : '搜索指标 —'
  return (
    <Box
      component="footer"
      sx={{
        height: LAYOUT.statusBar,
        minHeight: LAYOUT.statusBar,
        display: 'flex',
        alignItems: 'center',
        px: 2,
        gap: 2,
        borderTop: `1px solid ${COLORS.border}`,
        bgcolor: COLORS.bg,
        zIndex: 20,
      }}
    >
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
        <CircleIcon sx={{ fontSize: 10, color: COLORS.riskLow }} />
        <Typography sx={{ fontSize: 12, fontFamily: COLORS.mono, color: COLORS.textSecondary }}>
          {WORKSPACE_PATH}
        </Typography>
      </Stack>

      <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>|</Typography>

      <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
        {healthPercent === null ? '数据健康度 —' : `数据健康度 ${healthPercent}%`}
      </Typography>

      <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>|</Typography>

      <Button
        size="small"
        onClick={() => setStatsOpen(true)}
        sx={{
          minWidth: 0,
          p: 0.25,
          fontSize: 12,
          textTransform: 'none',
          color: COLORS.textMuted,
          '&:hover': { bgcolor: COLORS.bgHover },
        }}
      >
        {statsLabel}
      </Button>

      <Box sx={{ flex: 1 }} />

      <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
        {lastWrite ? `上次决策写入 ${lastWrite}` : '暂无决策写入'}
      </Typography>

      <SearchStatsDialog open={statsOpen} onClose={() => setStatsOpen(false)} />
    </Box>
  )
}
