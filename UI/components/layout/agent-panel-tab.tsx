import { Box, Tooltip, Typography } from '@mui/material'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import { useAppStore } from '../../store/app-store'
import { COLORS, LAYOUT } from '../../data/constants'

/** AI 面板收起态把手：44px 右侧竖条（图标 + AI + ⌘B 提示），点击呼出面板。
 *  Agent 任务进行中显示状态点——AI 始终存在，只等呼出。 */
export function AgentPanelTab() {
  const toggle = useAppStore((s) => s.toggleAgentPanel)
  const busy = useAppStore((s) => s.activeTask) !== null

  return (
    <Tooltip title="呼出 AI 面板（⌘B）" placement="left">
      <Box
        component="button"
        onClick={toggle}
        aria-label="呼出 AI 面板"
        sx={{
          width: LAYOUT.agentRail,
          minWidth: LAYOUT.agentRail,
          border: 'none',
          borderLeft: `1px solid ${COLORS.border}`,
          bgcolor: COLORS.bg,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          py: 1.5,
          cursor: 'pointer',
          color: COLORS.textSecondary,
          transition: 'background-color 0.2s, color 0.2s',
          '&:hover': {
            bgcolor: COLORS.bgHover,
            color: COLORS.accent,
          },
          '&:hover .rail-arrow': { opacity: 1 },
        }}
      >
        <Box sx={{ position: 'relative' }}>
          <AutoAwesomeIcon sx={{ fontSize: 17 }} />
          {busy && (
            <Box
              sx={{
                position: 'absolute',
                right: -2,
                top: -1,
                width: 7,
                height: 7,
                borderRadius: '50%',
                bgcolor: COLORS.accent,
                boxShadow: `0 0 0 2px ${COLORS.bg}`,
              }}
            />
          )}
        </Box>
        <ChevronLeftIcon
          className="rail-arrow"
          sx={{ fontSize: 14, opacity: 0, transition: 'opacity 0.2s', mt: 0.5 }}
        />
        <Box sx={{ flex: 1 }} />
        <Typography
          sx={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.1em',
            writingMode: 'vertical-rl',
            lineHeight: 1.5,
          }}
        >
          AI
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: 9.5, color: COLORS.textMuted }}>⌘B</Typography>
      </Box>
    </Tooltip>
  )
}
