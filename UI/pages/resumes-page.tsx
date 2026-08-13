import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import FileDownloadIcon from '@mui/icons-material/FileDownload'
import SaveAltIcon from '@mui/icons-material/SaveAlt'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import CloseIcon from '@mui/icons-material/Close'
import UndoIcon from '@mui/icons-material/Undo'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, EASE, RISK_COLOR } from '../data/constants'
import type { Person, ResumeEntry, ResumeModule } from '../types'
import type { CareerContext } from '../../engine/ir/context.ts'
import type { EvidenceItem } from '../../engine/ir/schema.ts'
import { modulesToSections, sectionsToModules, buildSkeletonModules } from '../utils/resume-working-copy'
import { ResumeDeriveDialog } from '../components/resume-derive-dialog'
import { ResumeStudio } from '../components/resume-studio'
import { ResumeAssets } from '../components/resume-assets'
import { ResumeDashboard } from '../components/resume/ResumeDashboard'
import { ResumeOptimizeWorkspace } from '../components/resume/ResumeOptimizeWorkspace'
import { computeResumeQuality, computeQualityChecks } from '../utils/resume-quality'

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

/** 经历分类用户语言（evidenceType → 资产面板标注；不暴露 IR 枚举） */
const EVIDENCE_TYPE_LABEL: Record<string, string> = {
  professional_experience: '职责',
  independent_project: '项目',
  learning_record: '学习',
}

const isExperienceModule = (title: string) => /工作经历|项目经验|项目经历|实习经历/.test(title)

/** 摘要段（个人优势）——平铺段，行锚 claim（Summary Strength Contract v0.1） */
const isSummaryModule = (title: string) => /个人优势|专业摘要|自我评价/.test(title)

/** 模块内容行（条目 content 与平铺 content 同契约——行 = 块文本） */
const linesOf = (content: string): string[] => content.split('\n').filter(Boolean)

/** 条目排序（Entry Contract §5）：period 倒序；无 period（未分组/新建空条目）垫底 */
function sortEntries(entries: ResumeEntry[]): ResumeEntry[] {
  return [...entries].sort((a, b) => (b.period ?? '').localeCompare(a.period ?? ''))
}

/** Entry Contract v0.1 迁移（渲染归类，保存即落盘）：旧平铺经历模块 → 条目化。
 *  有锚行按 claim → evidence 归条目（职责类 + 工作经历模块 → 公司条目）；无锚行 → 「未分组」兜底 */
function migrateEntries(
  mods: ResumeModule[],
  linksByText: Map<string, string[]>,
  evidenceItems: EvidenceItem[],
  claims: CareerContext['claims'],
  person: Person,
): ResumeModule[] {
  return mods.map((m) => {
    if (!isExperienceModule(m.title) || m.entries || m.content.trim() === '') return m
    const byKey = new Map<string, { entry: ResumeEntry; lines: string[] }>()
    const ungrouped: string[] = []
    const evidenceOf = (claimId: string) => {
      const claim = claims.find((c) => c.id === claimId)
      const evId = claim?.provenance.evidenceIds[0]
      return evId ? evidenceItems.find((e) => e.id === evId) : undefined
    }
    const company = person.experiences?.[0]
    for (const line of linesOf(m.content)) {
      const claimIds = linksByText.get(line) ?? []
      const ev = claimIds.length > 0 ? evidenceOf(claimIds[0]!) : undefined
      if (!ev || !ev.type) {
        ungrouped.push(line)
        continue
      }
      const isCompanyLine = m.title.includes('工作经历') && ev.type === 'professional_experience' && company
      const key = isCompanyLine ? `company:${company.company}` : `ev:${ev.id}`
      const hit = byKey.get(key) ?? {
        entry: isCompanyLine
          ? {
              id: `ent-company-${company.company}`,
              title: company.company,
              ...(company.role ? { role: company.role } : {}),
              ...(company.start || company.end ? { period: [company.start, company.end].filter(Boolean).join('-') } : {}),
              content: '',
            }
          : {
              id: `ent-${ev.id}`,
              title: ev.event.title,
              ...(ev.role ? { role: ev.role } : {}),
              ...(ev.event.period ? { period: ev.event.period } : {}),
              content: '',
            },
        lines: [],
      }
      hit.lines.push(line)
      byKey.set(key, hit)
    }
    const entries = sortEntries([...byKey.values()].map(({ entry, lines }) => ({ ...entry, content: lines.join('\n') })))
    if (ungrouped.length > 0) entries.push({ id: 'ent-ungrouped', title: '未分组', content: ungrouped.join('\n') })
    return { ...m, content: '', entries }
  })
}

/** HTML 转义（打印 HTML 内含用户文本——防注入） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 组装简历打印 HTML（引擎侧 Edge headless 渲染为 PDF；条目化段渲染条目头——Entry Contract v0.1） */
function buildResumeHtml(
  personName: string,
  resumeName: string,
  modules: { title: string; content: string; identity?: { label?: string; body?: string }[]; entries?: { title: string; role?: string; period?: string; description?: string; content: string }[] }[],
): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  body { font-family: "Microsoft YaHei", sans-serif; color: #1a1a1e; margin: 40px 48px; font-size: 14px; line-height: 1.6; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #6e6e78; font-size: 12px; margin-bottom: 24px; }
  h2 { font-size: 15px; border-bottom: 1px solid #d8d8dd; padding-bottom: 4px; margin: 20px 0 8px; }
  h3 { font-size: 14px; margin: 10px 0 4px; }
  p { margin: 0 0 10px; white-space: pre-wrap; }
  .desc { color: #6e6e78; font-size: 12.5px; margin: 0 0 8px; white-space: pre-wrap; }
</style>
</head>
<body>
  <h1>${escapeHtml(personName)}</h1>
  <div class="sub">${escapeHtml(resumeName)}</div>
  ${modules
    .map((m) => {
      const body =
        m.entries && m.entries.length > 0
          ? m.entries
              .map((e) => {
                const head = [e.title, e.role, e.period ? `（${e.period}）` : ''].filter(Boolean).join(' · ')
                const desc = e.description ? `<p class="desc">${escapeHtml(e.description)}</p>` : ''
                return `<h3>${escapeHtml(head)}</h3>${desc}${e.content ? `<p>${escapeHtml(e.content)}</p>` : ''}`
              })
              .join('\n  ')
          : m.identity && m.identity.length > 0
            ? m.identity.map((f) => `<b>${escapeHtml(f.label ?? '')}：</b>${escapeHtml(f.body ?? '')}`).join('<br/>')
            : escapeHtml(m.content)
      return `<h2>${escapeHtml(m.title)}</h2>${m.entries && m.entries.length > 0 ? body : `<p>${body}</p>`}`
    })
    .join('\n  ')}
</body>
</html>`
}

export function ResumesPage() {
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const push = useToastStore((s) => s.push)
  const person = useAppStore((s) => s.currentPerson())
  const resumeWorkspaceView = useAppStore((s) => s.resumeWorkspaceView)
  const engineStatus = useAppStore((s) => s.engineStatus)
  const rewrite = useAppStore((s) => s.rewrite)
  const startRewrite = useAppStore((s) => s.startRewrite)
  const cancelRewrite = useAppStore((s) => s.cancelRewrite)
  const resetRewrite = useAppStore((s) => s.resetRewrite)
  const reportRewriteFeedback = useAppStore((s) => s.reportRewriteFeedback)
  const resumes = useAppStore((s) => s.resumes)
  const workingCopies = useAppStore((s) => s.workingCopies)
  const activeWorkingCopyId = useAppStore((s) => s.activeWorkingCopyId)
  const setActiveWorkingCopy = useAppStore((s) => s.setActiveWorkingCopy)
  const upsertWorkingCopy = useAppStore((s) => s.upsertWorkingCopy)
  const promoteWorkingCopy = useAppStore((s) => s.promoteWorkingCopy)
  const careerContext = useAppStore((s) => s.careerContext)
  const evidenceItems = useAppStore((s) => s.evidence)
  const personResumes = useMemo(() => resumes.filter((r) => r.personId === person.id), [resumes, person.id])
  /** P2.3：编辑对象 = 工作副本（引擎侧用户创作对象）——localStorage 草稿降为初始化来源 */
  const personWorkingCopies = useMemo(() => workingCopies.filter((w) => w.owner === person.personId), [workingCopies, person.personId])
  const workingCopy = personWorkingCopies.find((w) => w.id === activeWorkingCopyId) ?? personWorkingCopies[0]
  const resume = personResumes[0]
  const [modules, setModules] = useState<ResumeModule[]>([])
  /** P2.3：block 绑定保留（text → claim links——编辑重建 blocks 时合并，不丢锚） */
  const linksByText = useRef<Map<string, string[]>>(new Map())

  /** 重建 blocks 时按文本合并既有绑定（新行 unbound；已有行保留 provenanceLinks——
   *  条目化段 entries[].blocks 同样合并，否则条目表述丢锚 → 全段退化为未资产化） */
  const buildSections = (mods: ResumeModule[]) => {
    const mergeLinks = (b: { id: string; text: string }) => {
      const links = linksByText.current.get(b.text)
      return links ? { ...b, provenanceLinks: links } : b
    }
    return modulesToSections(mods).map((s) => ({
      ...s,
      blocks: s.blocks.map(mergeLinks),
      ...(s.entries ? { entries: s.entries.map((e) => ({ ...e, blocks: e.blocks.map(mergeLinks) })) } : {}),
    }))
  }

  /** 模块变更统一出口：本地 state（输入流畅）+ 防抖 upsert 到引擎 working-copies（revision 协商） */
  const commitModules = (next: ResumeModule[]) => {
    setModules(next)
    if (workingCopy) {
      void upsertWorkingCopy({
        id: workingCopy.id,
        owner: person.personId ?? '',
        sections: buildSections(next),
        revision: workingCopy.revision,
      }).catch((e: unknown) => push('warning', e instanceof Error ? e.message : '保存失败'))
    }
  }
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
  /** P1.2：从经历资产添加（assetOpen = 目标模块 + 条目 id——用户主动应用表达资产进草稿） */
  const [assetOpen, setAssetOpen] = useState<{ moduleId: string; entryId: string } | null>(null)
  /** R1：表达检查清单展开态（质量条「查看详情」——逐项诊断非评分结论） */
  const [showChecks, setShowChecks] = useState(false)
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

  /** 导出当前编辑对象（在线：引擎 Edge headless 渲染 PDF 直接下载；离线/失败 → window.print 降级） */
  const exportPdf = () => {
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

  // R001：切换工作副本（模块上下文变化）→ 清理浮层与进行中的改写请求
  useEffect(() => {
    closeAll()
    invalidateRewrite()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkingCopyId])

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

  // 切人时：activeWorkingCopyId 不在当前人名下 → 回退到当前人第一个工作副本
  useEffect(() => {
    if (personWorkingCopies.length > 0 && !personWorkingCopies.some((w) => w.id === activeWorkingCopyId)) {
      setActiveWorkingCopy(personWorkingCopies[0].id)
    }
  }, [person.id, personWorkingCopies, activeWorkingCopyId, setActiveWorkingCopy])

  // P2.3：工作副本切换 → 同步模块内容（sections → modules；编辑写回走 commitModules 防抖 upsert）
  useEffect(() => {
    if (workingCopy) {
      const map = new Map<string, string[]>()
      for (const s of workingCopy.sections) {
        for (const b of s.blocks) {
          if (b.provenanceLinks && b.provenanceLinks.length > 0) map.set(b.text, b.provenanceLinks)
        }
        for (const e of s.entries ?? []) {
          for (const b of e.blocks) {
            if (b.provenanceLinks && b.provenanceLinks.length > 0) map.set(b.text, b.provenanceLinks)
          }
        }
      }
      linksByText.current = map
      // Entry Contract v0.1 迁移：旧平铺经历模块渲染归类（保存即落盘新格式）
      const migrated = migrateEntries(sectionsToModules(workingCopy.sections), map, evidenceItems, careerContext?.claims ?? [], person)
      setModules(migrated)
      setRevert(null)
      setNameDraft(null)
      closeAll()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkingCopyId])

  const qualityScore = useMemo(() => computeResumeQuality(modules), [modules])
  const qualityChecks = useMemo(() => computeQualityChecks(modules), [modules])

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
    const [mid, eid] = moduleId.split(':')
    let applied = false
    const next = modules.map((m) => {
      if (m.id !== mid) return m
      // 条目 textarea（复合 id moduleId:entryId）→ 替换落在条目 content
      if (eid) {
        const entry = m.entries?.find((e) => e.id === eid)
        if (!entry) return m
        const idx = entry.content.indexOf(selectedText)
        if (idx === -1) return m
        applied = true
        setRevert({ moduleId, prevContent: entry.content })
        return {
          ...m,
          entries: m.entries!.map((e) =>
            e.id === eid
              ? { ...e, content: entry.content.slice(0, idx) + text + entry.content.slice(idx + selectedText.length) }
              : e,
          ),
        }
      }
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
    })
    if (applied) {
      commitModules(next)
      push('success', '已应用 AI 改写（可撤销）')
    } else {
      push('warning', '原文已变化，请重新划词')
    }
    closeAll()
  }

  const undoRewrite = () => {
    if (!revert) return
    const [mid, eid] = revert.moduleId.split(':')
    commitModules(
      modules.map((m) => {
        if (m.id !== mid) return m
        if (eid) return { ...m, entries: m.entries?.map((e) => (e.id === eid ? { ...e, content: revert.prevContent } : e)) }
        return { ...m, content: revert.prevContent }
      }),
    )
    setRevert(null)
    push('info', '已撤销本次改写')
  }

  const moveModule = (index: number, dir: -1 | 1) => {
    const next = index + dir
    if (next < 0 || next >= modules.length) return
    const copy = [...modules];
    [copy[index], copy[next]] = [copy[next], copy[index]]
    commitModules(copy.map((m, i) => ({ ...m, order: i })))
  }

  /** 条目字段/内容变更（Entry Contract：条目头 = 事实通道——编辑保存 = 用户确认） */
  const updateEntry = (moduleId: string, entryId: string, patch: Partial<ResumeEntry>) => {
    setRevert(null)
    commitModules(
      modules.map((m) =>
        m.id === moduleId && m.entries
          ? { ...m, entries: m.entries.map((e) => (e.id === entryId ? { ...e, ...patch } : e)) }
          : m,
      ),
    )
  }
  const moveEntry = (moduleId: string, entryId: string, dir: -1 | 1) => {
    const m = modules.find((x) => x.id === moduleId)
    if (!m?.entries) return
    const i = m.entries.findIndex((e) => e.id === entryId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= m.entries.length) return
    const copy = [...m.entries];
    [copy[i], copy[j]] = [copy[j], copy[i]]
    commitModules(modules.map((x) => (x.id === moduleId ? { ...x, entries: copy } : x)))
  }
  const addEntry = (moduleId: string) => {
    const m = modules.find((x) => x.id === moduleId)
    if (!m) return
    const entries = [...(m.entries ?? []), { id: `ent-${Date.now().toString(36)}`, title: '', content: '' }]
    commitModules(modules.map((x) => (x.id === moduleId ? { ...x, entries } : x)))
  }
  /** 删除条目确认（无锚行删除即弃；有锚表述回资产池不删资产） */
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState<{ moduleId: string; entryId: string } | null>(null)
  const doDeleteEntry = () => {
    if (!confirmDeleteEntry) return
    const { moduleId, entryId } = confirmDeleteEntry
    commitModules(
      modules.map((m) =>
        m.id === moduleId && m.entries ? { ...m, entries: m.entries.filter((e) => e.id !== entryId) } : m,
      ),
    )
    setConfirmDeleteEntry(null)
    push('info', '条目已删除（表述仍保留在资产池）')
  }

  /** 技能资产通道（Entry Contract §7：flat 技能资产行——skill_inventory 投影） */
  const [skillOpen, setSkillOpen] = useState(false)
  const skillModule = useMemo(() => modules.find((m) => /技能/.test(m.title)), [modules])
  const insertSkill = (skillName: string) => {
    if (!skillModule) return
    if (linesOf(skillModule.content).some((l) => l.includes(skillName))) {
      push('info', '该技能已在技能模块中')
      return
    }
    const line = `- ${skillName}`
    commitModules(modules.map((m) => (m.id === skillModule.id ? { ...m, content: `${m.content}${m.content ? '\n' : ''}${line}` } : m)))
    push('success', '已加入技能模块（来自技能资产）')
  }

  /** 工作副本显示名（User Confirmation 编辑内容，非系统身份——失焦/回车保存；空 = 回退系统 ID 切片） */
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const commitRename = () => {
    if (!workingCopy || nameDraft === null) return
    const nextName = nameDraft.trim()
    void upsertWorkingCopy({
      id: workingCopy.id,
      owner: person.personId ?? '',
      name: nextName,
      sections: buildSections(modules),
      revision: workingCopy.revision,
    })
      .then(() => push('success', nextName ? '已重命名' : '已清除显示名（显示系统编号）'))
      .catch((e: unknown) => push('warning', e instanceof Error ? e.message : '重命名失败'))
    setNameDraft(null)
  }

  /** P1.2：可用表达资产（本人生效——归属过滤 + usable；owner 缺失 = 归属不明，不展示给任何人） */
  const usableClaims = useMemo(
    () => (careerContext?.claims ?? []).filter((c) => c.usable && c.owner === person.personId),
    [careerContext, person.personId],
  )
  /** 资产面板排序：目标模块类型优先（工作经历→职责类；项目经验→项目类）——仅排序不硬过滤，同一条表述两模块都可合法消费 */
  const orderedClaims = useMemo(() => {
    if (!assetOpen) return usableClaims
    const target = modules.find((m) => m.id === assetOpen.moduleId)?.title ?? ''
    const preferred = target.includes('工作经历') ? 'professional_experience' : 'independent_project'
    return [...usableClaims].sort((a, b) => (a.evidenceType === preferred ? 0 : 1) - (b.evidenceType === preferred ? 0 : 1))
  }, [usableClaims, assetOpen, modules])
  /** 目标条目已绑定的表述 id（行文本 → claim 锚反查）——已添加状态标记 + 防同条目重复插入 */
  const addedClaimIds = useMemo(() => {
    if (!assetOpen) return new Set<string>()
    const target = modules.find((m) => m.id === assetOpen.moduleId)
    if (!target) return new Set<string>()
    const entry = target.entries?.find((e) => e.id === assetOpen.entryId)
    const ids = new Set<string>()
    for (const line of linesOf(entry ? entry.content : target.content)) {
      for (const cid of linksByText.current.get(line) ?? []) ids.add(cid)
    }
    return ids
  }, [assetOpen, modules])
  /** claim → 使用中的模块集合（单侧使用判定——Entry Contract §5：跨模块重复需显式确认） */
  const claimModules = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const m of modules) {
      const allLines = m.entries && m.entries.length > 0 ? m.entries.flatMap((e) => linesOf(e.content)) : linesOf(m.content)
      for (const line of allLines) {
        for (const cid of linksByText.current.get(line) ?? []) {
          if (!map.has(cid)) map.set(cid, new Set())
          map.get(cid)!.add(m.id)
        }
      }
    }
    return map
  }, [modules])
  const titleOfEvidence = (id: string) => evidenceItems.find((e) => e.id === id)?.event.title ?? id
  /** 表述证据（首个 provenance evidence——条目自动归属的投影来源） */
  const evidenceOfClaim = (claimId: string) => {
    const claim = usableClaims.find((c) => c.id === claimId)
    const evId = claim?.provenance.evidenceIds[0]
    return evId ? evidenceItems.find((e) => e.id === evId) : undefined
  }

  /** 插入落点：目标条目（不存在 → 按证据投影自动建条目；Entry Contract §5 自动建条目——
   *  工作经历模块 + 职责类证据 → 公司条目（person 档案工作经历表）；其余 → 证据事件条目） */
  const entryForInsert = (moduleId: string, entryId: string, claimId: string): { module: ResumeModule; entry: ResumeEntry } => {
    const m = modules.find((x) => x.id === moduleId)!
    const existing = m.entries?.find((e) => e.id === entryId)
    if (existing) return { module: m, entry: existing }
    const ev = evidenceOfClaim(claimId)
    if (ev) {
      const byEvent = m.entries?.find((e) => e.title === ev.event.title)
      if (byEvent) return { module: m, entry: byEvent }
      const experiences = person.experiences ?? []
      // Entry Contract v0.2 Option A：workRowRef 优先（identity 行 = 唯一事实源）；
      // ref 行缺失 → 不猜公司，落证据事件条目（引擎已标 row_not_found，错位不再静默）
      const refRow = ev.workRowRef
        ? experiences.find((x) => x.company === ev.workRowRef!.company && (x.start ?? '') === ev.workRowRef!.start)
        : undefined
      const company =
        m.title.includes('工作经历') && ev.type === 'professional_experience'
          ? ev.workRowRef
            ? refRow
            : experiences[0]
          : undefined
      if (company) {
        const byCompany = m.entries?.find((e) => e.title === company.company)
        if (byCompany) return { module: m, entry: byCompany }
        return {
          module: m,
          entry: {
            id: `ent-company-${company.company}`,
            title: company.company,
            ...(company.role ? { role: company.role } : {}),
            ...(company.start || company.end ? { period: [company.start, company.end].filter(Boolean).join('-') } : {}),
            content: '',
          },
        }
      }
      return {
        module: m,
        entry: {
          id: `ent-${ev.id}`,
          title: ev.event.title,
          ...(ev.role ? { role: ev.role } : {}),
          ...(ev.event.period ? { period: ev.event.period } : {}),
          content: '',
        },
      }
    }
    const ungrouped = m.entries?.find((e) => e.id === 'ent-ungrouped')
    return { module: m, entry: ungrouped ?? { id: 'ent-ungrouped', title: '未分组', content: '' } }
  }

  /** 用户主动应用：Claim → 条目插入（不自动插入——User apply 边界；插入行带 claim 锚；
   *  同条目已绑定 → 提示不重复；跨模块已使用 → 显式确认（防重复写两遍减分）；
   *  摘要段例外——蒸馏正文是市场规范（结论+证据对），不触发跨模块确认 */
  const insertClaim = (claimId: string) => {
    if (!assetOpen) return
    if (addedClaimIds.has(claimId)) {
      push('info', '该表述已在当前条目中')
      return
    }
    const targetTitle = modules.find((m) => m.id === assetOpen.moduleId)?.title ?? ''
    if (!isSummaryModule(targetTitle)) {
      const usedModules = claimModules.get(claimId)
      if (usedModules && !usedModules.has(assetOpen.moduleId)) {
        setPendingCross({ claimId })
        return
      }
    }
    doInsertClaim(claimId)
  }

  const doInsertClaim = (claimId: string) => {
    if (!assetOpen) return
    const claim = usableClaims.find((c) => c.id === claimId)
    if (!claim) return
    const m = modules.find((x) => x.id === assetOpen.moduleId)
    if (!m) return
    // 平铺段（个人优势）：行追加到 content + claim 锚（Entry Contract §1 平铺段形态）
    if (!m.entries) {
      const line = `- ${claim.statement}`
      if (linesOf(m.content).includes(line)) {
        push('info', '该表述已在当前模块中')
        return
      }
      linksByText.current.set(line, [claimId])
      commitModules(modules.map((x) => (x.id === m.id ? { ...x, content: `${m.content}${m.content ? '\n' : ''}${line}` } : x)))
      setAssetOpen(null)
      push('success', '已加入个人优势（表达来自经历资产）')
      return
    }
    const { module, entry } = entryForInsert(assetOpen.moduleId, assetOpen.entryId, claimId)
    const line = `- ${claim.statement}`
    linksByText.current.set(line, [claimId])
    const nextEntries = sortEntries([
      ...(module.entries ?? []).filter((e) => e.id !== entry.id),
      { ...entry, content: `${entry.content}${entry.content ? '\n' : ''}${line}` },
    ])
    commitModules(modules.map((x) => (x.id === module.id ? { ...x, content: '', entries: nextEntries } : x)))
    setAssetOpen(null)
    push('success', '已加入简历（表达来自经历资产）')
  }

  /** 优势亮点（Summary Strength Contract v0.2）：profile 级引用型资产——结论句 + 多锚支撑
   *  （claimIds 经历型 / evidenceIds 技能奖项型；双空 = 软性条目降级标注）。保存 = 用户确认。
   *  所有写操作从 store 读最新状态（getState）——渲染闭包在 HMR/异步期间可能过期，用陈旧数组
   *  写回 = 覆盖引擎侧新数据（2026-08-14 实损 4 条优势教训）。 */
  type StrengthDraft = { text: string; claimIds: string[]; evidenceIds: string[] }
  const strengths = (person.summaryStrengths ?? []) as StrengthDraft[]
  /** 当前人的优势亮点最新状态（getState 实时读取——写操作唯一数据源，不用渲染闭包） */
  const latestStrengths = () =>
    ((useAppStore.getState().persons.find((p) => p.personId === person.personId)?.summaryStrengths ?? []) as StrengthDraft[])
  /** 已保存快照（onBlur 对比基准——本地乐观编辑后 person.summaryStrengths 已变，不能作基线） */
  const strengthsSavedRef = useRef<StrengthDraft[]>(person.summaryStrengths ?? [])
  const saveStrengths = (items: StrengthDraft[]) => {
    if (!person.personId) {
      push('warning', '人员未登记（引擎未连接）——优势亮点保存需要引擎登记')
      return
    }
    void useAppStore
      .getState()
      .upsertSummaryStrengths(person.personId, items)
      .then(() => {
        strengthsSavedRef.current = items
        push('success', '优势亮点已保存')
      })
      .catch((e: unknown) => push('warning', e instanceof Error ? e.message : '保存失败'))
  }
  const addStrength = (claimId: string) => {
    const claim = usableClaims.find((c) => c.id === claimId)
    if (!claim) return
    const current = latestStrengths()
    if (current.some((s) => s.claimIds.includes(claimId))) {
      push('info', '该表述已是优势亮点支撑')
      return
    }
    saveStrengths([...current, { text: claim.statement, claimIds: [claimId], evidenceIds: [] }])
  }
  /** 新建空条目（本地草稿行——blur 时无文本则丢弃不保存） */
  const newStrength = () => {
    const pid = person.personId
    useAppStore.setState((st) => ({
      persons: st.persons.map((p) =>
        p.personId === pid ? { ...p, summaryStrengths: [...(p.summaryStrengths ?? []), { text: '', claimIds: [], evidenceIds: [] }] } : p,
      ),
    }))
  }
  const removeStrength = (index: number) => saveStrengths(latestStrengths().filter((_, i) => i !== index))
  const editStrength = (index: number, text: string) =>
    saveStrengths(latestStrengths().map((s, i) => (i === index ? { ...s, text } : s)))
  const toggleStrengthSupport = (index: number, kind: 'claimIds' | 'evidenceIds', id: string) => {
    const current = latestStrengths()
    const s = current[index]
    if (!s) return
    const arr = s[kind]
    saveStrengths(current.map((x, i) => (i === index ? { ...x, [kind]: arr.includes(id) ? arr.filter((v) => v !== id) : [...arr, id] } : x)))
  }
  const insertStrength = (s: StrengthDraft) => {
    if (!assetOpen) return
    const m = modules.find((x) => x.id === assetOpen.moduleId)
    if (!m) return
    const line = `- ${s.text}`
    if (linesOf(m.content).includes(line)) {
      push('info', '该优势已在模块中')
      return
    }
    if (s.claimIds.length > 0) linksByText.current.set(line, s.claimIds)
    commitModules(modules.map((x) => (x.id === m.id ? { ...x, content: `${m.content}${m.content ? '\n' : ''}${line}` } : x)))
    setAssetOpen(null)
    push('success', s.claimIds.length > 0 ? '已加入个人优势（多锚支撑已绑定）' : '已加入个人优势（软性条目——无 claim 锚，promote 会提示）')
  }
  /** 支撑 picker 展开态（优势条目行「+ 支撑」——内联展开，非浮层） */
  const [supportPicker, setSupportPicker] = useState<{ index: number } | null>(null)
  /** 支撑候选：本人 trusted 证据（技能/奖项型佐证事实） */
  const trustedEvidence = useMemo(
    () => evidenceItems.filter((e) => e.status === 'trusted' && e.owner === person.personId),
    [evidenceItems, person.personId],
  )
  /** AI 总结候选（Summary Strength Contract v0.2 §3：Agent CLI 桥提交 → 用户裁决） */
  const strengthProposals = useAppStore((s) => s.strengthProposals).filter(
    (p) => p.personId === person.personId && p.status === 'pending',
  )
  const [summarizing, setSummarizing] = useState(false)
  /** AI 总结运行态（backgroundTasks 类型匹配——引擎 done/error 事件清除；后台任务不走会话簿记） */
  const strengthTaskRunning = useAppStore((s) => Object.values(s.backgroundTasks).some((t) => t.type === 'strength_summary'))
  const strengthTaskId = useAppStore((s) => Object.entries(s.backgroundTasks).find(([, t]) => t.type === 'strength_summary')?.[0] ?? null)
  const cancelStrengthTask = () => {
    if (!strengthTaskId) return
    void useAppStore
      .getState()
      .cancelBackgroundTask(strengthTaskId)
      .then(() => push('info', '已取消总结任务'))
      .catch((e: unknown) => push('warning', e instanceof Error ? e.message : '取消失败'))
  }
  const summarizeStrengths = () => {
    if (!person.personId) {
      push('warning', '人员未登记（引擎未连接）——AI 总结需要引擎')
      return
    }
    setSummarizing(true)
    void useAppStore
      .getState()
      .generateStrengthProposals(person.personId)
      .then(() => push('info', 'AI 总结任务已启动——完成后建议卡出现在下方'))
      .catch((e: unknown) => push('warning', e instanceof Error ? e.message : '启动失败'))
      .finally(() => setSummarizing(false))
  }
  const decideStrength = (id: string, action: 'accept' | 'reject') => {
    void useAppStore
      .getState()
      .decideStrengthProposal(id, action)
      .then(() => push('success', action === 'accept' ? '已接受——优势已并入档案（引擎校验锚定链）' : '已拒绝（审计保留）'))
      .catch((e: unknown) => push('warning', e instanceof Error ? e.message : '裁决失败'))
  }

  /** 跨模块重复插入确认（单侧使用红线——用户显式确认才放行） */
  const [pendingCross, setPendingCross] = useState<{ claimId: string } | null>(null)

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* 版本切换在侧栏「版本」——此处不重复提供入口 */}

      {/* Dashboard（落地页，非第五空间——ADR-021 §1） */}
      {resumeWorkspaceView === 'dashboard' && (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <ResumeDashboard onDerive={() => setDeriveOpen(true)} />
        </Box>
      )}

      {/* 优化空间：Resume Alignment Projection 四态视图（R2.2；只消费引擎版本 × 已建档 JD） */}
      {resumeWorkspaceView === 'optimize' && (
        <Box sx={{ flex: 1, overflow: 'auto' }}>
          <ResumeOptimizeWorkspace />
        </Box>
      )}

      {/* 历史空间：Resume Studio（Artifact Evolution Graph + Human Approval Console） */}
      {resumeWorkspaceView === 'history' && (
        <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
          <ResumeStudio />
        </Box>
      )}

      {/* 素材空间：Resume Assets（CareerContext 只读投影） */}
      {resumeWorkspaceView === 'library' && (
        <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
          <ResumeAssets />
        </Box>
      )}

      {resumeWorkspaceView === 'edit' && (
        !workingCopy ? (
        <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
          <Stack spacing={1} sx={{ alignItems: 'center', textAlign: 'center', maxWidth: 320 }}>
            <Typography sx={{ fontSize: 14, fontWeight: 600 }}>「{person.name}」暂无工作副本</Typography>
            <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted }}>
              从现有简历初始化创作对象，或从 AI 面板发起首个简历生成
            </Typography>
            <Stack direction="row" spacing={1}>
              {resume && (
                <Button
                  size="small"
                  variant="contained"
                  onClick={async () => {
                    try {
                      // 演示简历不携带人设内容：以档案身份字段 + 空模块骨架初始化（M5.2 G6 身份事实通道）
                      const seed = resume.isDemo
                        ? buildSkeletonModules(person)
                        : resume.modules.map((m, i) => ({ ...m, order: i }))
                      await upsertWorkingCopy({ owner: person.personId ?? '', sections: modulesToSections(seed), revision: 0 })
                      push('success', resume.isDemo ? '已从档案初始化身份字段（演示内容未带入）' : '已创建工作副本（内容来自现有简历）')
                    } catch (e) {
                      push('warning', e instanceof Error ? e.message : '创建工作副本失败')
                    }
                  }}
                  sx={{ fontSize: 12.5 }}
                >
                  {resume.isDemo ? '从档案初始化' : '从现有简历初始化'}
                </Button>
              )}
              <Button
                size="small"
                variant={resume ? 'outlined' : 'contained'}
                disabled={person.initStatus === 'pending'}
                title={person.initStatus === 'pending' ? '完成基础档案后可生成简历' : undefined}
                onClick={() => {
                  startAnalysis(`请为「${person.name}」生成简历：基于画像模块化输出，含量化指标与方向关键词`, {
                    taskType: 'resume_generation',
                    outputTarget: 'artifact',
                  })
                  push('info', '已预置「生成简历」上下文')
                }}
                sx={{ fontSize: 12.5 }}
              >
                生成简历
              </Button>
            </Stack>
            {resume?.isDemo && (
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                现有简历为演示数据——初始化仅带入你的档案身份字段，演示内容不会写入
              </Typography>
            )}
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
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.5 }}>
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mr: 1 }}>
              <SaveAltIcon sx={{ fontSize: 13, color: COLORS.textMuted }} />
              <TextField
                size="small"
                variant="standard"
                value={nameDraft ?? workingCopy?.name?.trim() ?? ''}
                placeholder={workingCopy ? workingCopy.id.slice(-6) : '副本名'}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                title="工作副本显示名——失焦/回车保存；留空显示系统编号"
                sx={{ fontSize: 12, width: 180, '& .MuiInputBase-root': { fontSize: 12 } }}
              />
            </Stack>
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, flex: 1 }}>
              编辑区 · 划词或 Shift+方向键选中 6 字以上 → 点击 ✨ 改写 · 使用 ↑↓ 调整模块顺序
            </Typography>
            <Button
              size="small"
              startIcon={<SaveAltIcon sx={{ fontSize: 14 }} />}
              onClick={async () => {
                if (!workingCopy) return
                try {
                  const doc = await promoteWorkingCopy(workingCopy.id)
                  push('success', `已创建版本 ${doc.id.slice(-6)}（未资产化内容已标注，可查看历史空间）`)
                } catch (e) {
                  push('warning', e instanceof Error ? e.message : '创建版本失败')
                }
              }}
              sx={{ fontSize: 12 }}
            >
              创建版本
            </Button>
            <Button size="small" startIcon={<FileDownloadIcon sx={{ fontSize: 14 }} />} onClick={exportPdf} sx={{ fontSize: 12 }}>
              导出 PDF
            </Button>
          </Stack>
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
                  {(() => {
                    const sec = workingCopy?.sections.find((x) => x.id === m.id)
                    const allBlocks = [...(sec?.blocks ?? []), ...(sec?.entries ?? []).flatMap((e) => e.blocks)]
                    const bound = allBlocks.filter((b) => b.provenanceLinks && b.provenanceLinks.length > 0).length
                    const total = allBlocks.length
                    // 技能/个人信息走资产行与身份通道，不适用 claim 锚定角标（Entry Contract §7）
                    if (!sec || total === 0 || /技能|个人信息|基本信息/.test(m.title)) return null
                    const all = bound === total
                    return (
                      <Typography
                        sx={{ fontSize: 10.5, flexShrink: 0, mr: 0.5, color: all ? COLORS.riskLow : bound > 0 ? COLORS.riskMedium : COLORS.textMuted }}
                        title={all ? '内容均有事实来源' : '部分内容尚未关联证明材料——可先确认素材空间的待确认表达'}
                      >
                        {all ? '✓ 有事实来源' : bound > 0 ? `△ ${bound}/${total} 有来源` : '⚠ 未关联证明材料'}
                      </Typography>
                    )
                  })()}
                  {isExperienceModule(m.title) && (!m.entries || m.entries.length === 0) && usableClaims.length > 0 && (
                    <Button
                      size="small"
                      onClick={() => setAssetOpen({ moduleId: m.id, entryId: '' })}
                      title="从经历资产添加表达（将自动创建条目）"
                      sx={{ minWidth: 0, px: 0.75, fontSize: 12, color: COLORS.accent }}
                    >
                      + 资产
                    </Button>
                  )}
                  {isSummaryModule(m.title) && usableClaims.length > 0 && (
                    <Button
                      size="small"
                      onClick={() => setAssetOpen({ moduleId: m.id, entryId: '' })}
                      title="从资产添加优势（结论 + 证据锚——摘要不产生新事实）"
                      sx={{ minWidth: 0, px: 0.75, fontSize: 12, color: COLORS.accent }}
                    >
                      + 资产
                    </Button>
                  )}
                  {/技能/.test(m.title) && (person.skills?.length ?? 0) > 0 && (
                    <Button
                      size="small"
                      onClick={() => setSkillOpen(true)}
                      title="从技能资产添加（skill_inventory 登记技能）"
                      sx={{ minWidth: 0, px: 0.75, fontSize: 12, color: COLORS.accent }}
                    >
                      + 技能资产
                    </Button>
                  )}
                  <Button size="small" disabled={idx === 0} onClick={() => moveModule(idx, -1)} sx={{ minWidth: 0, px: 0.75, fontSize: 12 }}>
                    ↑
                  </Button>
                  <Button size="small" disabled={idx === modules.length - 1} onClick={() => moveModule(idx, 1)} sx={{ minWidth: 0, px: 0.75, fontSize: 12 }}>
                    ↓
                  </Button>
                </Stack>
                {m.entries && m.entries.length > 0 ? (
                  <Stack sx={{ p: 0.75 }} spacing={0.75}>
                    {m.entries.map((entry, ei) => (
                      <Box
                        key={entry.id}
                        sx={{
                          border: `1px solid ${alpha(COLORS.border, 0.7)}`,
                          borderRadius: '6px',
                          overflow: 'hidden',
                          ...(entry.title === '未分组' ? { bgcolor: alpha(COLORS.textMuted, 0.04), borderStyle: 'dashed' } : {}),
                        }}
                      >
                        <Stack
                          direction="row"
                          spacing={0.5}
                          sx={{ alignItems: 'center', px: 0.75, py: 0.25, bgcolor: COLORS.bgHover, borderBottom: `1px solid ${COLORS.border}` }}
                        >
                          <TextField
                            size="small"
                            variant="standard"
                            placeholder={m.title.includes('工作经历') ? '公司名' : '项目名'}
                            value={entry.title}
                            onChange={(e) => updateEntry(m.id, entry.id, { title: e.target.value })}
                            sx={{ fontSize: 12.5, flex: 1.5, '& .MuiInputBase-root': { fontSize: 12.5, fontWeight: 600 } }}
                          />
                          <TextField
                            size="small"
                            variant="standard"
                            placeholder="职位/角色"
                            value={entry.role ?? ''}
                            onChange={(e) => updateEntry(m.id, entry.id, { role: e.target.value || undefined })}
                            sx={{ fontSize: 12, flex: 1, '& .MuiInputBase-root': { fontSize: 12 } }}
                          />
                          <TextField
                            size="small"
                            variant="standard"
                            placeholder="时间段"
                            value={entry.period ?? ''}
                            onChange={(e) => updateEntry(m.id, entry.id, { period: e.target.value || undefined })}
                            sx={{ fontSize: 12, flex: 1, '& .MuiInputBase-root': { fontSize: 12 } }}
                          />
                          {entry.title === '未分组' && (
                            <Typography sx={{ fontSize: 10.5, color: COLORS.textMuted, flexShrink: 0 }}>待归置</Typography>
                          )}
                          {usableClaims.length > 0 && (
                            <Button
                              size="small"
                              onClick={() => setAssetOpen({ moduleId: m.id, entryId: entry.id })}
                              title="从经历资产添加表达"
                              sx={{ minWidth: 0, px: 0.5, fontSize: 11.5, color: COLORS.accent }}
                            >
                              + 资产
                            </Button>
                          )}
                          <Button size="small" disabled={ei === 0} onClick={() => moveEntry(m.id, entry.id, -1)} sx={{ minWidth: 0, px: 0.5, fontSize: 11.5 }}>
                            ↑
                          </Button>
                          <Button size="small" disabled={ei === m.entries!.length - 1} onClick={() => moveEntry(m.id, entry.id, 1)} sx={{ minWidth: 0, px: 0.5, fontSize: 11.5 }}>
                            ↓
                          </Button>
                          <Button
                            size="small"
                            onClick={() => setConfirmDeleteEntry({ moduleId: m.id, entryId: entry.id })}
                            title="删除条目（表述保留在资产池）"
                            sx={{ minWidth: 0, px: 0.5, fontSize: 11.5, color: COLORS.riskHigh }}
                          >
                            ✕
                          </Button>
                        </Stack>
                        <TextField
                          fullWidth
                          multiline
                          minRows={1}
                          maxRows={2}
                          size="small"
                          variant="standard"
                          placeholder={m.title.includes('项目') ? '项目概述：做什么/解决什么问题（背景，一两句）' : '职责范围概述（可选）'}
                          value={entry.description ?? ''}
                          onChange={(e) => updateEntry(m.id, entry.id, { description: e.target.value || undefined })}
                          sx={{
                            px: 1.25,
                            pb: 0.5,
                            '& .MuiInputBase-root': { fontSize: 12, color: COLORS.textSecondary, '&:before': { borderBottom: 'none' } },
                          }}
                        />
                        <TextField
                          fullWidth
                          multiline
                          value={entry.content}
                          inputRef={(el: HTMLTextAreaElement | null) => {
                            textareaRefs.current[`${m.id}:${entry.id}`] = el
                          }}
                          onChange={(e) => updateEntry(m.id, entry.id, { content: e.target.value })}
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
                    <Button
                      size="small"
                      onClick={() => addEntry(m.id)}
                      sx={{ alignSelf: 'flex-start', fontSize: 11.5, color: COLORS.accent }}
                    >
                      + 新建条目
                    </Button>
                  </Stack>
                ) : m.identity && m.identity.length > 0 ? (
                  <Stack sx={{ p: 0.5 }}>
                    {m.identity.map((f) => (
                      <Stack
                        key={f.label}
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: 'center', px: 0.75, py: 0.5 }}
                      >
                        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, width: 64, flexShrink: 0 }}>
                          {f.label}
                        </Typography>
                        <TextField
                          fullWidth
                          size="small"
                          variant="standard"
                          value={f.body ?? ''}
                          onChange={(e) => {
                            setRevert(null)
                            commitModules(
                              modules.map((x) =>
                                x.id === m.id
                                  ? { ...x, identity: x.identity?.map((y) => (y.label === f.label ? { ...y, body: e.target.value } : y)) }
                                  : x,
                              ),
                            )
                          }}
                          sx={{ fontSize: 13, '& .MuiInputBase-root': { fontSize: 13 } }}
                        />
                      </Stack>
                    ))}
                  </Stack>
                ) : (
                  <TextField
                    fullWidth
                    multiline
                    value={m.content}
                    inputRef={(el: HTMLTextAreaElement | null) => {
                      textareaRefs.current[m.id] = el
                    }}
                    onChange={(e) => {
                      setRevert(null)
                      commitModules(
                        modules.map((x) => (x.id === m.id ? { ...x, content: e.target.value } : x)),
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
                )}
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
                {m.entries && m.entries.length > 0 ? (
                  <Box>
                    {m.entries.map((entry) => (
                      <Box key={entry.id} sx={{ mb: 1.25 }}>
                        <Typography
                          sx={{
                            fontSize: 13,
                            fontWeight: 700,
                            color: '#222',
                            lineHeight: 1.6,
                            fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
                          }}
                        >
                          {entry.title}
                          {entry.role ? ` · ${entry.role}` : ''}
                          {entry.period ? `（${entry.period}）` : ''}
                        </Typography>
                        {entry.description && (
                          <Typography
                            sx={{
                              fontSize: 12.5,
                              color: '#555',
                              whiteSpace: 'pre-wrap',
                              lineHeight: 1.6,
                              mb: 0.5,
                              fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
                            }}
                          >
                            {entry.description}
                          </Typography>
                        )}
                        {entry.content && (
                          <Typography
                            sx={{
                              fontSize: 13,
                              color: '#333',
                              whiteSpace: 'pre-wrap',
                              lineHeight: 1.65,
                              fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
                            }}
                          >
                            {entry.content}
                          </Typography>
                        )}
                      </Box>
                    ))}
                  </Box>
                ) : m.identity && m.identity.length > 0 ? (
                  <Box>
                    {m.identity.map((f) => (
                      <Typography
                        key={f.label}
                        sx={{
                          fontSize: 13,
                          color: '#333',
                          lineHeight: 1.65,
                          fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
                        }}
                      >
                        <Box component="span" sx={{ fontWeight: 700, color: '#222' }}>
                          {f.label}：
                        </Box>
                        {f.body}
                      </Typography>
                    ))}
                  </Box>
                ) : (
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
                )}
              </Box>
            ))}
          </Box>
        </Box>
      </Box>

      {/* Quality bar（R1：质量条 + 展开式表达检查清单——逐项诊断，非评分结论） */}
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
        <Button
          size="small"
          onClick={() => setShowChecks((v) => !v)}
          sx={{ fontSize: 12, color: COLORS.accent, minWidth: 0, px: 1 }}
        >
          {showChecks ? '收起详情' : '查看详情'}
        </Button>
      </Stack>
      <Collapse in={showChecks}>
        <Box sx={{ px: 2, py: 1.25, borderTop: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
          <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 0.75, letterSpacing: '0.04em' }}>
            表达检查（逐项诊断——不构成评分结论）
          </Typography>
          <Stack spacing={0.5}>
            {qualityChecks.map((c) => {
              const color =
                c.status === 'ok' ? COLORS.riskLow : c.status === 'partial' ? COLORS.riskMedium : COLORS.riskHigh
              const icon = c.status === 'ok' ? '✓' : c.status === 'partial' ? '△' : '✕'
              return (
                <Stack key={c.category} direction="row" spacing={1.25} sx={{ alignItems: 'flex-start' }}>
                  <Typography
                    sx={{ fontSize: 12, color, flexShrink: 0, fontFamily: COLORS.mono, minWidth: 84 }}
                  >
                    {icon} {c.label}
                  </Typography>
                  <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, lineHeight: 1.5, flex: 1 }}>
                    {c.hint}
                  </Typography>
                </Stack>
              )
            })}
          </Stack>
        </Box>
      </Collapse>
        </>
        )
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

      {/* P1.2：从经历资产添加——可用表达列表（用户主动应用，不自动插入） */}
      <Dialog open={assetOpen !== null} onClose={() => setAssetOpen(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontSize: 14, fontWeight: 600, pb: 1 }}>
          {isSummaryModule(modules.find((m) => m.id === assetOpen?.moduleId)?.title ?? '')
            ? '从资产添加优势（结论 + 证据锚）'
            : '从经历资产添加'}
        </DialogTitle>
        <DialogContent>
          {isSummaryModule(modules.find((m) => m.id === assetOpen?.moduleId)?.title ?? '') && (
            <Stack spacing={0.75} sx={{ mb: 1.5, p: 1, borderRadius: '8px', bgcolor: alpha(COLORS.accent, 0.05) }}>
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                <Typography sx={{ fontSize: 11.5, fontWeight: 600, color: COLORS.accent, flex: 1 }}>
                  优势亮点（档案级，跨简历复用——结论句 + 支撑引用）
                </Typography>
                <Button
                  size="small"
                  disabled={summarizing || strengthTaskRunning}
                  onClick={summarizeStrengths}
                  title="AI 从经历池总结优势候选（提案 → 你确认后并入）"
                  sx={{ minWidth: 0, px: 0.5, fontSize: 11.5, color: COLORS.accent }}
                >
                  {summarizing || strengthTaskRunning ? '总结中…' : 'AI 总结'}
                </Button>
                <Button size="small" onClick={newStrength} sx={{ minWidth: 0, px: 0.5, fontSize: 11.5, color: COLORS.accent }}>
                  + 新优势
                </Button>
              </Stack>
              {strengthTaskRunning && (
                <Box
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 1,
                    p: 2,
                    my: 0.5,
                    minHeight: 140,
                    borderRadius: '10px',
                    backdropFilter: 'blur(10px) saturate(150%)',
                    WebkitBackdropFilter: 'blur(10px) saturate(150%)',
                    bgcolor: alpha(COLORS.bgElevated, 0.55),
                    border: `1px solid ${alpha(COLORS.accent, 0.3)}`,
                    boxShadow: COLORS.cardShadow,
                  }}
                >
                  <CircularProgress size={22} sx={{ color: COLORS.accent }} />
                  <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>AI 正在总结优势亮点…</Typography>
                  <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>完成后建议卡出现在下方</Typography>
                  <Button
                    size="small"
                    onClick={cancelStrengthTask}
                    sx={{ mt: 0.5, px: 1, fontSize: 11, color: COLORS.riskHigh, border: `1px solid ${alpha(COLORS.riskHigh, 0.35)}` }}
                  >
                    取消任务
                  </Button>
                </Box>
              )}
              {strengths.length === 0 && (
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                  暂无——点「+ 新优势」直接写结论句，或在下方表述点 ★ 快捷创建
                </Typography>
              )}
              {strengths.map((s, i) => {
                const soft = s.claimIds.length === 0 && s.evidenceIds.length === 0
                return (
                  <Stack key={`${s.text}-${i}`} spacing={0.5}>
                    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                      <TextField
                        size="small"
                        variant="standard"
                        placeholder="结论句：能力维度 + 具体能力（如「动手与落地：从方案设计到样机调试的全流程独立开发」）"
                        value={s.text}
                        onChange={(e) => {
                          const next = [...strengths]
                          next[i] = { ...s, text: e.target.value }
                          useAppStore.setState((st) => ({
                            persons: st.persons.map((p) =>
                              p.personId === person.personId ? { ...p, summaryStrengths: next } : p,
                            ),
                          }))
                        }}
                        onBlur={(e) => {
                          const v = e.target.value.trim()
                          const prev = strengthsSavedRef.current[i]?.text ?? ''
                          if (v && v !== prev) editStrength(i, v)
                          else if (!v && prev === '') removeStrength(i)
                        }}
                        sx={{ flex: 1, '& .MuiInputBase-root': { fontSize: 12 } }}
                      />
                      <Button size="small" onClick={() => insertStrength(s)} title="加入个人优势模块（多锚行）" sx={{ minWidth: 0, px: 0.5, fontSize: 11.5, color: COLORS.accent }}>
                        加入
                      </Button>
                      <Button
                        size="small"
                        onClick={() => removeStrength(i)}
                        title="从优势亮点移除（支撑资产不受影响）"
                        sx={{ minWidth: 0, px: 0.5, fontSize: 11.5, color: COLORS.riskHigh }}
                      >
                        ✕
                      </Button>
                    </Stack>
                    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexWrap: 'wrap', pl: 1 }}>
                      {s.claimIds.map((cid) => {
                        const claim = usableClaims.find((c) => c.id === cid)
                        const evId = claim?.provenance.evidenceIds[0]
                        return (
                          <Chip
                            key={`c-${cid}`}
                            size="small"
                            label={`经历 · ${evId ? titleOfEvidence(evId) : cid}`}
                            onDelete={() => toggleStrengthSupport(i, 'claimIds', cid)}
                            sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.accent, 0.1), color: COLORS.accent }}
                          />
                        )
                      })}
                      {s.evidenceIds.map((eid) => (
                        <Chip
                          key={`e-${eid}`}
                          size="small"
                          label={`事实 · ${titleOfEvidence(eid)}`}
                          onDelete={() => toggleStrengthSupport(i, 'evidenceIds', eid)}
                          sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(RISK_COLOR.low, 0.12), color: RISK_COLOR.low }}
                        />
                      ))}
                      {soft && (
                        <Chip
                          size="small"
                          label="无证据支撑（软性条目）"
                          title="主观优势无支撑——HR 跳过信号；建议补支撑引用"
                          sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(RISK_COLOR.medium, 0.12), color: RISK_COLOR.medium }}
                        />
                      )}
                      <Button
                        size="small"
                        onClick={() => setSupportPicker(supportPicker?.index === i ? null : { index: i })}
                        title="添加/移除支撑引用（经历表述 + 事实）"
                        sx={{ minWidth: 0, px: 0.5, fontSize: 11, color: COLORS.accent }}
                      >
                        + 支撑
                      </Button>
                    </Stack>
                    {supportPicker?.index === i && (
                      <Stack spacing={0.5} sx={{ pl: 1, py: 0.5, borderRadius: '6px', bgcolor: COLORS.bgHover }}>
                        <Typography sx={{ fontSize: 10.5, color: COLORS.textMuted }}>经历支撑（表述资产）</Typography>
                        {usableClaims.map((c) => (
                          <Stack key={c.id} direction="row" spacing={0.5} sx={{ alignItems: 'center', cursor: 'pointer' }} onClick={() => toggleStrengthSupport(i, 'claimIds', c.id)}>
                            <Typography sx={{ fontSize: 11, flex: 1, color: s.claimIds.includes(c.id) ? COLORS.accent : COLORS.text }}>{c.statement}</Typography>
                            <Typography sx={{ fontSize: 10.5, color: s.claimIds.includes(c.id) ? COLORS.accent : COLORS.textMuted }}>{s.claimIds.includes(c.id) ? '✓' : '+'}</Typography>
                          </Stack>
                        ))}
                        <Typography sx={{ fontSize: 10.5, color: COLORS.textMuted, mt: 0.25 }}>事实支撑（技能/奖项证据）</Typography>
                        {trustedEvidence.map((e) => (
                          <Stack key={e.id} direction="row" spacing={0.5} sx={{ alignItems: 'center', cursor: 'pointer' }} onClick={() => toggleStrengthSupport(i, 'evidenceIds', e.id)}>
                            <Typography sx={{ fontSize: 11, flex: 1, color: s.evidenceIds.includes(e.id) ? RISK_COLOR.low : COLORS.text }}>{e.event.title}</Typography>
                            <Typography sx={{ fontSize: 10.5, color: s.evidenceIds.includes(e.id) ? RISK_COLOR.low : COLORS.textMuted }}>{s.evidenceIds.includes(e.id) ? '✓' : '+'}</Typography>
                          </Stack>
                        ))}
                      </Stack>
                    )}
                  </Stack>
                )
              })}
              {strengthProposals.length > 0 && (
                <Stack spacing={0.75}>
                  <Typography sx={{ fontSize: 11.5, fontWeight: 600, color: COLORS.accent }}>
                    AI 总结候选（接受 → 引擎校验后并入优势亮点；拒绝 → 审计保留）
                  </Typography>
                  {strengthProposals.map((p) => (
                    <Box key={p.id} sx={{ border: `1px dashed ${alpha(COLORS.accent, 0.5)}`, borderRadius: '6px', p: 0.75 }}>
                      <Stack spacing={0.25}>
                        {p.items.map((it, j) => (
                          <Typography key={j} sx={{ fontSize: 11.5, lineHeight: 1.6 }}>
                            · {it.text}
                          </Typography>
                        ))}
                      </Stack>
                      <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, justifyContent: 'flex-end' }}>
                        <Button size="small" onClick={() => decideStrength(p.id, 'accept')} sx={{ minWidth: 0, px: 0.75, fontSize: 11.5, color: RISK_COLOR.low }}>
                          接受
                        </Button>
                        <Button size="small" onClick={() => decideStrength(p.id, 'reject')} sx={{ minWidth: 0, px: 0.75, fontSize: 11.5, color: COLORS.riskHigh }}>
                          拒绝
                        </Button>
                      </Stack>
                    </Box>
                  ))}
                </Stack>
              )}
            </Stack>
          )}
          {usableClaims.length === 0 ? (
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
              暂无可用表达——先在素材空间确认待确认表达（AI 从你的经历生成的建议）
            </Typography>
          ) : (
            <Stack spacing={1}>
              {orderedClaims.map((c) => {
                const added = addedClaimIds.has(c.id)
                const usedModules = claimModules.get(c.id)
                const crossUsed = usedModules && !usedModules.has(assetOpen?.moduleId ?? '')
                return (
                  <Box
                    key={c.id}
                    onClick={() => insertClaim(c.id)}
                    sx={{
                      p: 1.25,
                      borderRadius: '8px',
                      border: `1px solid ${added ? RISK_COLOR.low : alpha(COLORS.border, 0.8)}`,
                      boxShadow: COLORS.cardShadow,
                      cursor: added ? 'default' : 'pointer',
                      ...(added ? { bgcolor: alpha(RISK_COLOR.low, 0.07) } : {}),
                      transition: `background-color 180ms ${EASE}, border-color 180ms ${EASE}`,
                      ...(added ? {} : { '&:hover': { borderColor: COLORS.accent, bgcolor: COLORS.accentMuted } }),
                    }}
                  >
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                      <Typography sx={{ fontSize: 12.5, lineHeight: 1.6, flex: 1 }}>{c.statement}</Typography>
                      {added && (
                        <Chip
                          size="small"
                          label="✓ 已添加"
                          sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(RISK_COLOR.low, 0.15), color: RISK_COLOR.low }}
                        />
                      )}
                      {!added && crossUsed && (
                        <Chip
                          size="small"
                          label="已在其他模块使用"
                          title="重复写两遍是 HR 减分项——添加需确认"
                          sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(RISK_COLOR.medium, 0.12), color: RISK_COLOR.medium }}
                        />
                      )}
                      {c.evidenceType && (
                        <Chip
                          size="small"
                          label={EVIDENCE_TYPE_LABEL[c.evidenceType] ?? c.evidenceType}
                          sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.accent, 0.1), color: COLORS.accent }}
                        />
                      )}
                      {isSummaryModule(modules.find((m) => m.id === assetOpen?.moduleId)?.title ?? '') && (
                        <Button
                          size="small"
                          title={strengths.some((s) => s.claimIds.includes(c.id)) ? '已是优势亮点支撑' : '存为优势亮点（档案级资产，跨简历复用）'}
                          disabled={strengths.some((s) => s.claimIds.includes(c.id))}
                          onClick={(e) => {
                            e.stopPropagation()
                            addStrength(c.id)
                          }}
                          sx={{ minWidth: 0, px: 0.5, fontSize: 12, color: COLORS.accent }}
                        >
                          ★
                        </Button>
                      )}
                    </Stack>
                    <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mt: 0.25 }}>
                      依据：{c.provenance.evidenceIds.map(titleOfEvidence).join('、')}
                    </Typography>
                  </Box>
                )
              })}
            </Stack>
          )}
        </DialogContent>
      </Dialog>

      {/* 跨模块重复确认（Entry Contract §5 单侧使用——用户显式确认才放行） */}
      <Dialog open={pendingCross !== null} onClose={() => setPendingCross(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 14, fontWeight: 600, pb: 1 }}>确认跨模块使用</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12.5, lineHeight: 1.7 }}>
            该表述已在其他模块使用。工作经历与项目经历重复写两遍是 HR 减分项——确认仍要添加到当前模块？
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 2, justifyContent: 'flex-end' }}>
            <Button size="small" onClick={() => setPendingCross(null)} sx={{ fontSize: 12 }}>
              取消
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => {
                if (pendingCross) doInsertClaim(pendingCross.claimId)
                setPendingCross(null)
              }}
              sx={{ fontSize: 12 }}
            >
              确认添加
            </Button>
          </Stack>
        </DialogContent>
      </Dialog>

      {/* 删除条目确认（无锚行删除即弃——需确认） */}
      <Dialog open={confirmDeleteEntry !== null} onClose={() => setConfirmDeleteEntry(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 14, fontWeight: 600, pb: 1 }}>删除条目</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12.5, lineHeight: 1.7 }}>
            条目下已绑定的表述会回到资产池（不删除）；手写的未资产化内容将被丢弃。
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 2, justifyContent: 'flex-end' }}>
            <Button size="small" onClick={() => setConfirmDeleteEntry(null)} sx={{ fontSize: 12 }}>
              取消
            </Button>
            <Button size="small" variant="contained" color="error" onClick={doDeleteEntry} sx={{ fontSize: 12 }}>
              删除
            </Button>
          </Stack>
        </DialogContent>
      </Dialog>

      {/* 技能资产通道（Entry Contract §7：flat 技能资产行——skill_inventory 投影，User Confirmation 登记） */}
      <Dialog open={skillOpen} onClose={() => setSkillOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontSize: 14, fontWeight: 600, pb: 1 }}>从技能资产添加</DialogTitle>
        <DialogContent>
          {(person.skills ?? []).length === 0 ? (
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
              暂无登记技能——技能资产在画像采集时确认登记（skill_inventory）
            </Typography>
          ) : (
            <Stack spacing={1}>
              {(person.skills ?? []).map((s) => {
                const added = skillModule ? linesOf(skillModule.content).some((l) => l.includes(s.name)) : false
                const lv = s.level >= 4 ? '熟练' : s.level >= 3 ? '熟悉' : '了解'
                return (
                  <Box
                    key={s.skillId ?? s.name}
                    onClick={() => insertSkill(s.name)}
                    sx={{
                      p: 1.25,
                      borderRadius: '8px',
                      border: `1px solid ${added ? RISK_COLOR.low : alpha(COLORS.border, 0.8)}`,
                      boxShadow: COLORS.cardShadow,
                      cursor: added ? 'default' : 'pointer',
                      ...(added ? { bgcolor: alpha(RISK_COLOR.low, 0.07) } : {}),
                      transition: `background-color 180ms ${EASE}, border-color 180ms ${EASE}`,
                      ...(added ? {} : { '&:hover': { borderColor: COLORS.accent, bgcolor: COLORS.accentMuted } }),
                    }}
                  >
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                      <Typography sx={{ fontSize: 12.5, lineHeight: 1.6, flex: 1 }}>{s.name}</Typography>
                      {added && (
                        <Chip size="small" label="✓ 已添加" sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(RISK_COLOR.low, 0.15), color: RISK_COLOR.low }} />
                      )}
                      <Chip size="small" label={lv} sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.accent, 0.1), color: COLORS.accent }} />
                    </Stack>
                  </Box>
                )
              })}
            </Stack>
          )}
        </DialogContent>
      </Dialog>

      <ResumeDeriveDialog open={deriveOpen} onClose={() => setDeriveOpen(false)} />
    </Box>
  )
}
