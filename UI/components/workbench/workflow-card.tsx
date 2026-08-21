import { useEffect } from 'react'
import { Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/material'
import { alpha, COLORS, RISK_COLOR } from '../../data/constants'
import { useAppStore, stageLabel } from '../../store/app-store'
import { useToastStore } from '../../store/toast-store'
import { DirectionPoolCard } from './direction-pool-card'

/**
 * 工作流投影卡（Career Workflow Contract v0.1）——UI 只投影 + Human Action，不 orchestrate：
 * - 显示 Goal / 阶段进度 / 当前 Stage 状态（running=Agent 正在工作 / waiting_gate=等你确认）
 * - waiting_gate → 「确认并继续」（workflow/advance）；running → 不显示确认（控制平面硬切断）
 * - 「暂不登记，继续探索」= 受控探索分支：不发 advance（契约 §4.3——不登记、不 completed、不越 Stage 1）
 * 引擎单方写 workflows/，本组件不修改状态（advance/abort 是用户动作，经 RPC 由引擎裁决）。
 */
export function WorkflowCard() {
  const workflows = useAppStore((s) => s.workflows)
  const initCandidates = useAppStore((s) => s.initCandidates)
  const startWorkflow = useAppStore((s) => s.startWorkflow)
  const advanceWorkflow = useAppStore((s) => s.advanceWorkflow)
  const abortWorkflow = useAppStore((s) => s.abortWorkflow)
  const push = useToastStore((s) => s.push)
  const person = useAppStore((s) => s.currentPerson())
  const engineStatus = useAppStore((s) => s.engineStatus)
  const loadInitCandidates = useAppStore((s) => s.loadInitCandidates)

  // BUG-009 修复：gateCopy 消费的候选源须与引擎同步——页面刷新后 initCandidates 是会话态缓存（空），
  // 不拉取会导致「当前无待确认候选」失真（引擎侧实际有 pending 候选）。
  // BUG-009b：deps 必须含 engineStatus——首挂时引擎仍在 connecting，loadInitCandidates 早退后永不重试
  useEffect(() => {
    if (person.personId && engineStatus === 'connected') void loadInitCandidates(person.personId)
  }, [person.personId, engineStatus, loadInitCandidates])

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
  const total = active.totalStages ?? active.stages.length
  const waitingGate = cur?.status === 'waiting_gate'
  const running = cur?.status === 'running'
  const failed = cur?.status === 'failed'

  // BUG-003 修复：waiting_gate 文案按实际候选类别渲染（不写死"教育/经历/技能/偏好"）——
  // 候选缺教育/经历类时（仅约束/兴趣，无法支撑 person-init）明示缺口，引导先补采集再确认
  const pendingCats = new Set(initCandidates.filter((c) => c.status === 'pending').map((c) => c.category))
  const hasEduExp = pendingCats.has('education') || pendingCats.has('experience')
  const hasAnyPending = pendingCats.size > 0
  // BUG-009 修复：画像已齐备（manifest completed → initStatus active/缺省）优先——
  // advance 的 evaluator 只看快照三件，候选确认不是必经步骤，文案不得误导「必须先补采集」
  const initDone = person.initStatus !== 'pending'
  // UI-3（v0.2 Gate Projection）：Stage 2 confirm_directions 明确告知方向池语义——
  // UI 不计算 confirmed、不 disabled 按钮，最终 Gate 由引擎终判（GATE_BLOCKED → advance 失败 toast 缺件）
  const gateCopy = waitingGate
    ? cur.id === 'direction_exploration'
      ? '方向池已生成，请确认至少一个方向后继续（未确认时无法进入评估阶段）。'
      : initDone
        ? '画像已齐备（个人事实已登记）——确认后直接进入下一阶段；暂不登记则本阶段保持未完成。'
        : !hasAnyPending
          ? '当前无待确认候选——需先在 AI 面板完成候选采集（教育/经历/技能/偏好），确认登记后才能推进本阶段。'
          : hasEduExp
            ? '系统已收集到候选事实（含教育/经历），确认后登记为个人事实并进入下一阶段；暂不登记则本阶段保持未完成（探索输入不会伪装成已登记事实）。'
            : '候选目前只有约束/兴趣类（缺教育/经历）——仅确认现有候选不足以完成画像登记，请先在 AI 面板补充教育/经历/技能采集后再确认。'
    : ''

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
            阶段 {stageIdx + 1} / {total}
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
                label="阶段失败"
                sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(RISK_COLOR.high, 0.12), color: RISK_COLOR.high }}
              />
            )}
          </Stack>

          {/* v0.2 方向池投影（UI-1：组件自判挂载条件——active + direction_exploration + 非空） */}
          <DirectionPoolCard />

          {/* BUG-008 修复：failed 阶段给出出口——重新发起（终止后重开事实收集）；
              advance 由引擎四步裁决，failed 状态不可 advance（硬切断，不假装可重试推进） */}
          {failed && (
            <Stack spacing={0.75}>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                本阶段未完成（候选不足以支撑画像登记或 Agent 未产出候选）。可重新发起工作流，重新收集事实。
              </Typography>
              <Button
                size="small"
                variant="contained"
                sx={{ fontSize: 11.5, alignSelf: 'flex-start' }}
                onClick={() => {
                  void abortWorkflow(active.id).then(() => startWorkflow('帮我确定职业方向'))
                }}
              >
                重新发起
              </Button>
            </Stack>
          )}
          {waitingGate && (
            <Stack spacing={0.75}>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textSecondary, lineHeight: 1.6 }}>{gateCopy}</Typography>
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
