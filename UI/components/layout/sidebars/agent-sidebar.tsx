/**
 * Agent 空间侧栏：会话列表（切换 + 新建）。每行显示会话运行状态（任务归属会话，
 * 同会话单任务互斥、跨会话并行——状态点 + 阶段文案 + 运行时长）。
 */
import { Box, Stack, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import LockIcon from '@mui/icons-material/Lock'
import UnarchiveIcon from '@mui/icons-material/Unarchive'
import dayjs from 'dayjs'
import { useState } from 'react'
import { useAppStore, activeExecutionOf } from '../../../store/app-store'
import { executionPhaseOf, formatElapsed, lastContentSegmentOf, PHASE_META } from '../../../store/agent-phase'
import type { StreamPhase } from '../../../store/agent-phase'
import { alpha, COLORS } from '../../../data/constants'

export function AgentSidebar() {
  const sessions = useAppStore((s) => s.sessions)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const createSession = useAppStore((s) => s.createSession)
  const executions = useAppStore((s) => s.executions)
  const now = useAppStore((s) => s.now)
  const initSessionId = useAppStore((s) => s.initSessionId)
  const person = useAppStore((s) => s.currentPerson())
  const [showUnassigned, setShowUnassigned] = useState(false)
  // 归属 key = 引擎 personId 稳定标识（未落盘本地 Person 用 ui:{id} 占位——与 createSession 同源）
  const ownerKey = person.personId ?? `ui:${person.id}`
  const list = sessions.filter((s) => s.personId === ownerKey && !s.archived)
  // 存量迁移产物：无法可靠考证归属的会话（显式未知，不混入任何人的列表）
  const unassigned = sessions.filter((s) => s.personId === 'unassigned' && !s.archived)

  /** 会话行当前阶段（ADR-034 UI Contract：Execution 驱动——有非终态执行即显示；
   *  waiting→waiting_input（Registry 事实）；running→最后内容段投影字段细分） */
  const rowPhase = (s: (typeof list)[number]): StreamPhase | undefined => {
    const task = activeExecutionOf(executions, s.id)
    if (!task) return undefined
    return executionPhaseOf(task, lastContentSegmentOf(s.messages))
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
            /** 当前人初始化中：非初始化采集会话被能力门控锁定（历史可看，不能产生新消息） */
            const locked = person.initStatus === 'pending' && s.id !== initSessionId
            const phase = rowPhase(s)
            const task = activeExecutionOf(executions, s.id)
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
                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                  {locked && <LockIcon sx={{ fontSize: 12, color: COLORS.textMuted }} />}
                  <Typography
                    sx={{
                      fontSize: 12.5,
                      fontWeight: active ? 600 : 500,
                      color: active ? COLORS.accent : COLORS.text,
                      flex: 1,
                      minWidth: 0,
                    }}
                    noWrap
                  >
                    {s.title}
                  </Typography>
                </Stack>
                {locked ? (
                  <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>
                    完成初始化后开放
                  </Typography>
                ) : phase !== undefined && task ? (
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
                        : `${PHASE_META[phase]} ${formatElapsed(now - new Date(task.startedAt).getTime())}`}
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

        {/* 未归属会话（存量迁移产物）：折叠区——数据保留可查，不混入任何人的列表（禁止静默错挂） */}
        {unassigned.length > 0 && (
          <Box sx={{ mt: 1, pt: 1, borderTop: `1px dashed ${COLORS.border}` }}>
            <Stack
              direction="row"
              spacing={0.5}
              onClick={() => setShowUnassigned((v) => !v)}
              sx={{
                alignItems: 'center',
                px: 1,
                py: 0.5,
                cursor: 'pointer',
                color: COLORS.textMuted,
                '&:hover': { color: COLORS.text },
              }}
            >
              <UnarchiveIcon sx={{ fontSize: 13 }} />
              <Typography sx={{ fontSize: 11.5, flex: 1 }}>未归属会话 · {unassigned.length}</Typography>
              <Typography sx={{ fontSize: 11 }}>{showUnassigned ? '收起' : '展开'}</Typography>
            </Stack>
            {showUnassigned &&
              unassigned.map((s) => (
                <Stack
                  key={s.id}
                  onClick={() => setCurrentSession(s.id)}
                  sx={{
                    mt: 0.5,
                    px: 1.25,
                    py: 0.75,
                    borderRadius: '8px',
                    cursor: 'pointer',
                    border: `1px dashed ${alpha(COLORS.border, 0.8)}`,
                    bgcolor: COLORS.bg,
                    '&:hover': { bgcolor: COLORS.bgHover },
                  }}
                >
                  <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }} noWrap>
                    {s.title}
                  </Typography>
                  <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>
                    {s.messages.length} 条 · {dayjs(s.updatedAt).format('MM-DD HH:mm')} · 归属待确认
                  </Typography>
                </Stack>
              ))}
          </Box>
        )}
      </Stack>
    </Stack>
  )
}
