import {
  Box,
  Button,
  Chip,
  Stack,
  TextField,
  Typography,
  Popover,
} from '@mui/material'
import PrintIcon from '@mui/icons-material/Print'
import FileDownloadIcon from '@mui/icons-material/FileDownload'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import UndoIcon from '@mui/icons-material/Undo'
import { useEffect, useMemo, useRef, useState } from 'react'
import { RESUMES } from '../data/mock-data'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS } from '../data/constants'
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
  const [activeId, setActiveId] = useState('r-dji')
  const resume = RESUMES.find((r) => r.id === activeId) ?? RESUMES[0]
  const [modules, setModules] = useState<ResumeModule[]>(resume.modules)
  const [anchor, setAnchor] = useState<{
    top: number;
    left: number;
    moduleId: string;
    text: string;
  } | null>(null)
  const [revert, setRevert] = useState<{ moduleId: string; prevContent: string } | null>(null)
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})

  // Sync modules when switching version
  const switchVersion = (id: string) => {
    const r = RESUMES.find((x) => x.id === id)
    if (r) {
      setActiveId(id)
      setModules(r.modules.map((m) => ({ ...m })))
      setRevert(null)
    }
  }

  const qualityScore = useMemo(() => {
    const totalLen = modules.reduce((s, m) => s + m.content.length, 0)
    const hasMetrics = modules.some((m) => /\d+%|\d+年/.test(m.content))
    let score = 70
    if (totalLen > 200) score += 10
    if (hasMetrics) score += 12
    if (modules.length >= 4) score += 5
    return Math.min(score, 96)
  }, [modules])

  /** 划词/键盘选中 → 记录选区位置并弹出 AI 改写候选。 */
  const onSelect = (el: HTMLTextAreaElement, moduleId: string) => {
    const sel = window.getSelection()
    if (!sel) return
    const text = sel.toString().trim()
    if (text.length < 6) return
    // textarea 选区的 range 无布局信息（rect 为 0×0），回退到元素 rect
    let rect = null
    if (sel.rangeCount > 0) {
      const r = sel.getRangeAt(0).getBoundingClientRect()
      if (r.width > 0 && r.height > 0) rect = r
    }
    if (!rect) rect = el.getBoundingClientRect()
    setAnchor({ top: rect.bottom + 6, left: rect.left, moduleId, text })
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

  const closeCandidate = () => setAnchor(null)

  const candidates = anchor ? CANDIDATE_RULES.map((r) => r.apply(anchor.text)) : []

  const applyCandidate = (text: string) => {
    if (!anchor) return
    const { moduleId, text: selectedText } = anchor
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
    closeCandidate()
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

      {/* Version switcher (compact, secondary already has tree) */}
      <Stack direction="row" spacing={1} sx={{ px: 2, py: 1, borderBottom: `1px solid ${COLORS.border}` }}>
        {RESUMES.map((r) => (
          <Chip
            key={r.id}
            size="small"
            label={r.name}
            onClick={() => switchVersion(r.id)}
            sx={{
              height: 24,
              fontSize: 12,
              cursor: 'pointer',
              bgcolor: r.id === activeId ? COLORS.accentMuted : COLORS.bgHover,
              color: r.id === activeId ? COLORS.accent : COLORS.textSecondary,
              border: `1px solid ${r.id === activeId ? alpha(COLORS.accent, 0.3) : COLORS.border}`,
            }}
          />
        ))}
      </Stack>

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
        >
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1.5 }}>
            编辑区 · 划词或 Shift+方向键选中 6 字以上 → AI 改写候选 · 使用 ↑↓ 调整模块顺序
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

      {/* AI rewrite popover — 定位到选区，候选基于选中原文生成 */}
      <Popover
        open={Boolean(anchor)}
        anchorReference="anchorPosition"
        anchorPosition={anchor ? { top: anchor.top, left: anchor.left } : undefined}
        onClose={closeCandidate}
        slotProps={{
          paper: {
            sx: {
              width: 400,
              mt: 1,
              p: 1.5,
              bgcolor: COLORS.bgElevated,
              backgroundImage: 'none',
              border: `1px solid ${COLORS.borderStrong}`,
              borderRadius: '10px',
              boxShadow: 'var(--cos-shadow)',
            },
          },
        }}
      >
        <Stack>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 1 }}>
            <AutoAwesomeIcon sx={{ fontSize: 14, color: COLORS.accent }} />
            <Typography sx={{ fontSize: 12, fontWeight: 600, flex: 1 }}>
              AI 改写候选
            </Typography>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
              基于选中原文生成
            </Typography>
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
            原文: {anchor?.text.slice(0, 80)}
            {(anchor?.text.length ?? 0) > 80 ? '…' : ''}
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
        </Stack>
      </Popover>
    </Box>
  )
}
