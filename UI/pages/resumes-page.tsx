import {
  Box,
  Button,
  Chip,
  IconButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import PrintIcon from '@mui/icons-material/Print'
import FileDownloadIcon from '@mui/icons-material/FileDownload'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import CloseIcon from '@mui/icons-material/Close'
import UndoIcon from '@mui/icons-material/Undo'
import { useEffect, useMemo, useRef, useState } from 'react'
import { RESUMES } from '../data/mock-data'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, EASE } from '../data/constants'
import type { ResumeModule } from '../types'

/** 改写策略模板：候选基于选中原文生成（演示模式，规则驱动而非真实 LLM）。 */
const CANDIDATE_RULES: { tag: string; apply: (text: string) => string }[] = [
  {
    tag: '量化增强',
    apply: (t) => `主导${t}，关键指标较此前显著提升（按实际口径记录：效率 / 良率 / 成本 / 数量）`,
  },
  {
    tag: '动词强化',
    apply: (t) =>
      `${t.replace(/负责/g, '主导').replace(/参与/g, '完成').replace(/做了/g, '实现')}，沉淀可复用方法并推广`,
  },
  {
    tag: '结构精简',
    apply: (t) => (t.length > 48 ? `${t.slice(0, 48)}…` : t),
  },
]

export function ResumesPage() {
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const push = useToastStore((s) => s.push)
  const activeResumeId = useAppStore((s) => s.activeResumeId)
  const resume = RESUMES.find((r) => r.id === activeResumeId) ?? RESUMES[0]
  const [modules, setModules] = useState<ResumeModule[]>(resume.modules)
  /** 选中状态 → 「✨ 改写」按钮位置（选区右下） */
  const [selButton, setSelButton] = useState<{
    top: number;
    left: number;
    moduleId: string;
    text: string;
  } | null>(null)
  /** 候选卡片展开状态 */
  const [cardOpen, setCardOpen] = useState(false)
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null)
  const [revert, setRevert] = useState<{ moduleId: string; prevContent: string } | null>(null)
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const btnRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  const closeAll = () => {
    setSelButton(null)
    setCardOpen(false)
  }

  // 点击按钮/卡片之外 → 关闭候选卡片（非模态，不吞点击）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (cardRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setCardOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // 版本切换由二级栏「版本 / 血缘」驱动（store），此处同步模块内容
  useEffect(() => {
    const r = RESUMES.find((x) => x.id === activeResumeId)
    if (r) {
      setModules(r.modules.map((m) => ({ ...m })))
      setRevert(null)
      closeAll()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeResumeId])

  const qualityScore = useMemo(() => {
    const totalLen = modules.reduce((s, m) => s + m.content.length, 0)
    const hasMetrics = modules.some((m) => /\d+%|\d+年/.test(m.content))
    let score = 70
    if (totalLen > 200) score += 10
    if (hasMetrics) score += 12
    if (modules.length >= 4) score += 5
    return Math.min(score, 96)
  }, [modules])

  /** 划词/键盘选中 → 显示「✨ 改写」按钮（选区右下，不直接弹候选）。 */
  const onSelect = (el: HTMLTextAreaElement, moduleId: string) => {
    const sel = window.getSelection()
    const text = sel ? sel.toString().trim() : ''
    if (text.length < 6) {
      // 选区无效（光标/点击/编辑）→ 隐藏按钮
      setSelButton((prev) => (prev ? null : prev))
      return
    }
    // textarea 选区的 range 无布局信息（rect 为 0×0），回退到元素 rect
    let rect = null
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0).getBoundingClientRect()
      if (r.width > 0 && r.height > 0) rect = r
    }
    if (!rect) rect = el.getBoundingClientRect()
    // 按钮右对齐选区底边，防止超出视口
    const left = Math.min(rect.right - 92, window.innerWidth - 104)
    setSelButton({ top: rect.bottom + 4, left, moduleId, text })
  }

  const openCard = () => {
    if (!selButton) return
    setCardPos({ top: selButton.top + 30, left: selButton.left })
    setCardOpen(true)
  }

  // 原生 select 事件不冒泡，且 MUI 不会把 onSelect 透传到 textarea——
  // 只能直接在元素上绑定原生监听器
  const moduleIds = modules.map((m) => m.id).join(',')
  useEffect(() => {
    const handle = (e: Event) => {
      const el = e.currentTarget as HTMLTextAreaElement
      const id = Object.entries(textareaRefs.current).find(([, v]) => v === el)?.[0]
      if (id) onSelect(el, id)
    }
    const els = Object.values(textareaRefs.current).filter(Boolean) as HTMLTextAreaElement[]
    els.forEach((el) => el.addEventListener('select', handle))
    return () => els.forEach((el) => el.removeEventListener('select', handle))
  }, [moduleIds])

  const candidates = selButton ? CANDIDATE_RULES.map((r) => r.apply(selButton.text)) : []

  const applyCandidate = (text: string) => {
    if (!selButton) return
    const { moduleId, text: selectedText } = selButton
    let applied = false
    setModules((prev) =>
      prev.map((m) => {
        if (m.id !== moduleId) return m
        const idx = m.content.indexOf(selectedText)
        if (idx === -1) return m
        applied = true
        setRevert({ moduleId, prevContent: m.content })
        return {
          ...m,
          content:
            m.content.slice(0, idx) +
            text +
            m.content.slice(idx + selectedText.length),
        }
      }),
    )
    if (applied) {
      push('success', '已应用 AI 改写（可撤销）')
    } else {
      push('warning', '原文已变化，请重新划词')
    }
    closeAll()
  }

  const undoRewrite = () => {
    if (!revert) return
    setModules((prev) =>
      prev.map((m) => (m.id === revert.moduleId ? { ...m, content: revert.prevContent } : m)),
    )
    setRevert(null)
    push('info', '已撤销本次改写')
  }

  const moveModule = (index: number, dir: -1 | 1) => {
    const next = index + dir
    if (next < 0 || next >= modules.length) return
    setModules((prev) => {
      const copy = [...prev];
      [copy[index], copy[next]] = [copy[next], copy[index]]
      return copy.map((m, i) => ({ ...m, order: i }))
    })
  }

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: 'center', px: 2, py: 1.25, borderBottom: `1px solid ${COLORS.border}` }}
      >
        <Typography sx={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>简历中心</Typography>
        <Chip size="small" label={resume.name} sx={{ height: 22, fontSize: 12, bgcolor: COLORS.accentMuted, color: COLORS.accent }} />
        {resume.targetCompany && (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
            → {resume.targetCompany} · {resume.targetPosition}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          startIcon={<AutoAwesomeIcon sx={{ fontSize: 14 }} />}
          onClick={() => {
            startAnalysis('请基于目标 JD 派生本简历：拆解 JD 关键词并逐模块改写')
            push('info', '已预置「基于 JD 派生」上下文')
          }}
          sx={{ fontSize: 12 }}
        >
          基于 JD 派生
        </Button>
        <Button
          size="small"
          startIcon={<FileDownloadIcon sx={{ fontSize: 14 }} />}
          onClick={() => push('info', '演示模式：导出将在阶段 3 接入')}
          sx={{ fontSize: 12 }}
        >
          导出
        </Button>
        <Button
          size="small"
          startIcon={<PrintIcon sx={{ fontSize: 14 }} />}
          onClick={() => push('info', '演示模式：打印将在阶段 3 接入')}
          sx={{ fontSize: 12 }}
        >
          打印
        </Button>
      </Stack>

      {/* 版本切换在二级栏「版本 / 血缘」——此处不重复提供入口 */}

      {/* Split editor / preview */}
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {/* Editor */}
        <Box
          sx={{
            flex: 1,
            overflow: 'auto',
            p: 2,
            borderRight: `1px solid ${COLORS.border}`,
          }}
          onScroll={closeAll}
        >
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1.5 }}>
            编辑区 · 划词或 Shift+方向键选中 6 字以上 → 点击 ✨ 改写 · 使用 ↑↓ 调整模块顺序
          </Typography>
          {revert && (
            <Box
              sx={{
                mb: 1.5,
                px: 1.25,
                py: 0.75,
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                bgcolor: alpha(COLORS.accent, 0.08),
                border: `1px dashed ${alpha(COLORS.accent, 0.35)}`,
              }}
            >
              <AutoAwesomeIcon sx={{ fontSize: 13, color: COLORS.accent }} />
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, flex: 1 }}>
                已应用 AI 改写
              </Typography>
              <Button
                size="small"
                startIcon={<UndoIcon sx={{ fontSize: 13 }} />}
                onClick={undoRewrite}
                sx={{ fontSize: 12, color: COLORS.accent, minWidth: 0 }}
              >
                撤销
              </Button>
            </Box>
          )}
          <Stack spacing={1.5}>
            {modules.map((m, idx) => (
              <Box
                key={m.id}
                sx={{
                  borderRadius: '8px',
                  border: `1px solid ${COLORS.border}`,
                  bgcolor: COLORS.bgElevated,
                  overflow: 'hidden',
                }}
              >
                <Stack
                  direction="row"
                  sx={{
                    alignItems: 'center',
                    px: 1.25,
                    py: 0.75,
                    bgcolor: COLORS.bgHover,
                    borderBottom: `1px solid ${COLORS.border}`,
                  }}
                >
                  <Typography
                    sx={{
                      fontSize: 11.5,
                      fontFamily: COLORS.mono,
                      color: COLORS.textMuted,
                      width: 18,
                      textAlign: 'center',
                      mr: 0.5,
                    }}
                  >
                    {idx + 1}
                  </Typography>
                  <Typography sx={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{m.title}</Typography>
                  <Button size="small" disabled={idx === 0} onClick={() => moveModule(idx, -1)} sx={{ minWidth: 0, px: 0.75, fontSize: 12 }}>
                    ↑
                  </Button>
                  <Button size="small" disabled={idx === modules.length - 1} onClick={() => moveModule(idx, 1)} sx={{ minWidth: 0, px: 0.75, fontSize: 12 }}>
                    ↓
                  </Button>
                </Stack>
                <TextField
                  fullWidth
                  multiline
                  value={m.content}
                  inputRef={(el: HTMLTextAreaElement | null) => {
                    textareaRefs.current[m.id] = el
                  }}
                  onChange={(e) => {
                    setRevert(null)
                    setModules((prev) =>
                      prev.map((x) => (x.id === m.id ? { ...x, content: e.target.value } : x)),
                    )
                  }}
                  sx={{
                    '& .MuiOutlinedInput-root': {
                      fontSize: 13,
                      lineHeight: 1.6,
                      '& fieldset': { border: 'none' },
                    },
                    '& textarea': { padding: '12px !important' },
                  }}
                />
              </Box>
            ))}
          </Stack>
        </Box>

        {/* Live preview */}
        <Box
          sx={{
            flex: 1,
            overflow: 'auto',
            p: 3,
            bgcolor: '#FAFAFA',
            color: '#1a1a1a',
          }}
        >
          <Box
            sx={{
              maxWidth: 560,
              mx: 'auto',
              bgcolor: '#fff',
              p: 4,
              borderRadius: '4px',
              boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
              minHeight: '80%',
            }}
          >
            {modules.map((m) => (
              <Box key={m.id} sx={{ mb: 2.5 }}>
                <Typography
                  sx={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: '#222',
                    borderBottom: '1.5px solid #222',
                    pb: 0.5,
                    mb: 1,
                    letterSpacing: '0.02em',
                  }}
                >
                  {m.title}
                </Typography>
                <Typography
                  sx={{
                    fontSize: 13,
                    color: '#333',
                    whiteSpace: 'pre-wrap',
                    lineHeight: 1.65,
                    fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
                  }}
                >
                  {m.content}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>

      {/* Quality bar */}
      <Stack
        direction="row"
        spacing={2}
        sx={{
          alignItems: 'center',
          px: 2,
          py: 1,
          borderTop: `1px solid ${COLORS.border}`,
          bgcolor: COLORS.bgElevated,
        }}
      >
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>内容真实性质检</Typography>
        <Box
          sx={{
            flex: 1,
            height: 4,
            borderRadius: 2,
            bgcolor: COLORS.bgHover,
            overflow: 'hidden',
          }}
        >
          <Box
            sx={{
              width: `${qualityScore}%`,
              height: '100%',
              bgcolor: qualityScore > 85 ? COLORS.riskLow : COLORS.riskMedium,
              borderRadius: 2,
            }}
          />
        </Box>
        <Typography sx={{ fontSize: 12, fontFamily: COLORS.mono, color: COLORS.textSecondary }}>
          {qualityScore}%
        </Typography>
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
          含量化指标 · 模块完整 · 无明显空泛表述
        </Typography>
      </Stack>

      {/* AI 改写：选中 → ✨ 浮动按钮（不直接弹候选，避免干扰划词） */}
      {selButton && !cardOpen && (
        <Box
          ref={btnRef}
          role="button"
          tabIndex={0}
          onClick={openCard}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              openCard()
            }
          }}
          sx={{
            position: 'fixed',
            top: selButton.top,
            left: selButton.left,
            zIndex: 1300,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            px: 1.25,
            py: 0.5,
            borderRadius: '8px',
            cursor: 'pointer',
            bgcolor: COLORS.bgElevated,
            color: COLORS.accent,
            border: `1px solid ${COLORS.borderStrong}`,
            boxShadow: 'var(--cos-shadow)',
            fontSize: 12,
            fontWeight: 600,
            userSelect: 'none',
            animation: `fade-in 0.2s ${EASE}`,
            '&:hover': { bgcolor: COLORS.accentMuted },
            '&:focus-visible': {
              outline: `2px solid ${COLORS.accent}`,
              outlineOffset: 2,
            },
          }}
        >
          <AutoAwesomeIcon sx={{ fontSize: 14 }} />
          <Typography component="span" sx={{ fontSize: 12, fontWeight: 600 }}>
            改写
          </Typography>
        </Box>
      )}

      {/* 候选卡片：非模态（不吞点击），点外部/× 关闭 */}
      {cardOpen && cardPos && selButton && (
        <Box
          ref={cardRef}
          sx={{
            position: 'fixed',
            top: cardPos.top,
            left: cardPos.left,
            zIndex: 1300,
            width: 400,
            p: 1.5,
            bgcolor: COLORS.bgElevated,
            backgroundImage: 'none',
            border: `1px solid ${COLORS.borderStrong}`,
            borderRadius: '10px',
            boxShadow: 'var(--cos-shadow)',
            animation: `fade-in 0.2s ${EASE}`,
          }}
        >
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 1 }}>
            <AutoAwesomeIcon sx={{ fontSize: 14, color: COLORS.accent }} />
            <Typography sx={{ fontSize: 12, fontWeight: 600, flex: 1 }}>
              AI 改写候选
            </Typography>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
              基于选中原文生成
            </Typography>
            <IconButton size="small" onClick={closeAll} aria-label="关闭候选" sx={{ p: 0.25 }}>
              <CloseIcon sx={{ fontSize: 15, color: COLORS.textMuted }} />
            </IconButton>
          </Stack>
          <Typography
            sx={{
              fontSize: 12,
              color: COLORS.textMuted,
              mb: 1,
              p: 1,
              bgcolor: COLORS.bgHover,
              borderRadius: '6px',
              maxHeight: 48,
              overflow: 'hidden',
            }}
          >
            原文: {selButton.text.slice(0, 80)}
            {selButton.text.length > 80 ? '…' : ''}
          </Typography>
          <Stack spacing={0.75}>
            {candidates.map((c, i) => (
              <Box
                key={i}
                onClick={() => applyCandidate(c)}
                sx={{
                  p: 1.25,
                  borderRadius: '6px',
                  border: `1px solid ${COLORS.border}`,
                  cursor: 'pointer',
                  '&:hover': {
                    borderColor: COLORS.accent,
                    bgcolor: COLORS.accentMuted,
                  },
                }}
              >
                <Typography sx={{ fontSize: 11.5, color: COLORS.accent, mb: 0.25 }}>
                  {CANDIDATE_RULES[i].tag}
                </Typography>
                <Typography sx={{ fontSize: 12, lineHeight: 1.5 }}>{c}</Typography>
              </Box>
            ))}
          </Stack>
        </Box>
      )}
    </Box>
  )
}
