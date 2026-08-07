/**
 * 工作台子视图 · 方向：决策结果工作台——
 * ① 推荐方向卡片（最新方向评估 payload 明细：匹配度条/置信度/优势/风险 + 查看完整评估）
 * ② 方向概览 chips（按方向聚合全部决策，过滤时间线）
 * ③ 分组时间线（历史决策溯源；点击决策 → 编辑抽屉）
 */
import { Box, Button, Chip, LinearProgress, Stack, Tooltip, Typography } from '@mui/material'
import ErrorIcon from '@mui/icons-material/Error'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import { useMemo, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import { alpha, COLORS, EASE, RISK_COLOR, RISK_LABEL } from '../../data/constants'
import { belongsToPerson } from '../../utils/ownership'
import type { DecisionView } from '../../store/engine-client'
import { DecisionEditDialog } from '../decision-edit-dialog'
import { DecisionDetailDrawer } from '../decision-detail-drawer'
import { DetailButton } from './detail-button'

const CONF_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' }

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

/** 决策展开的方向名列表：方向评估明细（v2.8 payload）逐方向；城市评估用口径方向；旧协议单字符串 */
function dirsOf(d: DecisionView): string[] {
  if (d.payload?.type === 'direction' && d.payload.directions.length > 0) {
    return d.payload.directions.map((x) => x.name)
  }
  if (d.payload?.type === 'city' && d.payload.direction) return [d.payload.direction]
  return d.direction ? [d.direction] : ['未标注方向']
}

/** 决策在该方向下的匹配度：payload 逐方向 match；旧协议 directionMatch */
function matchOf(d: DecisionView, name: string): number | undefined {
  if (d.payload?.type === 'direction') {
    return d.payload.directions.find((x) => x.name === name)?.match
  }
  return d.directionMatch
}

export function DirectionsView() {
  const decisions = useAppStore((s) => s.decisions)
  const contexts = useAppStore((s) => s.contexts)
  const person = useAppStore((s) => s.currentPerson())
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const [editing, setEditing] = useState<DecisionView | null>(null)
  const [detail, setDetail] = useState<DecisionView | null>(null)
  const [filter, setFilter] = useState<string>('all')

  const mine = decisions.filter((d) => belongsToPerson(d, person))

  /** 最新方向评估决策（payload 明细 → 推荐方向卡片）；同日多评估按 id 降序（登记顺序 = 时间顺序） */
  const latestDir = useMemo(() => {
    const dir = mine.filter((d) => d.payload?.type === 'direction' && d.payload.directions.length > 0)
    if (dir.length === 0) return undefined
    return [...dir].sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
    )[0]
  }, [mine])

  const dirs = latestDir?.payload?.type === 'direction' ? latestDir.payload.directions : []

  const groups = useMemo(() => {
    const map = new Map<string, DecisionView[]>()
    for (const d of mine) {
      for (const name of dirsOf(d)) {
        const list = map.get(name)
        if (list) list.push(d)
        else map.set(name, [d])
      }
    }
    // 决策多者优先（最新方向含最新决策，通常决策最多，自然靠前）
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [mine])

  /** 方向统计：决策数 + 最新决策（匹配/风险锚点） */
  const stats = useMemo(
    () =>
      groups.map(([name, list]) => {
        const latest = [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
        return { name, count: list.length, latest, match: latest ? matchOf(latest, name) : undefined }
      }),
    [groups],
  )

  /** 顶部洞察：已探索方向数（聚合口径）+ 最匹配方向（最新评估 payload 口径） */
  const insight = useMemo(() => {
    if (!latestDir || dirs.length === 0) return undefined
    const top = [...dirs].sort((a, b) => b.match - a.match)[0]
    return { count: groups.length, top }
  }, [latestDir, groups])

  const visible = filter === 'all' ? groups : groups.filter(([n]) => n === filter)

  const editingAggregate = editing
    ? (contexts.find((a) => a.records.some((r) => r.id === editing.id)) ?? null)
    : null

  return (
    <Box sx={{ p: 2.5, maxWidth: 900, mx: 'auto', width: '100%' }}>
      <Typography sx={{ fontSize: 16, fontWeight: 600, mb: 0.25 }}>方向视图</Typography>
      <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1.5, lineHeight: 1.6 }}>
        方向是聚合维度：最新评估的推荐方向 + 各方向下的决策记录（公司筛选 / JD 分析 / 简历定制按方向各自成组，互不覆盖）
      </Typography>

      {/* 洞察卡：已探索方向数（聚合）+ 最匹配方向（最新评估 payload） */}
      {insight && (
        <Box
          sx={{
            p: 1.75,
            borderRadius: '10px',
            border: `1px solid ${alpha(COLORS.border, 0.8)}`,
            boxShadow: COLORS.cardShadow,
            bgcolor: COLORS.bgElevated,
            mb: 2,
          }}
        >
          <Box
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              px: 1,
              py: 0.25,
              borderRadius: '999px',
              bgcolor: alpha(COLORS.accent, 0.1),
              color: COLORS.accent,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              mb: 0.75,
            }}
          >
            方向探索结论
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Box sx={{ minWidth: 96 }}>
              <Typography sx={{ fontSize: 22, fontWeight: 700, fontFamily: COLORS.mono, color: COLORS.accent, lineHeight: 1.2 }}>
                {insight.count} 个方向
              </Typography>
              <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mt: 0.25 }}>已探索</Typography>
            </Box>
            <Box sx={{ flex: 1, minWidth: 0, borderLeft: `1px solid ${COLORS.border}`, pl: 2 }}>
              <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.7 }}>
                最匹配 <Box component="span" sx={{ fontWeight: 600, color: COLORS.text }}>{insight.top.name}</Box> · {insight.top.match}%
                {insight.top.strengths.length > 0 && <> — {insight.top.strengths[0]}</>}
              </Typography>
            </Box>
          </Box>
        </Box>
      )}

      {/* ① 推荐方向卡片（最新方向评估 payload 明细；无明细旧决策不渲染卡片区） */}
      {latestDir && dirs.length > 0 && (
        <Box sx={{ mb: 2.5 }}>
          <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1 }}>推荐方向</Typography>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, fontFamily: COLORS.mono }}>
              {latestDir.createdAt || ''} 方向评估
            </Typography>
          </Stack>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 1.5 }}>
            {dirs.map((d) => (
              <Box
                key={d.name}
                sx={{
                  p: 1.5,
                  borderRadius: '10px',
                  border: `1px solid ${alpha(COLORS.border, 0.8)}`,
                  boxShadow: COLORS.cardShadow,
                  bgcolor: COLORS.bgElevated,
                  display: 'flex',
                  flexDirection: 'column',
                  transition: `background-color 180ms ${EASE}`,
                  '&:hover': { bgcolor: COLORS.bgHover },
                }}
              >
                <Stack direction="row" sx={{ alignItems: 'center', mb: 0.75 }}>
                  <Typography sx={{ fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>
                    {d.name}
                  </Typography>
                  <Chip
                    size="small"
                    label={`置信度 ${d.confidence ? CONF_LABEL[d.confidence] : '未标注'}`}
                    sx={{ height: 18, fontSize: 10.5, bgcolor: COLORS.bgHover, color: COLORS.textSecondary }}
                  />
                </Stack>

                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
                  <LinearProgress
                    variant="determinate"
                    value={d.match}
                    sx={{
                      flex: 1,
                      height: 6,
                      borderRadius: 3,
                      bgcolor: alpha(COLORS.text, 0.08),
                      '& .MuiLinearProgress-bar': { bgcolor: COLORS.accent, borderRadius: 3 },
                    }}
                  />
                  <Typography sx={{ fontSize: 13, fontWeight: 600, fontFamily: COLORS.mono, color: COLORS.accent }}>
                    {d.match}%
                  </Typography>
                </Stack>

                {d.strengths.length > 0 && (
                  <Stack spacing={0.25} sx={{ mb: 0.75 }}>
                    {d.strengths.slice(0, 3).map((s) => (
                      <Typography key={s} sx={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                        <Box component="span" sx={{ color: RISK_COLOR.low, fontWeight: 600, mr: 0.5 }}>✓</Box>
                        {s}
                      </Typography>
                    ))}
                  </Stack>
                )}
                {d.risks.length > 0 && (
                  <Stack spacing={0.25} sx={{ mb: 1 }}>
                    {d.risks.slice(0, 3).map((r) => (
                      <Typography key={r} sx={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.6 }}>
                        <Box component="span" sx={{ color: RISK_COLOR.medium, fontWeight: 600, mr: 0.5 }}>!</Box>
                        {r}
                      </Typography>
                    ))}
                  </Stack>
                )}

                <Box sx={{ mt: 'auto', pt: 0.75 }}>
                  <DetailButton onClick={() => setDetail(latestDir)} />
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {/* ② 方向概览 chips（决策数 + 最新匹配） */}
      <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75, mb: 2 }}>
        <Chip
          size="small"
          label={`全部 · ${mine.length}`}
          onClick={() => setFilter('all')}
          sx={{
            height: 22,
            fontSize: 11.5,
            bgcolor: filter === 'all' ? COLORS.accentMuted : COLORS.bgHover,
            color: filter === 'all' ? COLORS.accent : COLORS.textSecondary,
            border: `1px solid ${filter === 'all' ? COLORS.accent : COLORS.border}`,
            cursor: 'pointer',
          }}
        />
        {stats.map((s) => (
          <Chip
            key={s.name}
            size="small"
            label={`${s.name} · ${s.count}${s.match !== undefined && s.match > 0 ? ` · ${s.match}%` : ''}`}
            onClick={() => setFilter(s.name)}
            sx={{
              height: 22,
              fontSize: 11.5,
              bgcolor: filter === s.name ? COLORS.accentMuted : COLORS.bgHover,
              color: filter === s.name ? COLORS.accent : COLORS.textSecondary,
              border: `1px solid ${filter === s.name ? COLORS.accent : COLORS.border}`,
              cursor: 'pointer',
            }}
          />
        ))}
      </Stack>

      {/* ③ 方向分组时间线（历史决策溯源） */}
      {visible.length === 0 ? (
        <Box sx={{ py: 8, textAlign: 'center' }}>
          <Typography sx={{ fontSize: 13, color: COLORS.textMuted, lineHeight: 1.7 }}>
            「{person.name}」尚未探索职业方向
            <br />
            基于你的经历、技能与目标，分析可能的发展路径
          </Typography>
          <Button
            size="small"
            variant="contained"
            onClick={() =>
              startAnalysis(
                `请基于「${person.name}」的职业档案，探索适合的发展方向：结合经历、技能与自报意向，给出 2-3 个候选方向及理由。`,
              )
            }
            sx={{ mt: 2, fontSize: 12.5 }}
          >
            开始探索
          </Button>
        </Box>
      ) : (
        visible.map(([name, list]) => {
          const st = stats.find((x) => x.name === name)!
          const latest = st.latest
          return (
            <Box key={name} sx={{ mb: 3 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.75 }}>
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    bgcolor: latest ? RISK_COLOR[latest.riskLevel] : COLORS.border,
                  }}
                />
                <Typography sx={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{name}</Typography>
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, fontFamily: COLORS.mono }}>
                  {st.count} 条
                </Typography>
                {st.match !== undefined && st.match > 0 && (
                  <Typography sx={{ fontSize: 11.5, fontFamily: COLORS.mono, color: COLORS.accent }}>
                    最新匹配 {st.match}%
                  </Typography>
                )}
              </Stack>
              <Stack spacing={0.5} sx={{ ml: 0.75, pl: 1.5, borderLeft: `1px solid ${COLORS.border}` }}>
                {list.map((d) => {
                  const m = matchOf(d, name)
                  return (
                    <Box
                      key={d.id}
                      onClick={() => setEditing(d)}
                      sx={{
                        p: 1,
                        borderRadius: '8px',
                        cursor: 'pointer',
                        transition: `background-color 180ms ${EASE}`,
                        '&:hover': { bgcolor: COLORS.bgHover },
                      }}
                    >
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                        <Typography sx={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0 }} noWrap>
                          {d.title}
                        </Typography>
                        <Mark d={d} />
                      </Stack>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.25 }}>
                        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>
                          {d.createdAt || '无日期'}
                        </Typography>
                        {m !== undefined && m > 0 && (
                          <Typography
                            sx={{
                              fontSize: 11.5,
                              color: COLORS.textSecondary,
                              fontFamily: COLORS.mono,
                            }}
                          >
                            匹配 {m}%
                          </Typography>
                        )}
                        {d.skill && (
                          <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>{d.skill}</Typography>
                        )}
                        <Typography sx={{ fontSize: 11.5, color: RISK_COLOR[d.riskLevel] }}>
                          风险{RISK_LABEL[d.riskLevel]}
                        </Typography>
                      </Stack>
                    </Box>
                  )
                })}
              </Stack>
            </Box>
          )
        })
      )}

      <DecisionEditDialog
        decision={editing}
        aggregate={editingAggregate}
        onClose={() => setEditing(null)}
      />
      <DecisionDetailDrawer decision={detail} onClose={() => setDetail(null)} />
    </Box>
  )
}
