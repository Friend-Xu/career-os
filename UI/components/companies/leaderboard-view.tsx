/**
 * 公司适配榜视图（Company-Leaderboard-Contract-v0.1 §3/§4）——公司空间第三模式：
 * 与「公司档案」（明细）、「地图探索」（空间直觉）并列，榜单 = 顺序直觉（先投谁）。
 * - 分城市段：意向城市置顶；其余按「段内最高评级 tier + 公司数」；无城市信息垫底
 * - 段内排序：评级 tier → 风险（确定性规则；匹配因子一期仅展示不排序——公司级差距
 *   投影需聚合已递交 JD，见契约 §3.3 实现注记）
 * - 三层：档案层（主排序）/ 候选层（screener 捕捉未尽调）/ 岗位区（已递交 JD + 线索）
 * - 诚实标注：样本数、无评级、无差距计算、空网格 → 发起公司筛选入口
 */
import { Box, Button, Chip, Collapse, Stack, Tooltip, Typography } from '@mui/material'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { useMemo, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import { alpha, COLORS, EASE, RISK_COLOR, RISK_LABEL } from '../../data/constants'
import type { CandidatePoolEntry, JobLead, JobRecord, SalaryExpTier } from '../../../engine/ir/schema.ts'
import { aggregateBenchmarks, expTierLabel, parseSalaryRangeK } from '../../../engine/ir/salary'
import type { Company } from '../../types'

type CompanyWithRating = Company & { validation?: { status?: string } }

const TIER_RANK: Record<string, number> = { recommend: 3, consider: 2, cautious: 1 }
const TIER_LABEL: Record<string, string> = { recommend: '推荐', consider: '可投', cautious: '谨慎' }
const TIER_COLOR: Record<string, string> = { recommend: RISK_COLOR.low, consider: RISK_COLOR.medium, cautious: RISK_COLOR.high }
const RISK_RANK: Record<string, number> = { low: 3, medium: 2, high: 1 }

/** city 自由文本主城市名（"上海（临港…）" → "上海"） */
function mainCity(city: string | undefined): string {
  if (!city || city === '-') return ''
  return city.split(/[（(]/)[0]!.trim()
}

/** 公司名匹配（canonical 或 alias 精确） */
function companyMatches(jobCompany: string, c: CompanyWithRating): boolean {
  return jobCompany === c.name || (c.aliases ?? []).includes(jobCompany)
}

interface CitySection {
  city: string
  preferred: boolean
  conflicted: boolean
  companies: CompanyWithRating[]
}

export function LeaderboardView() {
  const companies = useAppStore((s) => s.companies) as CompanyWithRating[]
  const candidates = useAppStore((s) => s.candidates)
  const jobLeads = useAppStore((s) => s.jobLeads)
  const jobs = useAppStore((s) => s.jobs)
  const applications = useAppStore((s) => s.applications)
  const decisions = useAppStore((s) => s.decisions)
  const person = useAppStore((s) => s.currentPerson())
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const setPage = useAppStore((s) => s.setPage)
  const [expanded, setExpanded] = useState<string | null>(null)

  const preferredCity = person.preference?.city?.trim() ?? ''

  /** 档案层：跳过 invalid 档案（图谱同惯例），按城市分组 */
  const sections = useMemo<CitySection[]>(() => {
    const valid = companies.filter((c) => c.validation?.status !== 'invalid')
    const map = new Map<string, CompanyWithRating[]>()
    for (const c of valid) {
      const city = mainCity(c.city)
      const key = city || '(未标城市)'
      const list = map.get(key)
      if (list) list.push(c)
      else map.set(key, [c])
    }
    const out: CitySection[] = [...map.entries()].map(([city, list]) => {
      const sorted = [...list].sort((a, b) => {
        const ta = TIER_RANK[a.ratingTier ?? ''] ?? 0
        const tb = TIER_RANK[b.ratingTier ?? ''] ?? 0
        if (ta !== tb) return tb - ta
        const ra = RISK_RANK[a.riskLevel] ?? 0
        const rb = RISK_RANK[b.riskLevel] ?? 0
        if (ra !== rb) return rb - ra
        return a.name < b.name ? -1 : 1
      })
      const isPreferred = city === preferredCity
      const isConflicted = preferredCity !== '' && city !== '(未标城市)' && city !== preferredCity
      return { city, preferred: isPreferred, conflicted: isConflicted, companies: sorted }
    })
    const rank = (s: CitySection): number => {
      if (s.preferred) return 0
      const top = Math.max(...s.companies.map((c) => TIER_RANK[c.ratingTier ?? ''] ?? 0))
      return 100 - top * 10 - s.companies.length
    }
    return out.sort((a, b) => rank(a) - rank(b))
  }, [companies, preferredCity])

  /** 候选层：未进档案的候选池公司（按 fitStars 降序——仅候选段排序用） */
  const poolCompanies = useMemo(() => {
    const archived = new Set(companies.map((c) => c.name))
    const aliasSet = new Set(companies.flatMap((c) => c.aliases ?? []))
    return candidates
      .filter((c) => !archived.has(c.name) && !aliasSet.has(c.name))
      .sort((a, b) => b.fitStars - a.fitStars)
  }, [candidates, companies])

  /** 榜头跨城市洞察：非意向城市段最高 tier vs 意向城市段（只陈述，不替决策） */
  const insight = useMemo(() => {
    const pref = sections.find((s) => s.preferred)
    const bestOtherEntry = sections
      .filter((s) => !s.preferred && s.city !== '(未标城市)')
      .map((s) => ({ s, top: Math.max(...s.companies.map((c) => TIER_RANK[c.ratingTier ?? ''] ?? 0)) }))
      .sort((a, b) => b.top - a.top)[0]
    const bestOther = bestOtherEntry?.top ?? 0
    const tierLabel = TIER_LABEL[['', 'cautious', 'consider', 'recommend'][bestOther]!] ?? '未评级'
    if (!pref) {
      if (bestOther > 0 && preferredCity) {
        return `意向城市（${preferredCity}）尚无已尽调公司——${bestOtherEntry!.s.city} 段已有${tierLabel}级机会；先投异地还是继续筛选意向城市，由你判断`
      }
      return null
    }
    const prefTop = Math.max(...pref.companies.map((c) => TIER_RANK[c.ratingTier ?? ''] ?? 0))
    if (bestOther > prefTop) {
      return `意向城市段最高评级低于 ${bestOtherEntry!.s.city} 段（后者有 ${tierLabel} 级公司）——是否接受异地投递由你判断`
    }
    return null
  }, [sections, preferredCity])

  const jobsOf = (c: CompanyWithRating): JobRecord[] => jobs.filter((j) => companyMatches(j.company ?? '', c))
  const leadsOf = (c: CompanyWithRating): JobLead[] => jobLeads.filter((l) => companyMatches(l.company, c))
  const appStatusOf = (jobId: string): string | undefined => applications.find((a) => a.jobId === jobId)?.status
  const directionMatchOf = (jobId: string): number | undefined => {
    const d = decisions.find((x) => x.skill === 'jd-analysis' && x.subjectId === jobId)
    return d?.directionMatch
  }

  const promptCompanyResearch = (name: string): void =>
    startAnalysis(`请对「${name}」做公司尽调（company-research）：业务/财务/风险/岗位机会，写入公司档案并给出评级`, {
      taskType: 'company_research',
      contextRefs: [{ type: 'company', id: name }],
    })
  const promptJobLeads = (name: string): void =>
    startAnalysis(`请检索「${name}」的在招岗位线索（company-jobs）：官网优先，输出岗位线索登记 JSON`, {
      taskType: 'job_lead_search',
      contextRefs: [{ type: 'company', id: name }],
    })
  const promptScreener = (): void =>
    startAnalysis(`请按我的职业与意向城市跑公司筛选（company-screener），输出清单并登记候选池`, {
      taskType: 'company_screening',
    })

  return (
    <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
      <Box sx={{ maxWidth: 860, mx: 'auto', p: 2.5 }}>
        {/* 榜头：定位 + 诚实标注 + 跨城市洞察 */}
        <Typography sx={{ fontSize: 15, fontWeight: 600 }}>公司适配榜</Typography>
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mt: 0.25, mb: 1 }}>
          按城市分组 · 段内按评级与风险排序——对「你」的先投顺序，不是公司客观排名
        </Typography>
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75, mb: 1 }}>
          <Chip size="small" label={`已尽调 ${companies.filter((c) => c.validation?.status !== 'invalid').length} 家`} sx={{ height: 22, fontSize: 11.5 }} />
          <Chip size="small" label={`候选 ${poolCompanies.length} 家`} sx={{ height: 22, fontSize: 11.5 }} />
          <Chip size="small" label={`线索 ${jobLeads.length} 条`} sx={{ height: 22, fontSize: 11.5 }} />
          {sections.filter((s) => !s.preferred).length < 2 && (
            <Chip size="small" label="样本少，榜单仅供参考" sx={{ height: 22, fontSize: 11.5, color: COLORS.textMuted }} />
          )}
        </Stack>
        {insight && (
          <Box sx={{ p: 1.25, borderRadius: '8px', bgcolor: alpha(COLORS.accent, 0.06), border: `1px solid ${alpha(COLORS.accent, 0.2)}`, mb: 1.5 }}>
            <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>💡 {insight}</Typography>
          </Box>
        )}

        {/* 城市段 */}
        {sections.length === 0 && poolCompanies.length === 0 ? (
          <Box sx={{ py: 8, textAlign: 'center' }}>
            <Typography sx={{ fontSize: 13, color: COLORS.textMuted, lineHeight: 1.7 }}>
              暂无公司档案与候选
              <br />
              从 AI 面板发起公司筛选（company-screener）后，候选会出现在这里
            </Typography>
            <Button size="small" variant="outlined" onClick={promptScreener} sx={{ mt: 2, fontSize: 12.5 }}>
              发起公司筛选
            </Button>
          </Box>
        ) : (
          <Stack spacing={1.5}>
            {sections.map((s) => (
              <Box key={s.city}>
                <Stack direction="row" sx={{ alignItems: 'center', mb: 0.5 }} spacing={0.75}>
                  <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
                    {s.city}
                    {s.preferred && <span style={{ color: COLORS.accent }}> ✓ 意向</span>}
                    {s.conflicted && (
                      <Tooltip title="城市意向冲突——提示不否决，是否接受由你判断">
                        <span style={{ color: RISK_COLOR.medium }}> ⚠ 意向冲突</span>
                      </Tooltip>
                    )}
                  </Typography>
                  <Chip size="small" label={`${s.companies.length} 家`} sx={{ height: 18, fontSize: 10.5 }} />
                </Stack>
                <Stack spacing={0.5}>
                  {s.companies.map((c) => (
                    <CompanyRow
                      key={c.id}
                      company={c}
                      jobs={jobsOf(c)}
                      leads={leadsOf(c)}
                      appStatusOf={appStatusOf}
                      directionMatchOf={directionMatchOf}
                      expanded={expanded === c.id}
                      onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
                      onResearch={() => promptCompanyResearch(c.name)}
                      onJobLeads={() => promptJobLeads(c.name)}
                      onGoJobs={() => setPage('jobs')}
                    />
                  ))}
                </Stack>
              </Box>
            ))}

            {/* 候选层（screener 捕捉，未尽调） */}
            {poolCompanies.length > 0 && (
              <Box>
                <Stack direction="row" sx={{ alignItems: 'center', mb: 0.5 }} spacing={0.75}>
                  <Typography sx={{ fontSize: 13, fontWeight: 600, color: COLORS.textMuted }}>候选（未尽调）</Typography>
                  <Chip size="small" label={`${poolCompanies.length} 家 · 对口★排序`} sx={{ height: 18, fontSize: 10.5 }} />
                </Stack>
                <Stack spacing={0.5}>
                  {poolCompanies.map((c) => (
                    <CandidateRow key={c.id} entry={c} onResearch={() => promptCompanyResearch(c.name)} />
                  ))}
                </Stack>
              </Box>
            )}

            {/* 空网格 → 扩库入口 */}
            <Box sx={{ p: 1.5, borderRadius: '8px', border: `1px dashed ${COLORS.border}`, textAlign: 'center' }}>
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
                其他城市 × 行业尚未筛选——榜单会随筛选结果生长
              </Typography>
              <Button size="small" variant="outlined" onClick={promptScreener} sx={{ mt: 1, fontSize: 12 }}>
                发起公司筛选（扩库）
              </Button>
            </Box>
          </Stack>
        )}
      </Box>
    </Box>
  )
}

function CompanyRow(props: {
  company: CompanyWithRating
  jobs: JobRecord[]
  leads: JobLead[]
  appStatusOf: (jobId: string) => string | undefined
  directionMatchOf: (jobId: string) => number | undefined
  expanded: boolean
  onToggle: () => void
  onResearch: () => void
  onJobLeads: () => void
  onGoJobs: () => void
}) {
  const { company: c, jobs, leads, expanded } = props
  const tier = c.ratingTier
  const tierColor = tier ? TIER_COLOR[tier] : COLORS.textMuted
  const tierText = tier ? TIER_LABEL[tier] : '未评级'
  const total = jobs.length + leads.length

  // 二期 §7.4：市场对照——岗位薪资 vs 该 (岗位, 城市, 我的档位) 基准带（确定性，客户端复用引擎聚合）
  const salaryBenchmarks = useAppStore((s) => s.salaryBenchmarks)
  const personTier: SalaryExpTier | null = useAppStore((s) => s.valuationCard?.tier ?? null)
  const marketCompare = (role: string, city: string, salaryStr: string): string | null => {
    if (!personTier) return null
    const salary = parseSalaryRangeK(salaryStr)
    if (!salary) return null // 薪资无法解析（年薪/面议等）→ 不对比
    const band = aggregateBenchmarks(salaryBenchmarks).find((b) => b.role === role && b.city === city && b.expTier === personTier)
    if (!band) return '无市场基准'
    const mid = (salary.min + salary.max) / 2
    if (mid < band.p25) return '低于市场带（开价低）'
    return '带内'
  }
  const marketRows: { key: string; title: string; salary: string; cmp: string }[] = []
  if (personTier) {
    const seen = new Set<string>()
    for (const l of leads) {
      if (!l.salary || !l.city) continue
      const cmp = marketCompare(l.title, l.city, l.salary)
      const key = `${l.title}|${l.salary}`
      if (cmp && !seen.has(key)) {
        seen.add(key)
        marketRows.push({ key, title: l.title, salary: l.salary, cmp })
      }
    }
    for (const j of jobs) {
      if (!j.salary || !j.location) continue
      const cmp = marketCompare(j.title, j.location, j.salary)
      const key = `${j.title}|${j.salary}`
      if (cmp && !seen.has(key)) {
        seen.add(key)
        marketRows.push({ key, title: j.title, salary: j.salary, cmp })
      }
    }
  }

  return (
    <Box
      sx={{
        borderRadius: '8px',
        border: `1px solid ${alpha(COLORS.border, 0.8)}`,
        bgcolor: COLORS.bgElevated,
        boxShadow: COLORS.cardShadow,
        overflow: 'hidden',
      }}
    >
      <Stack direction="row" sx={{ p: 1.25, alignItems: 'center', cursor: 'pointer', transition: `background-color 180ms ${EASE}`, '&:hover': { bgcolor: COLORS.bgHover } }} onClick={props.onToggle} spacing={1}>
        <Typography sx={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0 }} noWrap>
          {c.name}
        </Typography>
        <Typography sx={{ fontSize: 11, color: COLORS.textMuted, flexShrink: 0 }} noWrap>
          {c.industry}
        </Typography>
        {c.contacted && <Chip size="small" label="已联系" sx={{ height: 18, fontSize: 10.5, flexShrink: 0 }} />}
        <Chip size="small" label={tierText} sx={{ height: 20, fontSize: 11, color: tierColor, borderColor: tierColor, flexShrink: 0 }} variant="outlined" />
        <Chip size="small" label={total > 0 ? `岗位 ${total}` : '暂无岗位'} sx={{ height: 20, fontSize: 11, flexShrink: 0 }} />
        {expanded ? <ExpandLessIcon sx={{ fontSize: 16, color: COLORS.textMuted, flexShrink: 0 }} /> : <ExpandMoreIcon sx={{ fontSize: 16, color: COLORS.textMuted, flexShrink: 0 }} />}
      </Stack>
      <Collapse in={expanded}>
        <Box sx={{ px: 1.5, pb: 1.5 }}>
          {/* 排序理由透明：tier + caveat + 风险 + 匹配因子 */}
          <Stack spacing={0.5} sx={{ mb: 1 }}>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textSecondary }}>
              评级：{tierText}
              {c.ratingCaveat ? `（保留：${c.ratingCaveat}）` : ''}
              {!tier && '——发起尽调后获得评级'}
            </Typography>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textSecondary }}>
              风险：{RISK_LABEL[c.riskLevel] ?? '—'}
              {c.riskLevel ? <span style={{ color: RISK_COLOR[c.riskLevel] }}> ●</span> : null}
            </Typography>
            {jobs.length === 0 ? (
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>硬差距未计算——递交 JD 后可算（匹配因子按可用数据取子集）</Typography>
            ) : (
              jobs.map((j) => {
                const dm = props.directionMatchOf(j.id)
                return (
                  <Typography key={j.id} sx={{ fontSize: 11.5, color: COLORS.textSecondary }}>
                    已递交 JD「{j.title}」
                    {dm !== undefined ? ` · 匹配 ${dm}%` : ''} · 差距明细见岗位工作区
                  </Typography>
                )
              })
            )}
          </Stack>
          {/* 岗位区：已递交 JD（投递深链）+ 线索（去递交 JD） */}
          {jobs.length > 0 && (
            <Stack spacing={0.5} sx={{ mb: 1 }}>
              {jobs.map((j) => {
                const st = props.appStatusOf(j.id)
                return (
                  <Stack key={j.id} direction="row" sx={{ alignItems: 'center' }} spacing={1}>
                    <Typography sx={{ fontSize: 12, flex: 1, minWidth: 0, cursor: 'pointer', color: COLORS.accent }} noWrap onClick={props.onGoJobs} title="去岗位工作区（投递/差距明细）">
                      {j.title}
                      {st ? `（${st}）` : ''}
                    </Typography>
                  </Stack>
                )
              })}
            </Stack>
          )}
          {leads.length > 0 && (
            <Stack spacing={0.5} sx={{ mb: 1 }}>
              {leads.map((l) => (
                <Stack key={l.id} direction="row" sx={{ alignItems: 'center' }} spacing={1}>
                  <Typography sx={{ fontSize: 12, flex: 1, minWidth: 0, color: COLORS.textSecondary }} noWrap>
                    线索：{l.title}
                    {l.salary ? ` · ${l.salary}` : ''} · {l.source}
                    {l.expiresAt < new Date().toISOString().slice(0, 10) ? ' · 可能过期' : ''}
                    {l.fraudFlags.length > 0 && (
                      <Tooltip title={`求职诈骗信号：${l.fraudFlags.join('、')}——提示不否决`}>
                        <span style={{ color: RISK_COLOR.high }}> ⚠</span>
                      </Tooltip>
                    )}
                  </Typography>
                  <Button size="small" sx={{ fontSize: 11, flexShrink: 0 }} onClick={props.onGoJobs}>
                    去递交 JD
                  </Button>
                </Stack>
              ))}
            </Stack>
          )}
          {/* 二期 §7.4：市场对照（我的档位已知时显示；无基准 → 显式标注，不计入排序） */}
          {personTier && marketRows.length > 0 && (
            <Stack spacing={0.5} sx={{ mb: 1 }}>
              <Typography sx={{ fontSize: 10.5, color: COLORS.textMuted }}>市场对照（{expTierLabel(personTier)} 档 · 岗位薪资 vs 市场带）</Typography>
              {marketRows.map((r) => (
                <Typography key={r.key} sx={{ fontSize: 11.5, color: COLORS.textSecondary }}>
                  {r.title} {r.salary} →{' '}
                  {r.cmp === '带内' ? <span style={{ color: COLORS.riskLow }}>市场带内 ✓</span> : r.cmp}
                </Typography>
              ))}
            </Stack>
          )}
          {/* 动作集 */}
          <Stack direction="row" spacing={1}>
            {!tier && <Button size="small" variant="outlined" sx={{ fontSize: 11.5 }} onClick={props.onResearch}>发起尽调</Button>}
            <Button size="small" variant="outlined" sx={{ fontSize: 11.5 }} onClick={props.onJobLeads}>发起岗位检索</Button>
            {tier && <Button size="small" variant="outlined" sx={{ fontSize: 11.5 }} onClick={props.onResearch}>重新尽调</Button>}
          </Stack>
        </Box>
      </Collapse>
    </Box>
  )
}

function CandidateRow(props: { entry: CandidatePoolEntry; onResearch: () => void }) {
  const { entry } = props
  return (
    <Box sx={{ p: 1.25, borderRadius: '8px', border: `1px dashed ${COLORS.border}`, bgcolor: COLORS.bgElevated, display: 'flex', alignItems: 'center', gap: 1 }}>
      <Typography sx={{ fontSize: 13, flex: 1, minWidth: 0 }} noWrap>
        {entry.name}
      </Typography>
      <Typography sx={{ fontSize: 11, color: COLORS.textMuted, flexShrink: 0 }} noWrap>
        {entry.city} · {entry.industry.join(' / ') || '—'}
      </Typography>
      <Chip size="small" label={`对口 ${'★'.repeat(Math.min(entry.fitStars, 5))}`} sx={{ height: 20, fontSize: 11, flexShrink: 0 }} />
      <Tooltip title={entry.signals.map((s) => `${s.tag}（${s.source}）`).join('；') || '无信号'}>
        <Chip size="small" label={`${entry.signals.length} 信号`} sx={{ height: 20, fontSize: 11, flexShrink: 0 }} />
      </Tooltip>
      <Button size="small" variant="outlined" sx={{ fontSize: 11.5, flexShrink: 0 }} onClick={props.onResearch}>
        发起尽调
      </Button>
    </Box>
  )
}
