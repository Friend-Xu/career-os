/**
 * Traceability Panel（M4-5.4，契约 M4-5-TRACEABILITY-UI-v0.1）。
 * 解释能力非导航能力：展示"这个表达单元为什么存在、依赖哪些事实来源"。
 * - 只读定位（owner → target）：无编辑 sourceRefs / 无添加删除引用 / 无修改 Fact / 无自动修复断链
 * - 无图谱 / 无评分（Reference Protocol 是定位关系，非语义推理——不显示支持强度/贡献比例）
 * - 断链显式（resolved=false + error，无 fallback / 无自动隐藏）
 */
import { Box, Dialog, DialogContent, DialogTitle, Typography } from '@mui/material'
import { useEffect } from 'react'
import type { TraceSource } from '../types'
import { useAppStore } from '../store/app-store'
import { alpha, COLORS, RISK_COLOR } from '../data/constants'

const ARTIFACT_LABEL: Record<string, string> = {
  resume: 'Resume',
  portfolio: 'Portfolio',
  interview: 'Interview',
  'cover-letter': 'Cover Letter',
}

/** locator 展示串：portfolio · project_xxx.pf_001（resume 无 scopeId） */
function locatorText(s: TraceSource): string {
  const l = s.locator
  return `${ARTIFACT_LABEL[l.artifact] ?? l.artifact} · ${l.scopeId ? `${l.scopeId}.` : ''}${l.objectId}`
}

function SourceRow({ s }: { s: TraceSource }) {
  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: 2,
        border: `1px solid ${s.resolved ? COLORS.border : alpha(RISK_COLOR.high, 0.4)}`,
        bgcolor: s.resolved ? COLORS.bg : alpha(RISK_COLOR.high, 0.04),
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Typography sx={{ fontSize: 12, fontWeight: 600, color: s.resolved ? COLORS.text : RISK_COLOR.high }}>
          {s.resolved ? '✓' : '✗'} {locatorText(s)}
        </Typography>
        {!s.resolved && <Typography sx={{ fontSize: 11, color: RISK_COLOR.high, ml: 'auto' }}>断链</Typography>}
      </Box>
      {s.resolved ? (
        <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, mt: 0.5 }}>{s.factStatement}</Typography>
      ) : (
        <Typography sx={{ fontSize: 11.5, color: RISK_COLOR.high, mt: 0.5 }}>Reason: {s.error}</Typography>
      )}
    </Box>
  )
}

export function TraceabilityPanel({
  open,
  onClose,
  scopeId,
  unitId,
}: {
  open: boolean
  onClose: () => void
  scopeId: string
  unitId: string
}) {
  const traceability = useAppStore((s) => s.traceability)
  const loadTraceability = useAppStore((s) => s.loadTraceability)

  useEffect(() => {
    if (open) void loadTraceability(scopeId, unitId)
  }, [open, scopeId, unitId, loadTraceability])

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontSize: 14, fontWeight: 700 }}>来源追溯</DialogTitle>
      <DialogContent sx={{ pb: 3 }}>
        {!traceability ? (
          <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted }}>加载中…</Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: alpha(COLORS.accent, 0.06), border: `1px solid ${alpha(COLORS.accent, 0.2)}` }}>
              <Typography sx={{ fontSize: 11, color: COLORS.textSecondary, mb: 0.5 }}>
                表达单元 · {traceability.node.id}
              </Typography>
              <Typography sx={{ fontSize: 13, fontWeight: 600, color: COLORS.text, lineHeight: 1.6 }}>
                {traceability.node.text}
              </Typography>
            </Box>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textSecondary }}>
              依赖的事实来源（{traceability.sources.length}）——只读定位，事实真相在源侧
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
              {traceability.sources.map((s, i) => (
                <SourceRow key={`${s.locator.artifact}-${s.locator.objectId}-${i}`} s={s} />
              ))}
            </Box>
          </Box>
        )}
      </DialogContent>
    </Dialog>
  )
}
