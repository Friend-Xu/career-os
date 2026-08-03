/**
 * 简历空间侧栏：版本列表（切换当前版本）。
 */
import { Stack, Typography } from '@mui/material'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import { useMemo } from 'react'
import { RESUMES } from '../../../data/mock-data'
import { useAppStore } from '../../../store/app-store'
import { COLORS } from '../../../data/constants'

export function ResumesSidebar() {
  const person = useAppStore((s) => s.currentPerson())
  const activeResumeId = useAppStore((s) => s.activeResumeId)
  const setActiveResumeId = useAppStore((s) => s.setActiveResumeId)
  const personResumes = useMemo(() => RESUMES.filter((r) => r.personId === person.id), [person.id])

  return (
    <Stack spacing={0.25} sx={{ p: 1.25 }}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5, px: 1 }}>
        <DescriptionOutlinedIcon sx={{ fontSize: 14, color: COLORS.textMuted }} />
        <Typography
          sx={{
            fontSize: 11,
            fontWeight: 600,
            color: COLORS.textMuted,
            letterSpacing: '0.05em',
            flex: 1,
          }}
        >
          版本
        </Typography>
        <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.textMuted }}>
          {personResumes.length}
        </Typography>
      </Stack>
      {personResumes.length === 0 ? (
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, px: 1, py: 2, textAlign: 'center' }}>
          暂无简历版本
        </Typography>
      ) : (
        personResumes.map((r) => {
          const active = r.id === activeResumeId
          return (
            <Stack
              key={r.id}
              direction="row"
              spacing={1}
              onClick={() => setActiveResumeId(r.id)}
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
              <Typography
                sx={{
                  fontSize: 12.5,
                  fontWeight: active ? 600 : 400,
                  color: active ? COLORS.accent : COLORS.text,
                  flex: 1,
                  minWidth: 0,
                }}
                noWrap
              >
                {r.name}
              </Typography>
            </Stack>
          )
        })
      )}
    </Stack>
  )
}
