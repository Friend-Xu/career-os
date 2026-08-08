/**
 * 优化空间空态（ADR-021 R0）：Resume Alignment Projection 的落地前引导（R2 实现四态矩阵）。
 * 产品化文案（非「建设中」）——「选择岗位」接现有 ResumeDeriveDialog（真实入口，非假按钮）。
 */
import { Box, Button, Stack, Typography } from '@mui/material'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import { COLORS } from '../../data/constants'

export function ResumeOptimizeEmpty({ onSelectJob }: { onSelectJob: () => void }) {
  return (
    <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', p: 3 }}>
      <Stack spacing={1.5} sx={{ alignItems: 'center', textAlign: 'center', maxWidth: 420 }}>
        <AutoAwesomeIcon sx={{ fontSize: 34, color: COLORS.accent, opacity: 0.75 }} />
        <Typography sx={{ fontSize: 15, fontWeight: 600 }}>岗位优化</Typography>
        <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, lineHeight: 1.7 }}>
          将当前简历与目标岗位要求进行匹配，发现表达缺口，并基于已有经历提出优化建议。
          <br />
          请选择已关联岗位开始优化。
        </Typography>
        <Button size="small" variant="contained" onClick={onSelectJob} sx={{ fontSize: 12.5 }}>
          选择岗位
        </Button>
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, lineHeight: 1.6 }}>
          优化建议仅基于已有事实——不会凭空生成经历。
        </Typography>
      </Stack>
    </Box>
  )
}
