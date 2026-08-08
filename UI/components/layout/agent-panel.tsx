import {
  Box,
  Button,
  IconButton,
  Stack,
  TextField,
  Typography,
  Collapse,
  Tooltip,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import OpenInFullIcon from '@mui/icons-material/OpenInFull'
import SendIcon from '@mui/icons-material/Send'
import StopCircleIcon from '@mui/icons-material/StopCircle'
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import { useEffect, useRef } from 'react'
import dayjs from 'dayjs'
import { useAppStore } from '../../store/app-store'
import { useToastStore } from '../../store/toast-store'
import { deriveAgentPhase, formatElapsed, PHASE_META } from '../../store/agent-phase'
import type { StreamPhase } from '../../store/agent-phase'
import { NEXT_ACTION } from '../../data/mock-data'
import { COLORS, EASE, LAYOUT, RISK_COLOR, alpha } from '../../data/constants'
import { MarkdownView } from '../markdown-view'
import { QuestionCardView } from '../agent/question-card-view'
import { useSessionScroll } from '../../hooks/use-session-scroll'
import { belongsToPerson } from '../../utils/ownership'
import type { DecisionRecord } from '../../types'

export function AgentPanel() {
  const open = useAppStore((s) => s.agentPanelOpen)
  const toggle = useAppStore((s) => s.toggleAgentPanel)
  const draft = useAppStore((s) => s.agentDraft)
  const setDraft = useAppStore((s) => s.setAgentDraft)
  const send = useAppStore((s) => s.sendAgentMessage)
  const addDecision = useAppStore((s) => s.addDecision)
  const expandToFull = useAppStore((s) => s.expandToFullAgent)
  const sessions = useAppStore((s) => s.sessions)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const pendingPrompt = useAppStore((s) => s.pendingPrompt)
  const activeTask = useAppStore((s) => s.sessionTasks[currentSessionId])
  const now = useAppStore((s) => s.now)
  const initSessionId = useAppStore((s) => s.initSessionId)
  const cancelCurrentTask = useAppStore((s) => s.cancelCurrentTask)
  const push = useToastStore((s) => s.push)
  const inputRef = useRef<HTMLInputElement>(null)
  const person = useAppStore((s) => s.currentPerson())
  const decisions = useAppStore((s) => s.decisions)

  const session = sessions.find((s) => s.id === currentSessionId)
  /** 面板会话窗口 = 最近 10 条完整消息（完整会话在全屏页——顶部「更早消息」入口跳转） */
  const recentMessages = session?.messages.slice(-10) ?? []
  const totalMessages = session?.messages.length ?? 0
  const taskRunning = activeTask !== undefined
  /** Person Capability Gate：当前人初始化中且非初始化会话 → 输入锁定（发送前拦截） */
  const inputLocked = person.initStatus === 'pending' && currentSessionId !== initSessionId
  /** 流式消息（任务运行时 = 会话最后一条 assistant 消息；提问挂起时是未答卡片） */
  const streamMsg = taskRunning ? session?.messages.at(-1) : undefined
  const streamPhase: StreamPhase | undefined =
    streamMsg?.role === 'assistant' && activeTask
      ? streamMsg.question && !streamMsg.question.answered
        ? 'waiting_input'
        : deriveAgentPhase(streamMsg)
      : undefined
  /** streamPhase 非 undefined 时 activeTask 必非 null——提前取值供 JSX 引用 */
  const taskStartedAt = activeTask?.startedAt ?? 0
  /** 会话滚动：打开/切会话滚到底；流式近底跟随、远底阅读保护（滚动位置是 View 层状态） */
  const { containerRef: scrollRef, scrollToLatest, hasNewContent, newCount } = useSessionScroll({
    sessionId: currentSessionId,
    messageCount: session?.messages.length ?? 0,
    contentTick: streamMsg?.content.length ?? 0,
    streaming: taskRunning,
    open,
  })

  useEffect(() => {
    if (pendingPrompt && open) {
      inputRef.current?.focus()
    }
  }, [pendingPrompt, open])

  if (!open) return null

  return (
    <Box
      sx={{
        width: LAYOUT.agentPanel,
        minWidth: LAYOUT.agentPanel,
        borderLeft: `1px solid ${COLORS.border}`,
        bgcolor: COLORS.bgElevated,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 10,
        animation: `fade-in 0.25s ${EASE}`,
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: 'center',
          px: 2,
          py: 1.25,
          borderBottom: `1px solid ${COLORS.border}`,
          minHeight: 44,
        }}
      >
        <AutoAwesomeIcon sx={{ fontSize: 16, color: COLORS.accent }} />
        <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1 }}>AI 助手</Typography>
        <Tooltip title="展开到全屏决策助手">
          <IconButton size="small" onClick={expandToFull} sx={{ color: COLORS.textSecondary }}>
            <OpenInFullIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="折叠面板 ⌘B">
          <IconButton size="small" onClick={toggle} sx={{ color: COLORS.textSecondary }}>
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Stack>

      <Box sx={{ p: 1.5, pb: 0 }}>
        <Box
          sx={{
            p: 1.5,
            borderRadius: '8px',
            bgcolor: COLORS.accentMuted,
            border: `1px solid ${alpha(COLORS.accent, 0.25)}`,
          }}
        >
          <Typography
            sx={{
              fontSize: 11.5,
              color: COLORS.accent,
              fontWeight: 600,
              mb: 0.5,
              letterSpacing: '0.03em',
            }}
          >
            建议 · 下一步
          </Typography>
          <Typography sx={{ fontSize: 13, fontWeight: 500, mb: 0.5 }}>
            {NEXT_ACTION.title}
          </Typography>
          <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, lineHeight: 1.45 }}>
            当前阶段上下文：公司筛选 · 深圳 86 分 / 技能画像
          </Typography>
        </Box>
      </Box>

      {/* ADR-020 Commit F：本次分析依据 = contextBundle 投影（显式引用，UI 只投影不解释——
          展示 Agent 使用了哪些明确引用；自读不属于依据清单；空 bundle（开放探索）不显示）。
          原「已加载上下文」（agentContextFiles mock——Agent 能读什么的硬编码列表）已废弃，Step 4 移除 */}
      {session?.contextBundle && session.contextBundle.references.length > 0 && (
        <Box sx={{ px: 1.5, py: 1.25 }}>
          <Typography
            sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 0.75, letterSpacing: '0.04em' }}
          >
            本次分析依据
          </Typography>
          <Stack spacing={0.75}>
            {session.contextBundle.references.map((r) => (
              <Stack key={`${r.type}-${r.id}`} direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
                <CheckCircleOutlinedIcon sx={{ fontSize: 13, color: COLORS.riskLow, mt: 0.25 }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontSize: 12.5, color: COLORS.text, lineHeight: 1.4 }} noWrap>
                    {r.label ?? r.id}
                  </Typography>
                  <Typography sx={{ fontSize: 11, color: COLORS.textMuted, lineHeight: 1.4 }} noWrap>
                    {r.snapshot
                      ? `${r.snapshot.kind === 'version' ? `版本 ${r.snapshot.value}` : `更新于 ${r.snapshot.value}`} · `
                      : ''}
                    {r.provenance.label}
                  </Typography>
                </Box>
              </Stack>
            ))}
          </Stack>
        </Box>
      )}

      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
        {totalMessages > recentMessages.length && (
          <Box sx={{ px: 1.25, py: 0.75, borderBottom: `1px solid ${COLORS.border}` }}>
            <Button
              size="small"
              fullWidth
              onClick={expandToFull}
              sx={{
                fontSize: 11.5,
                color: COLORS.accent,
                bgcolor: COLORS.bgHover,
                borderRadius: '6px',
                '&:hover': { bgcolor: COLORS.bgActive },
              }}
            >
              ↑ 更早消息（{totalMessages - recentMessages.length}）· 查看完整会话 →
            </Button>
          </Box>
        )}
        <Box ref={scrollRef} sx={{ flex: 1, overflow: 'auto', px: 1.5, py: 1 }}>
          {recentMessages.length === 0 ? (
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, textAlign: 'center', mt: 4 }}>
              快捷对话 — 带当前阶段上下文
            </Typography>
          ) : (
            <Stack spacing={1.25}>
              {recentMessages.map((msg) => (
                <Box
                  key={msg.id}
                  sx={{
                    p: 1.25,
                    borderRadius: '8px',
                    bgcolor: msg.role === 'user' ? COLORS.bgHover : alpha(COLORS.accent, 0.08),
                    border: `1px solid ${
                      msg.role === 'user' ? COLORS.border : alpha(COLORS.accent, 0.15)
                    }`,
                  }}
                >
                  <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 0.5 }}>
                    {msg.role === 'user' ? '你' : '助手'} · {dayjs(msg.timestamp).format('HH:mm')}
                  </Typography>
                  {msg.role === 'user' ? (
                    <Typography
                      sx={{
                        fontSize: 13,
                        whiteSpace: 'pre-wrap',
                        lineHeight: 1.6,
                        color: COLORS.text,
                      }}
                    >
                      {msg.content}
                    </Typography>
                  ) : msg.error ? (
                    <Box
                      sx={{
                        p: 1,
                        borderRadius: '6px',
                        bgcolor: alpha(RISK_COLOR.high, 0.08),
                        border: `1px solid ${alpha(RISK_COLOR.high, 0.3)}`,
                      }}
                    >
                      <Typography sx={{ fontSize: 12, fontWeight: 600, color: RISK_COLOR.high, mb: 0.5 }}>
                        AI 助手运行错误 · {msg.error.code}
                      </Typography>
                      <Typography sx={{ fontSize: 12.5, color: COLORS.text, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                        {msg.error.message}
                      </Typography>
                    </Box>
                  ) : streamMsg && msg.id === streamMsg.id && streamPhase ? (
                    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                      <Box
                        sx={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          bgcolor: COLORS.accent,
                          animation: 'cos-thinking-dot 1.2s ease-in-out infinite',
                        }}
                      />
                      <Typography
                        sx={{ fontSize: 12, fontFamily: COLORS.mono, color: COLORS.textSecondary }}
                      >
                        {streamPhase === 'waiting_input'
                          ? '等待你的回答'
                          : `${PHASE_META[streamPhase]} · ${formatElapsed(now - taskStartedAt)}`}
                      </Typography>
                    </Box>
                  ) : msg.question ? (
                    <QuestionCardView card={msg.question} messageId={msg.id} />
                  ) : (
                    <MarkdownView content={msg.content} />
                  )}
                </Box>
              ))}
            </Stack>
          )}
        </Box>
        {hasNewContent && newCount > 0 && (
          <Button
            size="small"
            onClick={scrollToLatest}
            sx={{
              position: 'absolute',
              bottom: 12,
              right: 12,
              fontSize: 12,
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
      </Box>

      <Box sx={{ p: 1.5, borderTop: `1px solid ${COLORS.border}` }}>
        <Collapse in={Boolean(pendingPrompt)}>
          <Box
            sx={{
              mb: 1,
              px: 1,
              py: 0.5,
              borderRadius: '4px',
              bgcolor: alpha(COLORS.accent, 0.1),
              border: `1px dashed ${alpha(COLORS.accent, 0.3)}`,
              animation: `fade-in 0.2s ${EASE}`,
            }}
          >
            <Typography sx={{ fontSize: 11.5, color: COLORS.accent, mb: 0.25 }}>
              已预置上下文 · 回车发送
            </Typography>
            <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }} noWrap>
              {pendingPrompt}
            </Typography>
          </Box>
        </Collapse>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-end' }}>
          <TextField
            inputRef={inputRef}
            fullWidth
            multiline
            maxRows={4}
            placeholder={
              taskRunning
                ? '任务运行中…（可点 ⏹ 停止）'
                : inputLocked
                  ? `完成「${person.name}」初始化后可继续对话`
                  : '输入消息…'
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
            size="small"
            sx={{
              '& .MuiOutlinedInput-root': {
                fontSize: 13,
                bgcolor: COLORS.bg,
              },
            }}
          />
          {taskRunning && (
            <Tooltip title="停止当前任务">
              <IconButton
                size="small"
                aria-label="停止当前 Agent 任务"
                onClick={() => {
                  cancelCurrentTask()
                  push('info', '已停止 Agent 任务')
                }}
                sx={{
                  borderRadius: '6px',
                  width: 32,
                  height: 32,
                  color: COLORS.riskHigh,
                  border: `1px solid ${COLORS.border}`,
                  '&:hover': { bgcolor: alpha(COLORS.riskHigh, 0.1) },
                }}
              >
                <StopCircleIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
          )}
          <IconButton
            size="small"
            disabled={!draft.trim() || taskRunning}
            onClick={() => draft.trim() && send(draft.trim())}
            sx={{
              bgcolor: COLORS.accent,
              color: COLORS.onAccent,
              borderRadius: '6px',
              width: 32,
              height: 32,
              '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 },
              '&.Mui-disabled': { bgcolor: COLORS.bgHover, color: COLORS.textMuted },
            }}
          >
            <SendIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Stack>
        <Button
          fullWidth
          size="small"
          disabled={person.initStatus === 'pending'}
          title={person.initStatus === 'pending' ? '完成基础档案后可写入决策' : undefined}
          sx={{
            mt: 1,
            fontSize: 12.5,
            color: COLORS.textSecondary,
            '&.Mui-disabled': { color: COLORS.textMuted },
          }}
          onClick={() => {
            const content = draft.trim() || '当前分析结果'
            // direction/city 跟随当前人最新决策（与顶栏方向胶囊同源），演示写入不硬编码方向
            const mine = decisions.filter((d) => belongsToPerson(d, person))
            const latest = mine.length
              ? [...mine].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
              : undefined
            const record: DecisionRecord = {
              id: `d-${Date.now()}`,
              title: content.slice(0, 24) || '未命名决策',
              skill: 'agent-write',
              direction: latest?.direction ?? '方向待定',
              directionMatch: latest?.directionMatch ?? 0,
              directionConfidence: 'medium',
              city: latest?.city ?? '',
              cityScore: latest?.cityScore ?? 0,
              salaryFeasible: true,
              riskLevel: 'medium',
              keyRisk: '待评估',
              status: 'completed',
              profile: person.name,
              summary: content,
              createdAt: new Date().toISOString(),
              protocolVersion: '2.1',
            }
            addDecision(record)
            setDraft('')
            push('success', `决策已写入「${record.title}」· 时间线已更新`)
          }}
        >
          写入决策记录
        </Button>
      </Box>
    </Box>
  )
}
