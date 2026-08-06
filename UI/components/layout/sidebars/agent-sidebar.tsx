/**
 * Agent 空间侧栏：会话列表（切换 + 新建）。每行显示会话运行状态（任务归属会话，
 * 同会话单任务互斥、跨会话并行——状态点 + 阶段文案 + 运行时长）。
 */
import { Box, Stack, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import dayjs from 'dayjs'
import { useAppStore } from '../../../store/app-store'
import { deriveAgentPhase, formatElapsed, PHASE_META } from '../../../store/agent-phase'
import type { StreamPhase } from '../../../store/agent-phase'
import { alpha, COLORS } from '../../../data/constants'

export function AgentSidebar() {
  const sessions = useAppStore((s) => s.sessions)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const createSession = useAppStore((s) => s.createSession)
  const sessionTasks = useAppStore((s) => s.sessionTasks)
  const now = useAppStore((s) => s.now)
  const person = useAppStore((s) => s.currentPerson())
  const list = sessions.filter((s) => s.personId === person.id && !s.archived)

  /** 会话行当前阶段：任务运行中由最后一条消息推导（提问挂起 → 等待你的回答） */
  const rowPhase = (s: (typeof list)[number]): StreamPhase | undefined => {
    const task = sessionTasks[s.id]
    if (!task) return undefined
    const last = s.messages.at(-1)
    if (last?.question && !last.question.answered) return 'waiting_input'
    if (last) return deriveAgentPhase(last)
    return 'running'
  }

  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', px: 1.25, py: 0.75 }}>
        <Typography
          sx={{
            fontSize: 11,
            fontWeight: 600,
            color: COLORS.textMuted,
            letterSpacing: '0.05em',
            flex: 1,
          }}
        >
          会话
        </Typography>
        <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.textMuted }}>
          {list.length}
        </Typography>
      </Stack>
      {/* 新建入口：虚线卡片（区别于会话实体卡片实线边框 + 白底） */}
      <Box sx={{ px: 1.25, pb: 0.75 }}>
        <Stack
          direction="row"
          spacing={0.75}
          onClick={() => createSession()}
          sx={{
            alignItems: 'center',
            justifyContent: 'center',
            px: 1.25,
            py: 1.1,
            borderRadius: '8px',
            cursor: 'pointer',
            border: `1px dashed ${alpha(COLORS.accent, 0.45)}`,
            bgcolor: alpha(COLORS.accent, 0.05),
            color: COLORS.accent,
            '&:hover': { bgcolor: alpha(COLORS.accent, 0.12) },
          }}
        >
          <AddIcon sx={{ fontSize: 16 }} />
          <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>新建会话</Typography>
        </Stack>
      </Box>
      <Stack sx={{ flex: 1, overflow: 'auto', px: 1 }}>
        {list.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, px: 1, py: 2, textAlign: 'center' }}>
            暂无会话
          </Typography>
        ) : (
          list.map((s) => {
            const active = s.id === currentSessionId
            const phase = rowPhase(s)
            const task = sessionTasks[s.id]
            return (
              <Stack
                key={s.id}
                onClick={() => setCurrentSession(s.id)}
                sx={{
                  mb: 0.5,
                  px: 1.25,
                  py: 1,
                  borderRadius: '8px',
                  cursor: 'pointer',
                  border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
                  bgcolor: active ? COLORS.accentMuted : COLORS.bg,
                  '&:hover': { bgcolor: active ? COLORS.accentMuted : COLORS.bgHover },
                }}
              >
                <Typography
                  sx={{
                    fontSize: 12.5,
                    fontWeight: active ? 600 : 500,
                    color: active ? COLORS.accent : COLORS.text,
                  }}
                  noWrap
                >
                  {s.title}
                </Typography>
                {phase !== undefined && task ? (
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mt: 0.25 }}>
                    <Box
                      sx={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        flexShrink: 0,
                        bgcolor: phase === 'waiting_input' ? COLORS.riskMedium : COLORS.accent,
                        animation:
                          phase === 'waiting_input'
                            ? undefined
                            : 'cos-thinking-dot 1.2s ease-in-out infinite',
                      }}
                    />
                    <Typography
                      sx={{ fontSize: 11, fontFamily: COLORS.mono, color: COLORS.textSecondary }}
                      noWrap
                    >
                      {phase === 'waiting_input'
                        ? '等待你的回答'
                        : `${PHASE_META[phase]} ${formatElapsed(now - task.startedAt)}`}
                    </Typography>
                  </Stack>
                ) : (
                  <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>
                    {s.messages.length} 条 · {dayjs(s.updatedAt).format('MM-DD HH:mm')}
                  </Typography>
                )}
              </Stack>
            )
          })
        )}
      </Stack>
    </Stack>
  )
}
