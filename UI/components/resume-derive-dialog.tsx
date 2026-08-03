/**
 * 选择 JD 派生 Dialog：列出 JD 池 → 选一个 → 新建派生版本（挂 targetCompany/Position，
 * 自动切换）+ 预置 Agent 派生上下文（带 JD 要求与原文）。
 */
import { Box, Dialog, DialogContent, DialogTitle, Stack, Typography } from '@mui/material'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS } from '../data/constants'

export function ResumeDeriveDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const jobs = useAppStore((s) => s.jobs)
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const createResumeVersion = useAppStore((s) => s.createResumeVersion)
  const push = useToastStore((s) => s.push)

  const derive = (company: string, title: string, requirements: string[], jd?: string) => {
    createResumeVersion({
      name: `${company} · ${title}`,
      targetCompany: company,
      targetPosition: title,
    })
    startAnalysis(
      `请基于所选 JD 派生简历内容（岗位：${company} · ${title}）：\nJD 要求：${requirements.join('、') || '（无结构化要求）'}\nJD 原文：${(jd ?? '').slice(0, 800) || '（无原文，按岗位名推断）'}\n按模块输出：个人信息/专业摘要/工作经历/项目经验/技能——含量化指标，关键词与 JD 对齐`,
    )
    push('success', '已创建派生版本并预置「基于 JD 派生」上下文')
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: 440,
            maxWidth: '92vw',
            borderRadius: '12px',
            bgcolor: COLORS.bgElevated,
            backgroundImage: 'none',
            border: `1px solid ${COLORS.borderStrong}`,
          },
        },
      }}
    >
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <AutoAwesomeIcon sx={{ fontSize: 16, color: COLORS.accent }} />
          <span>选择 JD 派生简历</span>
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ pt: '8px !important' }}>
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1.5 }}>
          选择一个 JD——派生版本将挂接该公司与岗位，Agent 按 JD 关键词改写
        </Typography>
        {jobs.length === 0 ? (
          <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted, py: 3, textAlign: 'center', lineHeight: 1.7 }}>
            JD 池为空
            <br />
            先在 JD 空间粘贴招聘要求建档
          </Typography>
        ) : (
          <Stack spacing={0.5}>
            {jobs.map((j) => (
              <Box
                key={j.id}
                onClick={() => derive(j.company, j.title, j.requirements.map((r) => r.name), j.jd)}
                sx={{
                  p: 1.25,
                  borderRadius: '8px',
                  border: `1px solid ${COLORS.border}`,
                  cursor: 'pointer',
                  '&:hover': {
                    borderColor: COLORS.accent,
                    bgcolor: alpha(COLORS.accent, 0.06),
                  },
                }}
              >
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>
                    {j.company} · {j.title}
                  </Typography>
                  <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.textMuted }}>
                    {j.requirements.length} 项要求
                  </Typography>
                </Stack>
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 0.25 }} noWrap>
                  {j.requirements.length > 0
                    ? j.requirements.map((r) => r.name).join(' / ')
                    : j.jd
                      ? '有 JD 原文'
                      : '无内容（按岗位名推断）'}
                </Typography>
              </Box>
            ))}
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  )
}
