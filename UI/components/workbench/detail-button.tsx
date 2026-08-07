/**
 * 评估详情入口按钮（button-in-button 轻量版）：文字 + 独立圆环内箭头。
 * 悬停：边框强调 + 圆环内箭头 1px 位移（内部动能），EASE 过渡。
 * 方向/城市卡片共用。
 */
import { Box, Button } from '@mui/material'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import { alpha, COLORS, EASE } from '../../data/constants'

export function DetailButton({ label = '查看完整评估', onClick }: { label?: string; onClick: () => void }) {
  return (
    <Button
      size="small"
      variant="outlined"
      onClick={onClick}
      sx={{
        fontSize: 12,
        color: COLORS.accent,
        borderColor: alpha(COLORS.accent, 0.4),
        transition: `border-color 180ms ${EASE}, background-color 180ms ${EASE}`,
        '&:hover': {
          borderColor: COLORS.accent,
          bgcolor: alpha(COLORS.accent, 0.06),
          '& .cos-btn-arrow': { transform: 'translateX(1px)' },
        },
      }}
    >
      {label}
      <Box
        component="span"
        className="cos-btn-arrow"
        sx={{
          ml: 0.75,
          width: 18,
          height: 18,
          borderRadius: '50%',
          bgcolor: alpha(COLORS.accent, 0.12),
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: `transform 180ms ${EASE}`,
        }}
      >
        <ArrowForwardIcon sx={{ fontSize: 11.5, color: COLORS.accent }} />
      </Box>
    </Button>
  )
}
