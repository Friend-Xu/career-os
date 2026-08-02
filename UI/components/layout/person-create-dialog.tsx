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
import CheckIcon from '@mui/icons-material/Check'
import { useState } from 'react'
import { useAppStore } from '../../store/app-store'
import { useToastStore } from '../../store/toast-store'
import { TARGET_ROLE_RECS } from '../../data/mock-data'
import { alpha, COLORS, EASE } from '../../data/constants'

const EMOJI_CHOICES = ['👤', '⚙️', '🎯', '💼', '🧬', '🏗️', '📊', '🔬', '🌐', '✈️']
const COLOR_CHOICES = ['#6B5BD6', '#2E7CF6', '#0FA382', '#D9489B', '#B45309', '#4338CA']
const STEP_LABELS = ['基本信息', '画像采集', '目标岗位']

export function PersonCreateDialog() {
  const open = useAppStore((s) => s.personCreateDialogOpen)
  const setOpen = useAppStore((s) => s.setPersonCreateDialogOpen)
  const addPerson = useAppStore((s) => s.addPerson)
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const push = useToastStore((s) => s.push)
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('👤')
  const [color, setColor] = useState(COLOR_CHOICES[0])
  const [selectedRoles, setSelectedRoles] = useState<string[]>([])

  const close = () => {
    setOpen(false)
    setStep(0)
    setName('')
    setEmoji('👤')
    setColor(COLOR_CHOICES[0])
    setSelectedRoles([])
  }

  const toggleRole = (roleName: string) => {
    setSelectedRoles((prev) =>
      prev.includes(roleName) ? prev.filter((r) => r !== roleName) : [...prev, roleName],
    )
  }

  const finish = () => {
    const personName = name.trim()
    if (!personName) return
    addPerson({
      name: personName,
      color,
      emoji,
      matchScore: 0,
      riskLevel: 'medium',
      archived: false,
      profilePath: `profiles/${personName}.md`,
      targetRoles: selectedRoles,
    })
    startAnalysis(
      `请为新人「${personName}」创建职业画像：逐步了解我的教育背景、工作经历、技能栈与财务约束，输出画像文件。${
        selectedRoles.length ? `目标岗位参考：${selectedRoles.join('、')}` : ''
      }`,
    )
    push(
      'success',
      `已创建「${personName}」· ${
        selectedRoles.length ? `目标岗位 ${selectedRoles.join(' / ')}` : '目标岗位暂未选择（可从方向探索开始）'
      } · 画像采集已就绪`,
    )
    close()
  }

  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>
        创建新人
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mt: 0.5, fontWeight: 400 }}>
          一个人 = 一份画像 + 一条决策链 + 独立投递/简历视图
        </Typography>
      </DialogTitle>
      <DialogContent sx={{ pt: 1.5 }}>
        <Stack direction="row" spacing={0.5} sx={{ mb: 2 }}>
          {STEP_LABELS.map((s, i) => (
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
                名字（对应画像文件）
              </Typography>
              <TextField
                fullWidth
                size="small"
                autoFocus
                placeholder="如：我 / 家人 A"
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
                  — 切换人时界面强调色随之变化
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
        ) : step === 1 ? (
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
                  下一步：采集「{name.trim() || '新朋友'}」画像
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
                    {name.trim() || '未命名'}
                  </Typography>
                  <Typography sx={{ fontSize: 12, color: COLORS.textMuted, fontFamily: COLORS.mono }}>
                    profiles/{name.trim() || '…'}.md
                  </Typography>
                </Box>
              </Stack>
            </Box>
          </Stack>
        ) : (
          <Stack spacing={1.5}>
            <Box>
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mb: 0.5 }}>
                基于画像，AI 推荐了以下目标岗位
                <Typography component="span" sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                  {' '}
                  · 演示推荐（阶段 3 接入真实分析）
                </Typography>
              </Typography>
            </Box>
            <Stack spacing={1}>
              {TARGET_ROLE_RECS.map((rec, i) => {
                const active = selectedRoles.includes(rec.name)
                return (
                  <Box
                    key={rec.id}
                    role="checkbox"
                    tabIndex={0}
                    aria-checked={active}
                    onClick={() => toggleRole(rec.name)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleRole(rec.name)
                      }
                    }}
                    sx={{
                      p: 1.25,
                      borderRadius: '8px',
                      cursor: 'pointer',
                      bgcolor: active ? COLORS.accentMuted : COLORS.bgHover,
                      border: `1.5px solid ${active ? COLORS.accent : COLORS.border}`,
                      animation: `fade-in 0.3s ${EASE} ${i * 0.06}s both`,
                      transition: `background-color 0.15s ${EASE}, border-color 0.15s ${EASE}, transform 0.1s ${EASE}`,
                      '&:active': { transform: 'scale(0.98)' },
                      '&:focus-visible': {
                        outline: `2px solid ${COLORS.accent}`,
                        outlineOffset: -1,
                      },
                    }}
                  >
                    <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
                      <Box
                        sx={{
                          width: 16,
                          height: 16,
                          borderRadius: '4px',
                          border: `1.5px solid ${
                            active ? COLORS.accent : COLORS.borderStrong
                          }`,
                          bgcolor: active ? COLORS.accent : 'transparent',
                          display: 'grid',
                          placeItems: 'center',
                          flexShrink: 0,
                          transition: `background-color 0.15s ${EASE}`,
                        }}
                      >
                        {active && <CheckIcon sx={{ fontSize: 12, color: COLORS.onAccent }} />}
                      </Box>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Stack
                          direction="row"
                          sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}
                        >
                          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
                            {rec.name}
                          </Typography>
                          <Typography
                            sx={{ fontSize: 12.5, fontFamily: COLORS.mono, color: COLORS.accent }}
                          >
                            {rec.match}%
                          </Typography>
                        </Stack>
                        <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mt: 0.25 }}>
                          {rec.reason}
                        </Typography>
                      </Box>
                    </Stack>
                  </Box>
                )
              })}
            </Stack>
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, textAlign: 'center' }}>
              暂不选择 → 从方向探索开始，AI 会随分析补充推荐
            </Typography>
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {step > 0 && (
          <Button
            size="small"
            color="inherit"
            startIcon={<ArrowBackIcon sx={{ fontSize: 14 }} />}
            onClick={() => setStep(step - 1)}
            sx={{ mr: 'auto', fontSize: 12.5 }}
          >
            上一步
          </Button>
        )}
        <Button size="small" color="inherit" onClick={close} sx={{ fontSize: 12.5 }}>
          取消
        </Button>
        {step < 2 ? (
          <Button
            size="small"
            variant="contained"
            disabled={!name.trim()}
            endIcon={<ArrowForwardIcon sx={{ fontSize: 14 }} />}
            onClick={() => setStep(step + 1)}
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
