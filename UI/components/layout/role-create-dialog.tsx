import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import { useState } from 'react'
import { useAppStore } from '../../store/app-store'
import { useToastStore } from '../../store/toast-store'
import { alpha, COLORS } from '../../data/constants'

const EMOJI_CHOICES = ['🤖', '📐', '🎯', '💼', '🧬', '🏗️', '📊', '🔬', '🌐', '✈️']
const COLOR_CHOICES = ['#6B5BD6', '#2E7CF6', '#0FA382', '#D9489B', '#B45309', '#4338CA']

export function RoleCreateDialog() {
  const open = useAppStore((s) => s.roleCreateDialogOpen)
  const setOpen = useAppStore((s) => s.setRoleCreateDialogOpen)
  const addRole = useAppStore((s) => s.addRole)
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const push = useToastStore((s) => s.push)
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('🤖')
  const [color, setColor] = useState(COLOR_CHOICES[0])

  const close = () => {
    setOpen(false)
    setStep(0)
    setName('')
    setEmoji('🤖')
    setColor(COLOR_CHOICES[0])
  }

  const finish = () => {
    const roleName = name.trim()
    if (!roleName) return
    addRole({
      name: roleName,
      color,
      emoji,
      matchScore: 0,
      riskLevel: 'medium',
      archived: false,
      profilePath: `profiles/${roleName}.md`,
    })
    startAnalysis(
      `请为新角色「${roleName}」创建职业画像：逐步了解我的教育背景、工作经历、技能栈与财务约束，输出画像文件。`,
    )
    push('success', `已创建角色「${roleName}」，画像采集已就绪`)
    close()
  }

  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>
        创建新角色
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mt: 0.5, fontWeight: 400 }}>
          一个角色 = 一个职业画像 + 独立决策链 + 独立投递视图
        </Typography>
      </DialogTitle>
      <DialogContent sx={{ pt: 1.5 }}>
        <Stack direction="row" spacing={0.5} sx={{ mb: 2 }}>
          {['基本信息', '画像采集'].map((s, i) => (
            <Box
              key={s}
              sx={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                bgcolor: i <= step ? COLORS.accent : COLORS.bgHover,
                transition: 'background-color 0.2s',
              }}
            />
          ))}
        </Stack>

        {step === 0 ? (
          <Stack spacing={2}>
            <Box>
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mb: 0.5 }}>
                角色名称
              </Typography>
              <TextField
                fullWidth
                size="small"
                autoFocus
                placeholder="如：机器人研发 / 算法工程 / 转汽车电子"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && name.trim()) setStep(1)
                }}
                sx={{ '& .MuiOutlinedInput-root': { fontSize: 13 } }}
              />
            </Box>
            <Box>
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mb: 0.75 }}>
                图标
              </Typography>
              <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                {EMOJI_CHOICES.map((e) => (
                  <Box
                    key={e}
                    role="button"
                    tabIndex={0}
                    onClick={() => setEmoji(e)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') setEmoji(e)
                    }}
                    sx={{
                      width: 36,
                      height: 36,
                      borderRadius: '8px',
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 18,
                      cursor: 'pointer',
                      bgcolor: e === emoji ? COLORS.accentMuted : COLORS.bgHover,
                      border: `1.5px solid ${
                        e === emoji ? COLORS.accent : COLORS.border
                      }`,
                      '&:hover': { borderColor: COLORS.accent },
                    }}
                  >
                    {e}
                  </Box>
                ))}
              </Stack>
            </Box>
            <Box>
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mb: 0.75 }}>
                主题色
                <Typography component="span" sx={{ fontSize: 12, color: COLORS.textMuted }}>
                  {' '}
                  — 切换角色时界面强调色随之变化
                </Typography>
              </Typography>
              <Stack direction="row" spacing={0.75}>
                {COLOR_CHOICES.map((c) => (
                  <Box
                    key={c}
                    role="button"
                    tabIndex={0}
                    onClick={() => setColor(c)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') setColor(c)
                    }}
                    sx={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      bgcolor: c,
                      cursor: 'pointer',
                      border: color === c ? '2.5px solid var(--cos-text)' : '2.5px solid transparent',
                      boxShadow: color === c ? `0 0 0 2px ${alpha(c, 0.4)}` : 'none',
                    }}
                  />
                ))}
              </Stack>
            </Box>
          </Stack>
        ) : (
          <Stack spacing={1.5}>
            <Box
              sx={{
                p: 1.5,
                borderRadius: '8px',
                bgcolor: COLORS.accentMuted,
                border: `1px solid ${alpha(COLORS.accent, 0.25)}`,
              }}
            >
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.75 }}>
                <AutoAwesomeIcon sx={{ fontSize: 14, color: COLORS.accent }} />
                <Typography sx={{ fontSize: 12.5, fontWeight: 600, color: COLORS.accent }}>
                  下一步：采集「{name.trim() || '新角色'}」画像
                </Typography>
              </Stack>
              <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                创建后将唤起 AI 对话，用渐进式提问（教育 / 经历 / 技能 / 财务约束，每题带推荐答案）生成
                职业画像。画像就绪后，决策链从「方向探索」开始。
              </Typography>
            </Box>
            <Box
              sx={{
                p: 1.5,
                borderRadius: '8px',
                bgcolor: COLORS.bgHover,
                border: `1px solid ${COLORS.border}`,
              }}
            >
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                <Box
                  sx={{
                    width: 36,
                    height: 36,
                    borderRadius: '8px',
                    bgcolor: alpha(color, 0.13),
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 18,
                  }}
                >
                  {emoji}
                </Box>
                <Box>
                  <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
                    {name.trim() || '未命名角色'}
                  </Typography>
                  <Typography sx={{ fontSize: 12, color: COLORS.textMuted, fontFamily: COLORS.mono }}>
                    profiles/{name.trim() || '…'}.md
                  </Typography>
                </Box>
              </Stack>
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {step === 1 && (
          <Button
            size="small"
            color="inherit"
            startIcon={<ArrowBackIcon sx={{ fontSize: 14 }} />}
            onClick={() => setStep(0)}
            sx={{ mr: 'auto', fontSize: 12.5 }}
          >
            上一步
          </Button>
        )}
        <Button size="small" color="inherit" onClick={close} sx={{ fontSize: 12.5 }}>
          取消
        </Button>
        {step === 0 ? (
          <Button
            size="small"
            variant="contained"
            disabled={!name.trim()}
            endIcon={<ArrowForwardIcon sx={{ fontSize: 14 }} />}
            onClick={() => setStep(1)}
            sx={{ fontSize: 12.5 }}
          >
            下一步
          </Button>
        ) : (
          <Button size="small" variant="contained" onClick={finish} sx={{ fontSize: 12.5 }}>
            创建并开始画像采集
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
