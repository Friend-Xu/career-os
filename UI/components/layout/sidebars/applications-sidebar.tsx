/**
 * 投递空间侧栏：状态过滤（含待跟进统计与计数）。
 */
import { Box, Stack, Typography } from '@mui/material'
import { useAppStore } from '../../../store/app-store'
import { COLORS, RISK_COLOR } from '../../../data/constants'

const COLUMNS = ['已评估', '已投递', '已联系', '已回复', '面试中', '已录取', '已拒绝'] as const

export function ApplicationsSidebar() {
  const applications = useAppStore((s) => s.applications)
  const applicationsFilter = useAppStore((s) => s.applicationsFilter)
  const setApplicationsFilter = useAppStore((s) => s.setApplicationsFilter)
  const person = useAppStore((s) => s.currentPerson())

  const personApps = applications.filter((a) => a.personId === person.id)
  const urgent = personApps.filter((a) => a.urgency === 'urgent' || a.urgency === 'overdue')
  const countOf = (s: string): number =>
    s === '全部' ? personApps.length : personApps.filter((a) => a.status === s).length

  return (
    <Stack spacing={0.25} sx={{ p: 1.25 }}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5, px: 1 }}>
        <Typography
          sx={{
            fontSize: 11,
            fontWeight: 600,
            color: COLORS.textMuted,
            letterSpacing: '0.05em',
            flex: 1,
          }}
        >
          状态
        </Typography>
        <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.textMuted }}>
          {personApps.length}
        </Typography>
      </Stack>
      {urgent.length > 0 && (
        <Box
          sx={{
            mx: 1,
            mb: 0.5,
            px: 1.25,
            py: 0.75,
            borderRadius: '6px',
            bgcolor: 'rgba(230,180,80,0.12)',
            border: '1px solid rgba(230,180,80,0.25)',
          }}
        >
          <Typography sx={{ fontSize: 11.5, color: RISK_COLOR.medium, fontWeight: 600 }}>
            {urgent.length} 条待跟进
          </Typography>
        </Box>
      )}
      {(['全部', ...COLUMNS] as const).map((s) => {
        const active = applicationsFilter === s
        const n = countOf(s)
        return (
          <Stack
            key={s}
            direction="row"
            spacing={1}
            onClick={() => setApplicationsFilter(s)}
            sx={{
              alignItems: 'center',
              px: 1,
              py: 0.6,
              borderRadius: '6px',
              cursor: 'pointer',
              bgcolor: active ? COLORS.accentMuted : 'transparent',
              '&:hover': { bgcolor: active ? COLORS.accentMuted : COLORS.bgHover },
            }}
          >
            <Box
              sx={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                bgcolor: active ? COLORS.accent : COLORS.border,
                flexShrink: 0,
              }}
            />
            <Typography
              sx={{
                fontSize: 12.5,
                fontWeight: active ? 600 : 400,
                color: active ? COLORS.accent : COLORS.text,
                flex: 1,
              }}
            >
              {s}
            </Typography>
            {/* 计数徽标：选中 accent / 零计数灰化弱化 */}
            <Box
              sx={{
                px: 0.75,
                py: 0.25,
                borderRadius: '999px',
                bgcolor: n === 0 ? 'transparent' : active ? COLORS.accentMuted : COLORS.bgHover,
              }}
            >
              <Typography
                sx={{
                  fontSize: 11,
                  fontFamily: COLORS.mono,
                  color: n === 0 ? COLORS.textMuted : active ? COLORS.accent : COLORS.textSecondary,
                }}
              >
                {n}
              </Typography>
            </Box>
          </Stack>
        )
      })}
    </Stack>
  )
}
