import {
  Box,
  Button,
  Chip,
  Stack,
  TextField,
  Typography,
  Popper,
  Paper,
  ClickAwayListener,
} from '@mui/material'
import PrintIcon from '@mui/icons-material/Print'
import FileDownloadIcon from '@mui/icons-material/FileDownload'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import DragIndicatorIcon from '@mui/icons-material/DragIndicator'
import { useMemo, useState, type MouseEvent } from 'react'
import { RESUMES } from '../data/mock-data'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS } from '../data/constants'
import type { ResumeModule } from '../types'

const AI_CANDIDATES = [
  '具备量化与实时系统背景，向机器人感知/控制方向转型，熟悉 C++/Python 与 ROS2 实践。',
  '5 年算法工程经验，擅长低延迟系统与机器学习部署，正在构建具身智能相关项目作品集。',
  '算法工程师，聚焦多模态感知与边缘推理，有跨团队落地复杂系统的完整闭环经验。',
]

export function ResumesPage() {
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const push = useToastStore((s) => s.push)
  const [activeId, setActiveId] = useState('r-dji')
  const resume = RESUMES.find((r) => r.id === activeId) ?? RESUMES[0]
  const [modules, setModules] = useState<ResumeModule[]>(resume.modules)
  const [selectedText, setSelectedText] = useState('')
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Sync modules when switching version
  const switchVersion = (id: string) => {
    const r = RESUMES.find((x) => x.id === id)
    if (r) {
      setActiveId(id)
      setModules(r.modules.map((m) => ({ ...m })))
      setEditingId(null)
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

  const onMouseUp = (e: MouseEvent, moduleId: string) => {
    const sel = window.getSelection()?.toString().trim()
    if (sel && sel.length > 8) {
      setSelectedText(sel)
      setEditingId(moduleId)
      setAnchorEl(e.currentTarget as HTMLElement)
    }
  }

  const applyCandidate = (text: string) => {
    if (!editingId) return
    setModules((prev) =>
      prev.map((m) =>
        m.id === editingId
          ? { ...m, content: m.content.replace(selectedText, text) }
          : m,
      ),
    )
    setAnchorEl(null)
    setSelectedText('')
    push('success', '已应用 AI 改写')
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
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>简历中心</Typography>
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
            编辑区 · 划词可触发 AI 改写 · 拖拽排序
          </Typography>
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
                  <DragIndicatorIcon sx={{ fontSize: 16, color: COLORS.textMuted, mr: 0.5 }} />
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
                  onChange={(e) =>
                    setModules((prev) =>
                      prev.map((x) => (x.id === m.id ? { ...x, content: e.target.value } : x)),
                    )
                  }
                  onMouseUp={(e) => onMouseUp(e, m.id)}
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

      {/* AI rewrite popper */}
      <Popper open={Boolean(anchorEl)} anchorEl={anchorEl} placement="bottom-start" sx={{ zIndex: 1300 }}>
        <ClickAwayListener onClickAway={() => setAnchorEl(null)}>
          <Paper
            sx={{
              mt: 1,
              p: 1.5,
              width: 360,
              bgcolor: COLORS.bgElevated,
              border: `1px solid ${COLORS.borderStrong}`,
              borderRadius: '10px',
              boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
            }}
          >
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 1 }}>
              <AutoAwesomeIcon sx={{ fontSize: 14, color: COLORS.accent }} />
              <Typography sx={{ fontSize: 12, fontWeight: 600 }}>AI 改写候选</Typography>
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
              原文: {selectedText.slice(0, 80)}
              {selectedText.length > 80 ? '…' : ''}
            </Typography>
            <Stack spacing={0.75}>
              {AI_CANDIDATES.map((c, i) => (
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
                  <Typography sx={{ fontSize: 11.5, color: COLORS.accent, mb: 0.25 }}>候选 {i + 1}</Typography>
                  <Typography sx={{ fontSize: 12, lineHeight: 1.5 }}>{c}</Typography>
                </Box>
              ))}
            </Stack>
          </Paper>
        </ClickAwayListener>
      </Popper>
    </Box>
  )
}
