/**
 * 方向视图：方向是查询/聚合/认知维度（非存储主键/生命周期边界）——
 * 按 direction 聚合决策记录，每个方向一条时间线；点击决策 → 编辑抽屉。
 */
import { Box, Dialog, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import ErrorIcon from '@mui/icons-material/Error'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import { useMemo, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { COLORS, RISK_COLOR } from '../data/constants'
import type { DecisionView } from '../store/engine-client'
import { DecisionEditDialog } from './decision-edit-dialog'

function Mark({ d }: { d: DecisionView }) {
  const v = d.validation
  if (!v || v.status === 'ok') return null
  const invalid = v.status === 'invalid'
  const color = invalid ? RISK_COLOR.high : RISK_COLOR.medium
  const Icon = invalid ? ErrorIcon : WarningAmberIcon
  return (
    <Tooltip title={v.issues.map((i) => i.reason).join('；')}>
      <Icon sx={{ fontSize: 13, color, flexShrink: 0 }} />
    </Tooltip>
  )
}

function DirectionGroup({
  name,
  decisions,
  onOpen,
}: {
  name: string
  decisions: DecisionView[]
  onOpen: (d: DecisionView) => void
}) {
  return (
    <Box sx={{ mb: 2 }}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.75 }}>
        <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: COLORS.accent }} />
        <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{name}</Typography>
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, fontFamily: 'var(--cos-mono, monospace)' }}>
          {decisions.length}
        </Typography>
      </Stack>
      <Stack spacing={0.5} sx={{ ml: 0.75, pl: 1.5, borderLeft: `1px solid ${COLORS.border}` }}>
        {decisions.map((d) => (
          <Box
            key={d.id}
            onClick={() => onOpen(d)}
            sx={{
              p: 0.75,
              borderRadius: '8px',
              cursor: 'pointer',
              '&:hover': { bgcolor: COLORS.bgHover },
            }}
          >
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
              <Typography sx={{ fontSize: 12.5, fontWeight: 500, flex: 1, minWidth: 0 }} noWrap>
                {d.title}
              </Typography>
              <Mark d={d} />
            </Stack>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.25 }}>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                {d.createdAt || '无日期'}
              </Typography>
              {d.directionMatch > 0 && (
                <Typography
                  sx={{
                    fontSize: 11.5,
                    color: COLORS.textSecondary,
                    fontFamily: 'var(--cos-mono, monospace)',
                  }}
                >
                  匹配 {d.directionMatch}%
                </Typography>
              )}
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>{d.skill ?? ''}</Typography>
            </Stack>
          </Box>
        ))}
      </Stack>
    </Box>
  )
}

export function DirectionViewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const decisions = useAppStore((s) => s.decisions)
  const contexts = useAppStore((s) => s.contexts)
  const person = useAppStore((s) => s.currentPerson())
  const [editing, setEditing] = useState<DecisionView | null>(null)

  const groups = useMemo(() => {
    const mine = decisions.filter((d) => d.profile === person.name)
    const map = new Map<string, DecisionView[]>()
    for (const d of mine) {
      const key = d.direction || '未标注方向'
      const list = map.get(key)
      if (list) list.push(d)
      else map.set(key, [d])
    }
    // 决策多者优先（最新方向含最新决策，通常决策最多，自然靠前）
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [decisions, person.name])

  const editingAggregate = editing
    ? (contexts.find((a) => a.records.some((r) => r.id === editing.id)) ?? null)
    : null

  return (
    <>
      <Dialog

        open={open}
        onClose={onClose}
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
        <Box sx={{ maxHeight: '80vh', overflow: 'auto', p: 2.5 }}>
          <Stack direction="row" sx={{ alignItems: 'center', mb: 2 }}>
            <Typography sx={{ fontSize: 15, fontWeight: 600, flex: 1 }}>
              方向视图 · {person.name}
            </Typography>
            <IconButton size="small" onClick={onClose}>
              <CloseIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Stack>
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 2, lineHeight: 1.6 }}>
            方向是聚合维度：每个方向下的全部决策记录（公司筛选/JD 分析/简历定制按方向各自成组，互不覆盖）
          </Typography>
          {groups.length === 0 ? (
            <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted }}>暂无决策记录</Typography>
          ) : (
            groups.map(([name, list]) => (
              <DirectionGroup
                key={name}
                name={name}
                decisions={list}
                onOpen={(d) => setEditing(d)}
              />
            ))
          )}
        </Box>
      </Dialog>
      <DecisionEditDialog
        decision={editing}
        aggregate={editingAggregate}
        onClose={() => setEditing(null)}
      />
    </>
  )
}
