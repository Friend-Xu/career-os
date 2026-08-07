/**
 * 工作台子视图 · 决策记录库：全部决策记录（时间倒序 + 校验标记 + 方向过滤）。
 * 点击记录 → 编辑抽屉（含聚合摘要入口）。
 */
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material'
import { useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { useAppStore } from '../../store/app-store'
import { COLORS, EASE, RISK_COLOR, RISK_LABEL, alpha } from '../../data/constants'
import { belongsToPerson } from '../../utils/ownership'
import type { DecisionView } from '../../store/engine-client'
import { DecisionEditDialog } from '../decision-edit-dialog'

export function DecisionsView() {
  const decisions = useAppStore((s) => s.decisions)
  const contexts = useAppStore((s) => s.contexts)
  const person = useAppStore((s) => s.currentPerson())
  const [editing, setEditing] = useState<DecisionView | null>(null)
  const [dir, setDir] = useState<string>('all')

  const mine = useMemo(
    () =>
      decisions
        .filter((d) => belongsToPerson(d, person))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [decisions, person.personId, person.name],
  )

  const directions = useMemo(
    () => [...new Set(mine.map((d) => d.direction).filter(Boolean))] as string[],
    [mine],
  )

  const visible = dir === 'all' ? mine : mine.filter((d) => d.direction === dir)

  const editingAggregate = editing
    ? (contexts.find((a) => a.records.some((r) => r.id === editing.id)) ?? null)
    : null

  const chipSx = (active: boolean) => ({
    height: 22,
    fontSize: 11.5,
    bgcolor: active ? COLORS.accentMuted : COLORS.bgHover,
    color: active ? COLORS.accent : COLORS.textSecondary,
    border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
    cursor: 'pointer',
  })

  return (
    <Box sx={{ p: 2.5, maxWidth: 900, mx: 'auto', width: '100%' }}>
      <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
        <Typography sx={{ fontSize: 16, fontWeight: 600, flex: 1 }}>决策记录</Typography>
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, fontFamily: COLORS.mono }}>
          {visible.length} 条
        </Typography>
      </Stack>
      <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1.5 }}>
        全部决策记录按时间倒序——点击查看摘要、局部修改或发起重新评估
      </Typography>

      <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75, mb: 2 }}>
        <Chip size="small" label={`全部 · ${mine.length}`} onClick={() => setDir('all')} sx={chipSx(dir === 'all')} />
        {directions.map((d) => (
          <Chip key={d} size="small" label={d} onClick={() => setDir(d)} sx={chipSx(dir === d)} />
        ))}
      </Stack>

      {visible.length === 0 ? (
        <Box sx={{ py: 8, textAlign: 'center' }}>
          <Typography sx={{ fontSize: 13, color: COLORS.textMuted, lineHeight: 1.7 }}>
            「{person.name}」尚无决策记录
            <br />
            从 AI 面板发起首个分析后，记录将在这里归档
          </Typography>
        </Box>
      ) : (
        <Stack spacing={0.5}>
          {visible.map((d) => {
            const v = d.validation
            const vColor =
              v?.status === 'invalid' ? RISK_COLOR.high : v?.status === 'degraded' ? RISK_COLOR.medium : null
            const vReasons = v?.issues.map((i) => i.reason).join('；') ?? ''
            return (
              <Box
                key={d.id}
                onClick={() => setEditing(d)}
                sx={{
                  p: 1.25,
                  borderRadius: '8px',
                  border: `1px solid ${alpha(COLORS.border, 0.8)}`,
                  boxShadow: COLORS.cardShadow,
                  cursor: 'pointer',
                  transition: `background-color 180ms ${EASE}, border-color 180ms ${EASE}`,
                  '&:hover': { bgcolor: COLORS.bgHover, borderColor: COLORS.borderStrong },
                }}
              >
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <Typography sx={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0 }} noWrap>
                    {d.title}
                  </Typography>
                  {vColor && (
                    <Tooltip
                      title={
                        v?.status === 'invalid' ? `待人工处理：${vReasons}` : vReasons || '数据降级（值域修正后保留）'
                      }
                    >
                      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: vColor, flexShrink: 0 }} />
                    </Tooltip>
                  )}
                  <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, fontFamily: COLORS.mono }}>
                    {dayjs(d.createdAt).format('MM-DD')}
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.5 }}>
                  <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, flex: 1, minWidth: 0 }} noWrap>
                    {d.keyRisk}
                  </Typography>
                  {d.payload?.type === 'direction' && d.payload.directions.length > 0 ? (
                    d.payload.directions.map((x) => (
                      <Chip
                        key={x.name}
                        size="small"
                        label={`${x.name} ${x.match}%`}
                        sx={{ height: 18, fontSize: 11, flexShrink: 0 }}
                      />
                    ))
                  ) : (
                    d.direction && (
                      <Chip size="small" label={d.direction} sx={{ height: 18, fontSize: 11, flexShrink: 0 }} />
                    )
                  )}
                  {d.payload?.type !== 'direction' && d.directionMatch > 0 && (
                    <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.accent }}>
                      匹配 {d.directionMatch}%
                    </Typography>
                  )}
                  <Typography sx={{ fontSize: 11.5, color: RISK_COLOR[d.riskLevel], flexShrink: 0 }}>
                    风险{RISK_LABEL[d.riskLevel]}
                  </Typography>
                </Stack>
              </Box>
            )
          })}
        </Stack>
      )}

      <DecisionEditDialog
        decision={editing}
        aggregate={editingAggregate}
        onClose={() => setEditing(null)}
      />
    </Box>
  )
}
