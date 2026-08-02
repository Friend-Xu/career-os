import {
  Box,
  Button,
  IconButton,
  Stack,
  Tooltip,
  Typography,
  LinearProgress,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import RefreshIcon from '@mui/icons-material/Refresh'
import dayjs from 'dayjs'
import { useAppStore } from '../store/app-store'
import { computePoolStats } from '../store/engine-client'
import {
  APPLICATION_STATS,
  NEXT_ACTION,
  POOL_HEALTH,
} from '../data/mock-data'
import { alpha, COLORS, EASE, RISK_COLOR, RISK_LABEL } from '../data/constants'
import type { MainWidthMode, RiskLevel } from '../types'

function ModeSwitcher() {
  const mode = useAppStore((s) => s.mainWidthMode)
  const setMode = useAppStore((s) => s.setMainWidthMode)

  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={mode}
      onChange={(_, v: MainWidthMode | null) => v && setMode(v)}
      sx={{
        '& .MuiToggleButton-root': {
          px: 1,
          py: 0.25,
          fontSize: 11.5,
          color: COLORS.textMuted,
          borderColor: COLORS.border,
          '&.Mui-selected': {
            color: COLORS.accent,
            bgcolor: COLORS.accentMuted,
          },
        },
      }}
    >
      <ToggleButton value="narrow">窄</ToggleButton>
      <ToggleButton value="wide">宽</ToggleButton>
      <ToggleButton value="fullscreen">全屏</ToggleButton>
    </ToggleButtonGroup>
  )
}

function StageBanner() {
  const person = useAppStore((s) => s.currentPerson())
  const personStages = useAppStore((s) => s.personStages[person.id])
  const current = (personStages ?? []).find((s) => s.status === 'current')
  return (
    <Box sx={{ py: 1.5, px: 0.5 }}>
      <Typography
        sx={{
          fontSize: 13,
          color: COLORS.textMuted,
          fontWeight: 400,
          letterSpacing: '0.01em',
        }}
      >
        当前阶段 · {current?.label ?? '未开始'}
        {current?.city && (
          <Typography component="span" sx={{ fontSize: 13, color: COLORS.textSecondary }}>
            {' '}
            · 基于 深圳 86 分 / 技能画像 / 薪资约束
          </Typography>
        )}
      </Typography>
    </Box>
  )
}

function NextActionCard() {
  const startAnalysis = useAppStore((s) => s.startAnalysis)

  return (
    <Box
      sx={{
        p: 2.5,
        borderRadius: '10px',
        border: `1.5px solid ${COLORS.accent}`,
        bgcolor: alpha(COLORS.accent, 0.06),
        animation: `fade-in 0.3s ${EASE}`,
      }}
    >
      <Typography
        sx={{
          fontSize: 11.5,
          fontWeight: 600,
          color: COLORS.accent,
          letterSpacing: '0.06em',
          mb: 1,
        }}
      >
        NEXT ACTION
      </Typography>
      <Typography sx={{ fontSize: 18, fontWeight: 600, mb: 1, letterSpacing: '-0.01em' }}>
        AI 推荐下一步：{NEXT_ACTION.title}
      </Typography>

      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', mb: 1.5, flexWrap: 'wrap', gap: 0.5 }}
      >
        <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>已完成:</Typography>
        {NEXT_ACTION.completedStages.map((s) => (
          <Stack key={s} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <CheckCircleIcon sx={{ fontSize: 13, color: COLORS.riskLow }} />
            <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>{s}</Typography>
          </Stack>
        ))}
      </Stack>

      <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, mb: 0.75 }}>
        AI 建议优先:
      </Typography>
      <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', gap: 0.75 }}>
        {NEXT_ACTION.priorities.map((p, i) => (
          <Box
            key={p}
            sx={{
              px: 1.25,
              py: 0.5,
              borderRadius: '6px',
              bgcolor: COLORS.bgHover,
              border: `1px solid ${COLORS.border}`,
              fontSize: 13,
            }}
          >
            <Typography component="span" sx={{ color: COLORS.accent, fontWeight: 600, mr: 0.5 }}>
              {i + 1}
            </Typography>
            {p}
          </Box>
        ))}
      </Stack>

      <Button
        variant="contained"
        endIcon={<ArrowForwardIcon />}
        onClick={() => startAnalysis(NEXT_ACTION.prompt)}
        sx={{
          bgcolor: COLORS.accent,
          color: COLORS.onAccent,
          fontWeight: 600,
          fontSize: 13,
          px: 2.5,
          py: 1,
          '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 },
        }}
      >
        开始分析
      </Button>
    </Box>
  )
}

function DecisionTimeline() {
  const setPage = useAppStore((s) => s.setPage)
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const decisions = useAppStore((s) => s.decisions)
  const person = useAppStore((s) => s.currentPerson())
  const personDecisions = decisions.filter((d) => d.profile === person.name)
  const items = personDecisions.slice(0, 3)

  return (
    <Box
      sx={{
        p: 2,
        borderRadius: '10px',
        border: `1px solid ${COLORS.border}`,
        bgcolor: COLORS.bgElevated,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 1.5, color: COLORS.textSecondary }}>
        决策时间线
      </Typography>
      {items.length === 0 ? (
        <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
          <Typography
            sx={{ fontSize: 12.5, color: COLORS.textMuted, textAlign: 'center', lineHeight: 1.6 }}
          >
            「{person.name}」尚无决策记录
            <br />
            从 AI 面板发起首个分析
          </Typography>
        </Box>
      ) : (
        <>
          <Stack spacing={0} sx={{ flex: 1 }}>
        {items.map((d, idx) => {
          // IR 降级消费：degraded → 标题旁黄点（Tooltip 显示 reason）；invalid → 红点 + 待人工处理标注
          const v = d.validation
          const vStatus = v?.status
          const vColor =
            vStatus === 'invalid' ? RISK_COLOR.high : vStatus === 'degraded' ? RISK_COLOR.medium : null
          const vReasons = v?.issues.map((i) => i.reason).join('；') ?? ''
          return (
          <Stack
            key={d.id}
            direction="row"
            spacing={1.5}
            sx={{
              position: 'relative',
              pb: idx < items.length - 1 ? 2 : 0,
              '&:hover .re-eval-btn': { opacity: 1 },
              '&:focus-within .re-eval-btn': { opacity: 1 },
            }}
          >
            {idx < items.length - 1 && (
              <Box
                sx={{
                  position: 'absolute',
                  left: 5,
                  top: 14,
                  bottom: 0,
                  width: 1,
                  bgcolor: COLORS.border,
                }}
              />
            )}
            <Box
              sx={{
                width: 11,
                height: 11,
                borderRadius: '50%',
                bgcolor: vColor ?? RISK_COLOR[d.riskLevel as RiskLevel],
                mt: 0.4,
                flexShrink: 0,
                zIndex: 1,
              }}
            />
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Stack
                direction="row"
                sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}
              >
                <Typography sx={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0 }} noWrap>
                  {d.title}
                </Typography>
                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexShrink: 0, ml: 1 }}>
                  {vStatus === 'invalid' && (
                    <Typography sx={{ fontSize: 11, color: RISK_COLOR.high, flexShrink: 0 }}>
                      待人工处理
                    </Typography>
                  )}
                  {vColor && (
                    <Tooltip
                      title={
                        vStatus === 'invalid'
                          ? `待人工处理：${vReasons}`
                          : vReasons || '数据降级（值域修正后保留）'
                      }
                    >
                      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: vColor }} />
                    </Tooltip>
                  )}
                  <Tooltip title="重新评估（唤起 AI 面板）">
                    <IconButton
                      size="small"
                      className="re-eval-btn"
                      onClick={() =>
                        startAnalysis(
                          `请重新评估「${d.title}」：结合最新画像与市场信息，更新匹配度与风险`,
                        )
                      }
                      sx={{
                        opacity: 0,
                        transition: `opacity 0.15s ${EASE}`,
                        p: 0.25,
                        color: COLORS.textMuted,
                        '&:hover': { color: COLORS.accent },
                        '&:focus-visible': { opacity: 1 },
                      }}
                    >
                      <RefreshIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>
                  <Typography
                    sx={{
                      fontSize: 11.5,
                      color: COLORS.textMuted,
                      fontFamily: COLORS.mono,
                    }}
                  >
                    {dayjs(d.createdAt).format('MM-DD')}
                  </Typography>
                </Stack>
              </Stack>
              <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, mt: 0.25 }} noWrap>
                {d.keyRisk}
                {d.directionMatch > 0 && ` · 匹配 ${d.directionMatch}%`}
                {` · 风险${RISK_LABEL[d.riskLevel]}`}
              </Typography>
            </Box>
          </Stack>
          )
        })}
      </Stack>
      {personDecisions.length > 3 && (
        <Button
          size="small"
          onClick={() => setPage('agent')}
          sx={{ mt: 1, alignSelf: 'flex-start', fontSize: 12, color: COLORS.accent }}
        >
          + 查看全部 →
        </Button>
      )}
        </>
      )}
    </Box>
  )
}

function PoolHealthCard() {
  const setPage = useAppStore((s) => s.setPage)
  const poolGraph = useAppStore((s) => s.poolGraph)
  const engineStatus = useAppStore((s) => s.engineStatus)

  // connected：从引擎图谱真实计算（健康 = 1 - 孤立/总数）；offline：mock 静态值
  const h = (() => {
    if (poolGraph && engineStatus === 'connected' && poolGraph.nodes.length > 0) {
      const stats = computePoolStats(poolGraph)
      return {
        healthPercent: Math.round((1 - stats.isolated / stats.total) * 100),
        totalNodes: stats.total,
        isolatedNodes: stats.isolated,
        missingFields: stats.missing,
      }
    }
    return POOL_HEALTH
  })()

  return (
    <Box
      sx={{
        p: 2,
        borderRadius: '10px',
        border: `1px solid ${COLORS.border}`,
        bgcolor: COLORS.bgElevated,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 1.5, color: COLORS.textSecondary }}>
        信息池健康
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', mb: 1 }}>
        <Typography
          sx={{
            fontSize: 28,
            fontWeight: 600,
            fontFamily: COLORS.mono,
            color: COLORS.riskLow,
            lineHeight: 1,
          }}
        >
          {h.healthPercent}%
        </Typography>
      </Stack>
      <LinearProgress
        variant="determinate"
        value={h.healthPercent}
        sx={{
          mb: 1.5,
          height: 6,
          borderRadius: 3,
          bgcolor: COLORS.bgHover,
          '& .MuiLinearProgress-bar': { bgcolor: COLORS.riskLow, borderRadius: 3 },
        }}
      />
      <Stack spacing={0.5} sx={{ flex: 1 }}>
        <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>
          <Box component="span" sx={{ fontFamily: COLORS.mono, color: COLORS.text }}>
            {h.totalNodes}
          </Box>{' '}
          节点
        </Typography>
        <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>
          <Box component="span" sx={{ fontFamily: COLORS.mono, color: COLORS.riskMedium }}>
            {h.isolatedNodes}
          </Box>{' '}
          孤立
        </Typography>
        <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>
          <Box component="span" sx={{ fontFamily: COLORS.mono, color: COLORS.riskHigh }}>
            {h.missingFields}
          </Box>{' '}
          字段缺失
        </Typography>
      </Stack>
      <Button
        size="small"
        onClick={() => setPage('infopool')}
        sx={{ mt: 1, alignSelf: 'flex-start', fontSize: 12, color: COLORS.accent }}
      >
        查看信息池 →
      </Button>
    </Box>
  )
}

function ApplicationStatusRow() {
  const setPage = useAppStore((s) => s.setPage)
  const s = APPLICATION_STATS

  return (
    <Box
      sx={{
        p: 2,
        borderRadius: '10px',
        border: `1px solid ${COLORS.border}`,
        bgcolor: COLORS.bgElevated,
      }}
    >
      <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 1, color: COLORS.textSecondary }}>
        投递执行状态
      </Typography>
      <Typography sx={{ fontSize: 13, mb: 0.75 }}>
        状态:{' '}
        <Box component="span" sx={{ color: COLORS.accent }}>
          面试中 {s.interviewing}
        </Box>
        {' · '}已投递 {s.applied}
        {' · '}已联系 {s.contacted}
        {' · '}目标公司 {s.totalTargetCompanies}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <WarningAmberIcon sx={{ fontSize: 14, color: COLORS.riskMedium }} />
        <Typography sx={{ fontSize: 13, color: COLORS.textSecondary, flex: 1 }}>
          节奏: 待跟进 {s.pendingFollowups} · 腾讯机器人岗位 3 天未跟进
        </Typography>
        <Button
          size="small"
          onClick={() => setPage('applications')}
          sx={{ fontSize: 12, color: COLORS.accent, minWidth: 0 }}
        >
          跟进 →
        </Button>
      </Stack>
    </Box>
  )
}

export function WorkbenchPage() {
  const mode = useAppStore((s) => s.mainWidthMode)

  const maxW = mode === 'narrow' ? 810 : mode === 'wide' ? 1160 : '100%'

  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: mode === 'fullscreen' ? 'stretch' : 'center',
        overflow: 'auto',
        p: 3,
      }}
    >
      <Box sx={{ width: '100%', maxWidth: maxW }}>
        <Stack
          direction="row"
          sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}
        >
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
            工作台 · 职业决策控制台
          </Typography>
          <ModeSwitcher />
        </Stack>

        <StageBanner />

        <Box sx={{ mb: 3 }}>
          <NextActionCard />
        </Box>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: '1fr 280px',
            gap: 2,
            mb: 3,
            minHeight: 200,
          }}
        >
          <DecisionTimeline />
          <PoolHealthCard />
        </Box>

        <ApplicationStatusRow />
      </Box>
    </Box>
  )
}
