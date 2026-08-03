/**
 * 公司空间主区：园区地图（浏览态）+ 档案 Dialog（理解/操作）。
 * 公司列表在侧栏（CompaniesSidebar）——浏览 → 列表 → 档案三层分工。
 */
import { Box, Button, Chip, Dialog, IconButton, Stack, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { useState } from 'react'
import { PARKS } from '../data/mock-data'
import { GapAnalysisSection } from '../components/gap-analysis-section'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, EASE, RISK_COLOR, RISK_LABEL } from '../data/constants'

export function CompaniesPage() {
  const [parkId, setParkId] = useState<number | null>(null)
  const setPage = useAppStore((s) => s.setPage)
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const companies = useAppStore((s) => s.companies)
  const markCompanyContacted = useAppStore((s) => s.markCompanyContacted)
  const jobs = useAppStore((s) => s.jobs)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)
  const selectedCompanyId = useAppStore((s) => s.selectedCompanyId)
  const setSelectedCompanyId = useAppStore((s) => s.setSelectedCompanyId)
  const push = useToastStore((s) => s.push)

  const selected = companies.find((c) => c.id === selectedCompanyId) ?? null
  const activePark = PARKS.find((p) => p.id === parkId)
  const companyJobs = jobs.filter((j) => j.company === selected?.name)

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', p: 2, gap: 1.5, overflow: 'hidden' }}>
      <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1.5}>
        <Typography sx={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>公司探索</Typography>
        <Chip size="small" label={`${companies.length} 家档案`} sx={{ height: 22, fontSize: 12 }} />
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>左侧列表选择公司查看档案</Typography>
      </Stack>

      {/* 园区地图（浏览态） */}
      <Box
        sx={{
          flex: 1,
          position: 'relative',
          borderRadius: '10px',
          border: `1px solid ${COLORS.border}`,
          bgcolor: COLORS.canvas,
          overflow: 'hidden',
        }}
      >
        <svg width="100%" height="100%" viewBox="0 0 900 520" preserveAspectRatio="xMidYMid meet">
          {Array.from({ length: 10 }).map((_, i) => (
            <line key={`h${i}`} x1={0} y1={i * 52} x2={900} y2={i * 52} stroke={alpha(COLORS.text, 0.06)} />
          ))}
          {Array.from({ length: 12 }).map((_, i) => (
            <line key={`v${i}`} x1={i * 75} y1={0} x2={i * 75} y2={520} stroke={alpha(COLORS.text, 0.06)} />
          ))}
          {[
            { name: '北京', x: 520, y: 80 },
            { name: '上海', x: 700, y: 260 },
            { name: '杭州', x: 640, y: 340 },
            { name: '深圳', x: 620, y: 440 },
          ].map((c) => (
            <text key={c.name} x={c.x} y={c.y} fill={COLORS.textMuted} fontSize={11} textAnchor="middle">
              {c.name}
            </text>
          ))}
        </svg>

        {PARKS.map((park, i) => {
          const x = ((park.lon - 113) / 5) * 700 + 80
          const y = ((41 - park.lat) / 12) * 420 + 40
          const active = parkId === park.id
          return (
            <Box
              key={park.id}
              onClick={() => setParkId(active ? null : park.id)}
              sx={{
                position: 'absolute',
                left: x,
                top: y,
                transform: 'translate(-50%, -50%)',
                px: 1.5,
                py: 1,
                borderRadius: '10px',
                bgcolor: active ? COLORS.accentMuted : COLORS.bgElevated,
                border: `1.5px solid ${active ? COLORS.accent : COLORS.border}`,
                cursor: 'pointer',
                animation: `fade-in 0.35s ${EASE} ${i * 0.08}s both`,
                '&:hover': { borderColor: COLORS.accent },
                minWidth: 120,
                textAlign: 'center',
              }}
            >
              <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{park.name}</Typography>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 0.25 }}>
                {park.city} · {park.companies.length} 家 · {park.year}
              </Typography>
            </Box>
          )
        })}

        {activePark && (
          <Box
            sx={{
              position: 'absolute',
              right: 16,
              top: 16,
              width: 260,
              p: 2,
              borderRadius: '10px',
              bgcolor: alpha(COLORS.bgElevated, 0.95),
              border: `1px solid ${COLORS.borderStrong}`,
            }}
          >
            <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
              <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{activePark.name}</Typography>
              <IconButton size="small" onClick={() => setParkId(null)}>
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Stack>
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1.5 }}>
              {activePark.industry} · 来源 {activePark.source} ({activePark.year})
            </Typography>
            <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mb: 0.75 }}>入驻企业</Typography>
            <Stack spacing={0.5}>
              {activePark.companies.map((name) => {
                const co = companies.find((c) => c.name === name)
                return (
                  <Box
                    key={name}
                    onClick={() => co && setSelectedCompanyId(co.id)}
                    sx={{
                      px: 1,
                      py: 0.75,
                      borderRadius: '6px',
                      bgcolor: COLORS.bgHover,
                      cursor: co ? 'pointer' : 'default',
                      '&:hover': co ? { bgcolor: COLORS.bgActive } : {},
                    }}
                  >
                    <Typography sx={{ fontSize: 12 }}>{name}</Typography>
                    {co && (
                      <Typography sx={{ fontSize: 11.5, color: COLORS.accent }}>
                        匹配 {co.matchScore}
                      </Typography>
                    )}
                  </Box>
                )
              })}
            </Stack>
          </Box>
        )}
      </Box>

      <Dialog
        open={Boolean(selected)}
        onClose={() => setSelectedCompanyId(null)}
        slotProps={{
          paper: {
            sx: {
              width: 460,
              maxWidth: '92vw',
              borderRadius: '12px',
              bgcolor: COLORS.bgElevated,
              backgroundImage: 'none',
            },
          },
        }}
      >
        {selected && (
          <Box sx={{ p: 2.5, maxHeight: '80vh', overflowY: 'auto' }}>
            <Stack direction="row" sx={{ alignItems: 'center', mb: 2 }}>
              <Typography sx={{ fontSize: 16, fontWeight: 600, flex: 1 }}>{selected.name}</Typography>
              <IconButton size="small" onClick={() => setSelectedCompanyId(null)}>
                <CloseIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Stack>

            <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', gap: 0.5 }}>
              {(selected.tags ?? []).map((t) => (
                <Chip key={t} size="small" label={t} sx={{ height: 22, fontSize: 12 }} />
              ))}
            </Stack>

            <Box
              sx={{
                p: 1.5,
                borderRadius: '8px',
                bgcolor: COLORS.bgHover,
                border: `1px solid ${COLORS.border}`,
                mb: 2,
              }}
            >
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1 }}>尽调摘要</Typography>
              <Stack spacing={1}>
                <Row label="城市" value={selected.city} />
                <Row label="产业" value={selected.industry} />
                <Row label="匹配度" value={`${selected.matchScore}%`} color={COLORS.accent} />
                <Row label="风险" value={RISK_LABEL[selected.riskLevel]} color={RISK_COLOR[selected.riskLevel]} />
                <Row label="来源" value={selected.source} />
              </Stack>
            </Box>

            <GapAnalysisSection companyName={selected.name} />

            <Stack spacing={1}>
              <Button
                variant="contained"
                fullWidth
                onClick={() => {
                  startAnalysis(
                    `请对「${selected.name}」（${selected.city} · ${selected.industry}）开展公司尽调：背调、风险、竞争力与入职建议`,
                  )
                  push('info', '已预置「公司尽调」上下文')
                }}
              >
                开始尽调
              </Button>
              <Button
                variant="outlined"
                fullWidth
                onClick={() => {
                  markCompanyContacted(selected.id)
                  push('success', `已标记「${selected.name}」为已联系 · 投递管理已同步`)
                  setSelectedCompanyId(null)
                  setPage('applications')
                }}
              >
                标记已联系 → 投递管理
              </Button>
            </Stack>

            {/* 该公司 JD（尽调完看岗位 → JD 工作区） */}
            {companyJobs.length > 0 && (
              <Box sx={{ mt: 2.5 }}>
                <Typography sx={{ fontSize: 11.5, fontWeight: 600, color: COLORS.textMuted, letterSpacing: '0.04em', mb: 1 }}>
                  该公司 JD · {companyJobs.length}
                </Typography>
                <Stack spacing={0.5}>
                  {companyJobs.map((j) => (
                    <Box
                      key={j.id}
                      onClick={() => {
                        setSelectedJobId(j.id)
                        setSelectedCompanyId(null)
                        setPage('jobs')
                      }}
                      sx={{
                        p: 1,
                        borderRadius: '8px',
                        border: `1px solid ${COLORS.border}`,
                        cursor: 'pointer',
                        '&:hover': { bgcolor: COLORS.bgHover, borderColor: COLORS.borderStrong },
                      }}
                    >
                      <Typography sx={{ fontSize: 12.5, fontWeight: 500 }}>{j.title}</Typography>
                      <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 0.25 }}>
                        {j.location && `${j.location} · `}
                        {j.salary ?? ''}
                        {j.requirements.length > 0 && ` · ${j.requirements.map((r) => r.name).join('/')}`}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              </Box>
            )}
          </Box>
        )}
      </Dialog>
    </Box>
  )
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
      <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>{label}</Typography>
      <Typography sx={{ fontSize: 12, fontWeight: 500, color: color ?? COLORS.text }}>{value}</Typography>
    </Stack>
  )
}
