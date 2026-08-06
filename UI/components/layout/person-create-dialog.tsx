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
import UploadFileIcon from '@mui/icons-material/UploadFile'
import ChatIcon from '@mui/icons-material/Chat'
import { useState } from 'react'
import { useAppStore } from '../../store/app-store'
import { useToastStore } from '../../store/toast-store'
import { alpha, COLORS, EASE } from '../../data/constants'

const EMOJI_CHOICES = ['👤', '⚙️', '🎯', '💼', '🧬', '🏗️', '📊', '🔬', '🌐', '✈️']
const COLOR_CHOICES = ['#6B5BD6', '#2E7CF6', '#0FA382', '#D9489B', '#B45309', '#4338CA']
const STEP_LABELS = ['基本信息', '初始化方式']

type SourceMode = 'resume' | 'interview'

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
  const [sourceMode, setSourceMode] = useState<SourceMode | null>(null)
  const [interest, setInterest] = useState('')

  const close = () => {
    setOpen(false)
    setStep(0)
    setName('')
    setEmoji('👤')
    setColor(COLOR_CHOICES[0])
    setSourceMode(null)
    setInterest('')
  }

  const finish = () => {
    const personName = name.trim()
    if (!personName || !sourceMode) return
    const interests = interest
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean)
    addPerson({
      name: personName,
      color,
      emoji,
      matchScore: 0,
      riskLevel: 'medium',
      archived: false,
      profilePath: `profiles/${personName}.md`,
      sourceMode,
      initialInterest: interests.length > 0 ? interests : undefined,
      initStatus: 'pending',
    })
    // 预置采集上下文：通道 A 读简历资产提取候选；通道 B 访谈引导。AI 只产候选，不直接写档案。
    const channelPrompt =
      sourceMode === 'resume'
        ? `请为新人「${personName}」初始化职业画像（简历通道）：读取 resumes/documents/ 中的简历资产，提取教育/经历/技能候选事实，逐一列出待确认项（标注来源：简历）——不要直接写入档案，等用户确认。`
        : `请为新人「${personName}」初始化职业画像（访谈通道）：通过渐进式提问（教育→经历→技能→约束）了解背景，提取候选事实并列出待确认项（标注来源：用户描述）——不要直接写入档案，等用户确认。`
    const interestHint = interests.length > 0 ? `当前关注方向（用户自报，非决策）：${interests.join('、')}。` : ''
    startAnalysis(`${channelPrompt}${interestHint}`)
    push(
      'success',
      `已创建「${personName}」· ${
        sourceMode === 'resume' ? '简历通道（读取现有简历提取候选）' : '访谈通道（对话采集）'
      } · 采集已开始`,
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
                  初始化方式——数据进入系统的路径
                </Typography>
              </Stack>
              <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                创建后将在工作台进行采集：AI 只提取候选事实，你确认后才会写入档案。
              </Typography>
            </Box>
            <Stack spacing={1}>
              {(
                [
                  {
                    mode: 'resume' as SourceMode,
                    icon: <UploadFileIcon sx={{ fontSize: 16 }} />,
                    title: '我有简历',
                    desc: '读取简历资产，提取经历/技能候选，你逐条确认',
                  },
                  {
                    mode: 'interview' as SourceMode,
                    icon: <ChatIcon sx={{ fontSize: 16 }} />,
                    title: '我没有简历',
                    desc: '通过对话访谈逐步了解教育、经历、技能与约束',
                  },
                ] as const
              ).map(({ mode, icon, title, desc }) => {
                const active = sourceMode === mode
                return (
                  <Box
                    key={mode}
                    role="radio"
                    tabIndex={0}
                    aria-checked={active}
                    onClick={() => setSourceMode(mode)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSourceMode(mode)
                      }
                    }}
                    sx={{
                      p: 1.25,
                      borderRadius: '8px',
                      cursor: 'pointer',
                      bgcolor: active ? COLORS.accentMuted : COLORS.bgHover,
                      border: `1.5px solid ${active ? COLORS.accent : COLORS.border}`,
                      transition: `background-color 0.15s ${EASE}, border-color 0.15s ${EASE}`,
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
                          borderRadius: '50%',
                          border: `1.5px solid ${active ? COLORS.accent : COLORS.borderStrong}`,
                          display: 'grid',
                          placeItems: 'center',
                          flexShrink: 0,
                          transition: `background-color 0.15s ${EASE}`,
                        }}
                      >
                        {active && (
                          <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: COLORS.accent }} />
                        )}
                      </Box>
                      <Box
                        sx={{
                          width: 30,
                          height: 30,
                          borderRadius: '8px',
                          display: 'grid',
                          placeItems: 'center',
                          color: COLORS.accent,
                          bgcolor: alpha(COLORS.accent, 0.12),
                          flexShrink: 0,
                        }}
                      >
                        {icon}
                      </Box>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{title}</Typography>
                        <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mt: 0.25 }}>
                          {desc}
                        </Typography>
                      </Box>
                    </Stack>
                  </Box>
                )
              })}
            </Stack>
            <Box>
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mb: 0.5 }}>
                当前关注方向（可选）
                <Typography component="span" sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                  {' '}
                  — 你自报的意向，不是决策；AI 不会据此自动推荐
                </Typography>
              </Typography>
              <TextField
                fullWidth
                size="small"
                placeholder="如：机械设计、AI 工程（逗号分隔多个）"
                value={interest}
                onChange={(e) => setInterest(e.target.value)}
                sx={{ '& .MuiOutlinedInput-root': { fontSize: 13 } }}
              />
            </Box>
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
        {step < 1 ? (
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
          <Button
            size="small"
            variant="contained"
            disabled={!name.trim() || !sourceMode}
            onClick={finish}
            sx={{ fontSize: 12.5 }}
          >
            创建并开始采集
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
