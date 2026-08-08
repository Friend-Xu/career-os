/**
 * Evolution Timeline（M4-5.3，契约 v0.3 §3.2）。
 * Artifact Evolution Event → ArtifactTimelineEvent → Timeline UI（Engine Events → Timeline Adapter → UI 投影）。
 * - 引擎已确定性排序（at → append order → id），UI 只过滤分组，不重排——同输入同输出
 * - Proposal 是事件来源（source: via proposal xxx），不是事件类型——不显示 "Proposal accepted"
 * - 只读：无编辑 / 无删除事件 / 无 filter builder（Traceability 范畴，M4-5.4）
 */
import { Box, Typography } from '@mui/material'
import type { ArtifactTimelineEvent, ArtifactType } from '../types'
import { useAppStore } from '../store/app-store'
import { alpha, COLORS } from '../data/constants'

const ARTIFACT_ORDER: ArtifactType[] = ['resume', 'portfolio', 'interview', 'cover-letter']

const TYPE_LABEL: Record<ArtifactType, string> = {
  resume: '简历',
  portfolio: '作品集',
  interview: '面试问答',
  'cover-letter': '求职信',
}

/** 事件语义色（UI 投影——建档/推进/表达变化/投递） */
const EVENT_COLOR: Record<string, string> = {
  created: COLORS.textMuted,
  state_transition: COLORS.accent,
  expression_changed: COLORS.riskMedium,
  delivery: COLORS.riskLow,
}

/** ISO → 展示时间（本地化截取，展示投影不做时区换算） */
function formatAt(iso: string): string {
  const d = iso.slice(0, 16).replace('T', ' ')
  return d.replace(/-/g, '/')
}

function EventRow({ e }: { e: ArtifactTimelineEvent }) {
  const color = EVENT_COLOR[e.event] ?? COLORS.textMuted
  return (
    <Box sx={{ display: 'flex', gap: 1.25 }}>
      <Box
        sx={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          bgcolor: color,
          mt: 0.75,
          flexShrink: 0,
          boxShadow: `0 0 0 3px ${alpha(color, 0.15)}`,
        }}
      />
      <Box sx={{ flex: 1, pb: 1.75, borderLeft: `1px solid ${COLORS.border}`, ml: -0.75, pl: 1.5, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: 12.5, fontWeight: 600, color: COLORS.text }}>{e.title}</Typography>
          {e.source && (
            <Typography sx={{ fontSize: 11, color: COLORS.accent, fontWeight: 500 }}>
              via 提案 {e.source.id}
            </Typography>
          )}
          <Typography sx={{ ml: 'auto', fontSize: 11, color: COLORS.textMuted, fontVariantNumeric: 'tabular-nums' }}>
            {formatAt(e.at)}
          </Typography>
        </Box>
        {(e.detail || e.artifactId) && (
          <Typography sx={{ fontSize: 11.5, color: COLORS.textSecondary, mt: 0.25 }}>
            {e.detail}
            {e.detail && e.artifactId && ' · '}
            {e.artifactId}
          </Typography>
        )}
      </Box>
    </Box>
  )
}

export function EvolutionTimeline() {
  const timelineEvents = useAppStore((s) => s.timelineEvents)
  const engineStatus = useAppStore((s) => s.engineStatus)

  if (timelineEvents.length === 0) {
    return (
      <Box sx={{ py: 6, textAlign: 'center' }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600, color: COLORS.text }}>暂无演化事件</Typography>
        <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, mt: 0.75 }}>
          {engineStatus === 'connected'
            ? '求职资产建档与演化（状态推进 / 表达改写 / 投递）会按时间投影到这里'
            : '引擎离线（演化时间线不可用）'}
        </Typography>
      </Box>
    )
  }

  const groups = ARTIFACT_ORDER.map((type) => ({
    type,
    events: timelineEvents.filter((e) => e.artifactType === type),
  })).filter((g) => g.events.length > 0)

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
      {groups.map((g) => (
        <Box key={g.type} sx={{ p: 2.5, borderRadius: 3, border: `1px solid ${COLORS.border}`, bgcolor: COLORS.bgElevated }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1.5 }}>
            <Typography sx={{ fontSize: 13.5, fontWeight: 700 }}>{TYPE_LABEL[g.type]}</Typography>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>{g.events.length} 个事件</Typography>
          </Box>
          <Box sx={{ pt: 0.25 }}>
            {g.events.map((e) => (
              <EventRow key={e.id} e={e} />
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  )
}
