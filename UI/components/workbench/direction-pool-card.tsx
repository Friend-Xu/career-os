import { Box, Button, Chip, Stack, Typography } from '@mui/material'
import { alpha, COLORS } from '../../data/constants'
import { useAppStore } from '../../store/app-store'
import type { StageArtifactState } from '../../../engine/ir/schema.ts'

/**
 * 方向池投影卡（Career Workflow Contract v0.2 UI-1/UI-2）——UI 只投影 + Human Action，不做业务判断：
 * - 数据源：store.directionsByWorkflow[activeWorkflowId]（Store 层按 workflow scope 拉取，组件只取 key）
 * - 每条 = 方向主张（claim，引擎登记时快照）+ 事实依据（evidence_refs 引用串，UI 不解析文件内容）
 *   + state 芯片（registered=待确认 / confirmed=已保留 / rejected=已排除）
 * - registered 项提供「确认」「排除」（UI-2 Resolve：Human Action → RPC → 引擎裁决 → workflowChanged → 重投影）；
 *   终态（confirmed/rejected）不显示动作按钮——状态机判定归引擎，UI 不维护 allowed transition
 * - 不计算 confirmed 计数、不判断能否继续（引擎终判）；空方向池 / 非 direction_exploration 阶段 → 不渲染
 */
const STATE_META: Record<StageArtifactState, { label: string; color: string }> = {
  registered: { label: '待确认', color: COLORS.accent },
  confirmed: { label: '已保留', color: COLORS.riskLow },
  rejected: { label: '已排除', color: COLORS.textMuted },
}

export function DirectionPoolCard() {
  const workflows = useAppStore((s) => s.workflows)
  const directionsByWorkflow = useAppStore((s) => s.directionsByWorkflow)
  const resolveDirection = useAppStore((s) => s.resolveDirection)

  const active = workflows.find((w) => w.status === 'active')
  if (!active || active.currentStage !== 'direction_exploration') return null
  const directions = directionsByWorkflow[active.id] ?? []
  if (directions.length === 0) return null

  return (
    <Box
      sx={{
        p: 1.25,
        borderRadius: '8px',
        bgcolor: alpha(COLORS.accent, 0.06),
        border: `1px solid ${alpha(COLORS.accent, 0.35)}`,
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography sx={{ fontSize: 12, fontWeight: 600, color: COLORS.textSecondary }}>方向池</Typography>
        <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>已登记 {directions.length} 条方向候选</Typography>
      </Stack>
      <Stack spacing={0.75}>
        {directions.map((a) => (
          <Box
            key={a.artifact_id}
            sx={{
              p: 1,
              borderRadius: '6px',
              bgcolor: COLORS.canvas,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <Typography sx={{ fontSize: 12.5, lineHeight: 1.5, flex: 1 }}>{a.claim}</Typography>
              <Chip
                size="small"
                label={STATE_META[a.state].label}
                sx={{
                  height: 18,
                  fontSize: 10.5,
                  flexShrink: 0,
                  bgcolor: alpha(STATE_META[a.state].color, 0.14),
                  color: STATE_META[a.state].color,
                }}
              />
            </Stack>
            {a.evidence_refs.length > 0 && (
              <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mt: 0.5, lineHeight: 1.5 }}>
                事实依据：{a.evidence_refs.join('；')}
              </Typography>
            )}
            {a.state === 'registered' && (
              <Stack direction="row" spacing={1} sx={{ mt: 0.75 }}>
                <Button
                  size="small"
                  variant="contained"
                  sx={{ fontSize: 11, height: 24, minWidth: 0, px: 1.25 }}
                  onClick={() => void resolveDirection(a.artifact_id, 'confirm')}
                >
                  确认
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  color="inherit"
                  sx={{ fontSize: 11, height: 24, minWidth: 0, px: 1.25 }}
                  onClick={() => void resolveDirection(a.artifact_id, 'reject')}
                >
                  排除
                </Button>
              </Stack>
            )}
          </Box>
        ))}
      </Stack>
    </Box>
  )
}
