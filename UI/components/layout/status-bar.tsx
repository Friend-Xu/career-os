import { Box, Typography, Stack } from '@mui/material'
import CircleIcon from '@mui/icons-material/Circle'
import { COLORS, LAYOUT } from '../../data/constants'
import { LAST_DECISION_WRITE, WORKSPACE_PATH, POOL_HEALTH } from '../../data/mock-data'
import { useAppStore } from '../../store/app-store'

export function StatusBar() {
  // 数据健康度：引擎 health RPC（契约 v1 单一计算源）；offline/未达 → mock 兜底
  const health = useAppStore((s) => s.health)
  const healthPercent = health ? health.overallScore : POOL_HEALTH.healthPercent
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
        数据健康度 {healthPercent}%
      </Typography>

      <Box sx={{ flex: 1 }} />

      <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
        上次决策写入 {LAST_DECISION_WRITE}
      </Typography>
    </Box>
  )
}
