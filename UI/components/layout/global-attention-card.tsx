import { Box, Button, IconButton, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import { useAttentionStore } from '../../store/attention-store'
import { useAppStore } from '../../store/app-store'
import { COLORS, alpha } from '../../data/constants'

/** 全局 Attention 浮层卡片：持久显示（不自动消失），点击跳转目标或手动关闭。
 *  只消费 AttentionItem 数据，不感知业务（初始化/引擎/简历…）。 */
export function GlobalAttentionCard() {
  const attention = useAttentionStore((s) => s.attention)
  const dismiss = useAttentionStore((s) => s.dismissAttention)
  const setPage = useAppStore((s) => s.setPage)
  const setWorkbenchView = useAppStore((s) => s.setWorkbenchView)

  if (!attention) return null

  const go = () => {
    if (attention.target) {
      setPage(attention.target.page)
      if (attention.target.view) setWorkbenchView(attention.target.view)
    }
    dismiss()
  }

  const color =
    attention.level === 'warning' ? COLORS.riskHigh : attention.level === 'success' ? COLORS.riskLow : COLORS.accent

  return (
    <Box
      sx={{
        position: 'fixed',
        top: 60,
        right: 16,
        zIndex: 1500,
        pointerEvents: 'none',
        animation: 'cos-slide-in-right 0.3s ease-out',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.25,
          px: 2,
          py: 1.25,
          borderRadius: '12px',
          bgcolor: COLORS.bgElevated,
          border: `1px solid ${alpha(color, 0.45)}`,
          boxShadow: 'var(--cos-shadow)',
          maxWidth: 400,
          pointerEvents: 'auto',
        }}
      >
        <AutoAwesomeIcon sx={{ fontSize: 18, color }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>{attention.title}</Typography>
          {attention.description && (
            <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.5, mt: 0.25 }}>
              {attention.description}
            </Typography>
          )}
        </Box>
        {attention.target && (
          <Button size="small" variant="contained" onClick={go} sx={{ fontSize: 12, flexShrink: 0 }}>
            去看看
          </Button>
        )}
        <IconButton size="small" onClick={dismiss} aria-label="关闭提示" sx={{ color: COLORS.textMuted }}>
          <CloseIcon sx={{ fontSize: 15 }} />
        </IconButton>
      </Box>
    </Box>
  )
}
