/**
 * 工作台子视图 · 城市：城市评估热力图 + 推荐列表。
 * 数据 = 城市评估决策（city 字段非空的决策记录）按城市聚合派生；
 * 初始化后的城市推荐会落入该视图（同一数据源）。
 */
import { Box, Button, Chip, Stack, Typography } from '@mui/material'
import { useMemo } from 'react'
import { useAppStore } from '../../store/app-store'
import { alpha, COLORS, RISK_COLOR, RISK_LABEL } from '../../data/constants'
import { belongsToPerson } from '../../utils/ownership'
import type { DecisionView } from '../../store/engine-client'
import type { RiskLevel } from '../../types'

/** 常用城市坐标（简化中国地图投影，lat/lon → viewBox 坐标；未收录城市回落列表视图） */
const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
  北京: { lat: 39.9, lon: 116.4 },
  上海: { lat: 31.2, lon: 121.5 },
  深圳: { lat: 22.5, lon: 114.1 },
  苏州: { lat: 31.3, lon: 120.6 },
  杭州: { lat: 30.3, lon: 120.2 },
  广州: { lat: 23.1, lon: 113.3 },
  常州: { lat: 31.8, lon: 119.9 },
  南京: { lat: 32.1, lon: 118.8 },
  无锡: { lat: 31.6, lon: 120.3 },
  成都: { lat: 30.6, lon: 104.1 },
  武汉: { lat: 30.6, lon: 114.3 },
  西安: { lat: 34.3, lon: 108.9 },
  合肥: { lat: 31.8, lon: 117.2 },
  宁波: { lat: 29.9, lon: 121.5 },
  东莞: { lat: 23.0, lon: 113.7 },
  佛山: { lat: 23.0, lon: 113.1 },
  重庆: { lat: 29.6, lon: 106.5 },
  青岛: { lat: 36.1, lon: 120.4 },
  天津: { lat: 39.1, lon: 117.2 },
  长沙: { lat: 28.2, lon: 113.0 },
}

interface CityAgg {
  city: string
  score: number
  risk: RiskLevel
  count: number
}

/** 热力三档：高分绿 / 中分黄 / 低分红 */
function heatColor(score: number): string {
  if (score >= 80) return RISK_COLOR.low
  if (score >= 60) return RISK_COLOR.medium
  return RISK_COLOR.high
}

function heatLabel(score: number): string {
  if (score >= 80) return '推荐'
  if (score >= 60) return '参考'
  return '谨慎'
}

/** 决策的评估城市集合：v2.8 payload 逐城市（带各自得分）；旧协议单 city 字符串（多城字符串无法拆分，score 缺失 → 0） */
function citiesOf(d: DecisionView): { name: string; score: number }[] {
  if (d.payload?.type === 'city' && d.payload.cities.length > 0) {
    return d.payload.cities.map((c) => ({ name: c.name, score: c.score }))
  }
  return d.city ? [{ name: d.city, score: d.cityScore ?? 0 }] : []
}

export function CitiesView() {
  const decisions = useAppStore((s) => s.decisions)
  const person = useAppStore((s) => s.currentPerson())
  const setWorkbenchView = useAppStore((s) => s.setWorkbenchView)

  /** 城市聚合：仅城市评估决策（skill=city-advisor；方向探索的自报意向 city 不是评估结果）按城市展开，各城市最新评估得分 */
  const cities = useMemo(() => {
    const mine = decisions.filter((d) => belongsToPerson(d, person) && d.skill === 'city-advisor' && (d.city || d.payload?.type === 'city'))
    const map = new Map<string, { d: DecisionView; score: number }[]>()
    for (const d of mine) {
      for (const c of citiesOf(d)) {
        const list = map.get(c.name)
        if (list) list.push({ d, score: c.score })
        else map.set(c.name, [{ d, score: c.score }])
      }
    }
    const agg: CityAgg[] = [...map.entries()].map(([city, hits]) => {
      const latest = [...hits].sort((a, b) => (a.d.createdAt < b.d.createdAt ? 1 : -1))[0]
      return {
        city,
        score: latest.score,
        risk: latest.d.riskLevel,
        count: hits.length,
      }
    })
    return agg.sort((a, b) => b.score - a.score)
  }, [decisions, person.personId, person.name])

  /** 方向是否已确定（最新决策的 direction 非空）——城市评估的前置条件 */
  const hasDirection = (() => {
    const mine = decisions.filter((d) => belongsToPerson(d, person))
    const latest = mine.length ? [...mine].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] : undefined
    return Boolean(latest?.direction && latest.direction !== '方向待定')
  })()

  if (!hasDirection) {
    return (
      <Box sx={{ p: 2.5, maxWidth: 900, mx: 'auto', width: '100%' }}>
        <Typography sx={{ fontSize: 16, fontWeight: 600, mb: 0.25 }}>城市视图</Typography>
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1.5 }}>
          城市评估热力图与推荐——基于城市评估决策派生
        </Typography>
        <Box sx={{ py: 8, textAlign: 'center' }}>
          <Typography sx={{ fontSize: 13, color: COLORS.textMuted, lineHeight: 1.7 }}>
            等待职业方向确定
            <br />
            方向确定后，城市评估才有对比依据（如「机器人方向 · 深圳 vs 上海」）
          </Typography>
          <Button size="small" variant="outlined" onClick={() => setWorkbenchView('directions')} sx={{ mt: 2, fontSize: 12.5 }}>
            先探索职业方向
          </Button>
        </Box>
      </Box>
    )
  }

  if (cities.length === 0) {
    return (
      <Box sx={{ p: 2.5, maxWidth: 900, mx: 'auto', width: '100%' }}>
        <Typography sx={{ fontSize: 16, fontWeight: 600, mb: 0.25 }}>城市视图</Typography>
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1.5 }}>
          城市评估热力图与推荐——基于城市评估决策派生
        </Typography>
        <Box sx={{ py: 8, textAlign: 'center' }}>
          <Typography sx={{ fontSize: 13, color: COLORS.textMuted, lineHeight: 1.7 }}>
            暂无城市评估
            <br />
            在 AI 面板发起城市评估（如「对比深圳 vs 上海」）后，这里会显示城市热力图与推荐
          </Typography>
        </Box>
      </Box>
    )
  }

  return (
    <Box sx={{ p: 2.5, maxWidth: 1100, mx: 'auto', width: '100%' }}>
      <Typography sx={{ fontSize: 16, fontWeight: 600, mb: 0.25 }}>城市视图</Typography>
      <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1.5 }}>
        城市评估热力图与推荐——评分取最新城市评估，颜色映射推荐度
      </Typography>

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'stretch' }}>
        {/* 热力地图（简化中国投影：网格底 + 城市热力色点 + 名称） */}
        <Box
          sx={{
            flex: 1.4,
            minWidth: 0,
            position: 'relative',
            borderRadius: '10px',
            border: `1px solid ${COLORS.border}`,
            bgcolor: COLORS.canvas,
            overflow: 'hidden',
            minHeight: 440,
          }}
        >
          <svg width="100%" height="100%" viewBox="0 0 900 520" preserveAspectRatio="xMidYMid meet">
            {Array.from({ length: 10 }).map((_, i) => (
              <line key={`h${i}`} x1={0} y1={i * 52} x2={900} y2={i * 52} stroke={alpha(COLORS.text, 0.05)} />
            ))}
            {Array.from({ length: 12 }).map((_, i) => (
              <line key={`v${i}`} x1={i * 75} y1={0} x2={i * 75} y2={520} stroke={alpha(COLORS.text, 0.05)} />
            ))}
            {cities.map((c) => {
              const coord = CITY_COORDS[c.city]
              if (!coord) return null
              const x = ((coord.lon - 100) / 22) * 760 + 40
              const y = ((42 - coord.lat) / 20) * 440 + 40
              const color = heatColor(c.score)
              const r = 9 + Math.min(c.count, 5) * 2
              return (
                <g key={c.city}>
                  <circle cx={x} cy={y} r={r + 8} fill={alpha(color, 0.18)} />
                  <circle cx={x} cy={y} r={r} fill={color} stroke="#fff" strokeWidth={2} />
                  <text
                    x={x}
                    y={y - r - 8}
                    textAnchor="middle"
                    fontSize={12}
                    fontWeight={600}
                    fill={COLORS.text}
                  >
                    {c.city} {c.score}
                  </text>
                </g>
              )
            })}
          </svg>
          <Stack direction="row" spacing={1.5} sx={{ position: 'absolute', bottom: 12, left: 12, px: 1.5, py: 0.75, borderRadius: '8px', bgcolor: alpha(COLORS.canvas, 0.85), border: `1px solid ${COLORS.border}` }}>
            {[
              { label: '推荐 ≥80', color: RISK_COLOR.low },
              { label: '参考 60-79', color: RISK_COLOR.medium },
              { label: '谨慎 <60', color: RISK_COLOR.high },
            ].map((l) => (
              <Stack key={l.label} direction="row" sx={{ alignItems: 'center' }} spacing={0.5}>
                <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: l.color }} />
                <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>{l.label}</Typography>
              </Stack>
            ))}
          </Stack>
        </Box>

        {/* 推荐列表（按评分降序） */}
        <Box
          sx={{
            width: 300,
            minWidth: 300,
            borderRadius: '10px',
            border: `1px solid ${COLORS.border}`,
            bgcolor: COLORS.bgElevated,
            p: 1.5,
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
            <Typography sx={{ fontSize: 12, fontWeight: 600, flex: 1, color: COLORS.textSecondary }}>
              城市推荐
            </Typography>
            <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, fontFamily: COLORS.mono }}>
              {cities.length} 城
            </Typography>
          </Stack>
          <Stack spacing={0.5}>
            {cities.map((c) => (
              <Box
                key={c.city}
                sx={{
                  p: 1,
                  borderRadius: '8px',
                  border: `1px solid ${alpha(heatColor(c.score), 0.35)}`,
                  bgcolor: alpha(heatColor(c.score), 0.06),
                }}
              >
                <Stack direction="row" sx={{ alignItems: 'center' }} spacing={0.75}>
                  <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{c.city}</Typography>
                  <Typography sx={{ fontSize: 15, fontWeight: 600, fontFamily: COLORS.mono, color: heatColor(c.score) }}>
                    {c.score}
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mt: 0.5 }}>
                  <Chip size="small" label={heatLabel(c.score)} sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(heatColor(c.score), 0.14), color: heatColor(c.score) }} />
                  <Typography sx={{ fontSize: 11.5, color: RISK_COLOR[c.risk] }}>风险{RISK_LABEL[c.risk]}</Typography>
                  <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, fontFamily: COLORS.mono }}>
                    {c.count} 条评估
                  </Typography>
                </Stack>
              </Box>
            ))}
          </Stack>
        </Box>
      </Box>
    </Box>
  )
}
