import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import ChatIcon from '@mui/icons-material/Chat'
import CloseIcon from '@mui/icons-material/Close'
import { useRef, useState } from 'react'
import { getEngine, useAppStore } from '../../store/app-store'
import { useToastStore } from '../../store/toast-store'
import { alpha, COLORS, EASE } from '../../data/constants'

/** ArrayBuffer → base64（分块避免 String.fromCharCode 栈溢出） */
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

const EMOJI_CHOICES = ['👤', '⚙️', '🎯', '💼', '🧬', '🏗️', '📊', '🔬', '🌐', '✈️']
const COLOR_CHOICES = ['#6B5BD6', '#2E7CF6', '#0FA382', '#D9489B', '#B45309', '#4338CA']
const STEP_LABELS = ['基本信息', '初始化方式']

type SourceMode = 'resume' | 'interview'

export function PersonCreateDialog() {
  const open = useAppStore((s) => s.personCreateDialogOpen)
  const setOpen = useAppStore((s) => s.setPersonCreateDialogOpen)
  const addPerson = useAppStore((s) => s.addPerson)
  const startInitializationSession = useAppStore((s) => s.startInitializationSession)
  const push = useToastStore((s) => s.push)
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('👤')
  const [color, setColor] = useState(COLOR_CHOICES[0])
  const [sourceMode, setSourceMode] = useState<SourceMode | null>(null)
  const [interest, setInterest] = useState('')
  const [resumeText, setResumeText] = useState('')
  const [resumeFileName, setResumeFileName] = useState('')
  const [resumePdfBase64, setResumePdfBase64] = useState('')
  const [resumeMethod, setResumeMethod] = useState<'text' | 'vision' | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [extractPhase, setExtractPhase] = useState<'text' | 'rendering' | 'vision' | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [extractExitOpen, setExtractExitOpen] = useState(false)
  const cancelledRef = useRef(false)
  const resumeFileInputRef = useRef<HTMLInputElement>(null)

  /** 取消上传：本地放弃等待（引擎请求继续跑完，结果丢弃），恢复表单可编辑 */
  const cancelExtraction = () => {
    cancelledRef.current = true
    setExtracting(false)
    setExtractPhase(null)
    push('info', '已取消识别——本次识别结果已丢弃')
  }

  const close = () => {
    setOpen(false)
    setStep(0)
    setName('')
    setEmoji('👤')
    setColor(COLOR_CHOICES[0])
    setSourceMode(null)
    setInterest('')
    setResumeText('')
    setResumeFileName('')
    setResumePdfBase64('')
    setResumeMethod(null)
    setExtracting(false)
    setExtractPhase(null)
    setPageCount(0)
  }

  /** 简历文件 → 输入：txt/md 前端直读；pdf 双通道（本地文本层 → pdfjs 渲染多页 + 逐页视觉） */
  const handleResumeFile = async (file: File) => {
    setResumeFileName(file.name)
    setExtracting(true)
    cancelledRef.current = false
    try {
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        setExtractPhase('text')
        setResumeText(await file.text())
        setResumeMethod('text')
        return
      }
      const pdfBase64 = await file.arrayBuffer().then(bufToBase64)
      setResumePdfBase64(pdfBase64)
      const engine = getEngine()
      if (!engine) {
        push('warning', '引擎离线：PDF 需连接引擎后提取')
        return
      }
      // 通道 1：本地文本层（免费离线，文本型 PDF 全页）
      setExtractPhase('text')
      const r1 = await engine.resumeExtract({ pdfBase64 })
      if (cancelledRef.current) return
      if (r1.status === 'completed') {
        setResumeText(r1.text)
        setResumeMethod('text')
        push('success', `已提取简历文本（文本解析 · ${r1.text.length} 字），请检查后创建`)
        return
      }
      // 通道 2：pdfjs 渲染多页 → 逐页视觉（图片型/乱码 PDF；免费模型延迟高，等待可达 2 分钟）
      try {
        push('info', '文本层不足——正在渲染页面并逐页视觉识别，请稍候…')
        setExtractPhase('rendering')
        const { renderPdfToPages } = await import('../../utils/pdf-pages')
        const pages = await renderPdfToPages(file)
        if (cancelledRef.current) return
        if (pages.length === 0) throw new Error('PDF 渲染无页面')
        setPageCount(pages.length)
        setExtractPhase('vision')
        const r2 = await engine.resumeExtract({ pages })
        if (cancelledRef.current) return
        setResumeText(r2.text)
        setResumeMethod('vision')
        if (r2.status === 'completed') {
          push('success', `已提取简历文本（视觉识别 · ${pages.length} 页 · ${r2.text.length} 字），请检查后创建`)
        } else if (r2.status === 'needs_review') {
          push('warning', `提取不完整（${r2.error ?? '部分页失败'}）——已填入提取文本，请手动检查补充`)
        } else {
          push('warning', `提取失败（${r2.error ?? '未知原因'}）——可稍后重试（免费模型高峰限流），或直接粘贴简历文本`)
        }
      } catch (err) {
        // 渲染失败或视觉通道失败：保留本地部分文本（如有）
        if (cancelledRef.current) return
        setResumeText(r1.text)
        setResumeMethod(r1.method)
        push(
          'warning',
          `视觉提取失败（${err instanceof Error ? err.message : String(err)}）${r1.text.trim() ? '——已填入部分文本' : '——请粘贴简历文本'}`,
        )
      }
    } catch (err) {
      if (cancelledRef.current) return
      push('warning', `提取失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setExtracting(false)
    }
  }

  const finish = async () => {
    const personName = name.trim()
    if (!personName || !sourceMode) return
    const interests = interest
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean)
    const newId = addPerson({
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
    // 引擎在线 → 落盘 persons/{id}/（manifest + intake/session-001.md）并回填 person_id；
    // 离线 → 仅本地 Person（诚实：无资产落盘，连接后需重新初始化）
    let personId: string | undefined
    if (useAppStore.getState().engineStatus === 'connected') {
      try {
        const res = await getEngine()!.createPersonSession({
          name: personName,
          sourceMode,
        })
        personId = res.personId
        useAppStore.getState().setPersonPersonId(newId, res.personId)
      } catch {
        personId = undefined
      }
    }
    // resume 通道：简历 Artifact 落盘（pdf 原文 + 提取文本 md + meta；编号递增不覆盖；落盘失败不阻塞创建）
    let artifactId: string | undefined
    if (personId && sourceMode === 'resume' && (resumeText.trim() || resumePdfBase64)) {
      try {
        const res = await getEngine()!.saveResumeOriginal({
          personId,
          fileName: resumeFileName || undefined,
          // pdf 场景同时落盘原文与提取文本（Agent 只读 extraction md，不读 pdf）
          ...(resumePdfBase64 ? { pdfBase64: resumePdfBase64, text: resumeText } : { text: resumeText }),
          ...(resumeMethod ? { extraction: { method: resumeMethod } } : {}),
        })
        artifactId = res.artifactId
      } catch {
        push('warning', '简历未落盘——创建后可在对话中粘贴简历文本')
      }
    }
    // 初始化会话：Agent 主动开场（内部指令不外显），输入框保持干净
    startInitializationSession({ personName, sourceMode, interests, personId })
    push(
      'success',
      `已建立「${personName}」职业档案 · 初始化空间已开启${artifactId ? ` · 简历已保存为源资料（${artifactId}）` : ''}${
        personId ? '' : '（引擎离线：未落盘，连接后需重新初始化）'
      }`,
    )
    close()
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        // 提取中禁止关闭（backdrop/Escape 均拦截），避免误触丢失识别结果
        if (extracting) return
        close()
      }}
      maxWidth="xs"
      fullWidth
    >
      <Box sx={{ position: 'relative' }}>
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pr: 5 }}>
          创建新人
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mt: 0.5, fontWeight: 400 }}>
            一个人 = 一份画像 + 一条决策链 + 独立投递/简历视图
          </Typography>
          <IconButton
            size="small"
            aria-label="关闭"
            onClick={() => (extracting ? setExtractExitOpen(true) : close())}
            sx={{
              position: 'absolute',
              top: 6,
              right: 6,
              zIndex: 11,
              color: COLORS.textMuted,
              '&:hover': { color: COLORS.text },
            }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
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
            {sourceMode === 'resume' && (
              <Box
                sx={{
                  p: 1.25,
                  borderRadius: '8px',
                  border: `1px dashed ${resumeText.trim() ? alpha(COLORS.accent, 0.45) : COLORS.borderStrong}`,
                  bgcolor: COLORS.bgHover,
                }}
              >
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>上传简历</Typography>
                  <Typography
                    sx={{ fontSize: 11.5, color: COLORS.textMuted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {resumeFileName ? `已选择：${resumeFileName}` : 'txt / md / pdf——AI 将从中提取候选'}
                  </Typography>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<UploadFileIcon sx={{ fontSize: 14 }} />}
                    onClick={() => resumeFileInputRef.current?.click()}
                    disabled={extracting}
                    sx={{ fontSize: 12, flexShrink: 0 }}
                  >
                    {extracting ? '提取中…' : '选择文件'}
                  </Button>
                  <input
                    ref={resumeFileInputRef}
                    type="file"
                    accept=".txt,.md,.pdf"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''
                      if (file) void handleResumeFile(file)
                    }}
                  />
                </Stack>
                {resumeText.trim() && (
                  <Typography sx={{ fontSize: 11, color: COLORS.textSecondary, mb: 0.5 }}>
                    简历来源：{resumeFileName || '手动粘贴'} · 提取方式：
                    {resumeMethod === 'vision' ? 'AI 视觉识别' : resumeMethod === 'text' ? '文本解析' : '手动输入'}
                    {' '}· 请检查确认后创建
                  </Typography>
                )}
                <TextField
                  fullWidth
                  size="small"
                  multiline
                  minRows={4}
                  maxRows={8}
                  placeholder="或直接粘贴简历文本（可选）"
                  value={resumeText}
                  onChange={(e) => setResumeText(e.target.value)}
                  sx={{ '& .MuiOutlinedInput-root': { fontSize: 12.5 } }}
                />
              </Box>
            )}
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
            disabled={extracting}
            sx={{ mr: 'auto', fontSize: 12.5 }}
          >
            上一步
          </Button>
        )}
        <Button size="small" color="inherit" onClick={close} disabled={extracting} sx={{ fontSize: 12.5 }}>
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
            disabled={!name.trim() || !sourceMode || extracting}
            onClick={finish}
            sx={{ fontSize: 12.5 }}
          >
            创建并开始采集
          </Button>
        )}
      </DialogActions>
        {extracting && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 10,
              borderRadius: 12,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 0.75,
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
              bgcolor: alpha(COLORS.bgElevated, 0.62),
            }}
          >
            <CircularProgress size={20} thickness={4} sx={{ color: COLORS.accent }} />
            <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
              {extractPhase === 'rendering'
                ? '正在渲染页面…'
                : extractPhase === 'vision'
                  ? `正在逐页视觉识别（共 ${pageCount} 页）…`
                  : '正在提取文本…'}
            </Typography>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
              免费模型较慢，识别中请勿关闭（约 1-2 分钟）
            </Typography>
            <Button
              size="small"
              color="inherit"
              onClick={cancelExtraction}
              sx={{ fontSize: 12, mt: 0.5, color: COLORS.textSecondary }}
            >
              取消上传
            </Button>
          </Box>
        )}

        {/* × 退出确认：识别进行中主动退出会丢弃结果（体验保护——识别突然消失会误以为系统坏了） */}
        <Dialog open={extractExitOpen} onClose={() => setExtractExitOpen(false)} maxWidth="xs" fullWidth>
          <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>正在处理简历</DialogTitle>
          <DialogContent>
            <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, lineHeight: 1.7 }}>
              退出后本次识别结果不会保存。可以稍后重新上传。
            </Typography>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button
              size="small"
              color="inherit"
              onClick={() => setExtractExitOpen(false)}
              sx={{ fontSize: 12.5 }}
            >
              继续识别
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => {
                setExtractExitOpen(false)
                close()
              }}
              sx={{ fontSize: 12.5 }}
            >
              退出
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </Dialog>
  )
}
