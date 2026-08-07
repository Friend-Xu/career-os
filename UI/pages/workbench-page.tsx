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
import RefreshIcon from '@mui/icons-material/Refresh'
import dayjs from 'dayjs'
import { useState } from 'react'
import { useAppStore } from '../store/app-store'
import { computePoolStats } from '../store/engine-client'
import { DecisionAggregateDialog } from '../components/decision-aggregate-dialog'
import { DecisionEditDialog } from '../components/decision-edit-dialog'
import { DirectionsView } from '../components/workbench/directions-view'
import { CitiesView } from '../components/workbench/cities-view'
import { DecisionsView } from '../components/workbench/decisions-view'
import { belongsToPerson } from '../utils/ownership'
import { ProfileView } from '../components/workbench/profile-view'
import { POOL_HEALTH } from '../data/mock-data'
import { alpha, COLORS, EASE, RISK_COLOR, RISK_LABEL } from '../data/constants'
import type { MainWidthMode, NavPageId, RiskLevel } from '../types'
import type { DecisionAggregate } from '../../engine/ir/schema.ts'
import type { DecisionView } from '../store/engine-client'

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

/** 初始化 Banner：Person 生命周期状态（initStatus=pending）——初始化空间入口，非独立模块 */
function InitializationBanner() {
  const startInitializationSession = useAppStore((s) => s.startInitializationSession)
  const person = useAppStore((s) => s.currentPerson())
  if (person.initStatus !== 'pending') return null

  const resumeChannel = person.sourceMode === 'resume'

  return (
    <Box
      sx={{
        px: 2,
        py: 1.5,
        mb: 2,
        borderRadius: '10px',
        border: `1.5px solid ${COLORS.accent}`,
        bgcolor: alpha(COLORS.accent, 0.06),
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Box>
          <Typography sx={{ fontSize: 11.5, fontWeight: 600, color: COLORS.accent, letterSpacing: '0.06em', mb: 0.75 }}>
            INITIALIZING · 「{person.name}」正在建立职业档案（{resumeChannel ? '简历通道' : '访谈通道'}）
          </Typography>
          <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, lineHeight: 1.6 }}>
            正在了解你的经历 · AI 只提取候选事实，你确认后才会写入档案
            {person.initialInterest && person.initialInterest.length > 0 && (
              <>
                {' '}
                · 关注方向（自报意向）：{person.initialInterest.join('、')}
              </>
            )}
          </Typography>
        </Box>
        <Button
          size="small"
          variant="contained"
          onClick={() =>
            startInitializationSession({
              personName: person.name,
              sourceMode: person.sourceMode ?? 'interview',
              interests: person.initialInterest,
            })
          }
          sx={{ flexShrink: 0, ml: 2, fontSize: 12.5 }}
        >
          继续采集 →
        </Button>
      </Stack>
    </Box>
  )
}

/** Today 视图：你现在需要关注什么——待处理（Next Action Resolver 规则派生）+ KPI 概览 */
function TodaySection() {
  const setPage = useAppStore((s) => s.setPage)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)
  const startAgentTask = useAppStore((s) => s.startAgentTask)
  const decisions = useAppStore((s) => s.decisions)
  const jobs = useAppStore((s) => s.jobs)
  const applications = useAppStore((s) => s.applications)
  const companies = useAppStore((s) => s.companies)
  const person = useAppStore((s) => s.currentPerson())

  const personApps = applications.filter((a) => a.personId === person.id)
  const personDecisions = decisions.filter((d) => belongsToPerson(d, person))

  const latestDirection =
    personDecisions.length > 0
      ? [...personDecisions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0].direction
      : undefined

  // Next Action Resolver（规则派生：系统告诉用户什么重要，Agent 帮助深入）
  // 方向探索：档案可用（非初始化中；undefined = 存量档案默认可用）但尚未产出方向决策 → 第一个推理引导
  const actions: { label: string; page: NavPageId; jobId?: string; prompt?: string }[] = []
  if (latestDirection === undefined && person.initStatus !== 'pending') {
    actions.push({
      label: '探索职业方向',
      page: 'agent',
      prompt: `请基于「${person.name}」的职业档案，探索适合的发展方向：结合经历、技能与自报意向，给出 2-3 个候选方向及理由。`,
    })
  }
  // 已分析判定：该公司的 jd-analysis 决策（公司名匹配，title 匹配过宽会误判）
  const toAnalyze = jobs.filter(
    (j) => !personDecisions.some((d) => d.skill === 'jd-analysis' && d.title.includes(j.company)),
  )
  if (toAnalyze.length > 0) actions.push({ label: `${toAnalyze.length} 个 JD 等待分析`, page: 'jobs', jobId: toAnalyze[0].id })
  const toFollow = personApps.filter((a) => a.urgency === 'urgent' || a.urgency === 'overdue')
  if (toFollow.length > 0) actions.push({ label: `${toFollow.length} 个投递待跟进`, page: 'applications' })
  const toApply = personApps.filter((a) => a.status === '已评估')
  if (toApply.length > 0) actions.push({ label: `${toApply.length} 个岗位待投递`, page: 'applications' })

  const kpis = [
    { label: '方向', value: latestDirection ?? '未探索' },
    { label: '公司', value: `${companies.length} 家` },
    { label: 'JD', value: `${jobs.length} 个` },    { label: '投递', value: `${personApps.length} 条` },
    { label: '决策', value: `${personDecisions.length} 条` },
  ]

  return (
    <Box sx={{ mb: 3 }}>
      {/* 待处理 */}
      {actions.length > 0 && (
        <Box
          sx={{
            px: 2,
            py: 1.5,
            mb: 2,
            borderRadius: '10px',
            border: `1.5px solid ${COLORS.accent}`,
            bgcolor: alpha(COLORS.accent, 0.06),
          }}
        >
          <Typography sx={{ fontSize: 11.5, fontWeight: 600, color: COLORS.accent, letterSpacing: '0.06em', mb: 1 }}>
            TODAY · 需要处理
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 0.75 }}>
            {actions.map((a) => (
              <Button
                key={a.label}
                size="small"
                variant="outlined"
                onClick={() => {
                  if (a.prompt) {
                    // 任务启动：新 Session + 立即执行（按钮即意图），转 Agent 页可见运行状态
                    setPage(a.page)
                    startAgentTask(a.prompt, { type: 'career-direction', title: '探索职业方向' })
                    return
                  }
                  if (a.jobId) setSelectedJobId(a.jobId)
                  setPage(a.page)
                }}
                sx={{ fontSize: 12.5, color: COLORS.accent, borderColor: alpha(COLORS.accent, 0.4) }}
              >
                {a.label} →
              </Button>
            ))}
          </Stack>
        </Box>
      )}

      {/* KPI 概览（3 秒规则：最重要的状态一眼可见） */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: 1.25,
        }}
      >
        {kpis.map((k) => (
          <Box
            key={k.label}
            sx={{
              p: 1.5,
              borderRadius: '10px',
              border: `1px solid ${alpha(COLORS.border, 0.8)}`,
              boxShadow: COLORS.cardShadow,
              bgcolor: COLORS.bgElevated,
            }}
          >
            <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mb: 0.5 }}>{k.label}</Typography>
            <Typography
              sx={{
                fontSize: 15,
                fontWeight: 600,
                color: COLORS.text,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {k.value}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function DecisionTimeline() {
  const startAgentTask = useAppStore((s) => s.startAgentTask)
  const decisions = useAppStore((s) => s.decisions)
  const contexts = useAppStore((s) => s.contexts)
  const person = useAppStore((s) => s.currentPerson())
  const [selectedAggregate, setSelectedAggregate] = useState<DecisionAggregate | null>(null)
  const [editing, setEditing] = useState<DecisionView | null>(null)
  const personDecisions = decisions.filter((d) => belongsToPerson(d, person))
  const items = personDecisions

  /** 时间线条目 → 编辑抽屉：在 contexts 中找该决策的问题绑定（有则展示聚合摘要 + 完整聚合入口） */
  const findAggregate = (decisionId: string): DecisionAggregate | undefined =>
    contexts.find((a) => a.records.some((r) => r.id === decisionId))

  return (
    <Box
      sx={{
        p: 2,
        borderRadius: '10px',
        border: `1px solid ${alpha(COLORS.border, 0.8)}`,
        boxShadow: COLORS.cardShadow,
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
          <Stack spacing={0} sx={{ flex: 1, overflow: 'auto', pr: 0.5, mr: -0.5 }}>
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
              px: 0.5,
              mx: -0.5,
              borderRadius: '8px',
              transition: `background-color 180ms ${EASE}`,
              '&:hover': { bgcolor: alpha(COLORS.bgHover, 0.6) },
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
                  // 注意：MUI 将 0-1 数字视为百分比（width: 1 = 100%），竖线必须显式 px 单位
                  width: '1px',
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
            <Box
              sx={{ minWidth: 0, flex: 1, cursor: 'pointer', borderRadius: '8px', px: 0.5, mx: -0.5 }}
              onClick={() => setEditing(d)}
            >
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
                      onClick={(e) => {
                        e.stopPropagation()
                        startAgentTask(
                          `请重新评估「${d.title}」：结合最新画像与市场信息，更新匹配度与风险`,
                          { type: 'decision-reassessment', title: '重新评估' },
                        )
                      }}
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
                {d.payload?.type === 'city' && d.payload.cities.length > 0
                  ? ` · ${d.payload.cities.map((c) => `${c.name} ${Math.round((c.score / 10) * 100) / 100}`).join(' / ')}`
                  : d.payload?.type === 'direction' && d.payload.directions.length > 0
                    ? ` · ${d.payload.directions.map((x) => `${x.name} ${x.match}%`).join(' / ')}`
                    : d.directionMatch > 0 && ` · 匹配 ${d.directionMatch}%`}
                {` · 风险${RISK_LABEL[d.riskLevel]}`}
              </Typography>
            </Box>
          </Stack>
          )
        })}
      </Stack>
        </>
      )}
      <DecisionAggregateDialog
        open={Boolean(selectedAggregate)}
        aggregate={selectedAggregate}
        onClose={() => setSelectedAggregate(null)}
      />
      <DecisionEditDialog
        decision={editing}
        aggregate={editing ? (findAggregate(editing.id) ?? null) : null}
        onClose={() => setEditing(null)}
        onOpenAggregate={() => {
          const agg = editing ? findAggregate(editing.id) : undefined
          if (agg) {
            setSelectedAggregate(agg)
            setEditing(null)
          }
        }}
      />
    </Box>
  )
}

function PoolHealthCard() {
  const setPage = useAppStore((s) => s.setPage)
  const poolGraph = useAppStore((s) => s.poolGraph)
  const health = useAppStore((s) => s.health)
  const engineStatus = useAppStore((s) => s.engineStatus)

  // 健康投影（契约 v1）：引擎 health RPC 为唯一计算源；offline/未达 → 回退图谱本地估算 → mock
  const h = (() => {
    if (health) {
      const graphDim = health.dimensions.find((d) => d.name === 'graph')
      return {
        healthPercent: health.overallScore,
        totalNodes: poolGraph?.nodes.length ?? 0,
        isolatedNodes: graphDim?.issues.find((i) => i.message.includes('孤立'))?.count ?? 0,
        missingFields: 0,
      }
    }
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
        border: `1px solid ${alpha(COLORS.border, 0.8)}`,
        boxShadow: COLORS.cardShadow,
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

export function WorkbenchPage() {
  const mode = useAppStore((s) => s.mainWidthMode)
  const view = useAppStore((s) => s.workbenchView)

  const maxW = mode === 'narrow' ? 810 : mode === 'wide' ? 1160 : '100%'

  // 子视图界面（画像/方向/城市/决策记录）：非弹窗，主区整页渲染
  if (view !== 'dashboard') {
    return (
      <Box sx={{ flex: 1, overflow: 'auto' }}>
        {view === 'profile' && <ProfileView />}
        {view === 'directions' && <DirectionsView />}
        {view === 'cities' && <CitiesView />}
        {view === 'decisions' && <DecisionsView />}
      </Box>
    )
  }

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

        <Box sx={{ mb: 3 }}>
          <InitializationBanner />
          <TodaySection />
        </Box>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: '1fr 280px',
            gap: 2,
            minHeight: 200,
          }}
        >
          <DecisionTimeline />
          <PoolHealthCard />
        </Box>
      </Box>
    </Box>
  )
}
