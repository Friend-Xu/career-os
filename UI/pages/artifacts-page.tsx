/**
 * Artifact Studio（M4-5，契约 M4-5-ARTIFACT-STUDIO-UI-v0.3）。
 * 信息架构四区按 slice 落地：M4-5.1 assets（Assets 概览）→ M4-5.2 proposals（提案中心）。
 * 原则：UI = Projection Consumer（Engine Context → UI View Model → Components）——
 *       只读，无编辑/删除/创建/状态修改按钮（§5 Interaction Boundary）；
 *       不显示 version（Evolution State 抽象）；summary 不含 Fact Layer（契约守卫）。
 */
import { Box, Card, Chip, Grid, Typography } from '@mui/material'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined'
import MailOutlinedIcon from '@mui/icons-material/MailOutlined'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import type { ComponentType } from 'react'
import type { SvgIconProps } from '@mui/material/SvgIcon'
import type { ArtifactSummary, ArtifactType } from '../types'
import { useAppStore } from '../store/app-store'
import { ProposalCenter } from '../components/proposal-center'
import { EvolutionTimeline } from '../components/evolution-timeline'
import { alpha, COLORS } from '../data/constants'

interface ArtifactMeta {
  label: string
  itemLabel: string
  icon: ComponentType<SvgIconProps>
}

/** 类级元信息（UI 本地投影——四卡结构一致，items 用各自 Fact Layer 语义标签） */
const ARTIFACT_META: Record<ArtifactType, ArtifactMeta> = {
  resume: { label: 'Resume', itemLabel: 'Statements', icon: DescriptionOutlinedIcon },
  portfolio: { label: 'Portfolio', itemLabel: 'Projects', icon: Inventory2OutlinedIcon },
  interview: { label: 'Interview', itemLabel: 'Questions', icon: ForumOutlinedIcon },
  'cover-letter': { label: 'Cover Letter', itemLabel: 'Units', icon: MailOutlinedIcon },
}

/** Evolution State 语义色（UI 投影——推进中/终态/空） */
const STATE_COLOR: Record<string, string> = {
  draft: COLORS.textMuted,
  review: COLORS.riskMedium,
  reviewed: COLORS.riskMedium,
  exported: COLORS.riskLow,
  archived: COLORS.textMuted,
  published: COLORS.riskLow,
  ready: COLORS.riskLow,
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function SummaryRow({ label, value }: { label: string; value: number }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
      <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary }}>{label}</Typography>
      <Typography
        sx={{
          ml: 'auto',
          fontSize: 17,
          fontWeight: 700,
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </Typography>
    </Box>
  )
}

/** M4-5.1 Assets 概览（Engine Context → ArtifactSummary[] → Cards） */
function AssetsSection() {
  const summaries = useAppStore((s) => s.artifactSummaries)
  const engineStatus = useAppStore((s) => s.engineStatus)

  if (summaries.length === 0) {
    return (
      <Box sx={{ mt: 2 }}>
        <Typography sx={{ fontSize: 13, color: COLORS.textSecondary }}>
          {engineStatus === 'connected'
            ? '暂无 Artifact 数据'
            : engineStatus === 'connecting'
              ? '连接引擎中…'
              : '引擎离线（Assets 视图不可用）'}
        </Typography>
      </Box>
    )
  }

  const pendingTotal = summaries.reduce((n, s) => n + s.counts.pendingProposals, 0)

  return (
    <Box>
      {pendingTotal > 0 && (
        <Box
          sx={{
            mt: 2,
            px: 2,
            py: 1.5,
            borderRadius: 2,
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            bgcolor: alpha(COLORS.accent, 0.08),
            border: `1px solid ${alpha(COLORS.accent, 0.25)}`,
          }}
        >
          <AutoAwesomeIcon sx={{ fontSize: 18, color: COLORS.accent }} />
          <Typography sx={{ fontSize: 13.5, fontWeight: 600, color: COLORS.text }}>
            {pendingTotal} 个 AI 建议待确认
          </Typography>
        </Box>
      )}

      <Grid container spacing={2} sx={{ mt: 1 }}>
        {summaries.map((s: ArtifactSummary) => {
          const meta = ARTIFACT_META[s.type]
          const Icon = meta.icon
          const stateColor = STATE_COLOR[s.state.value] ?? COLORS.textMuted
          return (
            <Grid key={s.id} size={{ xs: 12, sm: 6 }}>
              <Card
                variant="outlined"
                sx={{
                  p: 2.5,
                  borderColor: COLORS.border,
                  borderRadius: 3,
                  bgcolor: COLORS.bgElevated,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <Box
                    sx={{
                      width: 40,
                      height: 40,
                      borderRadius: 2,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      bgcolor: alpha(COLORS.accent, 0.1),
                      color: COLORS.accent,
                    }}
                  >
                    <Icon sx={{ fontSize: 22 }} />
                  </Box>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                    <Typography sx={{ fontSize: 15, fontWeight: 700 }}>{meta.label}</Typography>
                    <Typography sx={{ fontSize: 12.5, color: stateColor, fontWeight: 600 }}>
                      {s.state.label}
                    </Typography>
                  </Box>
                  {s.counts.pendingProposals > 0 && (
                    <Chip
                      label={`${s.counts.pendingProposals} 待确认`}
                      size="small"
                      sx={{
                        ml: 'auto',
                        fontSize: 11.5,
                        fontWeight: 600,
                        bgcolor: alpha(COLORS.accent, 0.12),
                        color: COLORS.accent,
                      }}
                    />
                  )}
                </Box>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mt: 2 }}>
                  <SummaryRow label={meta.itemLabel} value={s.counts.items} />
                  <SummaryRow label="Pending" value={s.counts.pendingProposals} />
                  <SummaryRow label="References" value={s.counts.references} />
                  {s.updatedAt && (
                    <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mt: 0.5 }}>
                      Updated {relativeTime(s.updatedAt)}
                    </Typography>
                  )}
                </Box>
              </Card>
            </Grid>
          )
        })}
      </Grid>
    </Box>
  )
}

export function ArtifactsPage() {
  const artifactsView = useAppStore((s) => s.artifactsView)

  return (
    <Box sx={{ p: 3, maxWidth: 1080 }}>
      <Typography sx={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>Artifact Studio</Typography>
      <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, mt: 0.5 }}>
        四 Artifact 治理（Engine Context → UI View Model → Cards；只读投影）
      </Typography>

      {artifactsView === 'proposals' && <ProposalCenter />}
      {artifactsView === 'evolution' && <EvolutionTimeline />}
      {artifactsView === 'assets' && <AssetsSection />}
    </Box>
  )
}
