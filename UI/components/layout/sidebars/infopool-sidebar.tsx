/**
 * 信息池空间侧栏：节点类型过滤（含孤立/待人工告警项，带计数）。
 */
import { Box, Stack, Typography } from '@mui/material'
import { useMemo } from 'react'
import { INFO_NODES } from '../../../data/mock-data'
import { useAppStore } from '../../../store/app-store'
import { computePoolStats } from '../../../store/engine-client'
import { COLORS, RISK_COLOR } from '../../../data/constants'

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'person', label: '人' },
  { id: 'decision', label: '决策' },
  { id: 'direction', label: '方向' },
  { id: 'city', label: '城市' },
  { id: 'company', label: '公司' },
  { id: 'role', label: '岗位' },
  { id: 'skill', label: '技能' },
  { id: 'isolated', label: '孤立' },
  { id: 'invalid', label: '待人工' },
]

export function InfoPoolSidebar() {
  const infopoolFilter = useAppStore((s) => s.infopoolFilter)
  const setInfopoolFilter = useAppStore((s) => s.setInfopoolFilter)
  const poolGraph = useAppStore((s) => s.poolGraph)
  const decisions = useAppStore((s) => s.decisions)
  const companies = useAppStore((s) => s.companies)
  const nodes = poolGraph?.nodes ?? INFO_NODES

  const counts = useMemo(() => {
    const byType: Record<string, number> = { all: nodes.length }
    for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1
    const isolated = poolGraph ? computePoolStats(poolGraph).isolated : 0
    const invalid =
      decisions.filter((d) => d.validation?.status === 'invalid').length +
      companies.filter((c) => c.validation?.status === 'invalid').length
    return { byType, isolated, invalid }
  }, [nodes, poolGraph, decisions, companies])

  const countOf = (id: string): number =>
    id === 'all'
      ? (counts.byType.all ?? 0)
      : id === 'isolated'
        ? counts.isolated
        : id === 'invalid'
          ? counts.invalid
          : (counts.byType[id] ?? 0)

  return (
    <Stack spacing={0.25} sx={{ p: 1.25 }}>
      <Typography
        sx={{
          fontSize: 11,
          fontWeight: 600,
          color: COLORS.textMuted,
          letterSpacing: '0.05em',
          px: 1,
          mb: 0.5,
        }}
      >
        节点类型
      </Typography>
      {FILTERS.map((f) => {
        const active = infopoolFilter === f.id
        const n = countOf(f.id)
        const warn = f.id === 'isolated' || f.id === 'invalid'
        return (
          <Stack
            key={f.id}
            direction="row"
            spacing={1}
            onClick={() => setInfopoolFilter(f.id)}
            sx={{
              alignItems: 'center',
              px: 1,
              py: 0.6,
              borderRadius: '6px',
              cursor: 'pointer',
              bgcolor: active ? COLORS.accentMuted : 'transparent',
              '&:hover': { bgcolor: active ? COLORS.accentMuted : COLORS.bgHover },
            }}
          >
            <Box
              sx={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                bgcolor: warn ? (n > 0 ? RISK_COLOR.medium : COLORS.border) : active ? COLORS.accent : COLORS.border,
                flexShrink: 0,
              }}
            />
            <Typography
              sx={{
                fontSize: 12.5,
                fontWeight: active ? 600 : 400,
                color: active ? COLORS.accent : COLORS.text,
                flex: 1,
              }}
            >
              {f.label}
            </Typography>
            <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.textMuted }}>{n}</Typography>
          </Stack>
        )
      })}
    </Stack>
  )
}
