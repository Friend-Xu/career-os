import {
  Box,
  Button,
  Chip,
  Collapse,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import SendIcon from '@mui/icons-material/Send'
import StopCircleIcon from '@mui/icons-material/StopCircle'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import RefreshIcon from '@mui/icons-material/Refresh'
import AddIcon from '@mui/icons-material/Add'
import TimelineIcon from '@mui/icons-material/Timeline'
import BuildIcon from '@mui/icons-material/Build'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { ModelSelect } from '../components/model-select'
import { MarkdownView } from '../components/markdown-view'
import { alpha, COLORS, RISK_COLOR, RISK_LABEL } from '../data/constants'
import type { ChatMessage, DecisionRecord, QuestionCard } from '../types'

function ContextCapsule() {
  const person = useAppStore((s) => s.currentPerson())
  const decisions = useAppStore((s) => s.decisions)

  // ADR-008：探索记录（决策链语义降级）——该人决策总数，非阶段推进
  const exploreCount = decisions.filter((d) => d.profile === person.name).length

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        alignItems: 'center',
        px: 2,
        py: 1,
        borderBottom: `1px solid ${COLORS.border}`,
        flexWrap: 'wrap',
        gap: 0.75,
      }}
    >
      <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mr: 0.5 }}>上下文</Typography>
      <Chip
        size="small"
        label={`${person.emoji} ${person.name} · 匹配 ${person.matchScore}%`}
        sx={{ height: 22, fontSize: 12, bgcolor: COLORS.bgHover, border: `1px solid ${COLORS.border}` }}
      />
      <Chip
        size="small"
        label={`探索记录 ${exploreCount}`}
        sx={{ height: 22, fontSize: 12, bgcolor: COLORS.accentMuted, color: COLORS.accent }}
      />
      <Chip
        size="small"
        label="关联决策 3"
        sx={{ height: 22, fontSize: 12, bgcolor: COLORS.bgHover, border: `1px solid ${COLORS.border}` }}
      />
    </Stack>
  )
}

function ReportCard({ record }: { record: DecisionRecord }) {
  const setPage = useAppStore((s) => s.setPage)
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const push = useToastStore((s) => s.push)

  return (
    <Box
      id={`report-${record.id}`}
      sx={{
        mt: 1.5,
        p: 2,
        borderRadius: '10px',
        border: `1px solid ${COLORS.border}`,
        bgcolor: COLORS.bg,
      }}
    >
      <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1.5 }}>
        {record.title} · 14 字段摘要
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 1,
          mb: 1.5,
        }}
      >
        {(
          [
            ['方向', record.direction],
            ['匹配度', `${record.directionMatch}%`],
            ['置信', record.directionConfidence],
            ['城市', record.city || '—'],
            ['城市分', String(record.cityScore || '—')],
            ['风险', RISK_LABEL[record.riskLevel]],
            ['关键风险', record.keyRisk],
            ['薪资可行', record.salaryFeasible ? '是' : '否'],
            ['状态', record.status],
          ] as const
        ).map(([k, v]) => (
          <Box key={k} sx={{ p: 1, borderRadius: '6px', bgcolor: COLORS.bgHover }}>
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>{k}</Typography>
            <Typography
              sx={{
                fontSize: 13,
                fontWeight: 500,
                color: k === '风险' ? RISK_COLOR[record.riskLevel] : COLORS.text,
                mt: 0.25,
              }}
              noWrap
            >
              {v}
            </Typography>
          </Box>
        ))}
      </Box>
      <Stack direction="row" spacing={1}>
        <Button
          size="small"
          startIcon={<RefreshIcon sx={{ fontSize: 14 }} />}
          onClick={() => {
            startAnalysis(`请重新评估决策「${record.title}」：更新匹配度、风险与结论`)
            push('info', '已预置「重新评估」上下文')
          }}
          sx={{ fontSize: 12.5 }}
        >
          重新评估
        </Button>
        <Button
          size="small"
          startIcon={<AddIcon sx={{ fontSize: 14 }} />}
          onClick={() => setPage('applications')}
          sx={{ fontSize: 12.5 }}
        >
          加入投递
        </Button>
        <Button
          size="small"
          startIcon={<TimelineIcon sx={{ fontSize: 14 }} />}
          onClick={() => setPage('workbench')}
          sx={{ fontSize: 12.5 }}
        >
          查看时间线
        </Button>
      </Stack>
    </Box>
  )
}

/** AskUserQuestion 卡片：问题 + 选项；点击选项回填用户消息并标记已作答 */
function QuestionCardView({ card, messageId }: { card: QuestionCard; messageId: string }) {
  const answer = useAppStore((s) => s.answerQuestion)

  return (
    <Box
      sx={{
        mt: 1.5,
        p: 2,
        borderRadius: '10px',
        border: `1px solid ${COLORS.border}`,
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

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const [showThinking, setShowThinking] = useState(false)

  // system 角色（权限审批/自动放行反馈）：居中浅注，非气泡
  if (msg.role === 'system') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', mb: 1.5 }}>
        <Typography
          sx={{
            fontSize: 12,
            color: COLORS.textMuted,
            bgcolor: COLORS.bgHover,
            px: 1.5,
            py: 0.5,
            borderRadius: '999px',
          }}
        >
          {msg.content}
        </Typography>
      </Box>
    )
  }

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
        mb: 2,
      }}
    >
      <Box sx={{ maxWidth: msg.role === 'user' ? '70%' : '85%' }}>
        {msg.role === 'assistant' && msg.isThinking && (
          <Box
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.75,
              px: 1.5,
              py: 0.5,
              mb: 0.75,
              borderRadius: '999px',
              bgcolor: COLORS.bgHover,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            <Typography sx={{ fontSize: 12, fontFamily: COLORS.mono, color: COLORS.textMuted }}>
              思考中
            </Typography>
            <Box sx={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              {[0, 1, 2].map((i) => (
                <Box
                  key={i}
                  sx={{
                    width: 4,
                    height: 4,
                    borderRadius: '50%',
                    bgcolor: COLORS.textMuted,
                    animation: `cos-thinking-dot 1.2s ease-in-out ${i * 0.2}s infinite`,
                  }}
                />
              ))}
            </Box>
          </Box>
        )}

        {msg.role === 'assistant' && msg.thinking && (
          <Box sx={{ mb: 0.75 }}>
            <Button
              size="small"
              onClick={() => setShowThinking((v) => !v)}
              endIcon={
                showThinking ? (
                  <ExpandLessIcon sx={{ fontSize: 14 }} />
                ) : (
                  <ExpandMoreIcon sx={{ fontSize: 14 }} />
                )
              }
              sx={{ fontSize: 12.5, color: COLORS.textMuted, minWidth: 0, px: 1 }}
            >
              思考过程
            </Button>
            <Collapse in={showThinking}>
              <Box
                sx={{
                  p: 1.25,
                  borderRadius: '8px',
                  bgcolor: COLORS.bgHover,
                  border: `1px solid ${COLORS.border}`,
                  fontFamily: COLORS.mono,
                  fontSize: 12,
                  color: COLORS.textMuted,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {msg.thinking}
              </Box>
            </Collapse>
          </Box>
        )}

        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <Stack direction="row" spacing={0.75} sx={{ mb: 0.75, flexWrap: 'wrap', gap: 0.5 }}>
            {msg.toolCalls.map((t) => (
              <Chip
                key={t.name}
                size="small"
                icon={<BuildIcon sx={{ fontSize: '12px !important' }} />}
                label={
                  t.status === 'waiting_approval'
                    ? `${t.name} · 等待授权`
                    : t.status === 'denied'
                      ? `${t.name} · 已拒绝`
                      : t.name
                }
                sx={{
                  height: 22,
                  fontSize: 11.5,
                  fontFamily: COLORS.mono,
                  bgcolor:
                    t.status === 'done'
                      ? alpha(COLORS.riskLow, 0.1)
                      : t.status === 'waiting_approval'
                        ? alpha(COLORS.riskMedium, 0.12)
                        : t.status === 'denied'
                          ? alpha(COLORS.riskHigh, 0.1)
                          : COLORS.bgHover,
                  border: `1px solid ${
                    t.status === 'done'
                      ? alpha(COLORS.riskLow, 0.25)
                      : t.status === 'waiting_approval'
                        ? alpha(COLORS.riskMedium, 0.3)
                        : t.status === 'denied'
                          ? alpha(COLORS.riskHigh, 0.3)
                          : COLORS.border
                  }`,
                  color:
                    t.status === 'done'
                      ? COLORS.riskLow
                      : t.status === 'waiting_approval'
                        ? COLORS.riskMedium
                        : t.status === 'denied'
                          ? COLORS.riskHigh
                          : COLORS.textSecondary,
                }}
              />
            ))}
          </Stack>
        )}

        {msg.error ? (
          <Box
            sx={{
              px: 2,
              py: 1.5,
              borderRadius: '12px 12px 12px 4px',
              bgcolor: alpha(RISK_COLOR.high, 0.08),
              border: `1px solid ${alpha(RISK_COLOR.high, 0.3)}`,
            }}
          >
            <Typography sx={{ fontSize: 12, fontWeight: 600, color: RISK_COLOR.high, mb: 0.5 }}>
              Agent 运行错误 · {msg.error.code}
            </Typography>
            <Typography sx={{ fontSize: 13, lineHeight: 1.6, color: COLORS.text, whiteSpace: 'pre-wrap' }}>
              {msg.error.message}
            </Typography>
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mt: 1 }}>
              {msg.error.retryable ? '可重新发送消息重试。' : '请调整后重新发送消息。'}
            </Typography>
          </Box>
        ) : msg.question ? (
          <QuestionCardView card={msg.question} messageId={msg.id} />
        ) : (
          <Box
            sx={{
              px: 2,
              py: 1.5,
              borderRadius: msg.role === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
              bgcolor: msg.role === 'user' ? COLORS.accentMuted : COLORS.bgElevated,
              border: `1px solid ${
                msg.role === 'user' ? alpha(COLORS.accent, 0.25) : COLORS.border
              }`,
            }}
          >
            {msg.role === 'user' ? (
              <Typography sx={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                {msg.content}
              </Typography>
            ) : (
              <MarkdownView content={msg.content} />
            )}
            {msg.reportCard && <ReportCard record={msg.reportCard} />}
          </Box>
        )}
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 0.5, px: 0.5 }}>
          {dayjs(msg.timestamp).format('HH:mm:ss')}
        </Typography>
      </Box>
    </Box>
  )
}

/** 当前理解草稿（Initialization Shell 右侧）：采集中的候选预览空壳——确认逻辑切片 2 接引擎 */
function UnderstandingDraft() {
  return (
    <Box
      sx={{
        width: 264,
        flexShrink: 0,
        borderLeft: `1px solid ${COLORS.border}`,
        bgcolor: COLORS.bg,
        p: 2,
        overflow: 'auto',
      }}
    >
      <Typography sx={{ fontSize: 12, fontWeight: 600, color: COLORS.textSecondary, mb: 0.75 }}>
        当前理解草稿
      </Typography>
      <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, lineHeight: 1.6, mb: 2 }}>
        采集中的信息将在这里累积，你确认后才会写入档案。
      </Typography>
      <Box
        sx={{
          p: 1.5,
          borderRadius: '8px',
          border: `1px dashed ${COLORS.borderStrong}`,
          textAlign: 'center',
        }}
      >
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>还没有候选信息</Typography>
      </Box>
    </Box>
  )
}

export function AgentPage() {
  const sessions = useAppStore((s) => s.sessions)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const draft = useAppStore((s) => s.agentDraft)
  const setDraft = useAppStore((s) => s.setAgentDraft)
  const send = useAppStore((s) => s.sendAgentMessage)
  const setPage = useAppStore((s) => s.setPage)
  const person = useAppStore((s) => s.currentPerson())
  const locateTarget = useAppStore((s) => s.locateTarget)
  const setLocateTarget = useAppStore((s) => s.setLocateTarget)
  const simulatePermissionRequest = useAppStore((s) => s.simulatePermissionRequest)
  const simulateQuestionRequest = useAppStore((s) => s.simulateQuestionRequest)
  const activeTask = useAppStore((s) => s.activeTask)
  const cancelCurrentTask = useAppStore((s) => s.cancelCurrentTask)
  const agentSettings = useAppStore((s) => s.agentSettings)
  const setAgentModel = useAppStore((s) => s.setAgentModel)
  const push = useToastStore((s) => s.push)
  const [demoAnchor, setDemoAnchor] = useState<HTMLElement | null>(null)

  /** Initialization Shell：当前人初始化中 → 全屏初始化空间（左对话 + 右理解草稿） */
  const initMode = person.initStatus === 'pending'

  const session = sessions.find((s) => s.id === currentSessionId)
  const taskRunning = activeTask !== null && activeTask.sessionId === currentSessionId
  /** 切换器选项 = 已启用服务商的勾选模型（设置页卡片管理） */
  const providerModels = useAppStore((s) => s.agentSettings.providers)
    .filter((p) => p.enabled)
    .flatMap((p) => p.models ?? [])

  useEffect(() => {
    if (!locateTarget) return
    document
      .getElementById(`report-${locateTarget}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setLocateTarget(null)
  }, [locateTarget, setLocateTarget, session?.messages.length])

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {initMode ? (
        <Stack
          direction="row"
          sx={{ alignItems: 'center', px: 2, py: 1.25, borderBottom: `1px solid ${COLORS.border}` }}
        >
          <Button
            size="small"
            startIcon={<ArrowBackIcon sx={{ fontSize: 15 }} />}
            onClick={() => setPage('workbench')}
            sx={{ fontSize: 12.5, color: COLORS.textSecondary, mr: 1.5, flexShrink: 0 }}
          >
            稍后继续
          </Button>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>
              正在建立「{person.name}」的职业档案
            </Typography>
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mt: 0.25 }}>
              {person.sourceMode === 'resume' ? '简历通道' : '访谈通道'} · 正在了解你的经历
            </Typography>
          </Box>
        </Stack>
      ) : (
        <Stack
          direction="row"
          sx={{ alignItems: 'center', px: 2, py: 1.25, borderBottom: `1px solid ${COLORS.border}` }}
        >
          <Typography sx={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em', flex: 1 }}>
            {session?.title ?? '决策 Agent'}
          </Typography>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            {/* 会话切换在侧栏（AgentSidebar）——此处只留演示入口 */}
            <Button
              size="small"
              onClick={(e) => setDemoAnchor(e.currentTarget)}
              sx={{ fontSize: 12, color: COLORS.textSecondary }}
            >
              演示交互
            </Button>
          </Stack>
        </Stack>
      )}

      {!initMode && <ContextCapsule />}

      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <Box sx={{ flex: 1, overflow: 'auto', px: 3, py: 2.5 }} aria-live="polite">
          <Box sx={{ maxWidth: initMode ? 720 : 800, mx: 'auto' }}>
            {!session?.messages.length ? (
              <Box sx={{ textAlign: 'center', mt: 10 }}>
                <Typography sx={{ fontSize: 15, fontWeight: 500, mb: 1 }}>开始深度决策对话</Typography>
                <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, mb: 3 }}>
                  Agent 会读取 profile / decision / company DB，输出建议并确认式写入决策记录
                </Typography>
                <Stack
                  direction="row"
                  spacing={1}
                  useFlexGap
                  sx={{ justifyContent: 'center', flexWrap: 'wrap' }}
                >
                  {['分析转行可行性', '对比深圳 vs 上海', '生成目标企业列表', '评估 JD 匹配度'].map(
                    (q) => (
                      <Chip
                        key={q}
                        label={q}
                        onClick={() => {
                          setDraft(q)
                          send(q)
                        }}
                        sx={{
                          cursor: 'pointer',
                          bgcolor: COLORS.bgHover,
                          border: `1px solid ${COLORS.border}`,
                          '&:hover': { borderColor: COLORS.accent, color: COLORS.accent },
                        }}
                      />
                    ),
                  )}
                </Stack>
              </Box>
            ) : (
              session.messages.map((m) => <MessageBubble key={m.id} msg={m} />)
            )}
          </Box>
        </Box>
        {initMode && <UnderstandingDraft />}
      </Box>

      <Box sx={{ px: 3, py: 2, borderTop: `1px solid ${COLORS.border}` }}>
        <Box sx={{ maxWidth: initMode ? 720 : 800, mx: 'auto' }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-end' }}>
            <TextField
              fullWidth
              multiline
              maxRows={6}
              placeholder={
                taskRunning
                  ? '任务运行中…（可点 ⏹ 停止）'
                  : initMode
                    ? '回复 Agent 的问题…（Enter 发送，Shift+Enter 换行）'
                    : '描述你的决策问题…（Enter 发送，Shift+Enter 换行）'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
                  e.preventDefault()
                  send(draft.trim())
                }
              }}
              disabled={taskRunning}
              sx={{
                '& .MuiOutlinedInput-root': {
                  bgcolor: COLORS.bgElevated,
                  fontSize: 13,
                },
              }}
            />
            {taskRunning && (
              <Tooltip title="停止当前 Agent 任务">
                <IconButton
                  size="small"
                  aria-label="停止当前 Agent 任务"
                  onClick={() => {
                    cancelCurrentTask()
                    push('info', '已停止 Agent 任务')
                  }}
                  sx={{
                    borderRadius: '8px',
                    width: 40,
                    height: 40,
                    color: COLORS.riskHigh,
                    border: `1px solid ${COLORS.border}`,
                    '&:hover': { bgcolor: alpha(COLORS.riskHigh, 0.1) },
                  }}
                >
                  <StopCircleIcon sx={{ fontSize: 19 }} />
                </IconButton>
              </Tooltip>
            )}
            <IconButton
              disabled={!draft.trim() || taskRunning}
              onClick={() => draft.trim() && send(draft.trim())}
              sx={{
                bgcolor: COLORS.accent,
                color: COLORS.onAccent,
                borderRadius: '8px',
                width: 40,
                height: 40,
                '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 },
                '&.Mui-disabled': { bgcolor: COLORS.bgHover, color: COLORS.textMuted },
              }}
            >
              <SendIcon sx={{ fontSize: 18 }} />
            </IconButton>
            {!initMode && (
              <ModelSelect
                compact
                value={agentSettings.model}
                onChange={(m) => setAgentModel(m)}
                options={providerModels}
                freeInput={false}
              />
            )}
          </Stack>
        </Box>
      </Box>

      <Menu anchorEl={demoAnchor} open={Boolean(demoAnchor)} onClose={() => setDemoAnchor(null)}>
        <MenuItem
          onClick={() => {
            setDemoAnchor(null)
            simulatePermissionRequest(
              'search_company_db',
              '查询公司库中的匹配企业（只读操作）：读取 companies DB 并按匹配度排序',
            )
            push('info', '演示模式：权限事件将在真实 LLM 流接入后自动触发')
          }}
        >
          模拟权限请求
        </MenuItem>
        <MenuItem
          onClick={() => {
            setDemoAnchor(null)
            simulateQuestionRequest('请选择本次分析的重点方向', [
              '深圳 vs 上海对比',
              '机器人企业筛选',
              'JD 匹配评估',
              '综合结论',
            ])
            push('info', '演示模式：提问卡片将在真实 LLM 流接入后由 Agent 自动发起')
          }}
        >
          模拟提问卡片
        </MenuItem>
      </Menu>
    </Box>
  )
}
