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
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { useEffect, useState, type ReactNode } from 'react'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, RISK_COLOR, RISK_LABEL } from '../data/constants'
import { EVIDENCE_PATTERNS_V0 } from '../../engine/ir/schema.ts'
import type { GapResult, JobRecord, Validation } from '../../engine/ir/schema.ts'
import type { Company } from '../types'

/** store companies 成员（CompanyRecord + validation 标记；占位公司 = invalid = 待尽调） */
type CompanyWithValidation = Company & { validation?: Validation }

/** pattern 模板追问（evidenceExpectations.questions 缺省时的展示 fallback） */
const PATTERN_QUESTION = new Map(EVIDENCE_PATTERNS_V0.map((p) => [p.id, p.question]))

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

/** 要求项匹配状态（gap 技能名与要求名双向子串容错）→ 匹配色 chip */
function reqStatus(reqName: string, gap: GapResult | null): 'ok' | 'partial' | 'missing' | 'none' {
  if (!gap) return 'none'
  const hit = (list: { name: string }[]) =>
    list.some((s) => s.name.includes(reqName) || reqName.includes(s.name))
  if (hit(gap.satisfied)) return 'ok'
  if (hit(gap.transferable)) return 'partial'
  if (hit(gap.missing)) return 'missing'
  return 'none'
}

const REQ_STATUS_STYLE: Record<'ok' | 'partial' | 'missing' | 'none', { chip: string; text: string }> = {
  ok: { chip: alpha(RISK_COLOR.low, 0.12), text: RISK_COLOR.low },
  partial: { chip: alpha(RISK_COLOR.medium, 0.12), text: RISK_COLOR.medium },
  missing: { chip: alpha(RISK_COLOR.high, 0.1), text: RISK_COLOR.high },
  none: { chip: COLORS.bgHover, text: COLORS.textSecondary },
}
const REQ_STATUS_PREFIX: Record<'ok' | 'partial' | 'missing' | 'none', string> = {
  ok: '✓ ',
  partial: '△ ',
  missing: '✗ ',
  none: '',
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

/** 决策标题里的公司名可能为简称（"示例智造科技" vs 建档全称"示例智造科技有限公司"）——双向子串容错 */
function companyInTitle(d: { title: string }, company: string): boolean {
  if (d.title.includes(company)) return true
  const brief = (d.title.split(/[：:]/)[1] ?? '').trim().split(/\s+/)[0]
  return Boolean(brief && brief.length >= 2 && (brief.includes(company) || company.includes(brief)))
}

/** 岗位工作区状态（从数据派生）：分析/建档/投递/面试
 *  - 建档自动占位投递「已评估」→ applied 判定：状态推进到「已投递」才算投出
 *  - 占位公司（validation invalid）= 待尽调，不视为已尽调 */
function deriveStatus(job: JobRecord, decisions: { title: string; skill?: string }[], company: CompanyWithValidation | undefined, appliedStatus?: string) {
  // 已分析判定：该公司的 jd-analysis 决策（公司名匹配，title 匹配过宽会误判）
  const analyzed = decisions.some(
    (d) => d.skill === 'jd-analysis' && companyInTitle(d, job.company),
  )
  const dueDiligence = company !== undefined && company.validation?.status !== 'invalid'
  const applied = Boolean(appliedStatus) && appliedStatus !== '已评估'
  const interviewing = appliedStatus === '面试中'
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

export function JobWorkspace({ jobId }: { jobId: string }) {
  const jobs = useAppStore((s) => s.jobs)
  const decisions = useAppStore((s) => s.decisions)
  const companies = useAppStore((s) => s.companies)
  const applications = useAppStore((s) => s.applications)
  const person = useAppStore((s) => s.currentPerson())
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const matchJob = useAppStore((s) => s.matchJob)
  const updateApplicationStatus = useAppStore((s) => s.updateApplicationStatus)
  const setPage = useAppStore((s) => s.setPage)
  const push = useToastStore((s) => s.push)

  const [gap, setGap] = useState<GapResult | null>(null)
  const [gapLoading, setGapLoading] = useState(false)
  const [jdOpen, setJdOpen] = useState(false)

  const job = jobs.find((j) => j.id === jobId)
  const company = job ? companies.find((c) => c.name === job.company) : undefined
  const app = job ? applications.find((a) => a.jobId === job.id) : undefined
  const st = job ? deriveStatus(job, decisions, company, app?.status) : null

  useEffect(() => {
    setGap(null)
    if (!job || job.responsibilities.length === 0) return
    setGapLoading(true)
    matchJob(job.id, person.name)
      .then(setGap)
      .catch(() => {})
      .finally(() => setGapLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  if (!job || !st) return null

  const jobDecisions = decisions.filter(
    (d) => d.skill === 'jd-analysis' && companyInTitle(d, job.company),
  )
  const aiResponsibilities = job.responsibilities.filter((r) => r.source === 'ai')

  const analyze = (): void => {
    startAnalysis(`请分析岗位「${job.company} · ${job.title}」的 JD：拆解核心要求（必须/加分/隐含），评估与画像的匹配度与差距，输出决策摘要表`)
    push('info', '已预置「JD 分析」上下文')
  }
  const dueDiligence = (): void => {
    startAnalysis(`请对「${job.company}」开展公司尽调：规模/市占率/业务构成/风险/入职建议，输出公司档案`)
    push('info', '已预置「公司尽调」上下文')
  }
  const optimizeResume = (): void => {
    startAnalysis(`请针对岗位「${job.company} · ${job.title}」的 JD 优化我的简历：拆解 JD 关键词，逐模块改写，输出修改建议`)
    push('info', '已预置「简历优化」上下文')
    setPage('resumes')
  }
  const advanceApply = (): void => {
    // 建档已自动占位「已评估」；此处推进到「已投递」（前置：分析 + 尽调完成）
    if (!app) return
    updateApplicationStatus(app.id, '已投递')
    push('success', '已推进投递（已投递）——到投递管理推进后续状态')
  }
  const interviewPrep = (): void => {
    startAnalysis(`请为「${job.company} · ${job.title}」准备面试：公司背景/岗位要求回顾/项目陈述组织/预测面试问题`)
    push('info', '已预置「面试准备」上下文')
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
        <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
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
              border: `1px solid ${COLORS.border}`,
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
            {st.analyzed && st.dueDiligence && app?.status === '已评估' && (
              <Button size="small" variant="outlined" startIcon={<SendIcon sx={{ fontSize: 14 }} />}
                onClick={advanceApply}
                sx={{ fontSize: 12 }}>
                推进投递
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
        </Box>

        {/* 职位描述（JD 原文 markdown 排版） */}
        {job.jd && (
          <Section title="职位描述">
            <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
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

        {/* 任职要求（Signal Layer：建档技能词匹配色 chips；ai 责任单元在岗位理解区，物理分家） */}
        {(() => {
          const userReqs = job.responsibilities.filter((r) => r.source === 'user')
          if (userReqs.length === 0) return null
          return (
            <Section title="任职要求">
              <Box sx={{ p: 2, borderRadius: '10px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
                <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                  {userReqs.map((r) => {
                    const st2 = reqStatus(r.statement, gap)
                    const s = REQ_STATUS_STYLE[st2]
                    return (
                      <Chip
                        key={r.id}
                        size="small"
                        label={`${REQ_STATUS_PREFIX[st2]}${r.statement}`}
                        sx={{ height: 22, fontSize: 11.5, bgcolor: s.chip, color: s.text }}
                      />
                    )
                  })}
                </Stack>
              </Box>
            </Section>
          )
        })()}

        {/* 匹配摘要（可解释覆盖） */}
        {job.responsibilities.length > 0 && (
          <Section title="JD 匹配">
            {gapLoading ? (
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>计算中…</Typography>
            ) : gap && gap.satisfied.length === 0 && gap.transferable.length === 0 && gap.missing.length === 0 ? (
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
                画像未声明技能或技能名未对齐词表，无法计算覆盖
              </Typography>
            ) : gap ? (
              <Box sx={{ p: 1.5, borderRadius: '10px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
                <Stack spacing={0.5}>
                  {gap.satisfied.length > 0 && (
                    <Typography sx={{ fontSize: 12.5, color: RISK_COLOR.low }}>
                      ✓ 符合：{gap.satisfied.map((s) => s.name).join('、')}
                    </Typography>
                  )}
                  {gap.transferable.length > 0 && (
                    <Typography sx={{ fontSize: 12.5, color: RISK_COLOR.medium }}>
                      △ 有基础：{gap.transferable.map((s) => s.name).join('、')}
                    </Typography>
                  )}
                  {gap.missing.length > 0 && (
                    <Typography sx={{ fontSize: 12.5, color: RISK_COLOR.high }}>
                      ✗ 不足：{gap.missing.map((s) => s.name).join('、')}
                    </Typography>
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
                  border: `1px solid ${COLORS.border}`,
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
              <Box sx={{ flex: 1, p: 1.5, borderRadius: '10px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 0.5 }}>JD 匹配</Typography>
                <Typography sx={{ fontSize: 12.5, color: COLORS.text }}>
                  {job.responsibilities.length > 0 ? `${job.responsibilities.length} 项要求已评估` : '未评估'}
                </Typography>
              </Box>
              <Box sx={{ flex: 1, p: 1.5, borderRadius: '10px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 0.5 }}>公司评估</Typography>
                <Typography sx={{ fontSize: 12.5, color: st.dueDiligence ? COLORS.text : COLORS.textMuted }}>
                  {st.dueDiligence ? '已尽调' : company ? '待尽调' : '未尽调'}
                </Typography>
              </Box>
            </Stack>
          </Section>
        )}

        {/* 决策记录（证据层） */}
        {jobDecisions.length > 0 && (
          <Section title="决策记录">
            <Box sx={{ p: 1, borderRadius: '10px', border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bg }}>
              <Stack spacing={0.5}>
                {jobDecisions.map((d) => (
                  <Stack key={d.id} direction="row" spacing={0.75} sx={{ alignItems: 'center', p: 0.75, borderRadius: '8px', '&:hover': { bgcolor: COLORS.bgHover } }}>
                    <HistoryIcon sx={{ fontSize: 13, color: COLORS.textMuted }} />
                    <Typography sx={{ fontSize: 12.5, fontWeight: 500, flex: 1, minWidth: 0 }} noWrap>
                      {d.title}
                    </Typography>
                    {d.directionMatch > 0 && (
                      <Typography sx={{ fontSize: 12, fontFamily: 'var(--cos-mono, monospace)', color: COLORS.textSecondary }}>
                        {d.directionMatch}%
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
