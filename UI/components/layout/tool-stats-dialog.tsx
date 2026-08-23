/**
 * 工具指标弹层（Phase 4B 统一指标板）：system/tool-stats 聚合投影的 UI 展示。
 * 数据仅来自引擎（store.toolStats）；离线/无记录 → 诚实空态，无 mock 兜底。
 * 隐私：只展示计数/耗时聚合与时间戳——查询内容不落 UI、不进 trace 外的任何展示层。
 */
import { Dialog, DialogContent, DialogTitle, IconButton, Stack, Typography, Box } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import RefreshIcon from '@mui/icons-material/Refresh'
import { useAppStore, pullToolStats } from '../../store/app-store'
import { COLORS } from '../../data/constants'
import type { ToolStatEntry, ToolStats, ToolSource } from '../../types'

const SOURCE_LABEL: Record<ToolSource, string> = {
  builtin: '本地',
  hosted: '托管',
  mcp: '研究',
  data: '数据',
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', { hour12: false })
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function StatRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between', mb: 0.75 }}>
      <Typography sx={{ fontSize: 13, color: COLORS.textMuted }}>{label}</Typography>
      <Typography sx={{ fontSize: 13, fontFamily: COLORS.mono, color: muted ? COLORS.textMuted : COLORS.text }}>
        {value}
      </Typography>
    </Stack>
  )
}

function ToolTable({ rows }: { rows: ToolStatEntry[] }) {
  if (rows.length === 0) {
    return <Typography sx={{ fontSize: 13, color: COLORS.textMuted }}>暂无工具调用记录</Typography>
  }
  return (
    <Box sx={{ '& > *': { borderBottom: `1px solid ${COLORS.border}` } }}>
      {rows.map((t) => (
        <Stack key={t.name} direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', py: 0.75 }}>
          <Typography sx={{ fontSize: 13, minWidth: 110 }}>{t.name}</Typography>
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, width: 44 }}>
            {SOURCE_LABEL[t.source] ?? t.source}
          </Typography>
          <Typography sx={{ fontSize: 12.5, fontFamily: COLORS.mono, width: 52, textAlign: 'right' }}>
            {t.calls} 次{t.errors > 0 ? ` / ${t.errors} 败` : ''}
          </Typography>
          <Typography sx={{ fontSize: 12.5, fontFamily: COLORS.mono, width: 72, textAlign: 'right' }}>
            {fmtMs(t.avgDurationMs)}
          </Typography>
        </Stack>
      ))}
    </Box>
  )
}

export function ToolStatsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const stats = useAppStore((s) => s.toolStats)
  const engineStatus = useAppStore((s) => s.engineStatus)

  const s: ToolStats | null = engineStatus === 'connected' ? stats : null

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 1.5 }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>工具指标</Typography>
        <Stack direction="row" spacing={0.5}>
          <IconButton
            size="small"
            title="刷新"
            onClick={() => {
              void pullToolStats()
            }}
          >
            <RefreshIcon sx={{ fontSize: 18 }} />
          </IconButton>
          <IconButton size="small" onClick={onClose}>
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ pb: 2 }}>
        {s === null ? (
          <Typography sx={{ fontSize: 13, color: COLORS.textMuted }}>
            暂无工具指标（引擎在线但未产生 trace，或引擎离线）
          </Typography>
        ) : (
          <>
            <StatRow label="工具调用" value={`${s.byTool.reduce((n, t) => n + t.calls, 0)} 次`} />
            <StatRow label="外部 HTTP 调用" value={`${s.externalCalls} 次`} />
            <StatRow label="缓存命中" value={`${s.cacheHits} 次`} />
            <StatRow label="守卫降级" value={`${s.fallbacks} 次`} />
            <StatRow label="预算用尽" value={`${s.budgetExhausted} 次`} />
            <StatRow label="首次" value={fmtTime(s.since)} muted />
            <StatRow label="最近" value={fmtTime(s.lastAt)} muted />
            <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted, mt: 1.5, mb: 0.5 }}>按来源</Typography>
            <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', mb: 1.5 }}>
              {s.bySource.map((src) => (
                <Typography key={src.source} sx={{ fontSize: 12, fontFamily: COLORS.mono, color: COLORS.textMuted }}>
                  {SOURCE_LABEL[src.source] ?? src.source} {src.calls} 次
                  {src.errors > 0 ? `（${src.errors} 败）` : ''}
                  {src.avgDurationMs !== null ? ` · ${fmtMs(src.avgDurationMs)}` : ''}
                </Typography>
              ))}
            </Stack>
            <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted, mb: 0.5 }}>按工具（平均耗时）</Typography>
            <ToolTable rows={s.byTool} />
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 1.5 }}>
              本地 trace 汇总（logs/traces），不含查询内容；引擎重启后 trace 保留。
            </Typography>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
