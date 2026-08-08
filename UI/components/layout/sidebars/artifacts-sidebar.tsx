/**
 * Artifact Studio 侧栏：三视图切换（Assets 概览 / 提案中心 / 演化时间线）——
 * 仿其他模块的侧栏上下文模式（选中高亮 + 计数徽标）。
 */
import { Box, Stack, Typography } from '@mui/material'
import { useAppStore } from '../../../store/app-store'
import { COLORS } from '../../../data/constants'

const VIEWS = [
  { key: 'assets', label: 'Assets 概览' },
  { key: 'proposals', label: '提案中心' },
  { key: 'evolution', label: '演化时间线' },
] as const

export function ArtifactsSidebar() {
  const artifactsView = useAppStore((s) => s.artifactsView)
  const setArtifactsView = useAppStore((s) => s.setArtifactsView)
  const artifactSummaries = useAppStore((s) => s.artifactSummaries)
  const proposals = useAppStore((s) => s.proposals)
  const portfolioProposals = useAppStore((s) => s.portfolioProposals)
  const interviewProposals = useAppStore((s) => s.interviewProposals)
  const coverLetterProposals = useAppStore((s) => s.coverLetterProposals)
  const timelineEvents = useAppStore((s) => s.timelineEvents)

  const countOf = (key: string): number => {
    if (key === 'assets') return artifactSummaries.length
    if (key === 'proposals') {
      return proposals.length + portfolioProposals.length + interviewProposals.length + coverLetterProposals.length
    }
    return timelineEvents.length
  }

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
          视图
        </Typography>
      </Stack>
      {VIEWS.map((v) => {
        const active = artifactsView === v.key
        const n = countOf(v.key)
        return (
          <Stack
            key={v.key}
            direction="row"
            spacing={1}
            onClick={() => setArtifactsView(v.key)}
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
              {v.label}
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
