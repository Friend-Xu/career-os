/**
 * 简历空间侧栏：版本列表（切换当前版本；「选择 JD 派生」新建的版本也在这里）。
 * hover 行尾删除按钮（确认后删版本，删除当前版本回退第一份）。
 */
import { Box, IconButton, Stack, Typography } from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import { useMemo } from 'react'
import { useAppStore } from '../../../store/app-store'
import { useToastStore } from '../../../store/toast-store'
import { COLORS } from '../../../data/constants'

export function ResumesSidebar() {
  const person = useAppStore((s) => s.currentPerson())
  const resumes = useAppStore((s) => s.resumes)
  const activeResumeId = useAppStore((s) => s.activeResumeId)
  const setActiveResumeId = useAppStore((s) => s.setActiveResumeId)
  const deleteResumeVersion = useAppStore((s) => s.deleteResumeVersion)
  const push = useToastStore((s) => s.push)
  const personResumes = useMemo(() => resumes.filter((r) => r.personId === person.id), [resumes, person.id])
  /** 原始简历（命名契约「原始简历」，存量派生版本可能缺 parentId）始终置顶；派生版本保持原顺序 */
  const sorted = useMemo(
    () =>
      [...personResumes].sort(
        (a, b) => Number(b.name.includes('原始简历')) - Number(a.name.includes('原始简历')),
      ),
    [personResumes],
  )

  return (
    <Stack sx={{ p: 1.25 }}>
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
        sorted.map((r) => {
          const active = r.id === activeResumeId
          const target = [r.targetPosition, r.targetCompany].filter(Boolean).join(' · ')
          return (
            <Stack
              key={r.id}
              onClick={() => setActiveResumeId(r.id)}
              sx={{
                mb: 0.5,
                px: 1.25,
                py: 1,
                borderRadius: '8px',
                cursor: 'pointer',
                border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
                bgcolor: active ? COLORS.accentMuted : COLORS.bg,
                '&:hover': { bgcolor: active ? COLORS.accentMuted : COLORS.bgHover },
                '&:hover .card-delete': { opacity: 1 },
              }}
            >
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
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
                  {r.name}
                </Typography>
                <Box className="card-delete" onClick={(e) => e.stopPropagation()} sx={{ opacity: 0, flexShrink: 0 }}>
                  <IconButton
                    size="small"
                    title="删除版本"
                    onClick={() => {
                      if (!window.confirm(`删除简历版本「${r.name}」？不可恢复。`)) return
                      deleteResumeVersion(r.id)
                      push('info', `已删除版本：${r.name}`)
                    }}
                    sx={{ p: 0.25 }}
                  >
                    <DeleteIcon sx={{ fontSize: 13, color: COLORS.textMuted }} />
                  </IconButton>
                </Box>
              </Stack>
              <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>
                {r.updatedAt.slice(5)}
                {target ? ` · ${target}` : ''}
              </Typography>
            </Stack>
          )
        })
      )}
    </Stack>
  )
}
