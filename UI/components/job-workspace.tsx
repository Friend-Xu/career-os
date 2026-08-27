/**
 * 岗位工作区（Job Task Workspace）：一次投递任务的完整空间。
 * - 布局参照招聘平台详情页模式：头部信息卡（职位标题 + 薪资高亮 + 关键 chips + 任务步骤/Actions）
 *   → 职位描述（JD 原文 markdown 排版）→ 任职要求（匹配色 chips）→ 匹配摘要 → 公司评估 → 投决 → 决策记录
 * - 投决 = 岗位匹配（能不能胜任）+ 公司评估（能不能去）两维度并列
 * - Agent 是能力层：Actions 按钮预置上下文唤起；决策记录是证据层（本岗位分析历史）
 */
import { Box, Button, Chip, Dialog, DialogContent, DialogTitle, Stack, Tooltip, Typography } from '@mui/material'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import FactCheckIcon from '@mui/icons-material/FactCheck'
import BusinessCenterIcon from '@mui/icons-material/BusinessCenter'
import DescriptionIcon from '@mui/icons-material/Description'
import SendIcon from '@mui/icons-material/Send'
import HistoryIcon from '@mui/icons-material/History'
import PsychologyIcon from '@mui/icons-material/Psychology'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { useEffect, useState, type ReactNode } from 'react'
import { getEngine, useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, EASE, RISK_COLOR, RISK_LABEL } from '../data/constants'
import { EVIDENCE_DIMENSIONS_V0, EVIDENCE_PATTERNS_V0 } from '../../engine/ir/schema.ts'
import type { ConstraintMatchRow, GapResult, JobRecord, ResumeRewriteContext, Validation } from '../../engine/ir/schema.ts'
import type { Company } from '../types'
import { resolveCompanyReference } from '../data/company-ref'
import { decisionMatchesJob } from '../utils/decision-job-link'

/** store companies 成员（CompanyRecord + validation 标记；占位公司 = invalid = 待尽调） */
type CompanyWithValidation = Company & { validation?: Validation }

/** pattern 模板追问（evidenceExpectations.questions 缺省时的展示 fallback） */
const PATTERN_QUESTION = new Map(EVIDENCE_PATTERNS_V0.map((p) => [p.id, p.question]))

/** dimension 名称映射（EvidenceDimensionDefinition.name，如 validation → 验证方式） */
const DIMENSION_NAME = new Map(EVIDENCE_DIMENSIONS_V0.map((d) => [d.id, d.name]))

/** 证据覆盖三态样式（✓ 已覆盖 / △ 有经历缺证明 / ✗ 无相关经历） */
const COVERAGE_STYLE: Record<'covered' | 'partial' | 'missing', { icon: string; color: string }> = {
  covered: { icon: '✓', color: RISK_COLOR.low },
  partial: { icon: '△', color: RISK_COLOR.medium },
  missing: { icon: '✗', color: RISK_COLOR.high },
}

/** 约束四态投影（UI 不拥有语义判断权——直接渲染 Matcher 结果；NOT_DECLARED = 岗位未要求，不投影行） */
const CONSTRAINT_STATUS: Record<ConstraintMatchRow['status'], { icon: string; color: string; label: string }> = {
  MATCHED: { icon: '✓', color: RISK_COLOR.low, label: '已满足' },
  NOT_MATCHED: { icon: '✗', color: RISK_COLOR.high, label: '未满足' },
  NEEDS_CONFIRMATION: { icon: '△', color: RISK_COLOR.medium, label: '待确认' },
  NOT_DECLARED: { icon: '—', color: COLORS.textMuted, label: '岗位未要求' },
}
const CONSTRAINT_LABEL: Record<ConstraintMatchRow['dim'], string> = { education: '学历', major: '专业', experience: '经验' }

/** 门槛维度行：岗位要求 / 你的情况 / 四态结果（来源锚点 = Matcher evidence，UI 只投影） */
function ConstraintRow({ row }: { row: ConstraintMatchRow }) {
  const st = CONSTRAINT_STATUS[row.status]
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
      <Typography sx={{ fontSize: 12.5, fontWeight: 600, color: COLORS.text, width: 34, flexShrink: 0, lineHeight: '20px' }}>
        {CONSTRAINT_LABEL[row.dim]}
      </Typography>
      <Stack spacing={0} sx={{ flex: 1 }}>
        <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, lineHeight: '20px' }}>岗位要求：{row.requirement}</Typography>
        <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, lineHeight: '20px' }}>你的情况：{row.person}</Typography>
        {row.note && <Typography sx={{ fontSize: 11, color: COLORS.textMuted, lineHeight: '18px' }}>{row.note}</Typography>}
      </Stack>
      <Typography sx={{ fontSize: 12.5, fontWeight: 600, color: st.color, whiteSpace: 'nowrap', lineHeight: '20px' }}>
        {st.icon} {st.label}
      </Typography>
    </Stack>
  )
}

/** JD 原文 markdown 排版（浅色瑞士风；原文为纯文本+列表，映射段落层级与配色） */
const JD_MD_COMPONENTS: Components = {
  h2: ({ children }) => (
    <Typography sx={{ fontSize: 14.5, fontWeight: 600, mb: 1, mt: 2, color: COLORS.text }}>{children}</Typography>
  ),
  h3: ({ children }) => (
    <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 0.75, mt: 1.5, color: COLORS.text }}>{children}</Typography>
  ),
  p: ({ children }) => (
    <Typography sx={{ fontSize: 13, lineHeight: 1.8, color: COLORS.textSecondary, mb: 1 }}>{children}</Typography>
  ),
  strong: ({ children }) => (
    <Box component="strong" sx={{ color: COLORS.text, fontWeight: 600 }}>{children}</Box>
  ),
  ul: ({ children }) => <Box component="ul" sx={{ pl: 3, mb: 1 }}>{children}</Box>,
  ol: ({ children }) => <Box component="ol" sx={{ pl: 3, mb: 1 }}>{children}</Box>,
  li: ({ children }) => (
    <Box component="li" sx={{ fontSize: 13, lineHeight: 1.8, color: COLORS.textSecondary, mb: 0.25 }}>{children}</Box>
  ),
}

/** JD 原文行级清洗：去掉与结构化要求重复的行（任职要求卡已展示）与头部信息尾巴（与头部卡重复） */
function cleanJd(jd: string, job: JobRecord): string {
  const norm = (s: string) =>
    s
      .replace(/\s+/g, '')
      .replace(/[（(].*?[）)]/g, '')
      .replace(/[:：]$/, '')
      .replace(/(股份有限公司|有限公司|公司|集团)/g, '')
  const reqNorms = job.responsibilities.map((r) => norm(r.statement))
  const titleNorm = norm(job.title)
  const companyNorm = norm(job.company)
  const locationNorm = job.location ? norm(job.location) : ''
  // 信息尾巴判定：整行 = 公司名 / 以地点开头（如"上海 5-10年 本科"）/ 同时含职位名+薪资（如"机械结构工程师 14-21K"）
  const isInfoTail = (n: string): boolean => {
    if (!n) return false
    if (n === companyNorm) return true
    if (locationNorm && n.startsWith(locationNorm)) return true
    if (!n.includes(titleNorm)) return false
    if (job.salary) return n.includes(norm(job.salary))
    return false
  }
  return jd
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false
      const n = norm(l)
      if (isInfoTail(n)) return false
      if (reqNorms.some((r) => r.length >= 4 && r === n)) return false
      return true
    })
    .join('\n\n')
}

/** 岗位工作区状态（从数据派生）：分析/建档/投递/面试
 *  - ADR-019：投递记录由用户「开始投递流程」创建（PREPARING 起）——applied 判定：
 *    状态推进到 SUBMITTED（已投递）才算投出
 *  - 占位公司（validation invalid）= 待尽调，不视为已尽调
 *  - analyzed 判定 = 岗位智能段存在（Engine parseJobIntelligence → responsibilities source=ai 确定性产物）：
 *    「分析完成」的事实是能力段已落盘，不是 jd-analysis 决策记录（决策记录是 M7 独立功能，非投递前置） */
function deriveStatus(job: JobRecord, company: CompanyWithValidation | undefined, appliedStatus?: string) {
  // 已分析判定：岗位智能段（source=ai）存在——能力段是分析完成的确定性事实
  const analyzed = job.responsibilities.some((r) => r.source === 'ai')
  const dueDiligence = company !== undefined && company.validation?.status !== 'invalid'
  const applied = appliedStatus === 'SUBMITTED' || appliedStatus === 'COMMUNICATING' || appliedStatus === 'INTERVIEWING' || appliedStatus === 'OFFERED'
  const interviewing = appliedStatus === 'INTERVIEWING'
  return { analyzed, dueDiligence, applied, interviewing }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mt: 2 }}>
      <Typography sx={{ fontSize: 11.5, fontWeight: 600, color: COLORS.textMuted, letterSpacing: '0.04em', mb: 0.75 }}>
        {title}
      </Typography>
      {children}
    </Box>
  )
}

/** 决策记录 → 简历改写上下文 → AI 面板提示文本（ResumeRewriteContext 是引擎投影，UI 只组装不解释） */
function buildResumeRewritePrompt(ctx: ResumeRewriteContext): string {
  const lines: string[] = [`请基于决策记录「${ctx.jobId}」的改写上下文，帮我优化简历：`]
  if (ctx.confirmedGaps.length > 0) {
    lines.push('已确认差距：')
    for (const g of ctx.confirmedGaps) {
      lines.push(`- ${g.dimension} · ${g.requirement}（${g.status}）`)
    }
  }
  if (ctx.evidenceHighlights.length > 0) {
    lines.push(`证据亮点：${ctx.evidenceHighlights.map((e) => `${e.source}:${e.id}`).join('、')}`)
  }
  for (const n of ctx.preparationNotes) {
    lines.push(`【${n.section}】${n.content}`)
  }
  return lines.join('\n')
}

export function JobWorkspace({ jobId }: { jobId: string }) {
  const jobs = useAppStore((s) => s.jobs)
  const decisions = useAppStore((s) => s.decisions)
  const companies = useAppStore((s) => s.companies)
  const applications = useAppStore((s) => s.applications)
  const person = useAppStore((s) => s.currentPerson())
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const matchJob = useAppStore((s) => s.matchJob)
  const fetchConstraintMatch = useAppStore((s) => s.fetchConstraintMatch)
  const constraintRows = useAppStore((s) => s.constraintRows)
  const fetchJobMatchScore = useAppStore((s) => s.fetchJobMatchScore)
  const jobMatchScores = useAppStore((s) => s.jobMatchScores)
  const fetchJobCoverage = useAppStore((s) => s.fetchJobCoverage)
  const evidenceCoverage = useAppStore((s) => s.evidenceCoverage)
  const evidenceItems = useAppStore((s) => s.evidence)
  const fetchClaimCoverage = useAppStore((s) => s.fetchClaimCoverage)
  const claimCoverage = useAppStore((s) => s.claimCoverage)
  const updateApplicationStatus = useAppStore((s) => s.updateApplicationStatus)
  const createApplication = useAppStore((s) => s.createApplication)
  const setPage = useAppStore((s) => s.setPage)
  const setResumeWorkspaceView = useAppStore((s) => s.setResumeWorkspaceView)
  const setResumeOptimizeMode = useAppStore((s) => s.setResumeOptimizeMode)
  const setResumeOptimizeJobId = useAppStore((s) => s.setResumeOptimizeJobId)
  const push = useToastStore((s) => s.push)
  const submitDecisionNarrative = useAppStore((s) => s.submitDecisionNarrative)

  const [gap, setGap] = useState<GapResult | null>(null)
  const [gapLoading, setGapLoading] = useState(false)
  const [jdOpen, setJdOpen] = useState(false)
  /** M7 提交成功后回显的决策 id（出现「生成简历改写上下文」按钮） */
  const [submittedDecisionId, setSubmittedDecisionId] = useState<string | null>(null)

  const job = jobs.find((j) => j.id === jobId)
  const company = job ? resolveCompanyReference(companies, job.company) : undefined
  const app = job ? applications.find((a) => a.jobId === job.id) : undefined
  const st = job ? deriveStatus(job, company, app?.status) : null

  useEffect(() => {
    setGap(null)
    if (!job || job.responsibilities.length === 0) return
    setGapLoading(true)
    matchJob(job.id, person.name)
      .then(setGap)
      .catch(() => {})
      .finally(() => setGapLoading(false))
    fetchConstraintMatch(job.id, person.personId ?? '')
    fetchJobMatchScore(job.id, person.personId ?? '')
    fetchJobCoverage(job.id)
    fetchClaimCoverage(job.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, job])

  if (!job || !st) return null

  const jobDecisions = decisions.filter(
    (d) => d.skill === 'jd-analysis' && decisionMatchesJob(d, job),
  )
  const aiResponsibilities = job.responsibilities.filter((r) => r.source === 'ai')
  const cRows = constraintRows[job.id] ?? null

  const analyze = (): void => {
    // 任务明文=提取导向（契约 v0.1 §1：Agent 只提取，不做画像匹配/投递判断）——
    // 匹配度与差距由引擎基于岗位智能段计算（JD 匹配区）；决策摘要表由「生成决策记录」（引擎组装）产出。
    // 若让 Agent「评估与画像的匹配度」「输出决策摘要表」：越权读画像判断 + 诱导直写 decisions/*（引擎单方注册）——双轨伪造。
    startAnalysis(`请分析岗位「${job.company} · ${job.title}」的 JD：拆解核心要求（必须/加分/隐含），提交岗位能力模型（岗位智能段）`, {
      taskType: 'job_analysis',
      contextRefs: [{ type: 'job', id: job.id }],
      outputTarget: 'decision',
    })
    push('info', '已预置「JD 分析」上下文；分析完成后匹配度与差距将在「JD 匹配」区展示')
  }
  const dueDiligence = (): void => {
    startAnalysis(`请对「${job.company}」开展公司尽调：规模/市占率/业务构成/风险/入职建议，输出公司档案`, {
      taskType: 'company_research',
      // company 引用：resolveCompanyReference 已解析当前岗位的公司档案（公司未建档 → 缺引用 → 引擎拒绝，先建档再尽调）
      contextRefs: company ? [{ type: 'company', id: company.id }] : [],
    })
    push('info', '已预置「公司尽调」上下文')
  }
  /** 优化简历（P2-2 提案通道深链）：派生不在聊天承载——直达优化空间派生模式，目标岗位预选为当前 JD */
  const optimizeResume = (): void => {
    setResumeOptimizeJobId(job.id)
    setResumeOptimizeMode('derive')
    setResumeWorkspaceView('optimize')
    setPage('resumes')
  }
  /** 发起投递（ADR-019 用户行动事实——显式「开始投递」创建，Agent 禁止创建）：
   *  decisionId 挂本岗位最新 jd-analysis 决策（可选——决策记录是 M7 独立功能，非投递前置；
   *  engine CreateApplicationRequest.decisionId optional，无决策也允许创建）。 */
  const startApply = (): void => {
    const newest = [...jobDecisions].sort((a, b) => `${b.createdAt}${b.id}`.localeCompare(`${a.createdAt}${a.id}`))[0]
    createApplication({ jobId: job.id, ...(newest ? { decisionId: newest.id } : {}) }).then(
      () => {
        push('success', `已发起投递流程：${job.company} · ${job.title}（准备投递）`)
        setPage('applications')
      },
      (err) => push('warning', `发起投递失败：${err instanceof Error ? err.message : String(err)}`),
    )
  }
  const advanceApply = (): void => {
    // 投递记录存在后推进到 SUBMITTED（用户确认投出）
    if (!app) return
    updateApplicationStatus(app.id, 'SUBMITTED')
      .then(() => push('success', '已推进投递（已投递）——到投递管理推进后续状态'))
      .catch((err) => push('warning', `推进失败：${err instanceof Error ? err.message : String(err)}`))
  }
  const interviewPrep = (): void => {
    startAnalysis(`请为「${job.company} · ${job.title}」准备面试：公司背景/岗位要求回顾/项目陈述组织/预测面试问题`, {
      taskType: 'interview_preparation',
      contextRefs: [{ type: 'job', id: job.id }],
    })
    push('info', '已预置「面试准备」上下文')
  }
  const collectEvidence = (): void => {
    // 入口 B（JD 驱动沉淀）：岗位智能表证明需求 × 证据库存缺口 → 引导沉淀（无则诚实说明）
    startAnalysis(
      `请检查岗位「${job.company} · ${job.title}」的证明需求（岗位智能表的 Evidence Expectations）与我的证据库存：` +
        '找出缺口，用岗位的追问引导我沉淀相关经历（按 evidence 子模块契约写入 evidence/ 目录）。没有相关经历就诚实说明缺口。',
      { taskType: 'explanation', contextRefs: [{ type: 'job', id: job.id }] },
    )
    push('info', '已预置「证据沉淀」上下文')
  }

  /** M7 一键存档决策记录（引擎按岗位/公司/缺口自动组装 14 字段摘要；不传 narrative） */
  const submitDecision = (): void => {
    const pid = person.personId
    if (!pid) {
      push('warning', '请先完成画像初始化')
      return
    }
    submitDecisionNarrative({ jobId: job.id, personId: pid })
      .then(({ decisionId }) => setSubmittedDecisionId(decisionId))
      .catch(() => {
        // 错误已由 store action toast
      })
  }
  /** M7 生成简历改写上下文（decisionId 回源 decisions/{id}.md → 组装提示 → 预置 AI 面板） */
  const genResumeContext = (): void => {
    const pid = person.personId
    if (!submittedDecisionId || !pid) return
    const engine = getEngine()
    if (!engine) {
      push('warning', '引擎未连接')
      return
    }
    engine
      .resumeContext(submittedDecisionId, pid)
      .then((ctx) => startAnalysis(buildResumeRewritePrompt(ctx)))
      .catch((err) => push('warning', `生成简历改写上下文失败：${err instanceof Error ? err.message : String(err)}`))
  }

  const step = (done: boolean, label: string): ReactNode => (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      {done ? (
        <CheckCircleIcon sx={{ fontSize: 14, color: RISK_COLOR.low }} />
      ) : (
        <Box sx={{ width: 10, height: 10, borderRadius: '50%', border: `1.5px solid ${COLORS.textMuted}` }} />
      )}
      <Typography sx={{ fontSize: 12, color: done ? COLORS.text : COLORS.textMuted }}>{label}</Typography>
    </Stack>
  )

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 2.5 }}>
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        {/* 头部信息卡：职位标题 + 薪资高亮 + 关键 chips + 任务步骤 + Actions */}
        <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg }}>
          <Stack direction="row" sx={{ alignItems: 'flex-start', mb: 0.5 }}>
            <Typography sx={{ fontSize: 18, fontWeight: 600, flex: 1, minWidth: 0 }}>{job.title}</Typography>
            {job.jd && (
              <Button
                size="small"
                onClick={() => setJdOpen(true)}
                sx={{ fontSize: 12, color: COLORS.textMuted, minWidth: 0, p: 0.5 }}
              >
                原文
              </Button>
            )}
          </Stack>
          <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, mb: 1.25 }}>
            {job.company}
            {job.location && ` · ${job.location}`}
            {job.createdAt && ` · ${job.createdAt.slice(0, 10)}`}
          </Typography>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.75, mb: 1.5 }}>
            {job.salary && (
              <Typography sx={{ fontSize: 22, fontWeight: 700, fontFamily: COLORS.mono, color: COLORS.accent }}>
                {job.salary}
              </Typography>
            )}
            {job.location && (
              <Chip size="small" label={`📍 ${job.location}`} sx={{ height: 22, fontSize: 12, bgcolor: COLORS.bgHover }} />
            )}
            {job.responsibilities.length > 0 && (
              <Chip size="small" label={`${job.responsibilities.length} 项要求`} sx={{ height: 22, fontSize: 12, bgcolor: COLORS.bgHover }} />
            )}
          </Stack>

          {/* 任务步骤（状态驱动） */}
          <Box
            sx={{
              p: 1.5,
              borderRadius: '8px',
              bgcolor: COLORS.bgHover,
              border: `1px solid ${alpha(COLORS.border, 0.8)}`,
              boxShadow: COLORS.cardShadow,
              mb: 1,
            }}
          >
            <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
              {step(st.analyzed, '分析 JD')}
              {step(st.dueDiligence, '公司尽调')}
              {step(st.applied, '投递')}
              {step(st.interviewing, '面试')}
            </Stack>
          </Box>

          {/* Actions（Agent 能力层入口，按状态显示） */}
          <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75 }}>
            {!st.analyzed && (
              <Tooltip title="提取岗位要求与证据需求，写回岗位档案">
                <Button size="small" variant="contained" startIcon={<AutoAwesomeIcon sx={{ fontSize: 14 }} />}
                  onClick={analyze}
                  sx={{ fontSize: 12, bgcolor: COLORS.accent, color: COLORS.onAccent, '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 } }}>
                  分析 JD
                </Button>
              </Tooltip>
            )}
            {st.analyzed && !st.dueDiligence && (
              <Button size="small" variant="outlined" startIcon={<BusinessCenterIcon sx={{ fontSize: 14 }} />}
                onClick={dueDiligence}
                sx={{ fontSize: 12 }}>
                公司尽调
              </Button>
            )}
            {st.analyzed && (
              <Button size="small" variant="outlined" startIcon={<DescriptionIcon sx={{ fontSize: 14 }} />}
                onClick={optimizeResume}
                sx={{ fontSize: 12 }}>
                优化简历
              </Button>
            )}
            {st.analyzed && st.dueDiligence && !app && (
              <Button size="small" variant="outlined" startIcon={<SendIcon sx={{ fontSize: 14 }} />}
                onClick={startApply}
                sx={{ fontSize: 12 }}>
                开始投递
              </Button>
            )}
            {st.analyzed && st.dueDiligence && app && (app.status === 'PREPARING' || app.status === 'READY') && (
              <Button size="small" variant="outlined" startIcon={<SendIcon sx={{ fontSize: 14 }} />}
                onClick={advanceApply}
                sx={{ fontSize: 12 }}>
                推进投递
              </Button>
            )}
            {st.analyzed && st.dueDiligence && app && app.status !== 'PREPARING' && app.status !== 'READY' && (
              <Button size="small" variant="outlined" startIcon={<SendIcon sx={{ fontSize: 14 }} />}
                onClick={() => setPage('applications')}
                sx={{ fontSize: 12 }}>
                查看投递
              </Button>
            )}
            {st.applied && !st.interviewing && (
              <Button size="small" variant="outlined" startIcon={<FactCheckIcon sx={{ fontSize: 14 }} />}
                onClick={interviewPrep}
                sx={{ fontSize: 12 }}>
                面试准备
              </Button>
            )}
          </Stack>

          {/* 投递资格提示：缺什么 + 原因 + 下一步（避免「神秘拒绝」——前置条件对用户可见） */}
          {!app && !st.analyzed && (
            <Box sx={{ mt: 1, p: 1, borderRadius: '8px', bgcolor: alpha(COLORS.border, 0.12), border: `1px dashed ${alpha(COLORS.border, 0.6)}` }}>
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>
                投递暂不可用 · <b style={{ color: COLORS.text }}>还差:JD 分析</b>
                <Box component="span" sx={{ ml: 1, fontSize: 11, color: COLORS.textMuted }}>分析岗位要求后生成能力模型,即可推进投递</Box>
              </Typography>
            </Box>
          )}
          {!app && st.analyzed && !st.dueDiligence && (
            <Box sx={{ mt: 1, p: 1, borderRadius: '8px', bgcolor: alpha(COLORS.border, 0.12), border: `1px dashed ${alpha(COLORS.border, 0.6)}` }}>
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>
                投递暂不可用 · <b style={{ color: COLORS.text }}>还差:公司尽调</b>
                <Box component="span" sx={{ ml: 1, fontSize: 11, color: COLORS.textMuted }}>完成公司尽调后档案生效,即可推进投递</Box>
              </Typography>
            </Box>
          )}
        </Box>

        {/* 职位描述（JD 原文 markdown 排版） */}
        {job.jd && (
          <Section title="职位描述">
            <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={JD_MD_COMPONENTS}>
                {cleanJd(job.jd, job)}
              </ReactMarkdown>
            </Box>
          </Section>
        )}

        {/* 岗位理解（Job Intelligence：AI 拆解后——这个岗位负责什么 / 面试会验证什么） */}
        {aiResponsibilities.length > 0 && (
          <Section title="岗位理解">
            <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${alpha(COLORS.accent, 0.25)}`, bgcolor: alpha(COLORS.accent, 0.05) }}>
              <Stack spacing={1.5}>
                {aiResponsibilities.map((r) => (
                  <Box key={r.id}>
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5 }}>
                      <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{r.statement}</Typography>
                      <Chip
                        size="small"
                        label={r.priority === 'must' ? '核心' : '加分'}
                        sx={{
                          height: 16,
                          fontSize: 10,
                          bgcolor: r.priority === 'must' ? alpha(COLORS.accent, 0.14) : COLORS.bgHover,
                          color: r.priority === 'must' ? COLORS.accent : COLORS.textMuted,
                        }}
                      />
                    </Stack>
                    {r.capabilities.length > 0 && (
                      <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                        {r.capabilities.map((c) => (
                          <Chip key={c} size="small" label={c} sx={{ height: 18, fontSize: 10.5, bgcolor: COLORS.bgHover, color: COLORS.textSecondary }} />
                        ))}
                      </Stack>
                    )}
                    {r.evidenceExpectations.length > 0 && (
                      <Box sx={{ mt: 0.75 }}>
                        <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mb: 0.25 }}>
                          需要证明
                        </Typography>
                        {r.evidenceExpectations.map((e, i) => (
                          <Stack key={i} direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
                            <CheckCircleIcon sx={{ fontSize: 13, color: RISK_COLOR.low, mt: 0.35 }} />
                            <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary }}>
                              {e.questions[0] ?? PATTERN_QUESTION.get(e.patternId) ?? e.patternId}
                            </Typography>
                          </Stack>
                        ))}
                      </Box>
                    )}
                  </Box>
                ))}
              </Stack>
            </Box>
          </Section>
        )}

        {/* 该岗位证据覆盖（M2 层3：要求证明什么 / 我已有什么 / 还缺什么——三态不做匹配分）
            全 missing（无任何相关经历）→ 引导空态，不显示一排 ✗（避免用户误读为失败） */}
        {(() => {
          const coverage = evidenceCoverage[job.id]
          if (!coverage || coverage.length === 0) return null
          const titleOf = (id: string): string => evidenceItems.find((e) => e.id === id)?.event.title ?? id
          const allMissing = coverage.every((rc) => rc.expectations.every((e) => e.status === 'missing'))
          // Claim 表达候选（M3-1 第三段）：按 responsibility.statement 匹配 claimCoverage 行（引擎派生，只含可消费 Claims）
          const claimRows = claimCoverage[job.id] ?? []
          const claimsOf = (statement: string) => claimRows.find((r) => r.responsibility === statement)?.claims ?? []
          return (
            <Section title="该岗位证据覆盖">
              {allMissing ? (
                <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${alpha(RISK_COLOR.medium, 0.25)}`, bgcolor: alpha(RISK_COLOR.medium, 0.04) }}>
                  <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, mb: 1 }}>
                    暂无相关经历——AI 会在分析岗位缺口时帮助你补充证据
                  </Typography>
                  <Button size="small" variant="outlined" startIcon={<PsychologyIcon sx={{ fontSize: 14 }} />} onClick={collectEvidence} sx={{ fontSize: 12 }}>
                    整理相关经历
                  </Button>
                </Box>
              ) : (
                <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${alpha(RISK_COLOR.medium, 0.25)}`, bgcolor: alpha(RISK_COLOR.medium, 0.04) }}>
                  <Stack spacing={1.5}>
                    {coverage.map((rc) => {
                      const claims = claimsOf(rc.statement)
                      return (
                        <Box key={rc.responsibilityId}>
                          <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: 0.5 }}>{rc.statement}</Typography>
                          <Stack spacing={0.25}>
                            {rc.expectations.map((e, i) => {
                              const s = COVERAGE_STYLE[e.status]
                              return (
                                <Stack key={i} direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
                                  <Typography sx={{ fontSize: 12, color: s.color, fontFamily: COLORS.mono, lineHeight: '20px', width: 12 }}>
                                    {s.icon}
                                  </Typography>
                                  <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, flex: 1 }}>
                                    {DIMENSION_NAME.get(e.dimension) ?? e.dimension}
                                    {e.status === 'covered' && e.matchedItems.length > 0 && (
                                      <Typography component="span" sx={{ fontSize: 12, color: COLORS.textMuted }}>
                                        {' — '}已覆盖：{e.matchedItems.map(titleOf).join('、')}
                                      </Typography>
                                    )}
                                    {e.status === 'partial' && (
                                      <Typography component="span" sx={{ fontSize: 12, color: COLORS.textMuted }}>
                                        {' — '}有相关经历，缺该维度证明
                                      </Typography>
                                    )}
                                    {e.status === 'missing' && (
                                      <Typography component="span" sx={{ fontSize: 12, color: COLORS.textMuted }}>
                                        {' — '}无相关经历
                                      </Typography>
                                    )}
                                  </Typography>
                                </Stack>
                              )
                            })}
                          </Stack>
                          {claims.length > 0 && (
                            <Box sx={{ mt: 0.5, pl: 2.75 }}>
                              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 0.25 }}>表达候选（可消费 Claim）</Typography>
                              <Stack spacing={0.25}>
                                {claims.map((c) => (
                                  <Stack key={c.id} direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
                                    <Typography sx={{ fontSize: 12, color: COLORS.accent, fontFamily: COLORS.mono, lineHeight: '20px', width: 12 }}>
                                      ◆
                                    </Typography>
                                    <Typography sx={{ fontSize: 12.5, color: COLORS.text, flex: 1, lineHeight: '20px' }}>
                                      {c.statement}
                                      <Typography
                                        component="span"
                                        sx={{
                                          fontSize: 10.5,
                                          fontWeight: 600,
                                          color: c.claimType === 'fact' ? RISK_COLOR.low : RISK_COLOR.medium,
                                          ml: 0.75,
                                          verticalAlign: 'middle',
                                        }}
                                      >
                                        {c.claimType === 'fact' ? '事实' : '归纳'}
                                      </Typography>
                                    </Typography>
                                  </Stack>
                                ))}
                              </Stack>
                            </Box>
                          )}
                        </Box>
                      )
                    })}
                    <Box>
                      <Button size="small" variant="outlined" startIcon={<PsychologyIcon sx={{ fontSize: 14 }} />} onClick={collectEvidence} sx={{ fontSize: 12 }}>
                        整理相关经历
                      </Button>
                    </Box>
                  </Stack>
                </Box>
              )}
            </Section>
          )
        })()}

        {/* 任职要求（建档原文展示——纯事实，无匹配语义；匹配状态见「JD 匹配」区，职责分离） */}
        {(() => {
          const userReqs = job.responsibilities.filter((r) => r.source === 'user')
          if (userReqs.length === 0) return null
          return (
            <Section title="任职要求">
              <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg }}>
                <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                  {userReqs.map((r) => (
                    <Chip
                      key={r.id}
                      size="small"
                      label={r.statement}
                      sx={{ height: 22, fontSize: 11.5, bgcolor: COLORS.bgHover, color: COLORS.textSecondary }}
                    />
                  ))}
                </Stack>
              </Box>
            </Section>
          )
        })()}

        {/* 岗位门槛（约束四态投影：学历/专业/经验——UI 只投影 Matcher 结果，不解释；无硬约束 → 空态不误判缺失） */}
        <Section title="岗位门槛">
          <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg }}>
            {cRows === null ? (
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>计算中…</Typography>
            ) : cRows.length === 0 ? (
              <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary }}>
                暂无明确门槛要求——JD 分析未识别硬性约束（偏好类要求不进入门槛）
              </Typography>
            ) : (
              <Stack spacing={1}>
                {cRows.map((r) => (
                  <ConstraintRow key={r.dim} row={r} />
                ))}
              </Stack>
            )}
          </Box>
        </Section>

        {/* 匹配摘要（可解释覆盖；输入 = 岗位智能段 capabilities——未分析岗位不产出匹配） */}
        {job.responsibilities.length > 0 && (
          <Section title="JD 匹配">
            {gapLoading ? (
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>计算中…</Typography>
            ) : gap && gap.satisfied.length === 0 && gap.transferable.length === 0 && gap.missing.length === 0 ? (
              /* 空 gap = 岗位未分析（无岗位智能段 capabilities）——不硬算匹配（长句对齐必然失败） */
              <Box
                sx={{
                  p: 2,
                  borderRadius: '10px',
                  border: `1px solid ${alpha(RISK_COLOR.medium, 0.25)}`,
                  bgcolor: alpha(RISK_COLOR.medium, 0.04),
                }}
              >
                <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 0.5 }}>尚未完成岗位分析</Typography>
                <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, mb: 1.25 }}>
                  当前仅保存 JD 原文，系统还未生成岗位能力模型——分析后这里会显示技能匹配与差距
                </Typography>
                <Button size="small" variant="outlined" startIcon={<AutoAwesomeIcon sx={{ fontSize: 14 }} />} onClick={analyze} sx={{ fontSize: 12 }}>
                  分析 JD
                </Button>
              </Box>
            ) : gap ? (
              <Box sx={{ p: 1.5, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg }}>
                <Stack spacing={0.5}>
                  {gap.satisfied.length > 0 && (
                    <Typography sx={{ fontSize: 12.5, color: RISK_COLOR.low }}>
                      ✓ 符合：{gap.satisfied.map((s) => (s.via ? `${s.via}（${s.name.split(/[（(]/)[0]!.trim()}）` : s.name)).join('、')}
                    </Typography>
                  )}
                  {gap.transferable.length > 0 && (
                    <Typography sx={{ fontSize: 12.5, color: RISK_COLOR.medium }}>
                      △ 有基础：{gap.transferable.map((s) => (s.via ? `${s.via}（${s.name.split(/[（(]/)[0]!.trim()}）` : s.name)).join('、')}
                    </Typography>
                  )}
                  {gap.missing.length > 0 && (
                    <Stack spacing={0.25}>
                      <Typography sx={{ fontSize: 12.5, color: RISK_COLOR.high }}>
                        未覆盖能力：{gap.missing.map((m) => m.name).join('、')}
                      </Typography>
                      <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>
                        岗位要求这些能力，画像未声明——不代表不具备；可在画像中补充确认
                      </Typography>
                    </Stack>
                  )}
                </Stack>
              </Box>
            ) : null}
          </Section>
        )}

        {/* 公司评估（能不能去） */}
        <Section title="公司评估">
          {company ? (
            company.validation?.status === 'invalid' ? (
              /* 占位档案（建档自动创建，invalid = 待尽调） */
              <Box
                sx={{
                  p: 1.5,
                  borderRadius: '10px',
                  border: `1px solid ${alpha(RISK_COLOR.medium, 0.4)}`,
                  bgcolor: alpha(RISK_COLOR.medium, 0.06),
                }}
              >
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
                  <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{company.name}</Typography>
                  <Chip
                    size="small"
                    label="待尽调"
                    sx={{ height: 18, fontSize: 11, bgcolor: alpha(RISK_COLOR.medium, 0.15), color: RISK_COLOR.medium }}
                  />
                </Stack>
                <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>
                  {company.city ? `${company.city} · ` : ''}占位档案——投递前建议先做公司尽调，确认规模/风险/业务，别被坑
                </Typography>
              </Box>
            ) : (
              <Box
                sx={{
                  p: 1.5,
                  borderRadius: '10px',
                  border: `1px solid ${alpha(COLORS.border, 0.8)}`,
                  boxShadow: COLORS.cardShadow,
                  bgcolor: COLORS.bg,
                }}
              >
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
                  <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{company.name}</Typography>
                  {company.matchScore > 0 && (
                    <Chip size="small" label={`${company.matchScore}%`} sx={{ height: 18, fontSize: 11, bgcolor: COLORS.accentMuted, color: COLORS.accent }} />
                  )}
                  {company.riskLevel && (
                    <Chip size="small" label={`风险${RISK_LABEL[company.riskLevel]}`} sx={{ height: 18, fontSize: 11, bgcolor: COLORS.bgHover }} />
                  )}
                </Stack>
                <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>
                  {company.city && `${company.city} · `}
                  {company.industry}
                  {company.headcount && ` · ${company.headcount}`}
                  {company.tags.length > 0 && ` · ${company.tags.join('/')}`}
                </Typography>
              </Box>
            )
          ) : (
            <Box
              sx={{
                p: 1.5,
                borderRadius: '10px',
                border: `1px solid ${alpha(RISK_COLOR.medium, 0.4)}`,
                bgcolor: alpha(RISK_COLOR.medium, 0.06),
              }}
            >
              <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary }}>
                ⚠ 「{job.company}」尚未建档——投递前建议先做公司尽调，确认规模/风险/业务，别被坑
              </Typography>
            </Box>
          )}
        </Section>

        {/* 投决（两维度并列） */}
        {st.analyzed && (
          <Section title="投决">
            <Stack direction="row" spacing={1.5}>
              <Box sx={{ flex: 1, p: 1.5, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg }}>
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 0.5 }}>JD 匹配</Typography>
                <Typography sx={{ fontSize: 12.5, color: COLORS.text }}>
                  {job.responsibilities.length > 0 ? `${job.responsibilities.length} 项要求已评估` : '未评估'}
                </Typography>
                {(() => {
                  const ms = jobMatchScores[job.id]
                  if (!ms) return null
                  if (ms.status === 'HARD_GATE_FAILED') {
                    return (
                      <Typography sx={{ fontSize: 12.5, color: RISK_COLOR.high, mt: 0.25 }} title={ms.dimensions.gate.detail.rows.find((r) => r.status === 'NOT_MATCHED')?.requirement}>
                        硬门槛不满足
                      </Typography>
                    )
                  }
                  if (ms.status === 'EVALUATED') {
                    return (
                      <Stack spacing={0} sx={{ mt: 0.25 }}>
                        <Typography sx={{ fontSize: 12.5, color: COLORS.accent }} title={`能力 ${ms.dimensions.capability.score}/5 · 门槛 ${ms.dimensions.gate.score ?? '—'}/5 · 差异化维度未纳入`}>
                          匹配度 {ms.score} / {ms.maxScore}{ms.verdict ? ` · ${ms.verdict}` : ''}
                        </Typography>
                        {ms.city?.conflict && (
                          <Typography sx={{ fontSize: 11, color: RISK_COLOR.medium }} title="城市意向冲突——提示不否决，是否接受由你判断">
                            ⚠ 城市意向冲突：意向 {ms.city.preferred} · 岗位 {ms.city.jobLocation}
                          </Typography>
                        )}
                      </Stack>
                    )
                  }
                  return null
                })()}
              </Box>
              <Box sx={{ flex: 1, p: 1.5, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg }}>
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 0.5 }}>公司评估</Typography>
                <Typography sx={{ fontSize: 12.5, color: st.dueDiligence ? COLORS.text : COLORS.textMuted }}>
                  {st.dueDiligence ? '已尽调' : company ? '待尽调' : '未尽调'}
                </Typography>
              </Box>
            </Stack>

            {/* 决策记录（M7 一键存档：引擎自动组装决策摘要） */}
            <Box sx={{ mt: 1.5, p: 1.5, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg }}>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 1 }}>
                一键存档：引擎将按当前岗位匹配、公司风险与缺口数据自动填写决策摘要；个人想法请用 AI 面板（重新评估）
              </Typography>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}>
                <Button
                  size="small"
                  variant="contained"
                  onClick={submitDecision}
                  sx={{ fontSize: 12, bgcolor: COLORS.accent, color: COLORS.onAccent, '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 } }}
                >
                  生成决策记录
                </Button>
                {submittedDecisionId && (
                  <>
                    <Typography sx={{ fontSize: 12, color: RISK_COLOR.low }}>决策已写入：{submittedDecisionId}</Typography>
                    <Button size="small" variant="outlined" onClick={genResumeContext} sx={{ fontSize: 12 }}>
                      生成简历改写上下文
                    </Button>
                  </>
                )}
              </Stack>
            </Box>
          </Section>
        )}

        {/* 决策记录（证据层） */}
        {jobDecisions.length > 0 && (
          <Section title="决策记录">
            <Box sx={{ p: 1, borderRadius: '10px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bg }}>
              <Stack spacing={0.5}>
                {jobDecisions.map((d) => (
                  <Stack key={d.id} direction="row" spacing={0.75} sx={{ alignItems: 'center', p: 0.75, borderRadius: '8px', transition: `background-color 180ms ${EASE}`, '&:hover': { bgcolor: COLORS.bgHover } }}>
                    <HistoryIcon sx={{ fontSize: 13, color: COLORS.textMuted }} />
                    <Typography sx={{ fontSize: 12.5, fontWeight: 500, flex: 1, minWidth: 0 }} noWrap>
                      {d.title}
                    </Typography>
                    {d.directionMatch > 0 && (
                      <Typography
                        sx={{ fontSize: 12, fontFamily: 'var(--cos-mono, monospace)', color: COLORS.textSecondary }}
                        title="AI 分析时的方向匹配判断（历史记录，非引擎规则合成分数）"
                      >
                        {d.directionMatch}%
                        <Box component="span" sx={{ fontSize: 10, color: COLORS.textMuted, ml: 0.5 }}>
                          AI 参考
                        </Box>
                      </Typography>
                    )}
                  </Stack>
                ))}
              </Stack>
            </Box>
          </Section>
        )}
      </Box>

      {/* JD 原文（未清洗完整版；职位描述卡是去重后的精编版） */}
      <Dialog open={jdOpen} onClose={() => setJdOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>
          JD 原文 · {job.company} · {job.title}
        </DialogTitle>
        <DialogContent dividers>
          <Box
            sx={{
              whiteSpace: 'pre-wrap',
              fontFamily: COLORS.mono,
              fontSize: 12.5,
              lineHeight: 1.8,
              color: COLORS.textSecondary,
            }}
          >
            {job.jd}
          </Box>
        </DialogContent>
      </Dialog>
    </Box>
  )
}
