/**
 * WebSearch 指标弹层（P3 指标板）：system/search-stats 聚合投影的 UI 展示。
 * 数据仅来自引擎（store.searchStats）；离线/无记录 → 诚实空态，无 mock 兜底。
 * 隐私：只展示计数与时间戳——查询内容不落 UI、不进 trace 外的任何展示层。
 */
import { Dialog, DialogContent, DialogTitle, IconButton, Stack, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import RefreshIcon from '@mui/icons-material/Refresh'
import { useAppStore } from '../../store/app-store'
import { pullSearchStats } from '../../store/app-store'
import { COLORS } from '../../data/constants'
import type { SearchStats } from '../../types'

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', { hour12: false })
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

export function SearchStatsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const stats = useAppStore((s) => s.searchStats)
  const engineStatus = useAppStore((s) => s.engineStatus)

  const s: SearchStats | null = engineStatus === 'connected' ? stats : null

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 1.5 }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>WebSearch 指标</Typography>
        <Stack direction="row" spacing={0.5}>
          <IconButton
            size="small"
            title="刷新"
            onClick={() => {
              void pullSearchStats()
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
            暂无搜索指标（引擎在线但未产生 web_search trace，或引擎离线）
          </Typography>
        ) : (
          <>
            <StatRow label="总搜索" value={`${s.searches} 次`} />
            <StatRow label="缓存命中" value={`${s.cacheHits} 次`} />
            <StatRow label="守卫降级" value={`${s.fallbacks} 次`} />
            <StatRow label="失败" value={`${s.errors} 次`} />
            <StatRow label="预算用尽" value={`${s.budgetExhausted} 次`} />
            <StatRow label="首次" value={fmtTime(s.since)} muted />
            <StatRow label="最近" value={fmtTime(s.lastAt)} muted />
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 1.5 }}>
              本地 trace 汇总（logs/traces/web_search-*.jsonl），不含查询内容；引擎重启后 trace 保留。
            </Typography>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
