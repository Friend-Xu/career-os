import { Box, Button, Stack, Typography } from '@mui/material'
import { useAppStore } from '../../store/app-store'
import { alpha, COLORS } from '../../data/constants'
import type { QuestionCard } from '../../types'

/**
 * AskUserQuestion 卡片（Session Rendering Layer 共享组件——面板与全屏页同一渲染语义）。
 * 问题 + 选项；点击选项回填用户消息并标记已作答。
 */
export function QuestionCardView({ card, messageId }: { card: QuestionCard; messageId: string }) {
  const answer = useAppStore((s) => s.answerQuestion)

  return (
    <Box
      sx={{
        mt: 1.5,
        p: 2,
        borderRadius: '10px',
        border: `1px solid ${alpha(COLORS.border, 0.8)}`,
        boxShadow: COLORS.cardShadow,
        bgcolor: COLORS.bg,
      }}
    >
      <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1.5 }}>{card.question}</Typography>
      <Stack spacing={1}>
        {card.options.map((opt) => (
          <Button
            key={opt}
            fullWidth
            size="small"
            disabled={card.answered}
            onClick={() => answer(messageId, opt)}
            variant={card.answered && card.answer === opt ? 'contained' : 'outlined'}
            sx={{
              justifyContent: 'flex-start',
              textAlign: 'left',
              fontSize: 12.5,
              textTransform: 'none',
            }}
          >
            {opt}
          </Button>
        ))}
      </Stack>
      {card.answered && (
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mt: 1.25 }}>
          已选择：{card.answer}
        </Typography>
      )}
    </Box>
  )
}
