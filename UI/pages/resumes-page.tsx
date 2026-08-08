import {
  Box,
  Button,
  Chip,
  IconButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import FileDownloadIcon from '@mui/icons-material/FileDownload'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import CloseIcon from '@mui/icons-material/Close'
import UndoIcon from '@mui/icons-material/Undo'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, EASE } from '../data/constants'
import type { ResumeModule } from '../types'
import { ResumeDeriveDialog } from '../components/resume-derive-dialog'
import { ResumeStudio } from '../components/resume-studio'
import { ResumeAssets } from '../components/resume-assets'

/** 改写策略模板：候选基于选中原文生成（离线降级，规则驱动而非真实 LLM）。 */
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

/** 常用改写意图（Revision Request 快捷入口，对应契约 intent chips） */
const INTENT_CHIPS = ['对齐 JD', '更精简', '量化增强', '更专业'] as const

/** HTML 转义（打印 HTML 内含用户文本——防注入） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 组装简历打印 HTML（引擎侧 Edge headless 渲染为 PDF） */
function buildResumeHtml(personName: string, resumeName: string, modules: { title: string; content: string }[]): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  body { font-family: "Microsoft YaHei", sans-serif; color: #1a1a1e; margin: 40px 48px; font-size: 14px; line-height: 1.6; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #6e6e78; font-size: 12px; margin-bottom: 24px; }
  h2 { font-size: 15px; border-bottom: 1px solid #d8d8dd; padding-bottom: 4px; margin: 20px 0 8px; }
  p { margin: 0 0 10px; white-space: pre-wrap; }
</style>
</head>
<body>
  <h1>${escapeHtml(personName)}</h1>
  <div class="sub">${escapeHtml(resumeName)}</div>
  ${modules.map((m) => `<h2>${escapeHtml(m.title)}</h2><p>${escapeHtml(m.content)}</p>`).join('\n  ')}
</body>
</html>`
}

export function ResumesPage() {
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const push = useToastStore((s) => s.push)
  const person = useAppStore((s) => s.currentPerson())
  const resumesView = useAppStore((s) => s.resumesView)
  const activeResumeId = useAppStore((s) => s.activeResumeId)
  const setActiveResumeId = useAppStore((s) => s.setActiveResumeId)
  const engineStatus = useAppStore((s) => s.engineStatus)
  const rewrite = useAppStore((s) => s.rewrite)
  const startRewrite = useAppStore((s) => s.startRewrite)
  const cancelRewrite = useAppStore((s) => s.cancelRewrite)
  const resetRewrite = useAppStore((s) => s.resetRewrite)
  const reportRewriteFeedback = useAppStore((s) => s.reportRewriteFeedback)
  const resumes = useAppStore((s) => s.resumes)
  const personResumes = useMemo(() => resumes.filter((r) => r.personId === person.id), [resumes, person.id])
  const resume = personResumes.find((r) => r.id === activeResumeId) ?? personResumes[0]
  const [modules, setModules] = useState<ResumeModule[]>(resume?.modules ?? [])
  /** 选中状态 → 「✨ 改写」按钮位置（选区右下） */
  const [selButton, setSelButton] = useState<{
    top: number;
    left: number;
    moduleId: string;
    text: string;
  } | null>(null)
  /** 改写浮层展开状态 */
  const [cardOpen, setCardOpen] = useState(false)
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null)
  /** 改写指令输入（Revision Request 的约束表达） */
  const [instruction, setInstruction] = useState('')
  /** 显式降级开关：error 后用户点「使用规则建议」→ 展示规则候选（R007 降级必须显式） */
  const [fallbackOpen, setFallbackOpen] = useState(false)
  const [revert, setRevert] = useState<{ moduleId: string; prevContent: string } | null>(null)
  const [deriveOpen, setDeriveOpen] = useState(false)
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const btnRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  /** 改写目标岗位上下文（prompt 注入；契约允许"参考 JD 上下文"，非自动匹配） */
  const jdContext = resume?.targetPosition
    ? `目标职位：${resume.targetPosition}${resume.targetCompany ? `（${resume.targetCompany}）` : ''}`
    : ''

  const closeAll = () => {
    setSelButton(null)
    setCardOpen(false)
  }

  /** R001：请求失效触发源——关闭/清理统一入口（running 则取消 + 复位） */
  const invalidateRewrite = () => {
    // 2B：候选已生成但未应用 → 用户决策 reject（只记录事件，不学习）
    if (rewrite.status === 'done' && rewrite.text.length > 0 && !revert) {
      reportRewriteFeedback({ action: 'reject' })
    }
    if (rewrite.status === 'thinking' || rewrite.status === 'streaming') cancelRewrite()
    else resetRewrite()
    setInstruction('')
    setFallbackOpen(false)
  }

  // R001：切换简历（模块上下文变化）→ 清理浮层与进行中的改写请求
  useEffect(() => {
    closeAll()
    invalidateRewrite()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeResumeId])

  // 点击按钮/卡片之外 → 关闭改写浮层（非模态，不吞点击；R001 场景 B：关闭即取消请求）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (cardRef.current?.contains(t) || btnRef.current?.contains(t)) return
      if (cardOpen) invalidateRewrite()
      setCardOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardOpen])

  // 切人时：activeResumeId 不在当前人名下 → 回退到当前人第一份
  useEffect(() => {
    if (personResumes.length > 0 && !personResumes.some((r) => r.id === activeResumeId)) {
      setActiveResumeId(personResumes[0].id)
    }
  }, [person.id, personResumes, activeResumeId, setActiveResumeId])

  // 版本切换由二级栏「版本 / 血缘」驱动（store），此处同步模块内容
  useEffect(() => {
    const r = personResumes.find((x) => x.id === activeResumeId)
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
    // textarea 失焦时浏览器会派发 select 事件（Blink blur 行为），并非用户划词——
    // 忽略，避免误清空改写指令、误取消进行中的改写
    if (document.activeElement !== el) return
    const sel = window.getSelection()
    const text = sel ? sel.toString().trim() : ''
    if (text.length < 6) {
      // 选区无效（光标/点击/编辑）→ 隐藏按钮
      setSelButton((prev) => (prev ? null : prev))
      return
    }
    // R001 场景 A：新选区产生 → 旧改写请求立即失效（绑定旧上下文）
    if (rewrite.status === 'thinking' || rewrite.status === 'streaming') cancelRewrite()
    setInstruction('')
    // textarea 选区的 range 无布局信息（rect 为 0×0），回退到元素 rect
    let rect = null
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0).getBoundingClientRect()
      if (r.width > 0 && r.height > 0) rect = r
    }
    if (!rect) rect = el.getBoundingClientRect()
    // 按钮右对齐选区底边；left/top 均防视口溢出（底部选区时按钮上移，避免出现在视口外）
    const left = Math.min(rect.right - 92, window.innerWidth - 104)
    const top = Math.min(rect.bottom + 4, window.innerHeight - 40)
    setSelButton({ top, left, moduleId, text })
  }

  const openCard = () => {
    if (!selButton) return
    // 初值防溢出：底部选区时浮层上移、右缘选区时浮层左移（浮层 440 宽，渲染后实测修正）
    const top = Math.min(selButton.top + 30, window.innerHeight - 260)
    const left = Math.min(selButton.left, window.innerWidth - 440 - 8)
    setCardPos({ top: Math.max(8, top), left: Math.max(8, left) })
    setCardOpen(true)
  }

  // 浮层渲染前按实际尺寸修正位置（useLayoutEffect：绘制前完成，浮层首次渲染即正确位置，
  // 避免打开后 DOM 移动导致 mousedown/mouseup 坐标不一致而吞掉首次点击）
  useLayoutEffect(() => {
    if (!cardOpen || !cardRef.current || !cardPos) return
    const { offsetHeight: h, offsetWidth: w } = cardRef.current
    const top = Math.max(8, Math.min(cardPos.top, window.innerHeight - h - 8))
    const left = Math.max(8, Math.min(cardPos.left, window.innerWidth - w - 8))
    if (top !== cardPos.top || left !== cardPos.left) setCardPos({ top, left })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardOpen])

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
        {resume && (
          <>
            {/* 版本切换在侧栏（ResumesSidebar）——此处只显示当前版本目标 */}
            {resume.targetCompany && (
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
                → {resume.targetCompany} · {resume.targetPosition}
              </Typography>
            )}
          </>
        )}
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          startIcon={<AutoAwesomeIcon sx={{ fontSize: 14 }} />}
          disabled={person.initStatus === 'pending'}
          title={person.initStatus === 'pending' ? '完成基础档案后可生成简历' : undefined}
          onClick={() => setDeriveOpen(true)}
          sx={{ fontSize: 12 }}
        >
          基于 JD 派生
        </Button>
        <Button
          size="small"
          startIcon={<FileDownloadIcon sx={{ fontSize: 14 }} />}
          onClick={() => {
            // 在线：引擎 spawn Edge headless 渲染 PDF 直接下载；离线/失败 → window.print 降级
            const html = buildResumeHtml(person.name, resume?.name ?? '', modules)
            void (async () => {
              try {
                const { pdf, fileName } = await useAppStore.getState().exportResume(html)
                const blob = new Blob([Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0))], {
                  type: 'application/pdf',
                })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = fileName
                a.click()
                URL.revokeObjectURL(url)
                push('success', '已导出 PDF')
              } catch {
                push('info', '导出服务不可用，已打开打印（另存为 PDF）')
                window.print()
              }
            })()
          }}
          sx={{ fontSize: 12 }}
        >
          导出 PDF
        </Button>
      </Stack>

      {/* 版本切换在侧栏「版本」——此处不重复提供入口 */}

      {/* M3.5.5 Resume Studio：Artifact Evolution Graph + Human Approval Console（无 Sentence 编辑器） */}
      {resumesView === 'studio' && (
        <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
          <ResumeStudio />
        </Box>
      )}

      {/* M3.5.5 Resume Assets：AI Read Projection Viewer（CareerContext 只读投影） */}
      {resumesView === 'assets' && (
        <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
          <ResumeAssets />
        </Box>
      )}

      {resumesView === 'workspace' && !resume ? (
        <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
          <Stack spacing={1} sx={{ alignItems: 'center', textAlign: 'center', maxWidth: 320 }}>
            <Typography sx={{ fontSize: 14, fontWeight: 600 }}>「{person.name}」暂无简历</Typography>
            <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted }}>
              从 AI 面板发起首个简历生成，或使用「基于 JD 派生」定制版本
            </Typography>
            <Button
              size="small"
              variant="contained"
              disabled={person.initStatus === 'pending'}
              title={person.initStatus === 'pending' ? '完成基础档案后可生成简历' : undefined}
              onClick={() => {
                startAnalysis(`请为「${person.name}」生成简历：基于画像模块化输出，含量化指标与方向关键词`)
                push('info', '已预置「生成简历」上下文')
              }}
              sx={{ fontSize: 12.5 }}
            >
              生成简历
            </Button>
          </Stack>
        </Box>
      ) : (
      <>
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
                  border: `1px solid ${alpha(COLORS.border, 0.8)}`,
                  boxShadow: COLORS.cardShadow,
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
      </>
      )}

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

      {/* 改写浮层：非模态（不吞点击），点外部/× 关闭；在线=指令式改写，离线=规则建议降级 */}
      {cardOpen && cardPos && selButton && (
        <Box
          ref={cardRef}
          sx={{
            position: 'fixed',
            top: cardPos.top,
            left: cardPos.left,
            zIndex: 1300,
            width: 440,
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
            <Typography sx={{ fontSize: 12, fontWeight: 600, flex: 1 }}>请求改写</Typography>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
              {engineStatus === 'connected' ? 'AI 助手生成候选' : '规则建议（引擎离线）'}
            </Typography>
            <IconButton
              size="small"
              onClick={() => {
                invalidateRewrite()
                closeAll()
              }}
              aria-label="关闭改写"
              sx={{ p: 0.25 }}
            >
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

          {/* 在线 idle：意图 chips + 约束输入（Revision Request 捕获器） */}
          {engineStatus === 'connected' && rewrite.status === 'idle' && (
            <>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 0.5 }}>
                期望怎么改？
              </Typography>
              <Stack direction="row" spacing={0.5} sx={{ mb: 1, flexWrap: 'wrap', gap: 0.5 }}>
                {INTENT_CHIPS.map((chip) => (
                  <Chip
                    key={chip}
                    size="small"
                    label={chip}
                    onClick={() => setInstruction(chip)}
                    sx={{
                      height: 22,
                      fontSize: 11.5,
                      cursor: 'pointer',
                      bgcolor: instruction === chip ? COLORS.accentMuted : COLORS.bgHover,
                      color: instruction === chip ? COLORS.accent : COLORS.textSecondary,
                      border: `1px solid ${instruction === chip ? COLORS.accent : COLORS.border}`,
                    }}
                  />
                ))}
              </Stack>
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                <TextField
                  size="small"
                  fullWidth
                  placeholder="补充要求（可选）：不要像教程，要像产品介绍…"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void startRewrite(selButton.text, instruction.trim() || '优化表述', jdContext)
                    }
                  }}
                  sx={{
                    '& .MuiInputBase-root': { fontSize: 12.5, bgcolor: COLORS.bgHover },
                  }}
                />
                <Button
                  size="small"
                  variant="contained"
                  onClick={() => void startRewrite(selButton.text, instruction.trim() || '优化表述', jdContext)}
                  sx={{ fontSize: 12, minWidth: 0, px: 1.5, height: 32 }}
                >
                  生成改写
                </Button>
              </Stack>
            </>
          )}

          {/* 在线 running：思考胶囊 + 流式候选 */}
          {(rewrite.status === 'thinking' || rewrite.status === 'streaming') && (
            <>
              {rewrite.status === 'thinking' && (
                <Box
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.75,
                    px: 1.5,
                    py: 0.5,
                    mb: 1,
                    borderRadius: '999px',
                    bgcolor: COLORS.bgHover,
                    border: `1px solid ${COLORS.border}`,
                  }}
                >
                  <Typography sx={{ fontSize: 12, fontFamily: COLORS.mono, color: COLORS.textMuted }}>
                    思考中
                  </Typography>
                  <Box sx={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    {[0, 1, 2].map((i) => (
                      <Box
                        key={i}
                        sx={{
                          width: 4,
                          height: 4,
                          borderRadius: '50%',
                          bgcolor: COLORS.textMuted,
                          animation: `cos-thinking-dot 1.2s ease-in-out ${i * 0.2}s infinite`,
                        }}
                      />
                    ))}
                  </Box>
                </Box>
              )}
              <Box
                sx={{
                  p: 1.25,
                  borderRadius: '6px',
                  bgcolor: COLORS.bgHover,
                  border: `1px solid ${COLORS.border}`,
                  minHeight: 64,
                  maxHeight: 160,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  color: COLORS.text,
                }}
              >
                {rewrite.text || '正在生成改写建议…'}
              </Box>
            </>
          )}

          {/* 在线 done：并排对比（原文 vs 候选）+ 应用/再调整 */}
          {engineStatus === 'connected' && rewrite.status === 'done' && (
            <>
              <Stack direction="row" spacing={0.75} sx={{ mb: 0.5 }}>
                <Typography sx={{ flex: 1, fontSize: 11.5, color: COLORS.textMuted }}>原文</Typography>
                <Typography sx={{ flex: 1, fontSize: 11.5, color: COLORS.accent }}>改写建议</Typography>
              </Stack>
              <Stack direction="row" spacing={0.75} sx={{ mb: 1 }}>
                <Box
                  sx={{
                    flex: 1,
                    p: 1,
                    borderRadius: '6px',
                    bgcolor: COLORS.bgHover,
                    border: `1px solid ${COLORS.border}`,
                    fontSize: 12,
                    lineHeight: 1.5,
                    maxHeight: 120,
                    overflow: 'auto',
                    color: COLORS.textMuted,
                  }}
                >
                  {selButton.text}
                </Box>
                <Box
                  sx={{
                    flex: 1,
                    p: 1,
                    borderRadius: '6px',
                    bgcolor: alpha(COLORS.accent, 0.06),
                    border: `1px solid ${alpha(COLORS.accent, 0.3)}`,
                    fontSize: 12,
                    lineHeight: 1.5,
                    maxHeight: 120,
                    overflow: 'auto',
                    color: COLORS.text,
                  }}
                >
                  {rewrite.text}
                </Box>
              </Stack>
              <Stack direction="row" spacing={0.75} sx={{ justifyContent: 'flex-end' }}>
                <Button
                  size="small"
                  onClick={() => resetRewrite()}
                  sx={{ fontSize: 12, minWidth: 0 }}
                >
                  再调整
                </Button>
                <Button
                  size="small"
                  variant="contained"
                  onClick={() => {
                    // 2B：用户采纳 AI 候选 → apply 事件（只记录不学习）
                    reportRewriteFeedback({ action: 'apply' })
                    applyCandidate(rewrite.text)
                    resetRewrite()
                  }}
                  sx={{ fontSize: 12, minWidth: 0, px: 1.5 }}
                >
                  应用改写
                </Button>
              </Stack>
            </>
          )}

          {/* 在线 error：错误卡 + 重试 + 显式降级 */}
          {engineStatus === 'connected' && rewrite.status === 'error' && (
            <>
              <Box
                sx={{
                  p: 1,
                  mb: 1,
                  borderRadius: '6px',
                  bgcolor: alpha(COLORS.riskHigh, 0.08),
                  border: `1px solid ${alpha(COLORS.riskHigh, 0.3)}`,
                  fontSize: 12,
                  color: COLORS.textSecondary,
                }}
              >
                {rewrite.error?.message ?? '改写失败'}
              </Box>
              <Stack direction="row" spacing={0.75} sx={{ justifyContent: 'flex-end' }}>
                <Button
                  size="small"
                  onClick={() => setFallbackOpen(true)}
                  sx={{ fontSize: 12, minWidth: 0 }}
                >
                  使用规则建议
                </Button>
                <Button
                  size="small"
                  variant="contained"
                  onClick={() => void startRewrite(selButton.text, instruction.trim() || '优化表述', jdContext)}
                  sx={{ fontSize: 12, minWidth: 0, px: 1.5 }}
                >
                  重新生成
                </Button>
              </Stack>
            </>
          )}

          {/* 降级候选（R007 显式）：离线 idle 直接可用；在线 error 后经「使用规则建议」进入 */}
          {((engineStatus !== 'connected' && rewrite.status === 'idle') ||
            (engineStatus === 'connected' && rewrite.status === 'error' && fallbackOpen)) && (
            <>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 0.5 }}>
                AI 改写不可用，使用规则建议：
              </Typography>
                <Stack spacing={0.75}>
                  {candidates.map((c, i) => (
                    <Box
                      key={i}
                      onClick={() => applyCandidate(c)}
                      sx={{
                        p: 1.25,
                        borderRadius: '6px',
                        border: `1px solid ${alpha(COLORS.border, 0.8)}`,
                        boxShadow: COLORS.cardShadow,
                        cursor: 'pointer',
                        transition: `background-color 180ms ${EASE}, border-color 180ms ${EASE}`,
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
              </>
            )}
        </Box>
      )}

      <ResumeDeriveDialog open={deriveOpen} onClose={() => setDeriveOpen(false)} />
    </Box>
  )
}
