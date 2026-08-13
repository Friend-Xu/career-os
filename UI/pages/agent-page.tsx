import {
  Box,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
import LockIcon from '@mui/icons-material/Lock'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { deriveAgentPhase, formatElapsed, PHASE_META } from '../store/agent-phase'
import type { StreamPhase } from '../store/agent-phase'
import { ModelSelect } from '../components/model-select'
import { MarkdownView } from '../components/markdown-view'
import { QuestionCardView } from '../components/agent/question-card-view'
import { useSessionScroll } from '../hooks/use-session-scroll'
import { belongsToPerson } from '../utils/ownership'
import { decisionMatchesJob } from '../utils/decision-job-link'
import { alpha, COLORS, RISK_COLOR, RISK_LABEL } from '../data/constants'
import type { ChatMessage, DecisionRecord } from '../types'

function ContextCapsule() {
  const person = useAppStore((s) => s.currentPerson())
  const decisions = useAppStore((s) => s.decisions)

  // ADR-008：探索记录（决策链语义降级）——该人决策总数，非阶段推进
  const exploreCount = decisions.filter((d) => belongsToPerson(d, person)).length

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
  const jobs = useAppStore((s) => s.jobs)
  const applications = useAppStore((s) => s.applications)
  const createApplication = useAppStore((s) => s.createApplication)

  // ADR-019 Step 4.3：决策 → 行动入口。仅 JD 分析类决策（subjectId 直连，存量标题回退）可关联岗位发起投递
  const linkedJob = jobs.find((j) => decisionMatchesJob(record, j))
  const existingApp = linkedJob ? applications.find((a) => a.jobId === linkedJob.id) : undefined

  const handleStartApply = () => {
    if (!linkedJob) {
      push('warning', '该决策未关联岗位——仅岗位分析类决策可发起投递')
      return
    }
    if (existingApp) {
      push('info', '该岗位已有投递记录——到投递管理推进状态')
      setPage('applications')
      return
    }
    void createApplication({ jobId: linkedJob.id, decisionId: record.id }).then(
      () => {
        push('success', `已发起投递流程：${linkedJob.company} · ${linkedJob.title}（准备投递）`)
        setPage('applications')
      },
      (err) => push('warning', `发起投递失败：${err instanceof Error ? err.message : String(err)}`),
    )
  }

  return (
    <Box
      id={`report-${record.id}`}
      sx={{
        mt: 1.5,
        p: 2,
        borderRadius: '10px',
        border: `1px solid ${alpha(COLORS.border, 0.8)}`,
        boxShadow: COLORS.cardShadow,
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
      {record.payload?.type === 'city' && (
        <Box sx={{ mb: 1.5 }}>
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 0.5 }}>城市评估明细</Typography>
          <Stack spacing={0.5}>
            {record.payload.cities.map((c) => (
              <Box key={c.name} sx={{ p: 1, borderRadius: '6px', bgcolor: COLORS.bgHover }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>{c.name}</Typography>
                  <Typography sx={{ fontSize: 12.5, fontFamily: COLORS.mono, color: COLORS.accent }}>
                    {c.score}/100
                  </Typography>
                  {c.confidence && (
                    <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>置信{c.confidence}</Typography>
                  )}
                </Stack>
                {(c.strengths.length > 0 || c.risks.length > 0) && (
                  <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 0.25, lineHeight: 1.5 }}>
                    {c.strengths.length > 0 && `优势：${c.strengths.join('、')}`}
                    {c.strengths.length > 0 && c.risks.length > 0 && '　'}
                    {c.risks.length > 0 && `风险：${c.risks.join('、')}`}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
        </Box>
      )}
      {record.payload?.type === 'direction' && (
        <Box sx={{ mb: 1.5 }}>
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 0.5 }}>方向评估明细</Typography>
          <Stack spacing={0.5}>
            {record.payload.directions.map((d) => (
              <Box key={d.name} sx={{ p: 1, borderRadius: '6px', bgcolor: COLORS.bgHover }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>{d.name}</Typography>
                  <Typography sx={{ fontSize: 12.5, fontFamily: COLORS.mono, color: COLORS.accent }}>
                    {d.match}%
                  </Typography>
                  {d.confidence && (
                    <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>置信{d.confidence}</Typography>
                  )}
                </Stack>
                {(d.strengths.length > 0 || d.risks.length > 0) && (
                  <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 0.25, lineHeight: 1.5 }}>
                    {d.strengths.length > 0 && `优势：${d.strengths.join('、')}`}
                    {d.strengths.length > 0 && d.risks.length > 0 && '　'}
                    {d.risks.length > 0 && `风险：${d.risks.join('、')}`}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
        </Box>
      )}
      <Stack direction="row" spacing={1}>
        <Button
          size="small"
          startIcon={<RefreshIcon sx={{ fontSize: 14 }} />}
          onClick={() => {
            startAnalysis(`请重新评估决策「${record.title}」：更新匹配度、风险与结论`, {
              taskType: 'decision_reassessment',
              contextRefs: [{ type: 'decision', id: record.id }],
              outputTarget: 'decision',
            })
            push('info', '已预置「重新评估」上下文')
          }}
          sx={{ fontSize: 12.5 }}
        >
          重新评估
        </Button>
        <Button
          size="small"
          startIcon={<AddIcon sx={{ fontSize: 14 }} />}
          onClick={handleStartApply}
          disabled={!linkedJob}
          sx={{ fontSize: 12.5 }}
        >
          {existingApp ? '查看投递' : '开始投递'}
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

/** 任务类型 → 中文名（P2 状态条显示；startAgentTask 的 type 是英文 key） */
const TASK_TYPE_LABEL: Record<string, string> = {
  'career-direction': '探索职业方向',
  'decision-reassessment': '重新评估',
}

/** 流式消息的任务状态条：绑定 activeTask（与停止按钮同源），任务结束前持续显示不闪灭 */
function MessageBubble({
  msg,
  stream,
}: {
  msg: ChatMessage
  stream?: { startedAt: number; now: number; phase: StreamPhase; taskType?: string }
}) {
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
        {msg.role === 'assistant' && stream && (
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
            <Box
              sx={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                bgcolor: COLORS.accent,
                animation: 'cos-thinking-dot 1.2s ease-in-out infinite',
              }}
            />
            <Typography sx={{ fontSize: 12, fontFamily: COLORS.mono, color: COLORS.textSecondary }}>
              {stream.phase === 'waiting_input'
                ? '等待你的回答'
                : `${stream.taskType ? `${TASK_TYPE_LABEL[stream.taskType] ?? stream.taskType} · ` : ''}${PHASE_META[stream.phase]} · ${formatElapsed(stream.now - stream.startedAt)}`}
            </Typography>
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
              AI 助手运行错误 · {msg.error.code}
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
              // 隐藏 Agent 候选标记行（切片 2.2 内部协议，候选投影在右侧「正在收集的信息」）
              <MarkdownView content={msg.content.replace(/^候选标记：.*$/gm, '')} />
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

/** 正在收集的信息（切片 2.2/2.3：extraction/candidates.md 投影——候选裁决入口，确认动作 = resolution 事件） */
function UnderstandingDraft() {
  const candidates = useAppStore((s) => s.initCandidates)
  const resolve = useAppStore((s) => s.resolveInitCandidate)
  const [editingId, setEditingId] = useState<string | null>(null)
  const pending = candidates.filter((c) => c.status === 'pending')
  const confirmed = candidates.filter((c) => c.status === 'confirmed')
  const groups = ['education', 'experience', 'skill', 'constraint', 'interest'] as const
  const labelMap: Record<string, string> = {
    education: '教育经历',
    experience: '工作/项目经历',
    skill: '技能',
    constraint: '偏好与约束',
    interest: '关注方向',
  }
  const sourceLabel = (s: string) => (s === 'resume' ? '简历' : '你的描述')

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
        正在收集的信息
      </Typography>
      <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, lineHeight: 1.6, mb: 1.5 }}>
        待确认 {pending.length} 条 · 已确认 {confirmed.length} 条
      </Typography>
      {pending.length === 0 && confirmed.length === 0 ? (
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
      ) : (
        groups.map((g) => {
          const items = pending.filter((c) => c.category === g)
          if (items.length === 0) return null
          return (
            <Box key={g} sx={{ mb: 1.5 }}>
              <Typography sx={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, mb: 0.5 }}>
                {labelMap[g]}
              </Typography>
              {items.map((c) => (
                <Box
                  key={c.id}
                  sx={{
                    px: 1.25,
                    py: 1,
                    mb: 0.5,
                    borderRadius: '8px',
                    border: `1px solid ${alpha(COLORS.border, 0.8)}`,
                    boxShadow: COLORS.cardShadow,
                    bgcolor: COLORS.bgElevated,
                  }}
                >
                  <Typography sx={{ fontSize: 12.5, color: COLORS.text, lineHeight: 1.5 }}>
                    {c.content}
                  </Typography>
                  {c.education && (
                    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                      {[c.education.school, c.education.degree, c.education.major]
                        .filter(Boolean)
                        .map((v) => (
                          <Chip key={v as string} size="small" label={v as string} sx={{ height: 18, fontSize: 10.5, bgcolor: COLORS.bgHover, color: COLORS.textSecondary }} />
                        ))}
                      {c.education.startYear && c.education.endYear && (
                        <Chip size="small" label={`${c.education.startYear}-${c.education.endYear}`} sx={{ height: 18, fontSize: 10.5, bgcolor: COLORS.bgHover, color: COLORS.textMuted }} />
                      )}
                    </Stack>
                  )}
                  <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mt: 0.5 }}>
                    来源：{sourceLabel(c.source)} · 待确认
                  </Typography>
                  {editingId === c.id ? (
                    <TextField
                      size="small"
                      fullWidth
                      autoFocus
                      defaultValue={c.content}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
                          void resolve(c.id, 'modified', (e.target as HTMLInputElement).value.trim())
                          setEditingId(null)
                        }
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      sx={{ mt: 0.75, '& .MuiOutlinedInput-root': { fontSize: 12 } }}
                    />
                  ) : (
                    <Stack direction="row" spacing={0.5} sx={{ mt: 0.75 }}>
                      <Button
                        size="small"
                        onClick={() => void resolve(c.id, 'confirmed')}
                        sx={{
                          minWidth: 0,
                          px: 1,
                          py: 0.25,
                          fontSize: 11.5,
                          color: COLORS.riskLow,
                          border: `1px solid ${alpha(COLORS.riskLow, 0.35)}`,
                        }}
                      >
                        确认
                      </Button>
                      <Button
                        size="small"
                        onClick={() => setEditingId(c.id)}
                        sx={{
                          minWidth: 0,
                          px: 1,
                          py: 0.25,
                          fontSize: 11.5,
                          color: COLORS.textSecondary,
                          border: `1px solid ${COLORS.border}`,
                        }}
                      >
                        修改
                      </Button>
                      <Button
                        size="small"
                        onClick={() => void resolve(c.id, 'rejected')}
                        sx={{
                          minWidth: 0,
                          px: 1,
                          py: 0.25,
                          fontSize: 11.5,
                          color: COLORS.textMuted,
                          border: `1px solid ${COLORS.border}`,
                        }}
                      >
                        拒绝
                      </Button>
                    </Stack>
                  )}
                </Box>
              ))}
            </Box>
          )
        })
      )}
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
  const initSessionId = useAppStore((s) => s.initSessionId)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const startInitializationSession = useAppStore((s) => s.startInitializationSession)
  const simulatePermissionRequest = useAppStore((s) => s.simulatePermissionRequest)
  const simulateQuestionRequest = useAppStore((s) => s.simulateQuestionRequest)
  const activeTask = useAppStore((s) => s.sessionTasks[currentSessionId])
  const cancelCurrentTask = useAppStore((s) => s.cancelCurrentTask)
  const agentSettings = useAppStore((s) => s.agentSettings)
  const setAgentModel = useAppStore((s) => s.setAgentModel)
  const push = useToastStore((s) => s.push)
  const [demoAnchor, setDemoAnchor] = useState<HTMLElement | null>(null)

  /** Initialization Shell：当前人初始化中 → 全屏初始化空间（左对话 + 右理解草稿） */
  const initMode = person.initStatus === 'pending'
  const completeInitialization = useAppStore((s) => s.completeInitialization)
  const [completeOpen, setCompleteOpen] = useState(false)

  const session = sessions.find((s) => s.id === currentSessionId)
  const taskRunning = activeTask !== undefined
  /** 心跳时间源（store 每秒 tick；消息内状态条/顶部状态条/会话列表共用） */
  const now = useAppStore((s) => s.now)
  /** Person Capability Gate：当前人初始化中且非初始化会话 → 输入锁定（历史可看，发送前拦截） */
  const inputLocked = person.initStatus === 'pending' && currentSessionId !== initSessionId
  /** 切换器选项 = 已启用服务商的勾选模型（设置页卡片管理） */
  const providerModels = useAppStore((s) => s.agentSettings.providers)
    .filter((p) => p.enabled)
    .flatMap((p) => p.models ?? [])

  /** 任务运行中 = 会话最后一条 assistant 消息承载流式状态（提问挂起时是未答卡片） */
  const streamMsg = taskRunning ? session?.messages.at(-1) : undefined
  const stream: { startedAt: number; now: number; phase: StreamPhase; taskType?: string } | undefined =
    streamMsg?.role === 'assistant' && activeTask
      ? {
          startedAt: activeTask.startedAt,
          now,
          taskType: activeTask.type,
          phase:
            streamMsg.question && !streamMsg.question.answered
              ? 'waiting_input'
              : deriveAgentPhase(streamMsg),
        }
      : undefined

  /** 会话滚动：打开/切会话滚到底；流式近底跟随、远底阅读保护（滚动位置是 View 层状态） */
  const { containerRef: scrollRef, scrollToLatest, hasNewContent, newCount } = useSessionScroll({
    sessionId: currentSessionId,
    messageCount: session?.messages.length ?? 0,
    contentTick: streamMsg?.content.length ?? 0,
    streaming: taskRunning,
  })

  useEffect(() => {
    if (!locateTarget) return
    document
      .getElementById(`report-${locateTarget}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setLocateTarget(null)
  }, [locateTarget, setLocateTarget, session?.messages.length])

  // 初始化模式：进入时从引擎重拉候选（刷新/重进入恢复右侧「正在收集的信息」；
  // 依赖 engineStatus——连接完成前跳过，连接后自动重拉）
  const engineStatus = useAppStore((s) => s.engineStatus)
  useEffect(() => {
    if (initMode && person.personId && engineStatus === 'connected') {
      void useAppStore.getState().loadInitCandidates(person.personId)
    }
  }, [initMode, person.personId, engineStatus])

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
          <Button
            size="small"
            variant="contained"
            onClick={() => setCompleteOpen(true)}
            sx={{ flexShrink: 0, ml: 1.5, fontSize: 12.5 }}
          >
            进入职业档案
          </Button>
        </Stack>
      ) : (
        <Stack
          direction="row"
          sx={{ alignItems: 'center', px: 2, py: 1.25, borderBottom: `1px solid ${COLORS.border}` }}
        >
          <Typography sx={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em', flex: 1 }}>
            {session?.title ?? '决策助手'}
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

      {/* 顶部任务状态条：滚动时始终可见（消息内状态条随内容滚动）——只展示当前会话任务 */}
      {stream && (
        <Box
          sx={{
            px: 3,
            py: 0.75,
            borderBottom: `1px solid ${COLORS.border}`,
            bgcolor: COLORS.bgElevated,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
          }}
        >
          <Box
            sx={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              bgcolor: COLORS.accent,
              animation: 'cos-thinking-dot 1.2s ease-in-out infinite',
            }}
          />
          <Typography sx={{ fontSize: 12, fontFamily: COLORS.mono, color: COLORS.textSecondary }}>
            {stream.phase === 'waiting_input'
              ? '等待你的回答'
              : `${PHASE_META[stream.phase]} · ${formatElapsed(stream.now - stream.startedAt)}`}
          </Typography>
        </Box>
      )}

      {!initMode && <ContextCapsule />}

      {/* 完成初始化确认：用户声明基础信息达到可用状态（非封闭，之后可随时补充/重置） */}
      <Dialog open={completeOpen} onClose={() => setCompleteOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>
          将「{person.name}」的职业档案标记为可用？
        </DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, lineHeight: 1.7 }}>
            基础信息已建立后即可正常使用档案视图（决策 / 投递 / 简历中心）。
            档案不是封闭的——之后仍可随时补充或重置初始化。
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button size="small" color="inherit" onClick={() => setCompleteOpen(false)} sx={{ fontSize: 12.5 }}>
            稍后再说
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => {
              setCompleteOpen(false)
              void completeInitialization(person.id)
            }}
            sx={{ fontSize: 12.5 }}
          >
            进入职业档案
          </Button>
        </DialogActions>
      </Dialog>

      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <Box sx={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <Box ref={scrollRef} sx={{ height: '100%', overflow: 'auto', px: 3, py: 2.5 }} aria-live="polite">
            <Box sx={{ maxWidth: initMode ? 720 : 800, mx: 'auto' }}>
            {!session?.messages.length ? (
              <Box sx={{ textAlign: 'center', mt: 10 }}>
                <Typography sx={{ fontSize: 15, fontWeight: 500, mb: 1 }}>开始深度决策对话</Typography>
                <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, mb: 3 }}>
                  助手会读取画像 / 决策 / 公司数据，输出建议并确认式写入决策记录
                </Typography>
                <Stack spacing={1} sx={{ alignItems: 'center' }}>
                  <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, letterSpacing: '0.05em' }}>
                    推荐开始
                  </Typography>
                  <Stack
                    direction="row"
                    spacing={1}
                    useFlexGap
                    sx={{ justifyContent: 'center', flexWrap: 'wrap' }}
                  >
                    {['帮我探索职业方向', '分析我的竞争优势', '评估我的下一步选择'].map(
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
                </Stack>
              </Box>
            ) : (
              session.messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  msg={m}
                  stream={m.id === streamMsg?.id ? stream : undefined}
                />
              ))
            )}
          </Box>
        </Box>
        {hasNewContent && newCount > 0 && (
          <Button
            size="small"
            onClick={scrollToLatest}
            sx={{
              position: 'absolute',
              bottom: 16,
              right: 24,
              fontSize: 12.5,
              color: COLORS.textSecondary,
              bgcolor: COLORS.bgElevated,
              border: `1px solid ${COLORS.borderStrong}`,
              boxShadow: COLORS.cardShadow,
              borderRadius: '999px',
              '&:hover': { bgcolor: COLORS.bgHover, color: COLORS.text },
            }}
          >
            ↓ {newCount} 条新内容
          </Button>
        )}
        {initMode && <UnderstandingDraft />}
        </Box>
      </Box>

      <Box sx={{ px: 3, py: 2, borderTop: `1px solid ${COLORS.border}` }}>
        <Box sx={{ maxWidth: initMode ? 720 : 800, mx: 'auto' }}>
          {inputLocked && (
            <Stack
              direction="row"
              spacing={1}
              sx={{
                alignItems: 'center',
                mb: 1,
                px: 1.5,
                py: 0.75,
                borderRadius: '8px',
                bgcolor: alpha(COLORS.riskMedium, 0.08),
                border: `1px solid ${alpha(COLORS.riskMedium, 0.25)}`,
              }}
            >
              <LockIcon sx={{ fontSize: 14, color: COLORS.riskMedium }} />
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, flex: 1 }}>
                「{person.name}」的档案正在初始化，该会话已锁定——历史可查看，完成基础档案后可继续对话
              </Typography>
              <Button
                size="small"
                onClick={() => {
                  // 初始化会话存在 → 直接切回；刷新后不存在（会话不持久化）→ 重建初始化空间
                  if (initSessionId) {
                    setCurrentSession(initSessionId)
                  } else {
                    startInitializationSession({
                      personName: person.name,
                      sourceMode: person.sourceMode ?? 'interview',
                      interests: person.initialInterest,
                      personId: person.personId,
                    })
                  }
                }}
                sx={{ fontSize: 12, flexShrink: 0 }}
              >
                继续初始化
              </Button>
            </Stack>
          )}
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-end' }}>
            <TextField
              fullWidth
              multiline
              maxRows={6}
              placeholder={
                taskRunning
                  ? '任务运行中…（可点 ⏹ 停止）'
                  : inputLocked
                    ? `完成「${person.name}」初始化后可继续对话`
                    : initMode
                      ? '回复 Agent 的问题…（Enter 发送，Shift+Enter 换行）'
                      : '描述你的决策问题…（Enter 发送，Shift+Enter 换行）'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && draft.trim() && !inputLocked) {
                  e.preventDefault()
                  send(draft.trim())
                }
              }}
              disabled={taskRunning || inputLocked}
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
              disabled={!draft.trim() || taskRunning || inputLocked}
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
