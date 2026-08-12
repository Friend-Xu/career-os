import { Box, Typography, Stack } from '@mui/material'
import CircleIcon from '@mui/icons-material/Circle'
import { COLORS, LAYOUT } from '../../data/constants'
import { WORKSPACE_PATH, POOL_HEALTH } from '../../data/mock-data'
import { useAppStore } from '../../store/app-store'

export function StatusBar() {
  // 数据健康度：引擎 health RPC（契约 v1 单一计算源）；引擎在线但无报告 → 诚实空态「—」；offline → mock 演示兜底
  const health = useAppStore((s) => s.health)
  const engineStatus = useAppStore((s) => s.engineStatus)
  const decisions = useAppStore((s) => s.decisions)
  const healthPercent = health ? health.overallScore : engineStatus === 'connected' ? null : POOL_HEALTH.healthPercent
  // 上次决策写入：取真实决策最新一条（decisions 头部为最新）；空 → 「暂无决策写入」
  const lastWrite = decisions.length > 0 ? decisions[0]?.createdAt : null
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

      <Box sx={{ flex: 1 }} />

      <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
        {lastWrite ? `上次决策写入 ${lastWrite}` : '暂无决策写入'}
      </Typography>
    </Box>
  )
}
