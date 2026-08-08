import {
  Box,
  Button,
  Chip,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material'
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined'
import ViewKanbanIcon from '@mui/icons-material/ViewKanban'
import ViewListIcon from '@mui/icons-material/ViewList'
import { useMemo, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, EASE } from '../data/constants'
import type { Application, ApplicationStatus } from '../types'

/**
 * 投递管理（ADR-019 Step 4：Application = 用户行动事实，Engine Registry 唯一事实源）。
 * - 8 列看板 = 生命周期投影（PREPARING→READY→SUBMITTED→COMMUNICATING→INTERVIEWING→OFFERED，
 *   REJECTED/WITHDRAWN 终态），无「已评估」列（建档占位已废弃）
 * - 卡片岗位信息从 jobId 解析活数据；Job 删除后 displayFallback 展示「岗位已失效」
 * - 创建入口在 Decision 页（「开始投递流程」），此处只管理状态推进
 */

const COLUMNS: { status: ApplicationStatus; label: string }[] = [
  { status: 'PREPARING', label: '准备投递' },
  { status: 'READY', label: '待提交' },
  { status: 'SUBMITTED', label: '已投递' },
  { status: 'COMMUNICATING', label: '沟通中' },
  { status: 'INTERVIEWING', label: '面试中' },
  { status: 'OFFERED', label: 'Offer' },
  { status: 'REJECTED', label: '已拒绝' },
  { status: 'WITHDRAWN', label: '已撤回' },
]

const STATUS_LABEL: Record<ApplicationStatus, string> = Object.fromEntries(
  COLUMNS.map((c) => [c.status, c.label]),
) as Record<ApplicationStatus, string>

/** 状态色（UI 投影——不解释，仅语义色区分） */
const STATUS_COLOR: Record<ApplicationStatus, string> = {
  PREPARING: COLORS.textSecondary,
  READY: COLORS.accent,
  SUBMITTED: COLORS.accent,
  COMMUNICATING: COLORS.riskLow,
  INTERVIEWING: COLORS.riskLow,
  OFFERED: COLORS.riskLow,
  REJECTED: COLORS.riskHigh,
  WITHDRAWN: COLORS.textMuted,
}

/** 投递卡片：岗位（jobId 解析活数据）/ 状态推进 / 提交时间。
 * - 岗位信息只引用不复制：job 活着显示活数据，Job 删除后 displayFallback（「岗位已失效」）
 * - 仅 PREPARING 可删除（撤销误操作）——行动历史不可删除，其余推进 WITHDRAWN
 */
function KanbanCard({ app }: { app: Application }) {
  const update = useAppStore((s) => s.updateApplicationStatus)
  const deleteApp = useAppStore((s) => s.deleteApplication)
  const push = useToastStore((s) => s.push)
  const jobs = useAppStore((s) => s.jobs)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)
  const setPage = useAppStore((s) => s.setPage)

  const job = app.jobId ? jobs.find((j) => j.id === app.jobId) : undefined
  // 岗位唯一事实源 = Job；Job 删除后 displayFallback（历史展示）
  const company = job?.company ?? app.displayFallback?.company ?? ''
  const position = job?.title ?? app.displayFallback?.position ?? ''

  const changeStatus = async (status: ApplicationStatus) => {
    try {
      await update(app.id, status)
      push('info', `${company} → ${STATUS_LABEL[status]}`)
    } catch (err) {
      push('warning', `状态推进失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const openWorkspace = () => {
    if (!job) return
    setSelectedJobId(job.id)
    setPage('jobs')
  }

  const handleDelete = () => {
    if (!window.confirm(`删除投递记录「${company} · ${position}」？仅准备中记录可删除，不可恢复。`)) return
    void deleteApp(app.id).then(
      () => push('info', `已删除投递：${company} · ${position}`),
      (err) => push('warning', `删除失败：${err instanceof Error ? err.message : String(err)}`),
    )
  }

  return (
    <Box
      onClick={openWorkspace}
      sx={{
        p: 1.5,
        borderRadius: '8px',
        bgcolor: COLORS.bg,
        border: `1px solid ${alpha(COLORS.border, 0.8)}`,
        boxShadow: COLORS.cardShadow,
        mb: 1,
        cursor: job ? 'pointer' : 'default',
        transition: `background-color 180ms ${EASE}, border-color 180ms ${EASE}`,
        '&:hover': { borderColor: job ? COLORS.borderStrong : COLORS.border, bgcolor: job ? COLORS.bgHover : COLORS.bg },
      }}
    >
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start', mb: 0.5 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1, lineHeight: 1.35 }}>
          {company || '（无岗位信息）'}
        </Typography>
        {app.status === 'PREPARING' ? (
          <Tooltip title="删除投递记录（仅准备中可删除）">
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation()
                handleDelete()
              }}
              sx={{ p: 0.25, color: COLORS.textMuted, '&:hover': { color: COLORS.riskHigh } }}
            >
              <DeleteOutlinedIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        ) : (
          <Box sx={{ width: 24 }} />
        )}
      </Stack>
      <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, mb: 0.5 }} noWrap>
        {position || '—'}
      </Typography>
      {app.submittedAt && (
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 0.5, fontFamily: COLORS.mono }}>
          提交于 {app.submittedAt.slice(0, 10)}
        </Typography>
      )}
      <Chip
        size="small"
        label={STATUS_LABEL[app.status]}
        sx={{
          height: 18,
          fontSize: 11.5,
          bgcolor: alpha(STATUS_COLOR[app.status], 0.1),
          color: STATUS_COLOR[app.status],
          border: `1px solid ${alpha(STATUS_COLOR[app.status], 0.2)}`,
          mb: 0.5,
        }}
      />
      {/* 引用信息行（紧凑文本，非 chip——150px 卡片内多个 chip 必然拥挤） */}
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minHeight: 16 }}>
        {job ? (
          <Typography sx={{ fontSize: 11, color: COLORS.riskLow, flexShrink: 0 }}>JD ✓</Typography>
        ) : (
          <Typography sx={{ fontSize: 11, color: COLORS.textMuted, flexShrink: 0 }} noWrap>
            岗位已失效
          </Typography>
        )}
        {app.decisionId && (
          <>
            <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>·</Typography>
            <Typography sx={{ fontSize: 11, color: COLORS.textSecondary, flexShrink: 0 }} noWrap>
              决策 ✓
            </Typography>
          </>
        )}
        {job && (
          <Typography sx={{ fontSize: 11, color: COLORS.accent, ml: 'auto', flexShrink: 0 }}>
            工作区 →
          </Typography>
        )}
      </Stack>

      <Select
        size="small"
        value={app.status}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => void changeStatus(e.target.value as ApplicationStatus)}
        sx={{
          mt: 1,
          width: '100%',
          fontSize: 12,
          height: 26,
          color: COLORS.textSecondary,
          '& .MuiOutlinedInput-notchedOutline': { borderColor: COLORS.border },
          '& .MuiSelect-select': { py: 0.25, px: 1 },
        }}
      >
        {COLUMNS.map((c) => (
          <MenuItem key={c.status} value={c.status} sx={{ fontSize: 12 }}>
            {c.label}
          </MenuItem>
        ))}
      </Select>
    </Box>
  )
}

export function ApplicationsPage() {
  const [tab, setTab] = useState(0)
  const applications = useAppStore((s) => s.applications)
  const applicationsFilter = useAppStore((s) => s.applicationsFilter)
  const person = useAppStore((s) => s.currentPerson())
  const setPage = useAppStore((s) => s.setPage)

  const personId = person.personId ?? ''
  const personApps = applications.filter((a) => a.personId === personId)

  const filtered =
    applicationsFilter === '全部'
      ? personApps
      : personApps.filter((a) => a.status === applicationsFilter)

  const byStatus = useMemo(() => {
    const map: Record<string, Application[]> = {}
    COLUMNS.forEach((c) => {
      map[c.status] = []
    })
    filtered.forEach((a) => {
      (map[a.status] ??= []).push(a)
    })
    return map
  }, [filtered])

  // 空态：无投递 → 引导从决策发起（投递入口在 Decision 页，此处只管理状态）
  if (personApps.length === 0) {
    return (
      <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', p: 3 }}>
        <Stack spacing={1.5} sx={{ alignItems: 'center', textAlign: 'center', maxWidth: 320 }}>
          <Typography sx={{ fontSize: 14, fontWeight: 600 }}>投递还是空的</Typography>
          <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted, lineHeight: 1.7 }}>
            完成岗位分析与决策后，
            <br />
            在决策记录中发起「开始投递流程」，
            <br />
            行动记录在这里推进
          </Typography>
          <Button
            size="small"
            variant="contained"
            onClick={() => setPage('workbench')}
            sx={{ fontSize: 12.5, bgcolor: COLORS.accent, color: COLORS.onAccent, '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 } }}
          >
            去看决策 →
          </Button>
        </Stack>
      </Box>
    )
  }

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', p: 2, gap: 1.5, overflow: 'hidden' }}>
      <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1.5}>
        <Typography sx={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>投递管理</Typography>
        <Chip size="small" label={`${personApps.length} 条`} sx={{ height: 22, fontSize: 12 }} />
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
          行动记录由决策发起 · 状态由你推进
        </Typography>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 30 }}>
          <Tab icon={<ViewKanbanIcon sx={{ fontSize: 16 }} />} iconPosition="start" label="看板" sx={{ minHeight: 30 }} />
          <Tab icon={<ViewListIcon sx={{ fontSize: 16 }} />} iconPosition="start" label="列表" sx={{ minHeight: 30 }} />
        </Tabs>
      </Stack>

      {/* 状态过滤在侧栏（ApplicationsSidebar）——此处只消费过滤结果 */}

      {tab === 0 ? (
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            gap: 1.25,
            overflow: 'auto',
            minHeight: 0,
          }}
        >
          {COLUMNS.map((col) => (
            <Box
              key={col.status}
              sx={{
                minWidth: 150,
                width: 150,
                flex: '0 0 150px',
                display: 'flex',
                flexDirection: 'column',
                bgcolor: COLORS.bgElevated,
                borderRadius: '10px',
                border: `1px solid ${alpha(COLORS.border, 0.8)}`,
                boxShadow: COLORS.cardShadow,
                overflow: 'hidden',
              }}
            >
              <Stack
                direction="row"
                sx={{
                  alignItems: 'center',
                  px: 1.25,
                  py: 1,
                  borderBottom: `1px solid ${COLORS.border}`,
                }}
              >
                <Typography sx={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{col.label}</Typography>
                <Typography
                  sx={{
                    fontSize: 12,
                    fontFamily: COLORS.mono,
                    color: COLORS.textMuted,
                    bgcolor: COLORS.bgHover,
                    px: 0.75,
                    borderRadius: '4px',
                  }}
                >
                  {byStatus[col.status]?.length ?? 0}
                </Typography>
              </Stack>
              <Box sx={{ flex: 1, overflow: 'auto', p: 1 }}>
                {(byStatus[col.status] ?? []).map((app) => (
                  <KanbanCard key={app.id} app={app} />
                ))}
              </Box>
            </Box>
          ))}
        </Box>
      ) : (
        <Box
          sx={{
            flex: 1,
            overflow: 'auto',
            borderRadius: '10px',
            border: `1px solid ${alpha(COLORS.border, 0.8)}`,
            boxShadow: COLORS.cardShadow,
            bgcolor: COLORS.bgElevated,
          }}
        >
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: '1.2fr 1.4fr 0.8fr 0.9fr 0.9fr',
              px: 2,
              py: 1,
              borderBottom: `1px solid ${COLORS.border}`,
              position: 'sticky',
              top: 0,
              bgcolor: COLORS.bgElevated,
            }}
          >
            {['公司', '岗位', '状态', '提交时间', '决策'].map((h) => (
              <Typography key={h} sx={{ fontSize: 12, color: COLORS.textMuted, fontWeight: 600 }}>
                {h}
              </Typography>
            ))}
          </Box>
          {filtered.map((a) => {
            const jobView = a.jobId ? useAppStore.getState().jobs.find((j) => j.id === a.jobId) : undefined
            return (
              <Box
                key={a.id}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '1.2fr 1.4fr 0.8fr 0.9fr 0.9fr',
                  px: 2,
                  py: 1.25,
                  borderBottom: `1px solid ${COLORS.border}`,
                  alignItems: 'center',
                  '&:hover': { bgcolor: COLORS.bgHover },
                }}
              >
                <Typography sx={{ fontSize: 13, fontWeight: 500 }}>
                  {jobView?.company ?? a.displayFallback?.company ?? a.jobId}
                </Typography>
                <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }} noWrap>
                  {jobView?.title ?? a.displayFallback?.position ?? '（岗位已失效）'}
                </Typography>
                <Select
                  size="small"
                  value={a.status}
                  onChange={(e) => {
                    const st = e.target.value as ApplicationStatus
                    void useAppStore.getState().updateApplicationStatus(a.id, st).catch((err) =>
                      useToastStore.getState().push('warning', `状态推进失败：${err instanceof Error ? err.message : String(err)}`),
                    )
                  }}
                  sx={{
                    fontSize: 12,
                    height: 26,
                    color: STATUS_COLOR[a.status],
                    '& .MuiOutlinedInput-notchedOutline': { borderColor: COLORS.border },
                    '& .MuiSelect-select': { py: 0.25 },
                  }}
                >
                  {COLUMNS.map((c) => (
                    <MenuItem key={c.status} value={c.status} sx={{ fontSize: 12 }}>
                      {c.label}
                    </MenuItem>
                  ))}
                </Select>
                <Typography sx={{ fontSize: 12, fontFamily: COLORS.mono, color: COLORS.textMuted }}>
                  {a.submittedAt?.slice(0, 10) ?? '—'}
                </Typography>
                <Typography sx={{ fontSize: 12, color: COLORS.textMuted }} noWrap>
                  {a.decisionId ?? '—'}
                </Typography>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}
