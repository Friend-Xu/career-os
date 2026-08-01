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
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import { useEffect, useRef } from 'react'
import { useAppStore } from '../../store/app-store'
import { useToastStore } from '../../store/toast-store'
import { NEXT_ACTION } from '../../data/mock-data'
import { COLORS, EASE, LAYOUT, alpha } from '../../data/constants'
import type { DecisionRecord } from '../../types'

export function AgentPanel() {
  const open = useAppStore((s) => s.agentPanelOpen)
  const toggle = useAppStore((s) => s.toggleAgentPanel)
  const draft = useAppStore((s) => s.agentDraft)
  const setDraft = useAppStore((s) => s.setAgentDraft)
  const send = useAppStore((s) => s.sendAgentMessage)
  const addDecision = useAppStore((s) => s.addDecision)
  const expandToFull = useAppStore((s) => s.expandToFullAgent)
  const contextFiles = useAppStore((s) => s.agentContextFiles)
  const sessions = useAppStore((s) => s.sessions)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const pendingPrompt = useAppStore((s) => s.pendingPrompt)
  const push = useToastStore((s) => s.push)
  const inputRef = useRef<HTMLInputElement>(null)

  const session = sessions.find((s) => s.id === currentSessionId)
  const recentMessages = session?.messages.slice(-4) ?? []

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
        <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1 }}>AI Agent</Typography>
        <Tooltip title="展开到全屏决策 Agent">
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

      <Box sx={{ px: 1.5, py: 1.25 }}>
        <Typography
          sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 0.75, letterSpacing: '0.04em' }}
        >
          已加载上下文
        </Typography>
        <Stack spacing={0.5}>
          {contextFiles.map((f) => (
            <Stack key={f} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
              <CheckCircleOutlinedIcon sx={{ fontSize: 13, color: COLORS.riskLow }} />
              <Typography
                sx={{ fontSize: 12.5, fontFamily: COLORS.mono, color: COLORS.textSecondary }}
              >
                {f}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', px: 1.5, py: 1 }}>
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
                  {msg.role === 'user' ? '你' : 'Agent'}
                </Typography>
                <Typography
                  sx={{
                    fontSize: 13,
                    whiteSpace: 'pre-wrap',
                    lineHeight: 1.5,
                    color: COLORS.text,
                  }}
                >
                  {msg.content.length > 180 ? `${msg.content.slice(0, 180)}…` : msg.content}
                </Typography>
              </Box>
            ))}
          </Stack>
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
            }}
          >
            <Typography sx={{ fontSize: 11.5, color: COLORS.accent }}>已预置分析上下文</Typography>
          </Box>
        </Collapse>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-end' }}>
          <TextField
            inputRef={inputRef}
            fullWidth
            multiline
            maxRows={4}
            placeholder="输入消息…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
                e.preventDefault()
                send(draft.trim())
              }
            }}
            size="small"
            sx={{
              '& .MuiOutlinedInput-root': {
                fontSize: 13,
                bgcolor: COLORS.bg,
              },
            }}
          />
          <IconButton
            size="small"
            disabled={!draft.trim()}
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
          sx={{ mt: 1, fontSize: 12.5, color: COLORS.textSecondary }}
          onClick={() => {
            const content = draft.trim() || '当前分析结果'
            const record: DecisionRecord = {
              id: `d-${Date.now()}`,
              title: content.slice(0, 24) || '未命名决策',
              skill: 'agent-write',
              direction: '机器人',
              directionMatch: 0,
              directionConfidence: 'medium',
              city: '深圳',
              cityScore: 0,
              salaryFeasible: true,
              riskLevel: 'medium',
              keyRisk: '待评估',
              status: 'completed',
              profile: '机器人研发',
              summary: content,
              createdAt: new Date().toISOString(),
              protocolVersion: '2.1',
            }
            addDecision(record)
            setDraft('')
            push('success', `已写入决策记录「${record.title}」`)
          }}
        >
          写入决策记录
        </Button>
      </Box>
    </Box>
  )
}
