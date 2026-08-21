/**
 * 公司空间侧栏：公司列表（搜索 + 城市/产业过滤 + 质量筛选排序，契约 company-screening-contract-v0.1）。
 * 视图切换（公司档案/地图探索）在主区顶部左侧（companies-page）。
 * 点击行 → 选中公司（selectedCompanyId 驱动两视图联动）；locateTarget 定位滚动；
 * hover 行尾删除按钮（确认后删公司档案文件，引擎广播重拉）。
 * 排序语义 = 公司自身质量（Screening ≠ Recommendation，UI 固定「质量排序」文案）。
 */
import { Box, Chip, IconButton, InputAdornment, MenuItem, Select, Stack, TextField, Typography } from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import SearchIcon from '@mui/icons-material/Search'
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../../store/app-store'
import { useToastStore } from '../../../store/toast-store'
import { COLORS, RISK_COLOR, alpha } from '../../../data/constants'
import { resolveCompanyReference } from '../../../data/company-ref'
import type { AssessmentStatus, CompanyDimension } from '../../../../engine/ir/schema.ts'

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'sz', label: '深圳' },
  { id: 'sh', label: '上海' },
  { id: 'hz', label: '杭州' },
  { id: 'bj', label: '北京' },
  { id: 'robot', label: '机器人产业' },
  { id: 'contacted', label: '已联系' },
]

const DIMENSION_LABELS: Record<CompanyDimension, string> = {
  credibility: '可信度',
  growth: '成长性',
  technology: '技术壁垒',
  opportunity: '职业机会',
  stability: '稳定性',
}

const STATUS_FILTERS: { id: 'all' | AssessmentStatus; label: string }[] = [
  { id: 'all', label: '全部状态' },
  { id: 'EVALUATED', label: '已评估' },
  { id: 'PARTIAL', label: '部分评估' },
  { id: 'INSUFFICIENT_DATA', label: '数据不足' },
]

/** 风险信号 = factType=RISK 且 stability 负贡献（契约 §2——不绑定具体文本） */
function hasRiskSignal(c: { assessment?: unknown }): boolean {
  const a = c.assessment as { signals?: { factType: string; points: Partial<Record<CompanyDimension, number>> }[] } | null | undefined
  return a?.signals?.some((s) => s.factType === 'RISK' && (s.points.stability ?? 0) < 0) ?? false
}

export function CompaniesSidebar() {
  const companies = useAppStore((s) => s.companies)
  const companiesFilter = useAppStore((s) => s.companiesFilter)
  const setCompaniesFilter = useAppStore((s) => s.setCompaniesFilter)
  const selectedCompanyId = useAppStore((s) => s.selectedCompanyId)
  const setSelectedCompanyId = useAppStore((s) => s.setSelectedCompanyId)
  const deleteCompany = useAppStore((s) => s.deleteCompany)
  const applications = useAppStore((s) => s.applications)
  const jobs = useAppStore((s) => s.jobs)
  const decisions = useAppStore((s) => s.decisions)
  const resumes = useAppStore((s) => s.resumeVersions)
  const push = useToastStore((s) => s.push)
  const locateTarget = useAppStore((s) => s.locateTarget)
  const setLocateTarget = useAppStore((s) => s.setLocateTarget)
  const [search, setSearch] = useState('')
  // 质量筛选（组件态——契约 §Boundary：筛选条件不持久化，刷新回默认）
  const [sortByQuality, setSortByQuality] = useState(true)
  const [riskOnly, setRiskOnly] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'all' | AssessmentStatus>('all')
  const [dimensionFilter, setDimensionFilter] = useState<CompanyDimension[]>([])

  // 跨空间定位（信息池「更新尽调」菜单 → 选中档案 + 侧栏滚动到行）
  useEffect(() => {
    if (!locateTarget) return
    setSelectedCompanyId(locateTarget)
    setTimeout(() => {
      document
        .getElementById(`company-${locateTarget}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 0)
    setLocateTarget(null)
  }, [locateTarget, setLocateTarget, setSelectedCompanyId])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const base = q
      ? companies.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            (c.city ?? '').includes(q) ||
            (c.industry ?? '').includes(q) ||
            (c.tags ?? []).some((t) => t.includes(q)),
        )
      : companies
    switch (companiesFilter) {
    case 'sz':
      return base.filter((c) => (c.city ?? '').startsWith('深圳'))
    case 'sh':
      return base.filter((c) => (c.city ?? '').startsWith('上海'))
    case 'hz':
      return base.filter((c) => (c.city ?? '').startsWith('杭州'))
    case 'bj':
      return base.filter((c) => (c.city ?? '').startsWith('北京'))
    case 'robot':
      return base.filter((c) => c.industry?.includes('机器人'))
    case 'contacted':
      return base.filter((c) => c.contacted)
    default:
      return base
    }
  }, [search, companiesFilter, companies])

  // 质量筛选（契约 company-screening-contract-v0.1）：状态/风险/维度互选叠加；排序 = qualityScore desc + 名称 asc（null 恒排最后）
  const visible = useMemo(() => {
    let list = filtered
    if (statusFilter !== 'all') list = list.filter((c) => (c.assessment?.status ?? null) === statusFilter)
    if (riskOnly) list = list.filter(hasRiskSignal)
    if (dimensionFilter.length > 0) {
      list = list.filter((c) =>
        dimensionFilter.every((d) => (c.assessment?.dimensions?.[d] ?? 0) > 0),
      )
    }
    if (sortByQuality) {
      list = [...list].sort((a, b) => {
        const sa = a.assessment?.qualityScore ?? null
        const sb = b.assessment?.qualityScore ?? null
        if (sa == null && sb == null) return a.name.localeCompare(b.name)
        if (sa == null) return 1
        if (sb == null) return -1
        return sb - sa || a.name.localeCompare(b.name)
      })
    }
    return list
  }, [filtered, sortByQuality, riskOnly, statusFilter, dimensionFilter])

  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Box sx={{ p: 1.25, pb: 0.5 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 1 }}>
          <Typography
            sx={{
              fontSize: 11,
              fontWeight: 600,
              color: COLORS.textMuted,
              letterSpacing: '0.05em',
              flex: 1,
            }}
          >
            公司空间
          </Typography>
          <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.textMuted }}>
            {visible.length}/{companies.length}
          </Typography>
        </Stack>
        <TextField
          size="small"
          placeholder="搜索公司…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 15, color: COLORS.textMuted }} />
                </InputAdornment>
              ),
            },
          }}
          sx={{ width: '100%', mb: 1, '& .MuiOutlinedInput-root': { height: 28, fontSize: 12 } }}
        />
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          {FILTERS.map((f) => {
            const active = companiesFilter === f.id
            return (
              <Chip
                key={f.id}
                size="small"
                label={f.label}
                onClick={() => setCompaniesFilter(f.id)}
                sx={{
                  height: 20,
                  fontSize: 11,
                  bgcolor: active ? COLORS.accentMuted : COLORS.bgHover,
                  color: active ? COLORS.accent : COLORS.textSecondary,
                  border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
                  cursor: 'pointer',
                }}
              />
            )
          })}
        </Stack>
        {/* 质量筛选（契约 v0.1：排序 = 公司自身质量，Screening ≠ Recommendation） */}
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.75 }}>
          <Chip
            size="small"
            label="质量排序"
            onClick={() => setSortByQuality((v) => !v)}
            sx={{
              height: 20,
              fontSize: 11,
              bgcolor: sortByQuality ? COLORS.accentMuted : COLORS.bgHover,
              color: sortByQuality ? COLORS.accent : COLORS.textSecondary,
              border: `1px solid ${sortByQuality ? COLORS.accent : COLORS.border}`,
              cursor: 'pointer',
            }}
          />
          <Chip
            size="small"
            label="仅看风险"
            onClick={() => setRiskOnly((v) => !v)}
            sx={{
              height: 20,
              fontSize: 11,
              bgcolor: riskOnly ? alpha(COLORS.riskHigh, 0.15) : COLORS.bgHover,
              color: riskOnly ? COLORS.riskHigh : COLORS.textSecondary,
              border: `1px solid ${riskOnly ? COLORS.riskHigh : COLORS.border}`,
              cursor: 'pointer',
            }}
          />
        </Stack>
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.75 }}>
          <Select
            size="small"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | AssessmentStatus)}
            sx={{
              flex: 1,
              minWidth: 0,
              height: 24,
              fontSize: 11,
              '& .MuiSelect-select': { py: 0 },
            }}
          >
            {STATUS_FILTERS.map((s) => (
              <MenuItem key={s.id} value={s.id} sx={{ fontSize: 12 }}>
                {s.label}
              </MenuItem>
            ))}
          </Select>
          <Select
            size="small"
            multiple
            displayEmpty
            value={dimensionFilter}
            onChange={(e) => setDimensionFilter(e.target.value as CompanyDimension[])}
            renderValue={(sel) => (sel.length === 0 ? '能力维度' : sel.map((d) => DIMENSION_LABELS[d]).join(' / '))}
            sx={{
              flex: 1,
              minWidth: 0,
              height: 24,
              fontSize: 11,
              '& .MuiSelect-select': { py: 0 },
            }}
          >
            {(Object.keys(DIMENSION_LABELS) as CompanyDimension[]).map((d) => (
              <MenuItem key={d} value={d} sx={{ fontSize: 12 }}>
                {DIMENSION_LABELS[d]}
              </MenuItem>
            ))}
          </Select>
        </Stack>
      </Box>
      <Stack sx={{ flex: 1, overflow: 'auto', px: 1 }}>
        {visible.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, px: 1, py: 2, textAlign: 'center' }}>
            没有符合当前筛选条件的公司
          </Typography>
        ) : (
          visible.map((c) => {
            const active = selectedCompanyId === c.id
            const v = c.validation
            const vColor =
              v?.status === 'invalid' ? RISK_COLOR.high : v?.status === 'degraded' ? RISK_COLOR.medium : undefined
            return (
              <Stack
                key={c.id}
                id={`company-${c.id}`}
                onClick={() => setSelectedCompanyId(c.id)}
                sx={{
                  mb: 0.5,
                  px: 1.25,
                  py: 1,
                  borderRadius: '8px',
                  cursor: 'pointer',
                  border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
                  bgcolor: active ? COLORS.accentMuted : COLORS.bg,
                  '&:hover': { bgcolor: active ? COLORS.accentMuted : COLORS.bgHover },
                  '&:hover .card-delete': { opacity: 1 },
                }}
              >
                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                  <Typography
                    sx={{
                      fontSize: 12.5,
                      fontWeight: active ? 600 : 500,
                      color: active ? COLORS.accent : COLORS.text,
                      flex: 1,
                      minWidth: 0,
                    }}
                    noWrap
                  >
                    {c.name}
                  </Typography>
                  {vColor && <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: vColor, flexShrink: 0 }} />}
                  {c.assessment?.status === 'EVALUATED' && (
                    <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.accent }}>
                      {c.assessment.qualityScore}
                    </Typography>
                  )}
                  <Box className="card-delete" sx={{ opacity: 0, flexShrink: 0 }}>
                    <IconButton
                      size="small"
                      title="删除公司档案"
                      onClick={(e) => {
                        e.stopPropagation()
                        const appN = applications.filter((a) => {
                          const jobCompany = a.jobId ? jobs.find((j) => j.id === a.jobId)?.company : undefined
                          return jobCompany ? resolveCompanyReference(companies, jobCompany)?.id === c.id : false
                        }).length
                        const decN = decisions.filter((d) => d.title.includes(c.name)).length
                        const resN = resumes.filter((r) => {
                          // ResumeDocument 无 targetCompany（引擎 IR）；经 targetJobId 关联 jobs/ 取公司
                          const jobCompany = r.targetJobId ? jobs.find((j) => j.id === r.targetJobId)?.company : undefined
                          return jobCompany ? resolveCompanyReference(companies, jobCompany)?.id === c.id : false
                        }).length
                        const link = [appN && `投递 ${appN}`, decN && `决策 ${decN}`, resN && `简历版本 ${resN}`]
                          .filter(Boolean)
                          .join(' · ')
                        const hint = link
                          ? `关联：${link}——删除后投递/决策/简历版本保留（尽调状态回落「尚未建档」）。`
                          : '投递/决策/简历版本不受影响。'
                        if (!window.confirm(`删除公司档案「${c.name}」？不可恢复。${hint}`)) return
                        void deleteCompany(c.id).then(
                          () => push('info', `已删除公司：${c.name}`),
                          (err) => push('warning', `删除失败：${err instanceof Error ? err.message : String(err)}`),
                        )
                      }}
                      sx={{ p: 0.25 }}
                    >
                      <DeleteIcon sx={{ fontSize: 13, color: COLORS.textMuted }} />
                    </IconButton>
                  </Box>
                </Stack>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <Typography sx={{ fontSize: 11, color: COLORS.textMuted, flex: 1, minWidth: 0 }} noWrap>
                    {c.city ?? ''}
                    {c.industry ? ` · ${c.industry}` : ''}
                  </Typography>
                  {c.contacted && (
                    <Typography sx={{ fontSize: 11, color: COLORS.riskLow }}>已联系</Typography>
                  )}
                </Stack>
              </Stack>
            )
          })
        )}
      </Stack>
    </Stack>
  )
}
