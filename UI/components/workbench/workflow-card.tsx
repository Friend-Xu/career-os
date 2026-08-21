import { Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/material'
import { alpha, COLORS, RISK_COLOR } from '../../data/constants'
import { useAppStore, stageLabel } from '../../store/app-store'
import { useToastStore } from '../../store/toast-store'

/**
 * 工作流投影卡（Career Workflow Contract v0.1）——UI 只投影 + Human Action，不 orchestrate：
 * - 显示 Goal / 阶段进度 / 当前 Stage 状态（running=Agent 正在工作 / waiting_gate=等你确认）
 * - waiting_gate → 「确认并继续」（workflow/advance）；running → 不显示确认（控制平面硬切断）
 * - 「暂不登记，继续探索」= 受控探索分支：不发 advance（契约 §4.3——不登记、不 completed、不越 Stage 1）
 * 引擎单方写 workflows/，本组件不修改状态（advance/abort 是用户动作，经 RPC 由引擎裁决）。
 */
export function WorkflowCard() {
  const workflows = useAppStore((s) => s.workflows)
  const startWorkflow = useAppStore((s) => s.startWorkflow)
  const advanceWorkflow = useAppStore((s) => s.advanceWorkflow)
  const abortWorkflow = useAppStore((s) => s.abortWorkflow)
  const push = useToastStore((s) => s.push)
  const person = useAppStore((s) => s.currentPerson())

  const active = workflows.find((w) => w.status === 'active')

  if (!active) {
    return (
      <Box
        sx={{
          p: 1.5,
          borderRadius: '8px',
          bgcolor: COLORS.canvas,
          border: `1px solid ${COLORS.border}`,
          mb: 2,
        }}
      >
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>工作流</Typography>
          <Button
            size="small"
            variant="outlined"
            disabled={!person.personId}
            title="发起「职业方向」工作流：阶段 1 收集个人事实（含候选确认）→ 方向探索 → 评估 → 推荐"
            onClick={() => void startWorkflow('帮我确定职业方向')}
            sx={{ fontSize: 11.5 }}
          >
            发起「职业方向」工作流
          </Button>
        </Stack>
      </Box>
    )
  }

  const stageIdx = active.stages.findIndex((s) => s.id === active.currentStage)
  const cur = stageIdx >= 0 ? active.stages[stageIdx] : undefined
  const progress = active.stages.filter((s) => s.status === 'completed').length
  const total = active.stages.length
  const waitingGate = cur?.status === 'waiting_gate'
  const running = cur?.status === 'running'

  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: '8px',
        bgcolor: COLORS.canvas,
        border: `1px solid ${waitingGate ? alpha(COLORS.accent, 0.5) : COLORS.border}`,
        mb: 2,
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography sx={{ fontSize: 12, fontWeight: 600 }}>
          {active.statement}
          <Typography component="span" sx={{ fontSize: 11, color: COLORS.textMuted, ml: 1 }}>
            阶段 {progress + (waitingGate || running ? 1 : 0)} / {total}
          </Typography>
        </Typography>
        <Button size="small" color="inherit" sx={{ fontSize: 11, minWidth: 0, p: 0.25 }} onClick={() => void abortWorkflow(active.id)}>
          终止
        </Button>
      </Stack>

      {/* 阶段进度条（投影） */}
      <Stack direction="row" spacing={0.75} sx={{ mb: 1.5 }}>
        {active.stages.map((s) => (
          <Box
            key={s.id}
            sx={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              bgcolor: s.status === 'completed' ? COLORS.riskLow : s.id === active.currentStage ? COLORS.accent : alpha(COLORS.border, 0.8),
            }}
          />
        ))}
      </Stack>

      {cur && (
        <Stack spacing={1}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography sx={{ fontSize: 12.5, fontWeight: 500 }}>阶段：{stageLabel(cur.id)}</Typography>
            {running && (
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                <CircularProgress size={10} thickness={5} />
                <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>Agent 正在工作</Typography>
              </Stack>
            )}
            {waitingGate && (
              <Chip
                size="small"
                label="等待你的确认"
                sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.accent, 0.14), color: COLORS.accent }}
              />
            )}
            {cur.status === 'failed' && (
              <Chip
                size="small"
                label="阶段失败（可重试）"
                sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(RISK_COLOR.high, 0.12), color: RISK_COLOR.high }}
              />
            )}
          </Stack>

          {/* Human Gate：确认并继续（advance 由引擎四步裁决；失败 toast 缺件）——
              暂不登记 = 受控探索分支，不发 advance（契约 §4.3） */}
          {waitingGate && (
            <Stack spacing={0.75}>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                系统已收集到候选事实（{cur.gate?.id === 'confirm_person_facts' ? '教育/经历/技能/偏好' : '推荐结论'}）。
                确认后登记为个人事实并进入下一阶段；暂不登记则本阶段保持未完成（探索输入不会伪装成已登记事实）。
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button size="small" variant="contained" sx={{ fontSize: 11.5 }} onClick={() => void advanceWorkflow(active.id, cur.gate?.id)}>
                  确认并继续
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  sx={{ fontSize: 11.5 }}
                  title="不登记、不推进 Stage——仅允许本轮探索使用口述信息（契约 §4.3 受控探索分支）"
                  onClick={() =>
                    push(
                      'info',
                      '暂不登记：本轮对话仍可继续探索，但口述信息不会升级为个人事实——确认登记后才会推进阶段',
                    )
                  }
                >
                  暂不登记，继续探索
                </Button>
              </Stack>
            </Stack>
          )}
        </Stack>
      )}
    </Box>
  )
}
