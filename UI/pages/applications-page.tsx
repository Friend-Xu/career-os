import {
  Box,
  Button,
  Chip,
  Stack,
  Tab,
  Tabs,
  Typography,
  MenuItem,
  Select,
} from '@mui/material'
import ViewKanbanIcon from '@mui/icons-material/ViewKanban'
import ViewListIcon from '@mui/icons-material/ViewList'
import { useMemo, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS } from '../data/constants'
import type { Application, ApplicationStatus, FollowupUrgency } from '../types'

const COLUMNS: ApplicationStatus[] = [
  '已评估',
  '已投递',
  '已联系',
  '已回复',
  '面试中',
  '已录取',
  '已拒绝',
]

const URGENCY_META: Record<
  FollowupUrgency,
  { label: string; color: string; icon: string }
> = {
  urgent: { label: '紧急', color: '#F07178', icon: '🔴' },
  overdue: { label: '逾期', color: '#E6B450', icon: '🟡' },
  waiting: { label: '等待中', color: '#59C2FF', icon: '🔵' },
  cooled: { label: '已冷却', color: '#5C6370', icon: '⚪' },
}

function KanbanCard({ app }: { app: Application }) {
  const update = useAppStore((s) => s.updateApplicationStatus)
  const push = useToastStore((s) => s.push)
  const u = URGENCY_META[app.urgency]

  const changeStatus = (status: ApplicationStatus) => {
    update(app.id, status)
    push('info', `${app.company} → ${status}`)
  }

  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: '8px',
        bgcolor: COLORS.bg,
        border: `1px solid ${COLORS.border}`,
        mb: 1,
        '&:hover': { borderColor: COLORS.borderStrong },
      }}
    >
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start', mb: 0.75 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1, lineHeight: 1.35 }}>
          {app.company}
        </Typography>
        <Typography sx={{ fontSize: 12 }} title={u.label}>
          {u.icon}
        </Typography>
      </Stack>
      <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, mb: 1 }} noWrap>
        {app.position}
      </Typography>
      {app.notes && (
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1 }} noWrap>
          {app.notes}
        </Typography>
      )}
      <Stack direction="row" sx={{ alignItems: 'center' }} spacing={0.5}>
        <Chip
          size="small"
          label={u.label}
          sx={{
            height: 18,
            fontSize: 11.5,
            bgcolor: alpha(u.color, 0.1),
            color: u.color,
            border: `1px solid ${alpha(u.color, 0.2)}`,
          }}
        />
        {app.followupDue && (
          <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, fontFamily: COLORS.mono }}>
            {app.followupDue.slice(5)}
          </Typography>
        )}
      </Stack>
      <Select
        size="small"
        value={app.status}
        onChange={(e) => changeStatus(e.target.value as ApplicationStatus)}
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
        {COLUMNS.map((s) => (
          <MenuItem key={s} value={s} sx={{ fontSize: 12 }}>
            {s}
          </MenuItem>
        ))}
      </Select>
    </Box>
  )
}

export function ApplicationsPage() {
  const [tab, setTab] = useState(0)
  const applications = useAppStore((s) => s.applications)
  const update = useAppStore((s) => s.updateApplicationStatus)
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const applicationsFilter = useAppStore((s) => s.applicationsFilter)
  const push = useToastStore((s) => s.push)

  const filtered =
    applicationsFilter === '全部'
      ? applications
      : applications.filter((a) => a.status === applicationsFilter)

  const byStatus = useMemo(() => {
    const map: Record<string, Application[]> = {}
    COLUMNS.forEach((c) => {
      map[c] = []
    })
    filtered.forEach((a) => {
      (map[a.status] ??= []).push(a)
    })
    return map
  }, [filtered])

  const urgent = applications.filter((a) => a.urgency === 'urgent' || a.urgency === 'overdue')

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', p: 2, gap: 1.5, overflow: 'hidden' }}>
      <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1.5}>
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>投递管理</Typography>
        <Chip size="small" label={`${applications.length} 条`} sx={{ height: 22, fontSize: 12 }} />
        {urgent.length > 0 && (
          <Chip
            size="small"
            label={`${urgent.length} 条待跟进`}
            sx={{
              height: 22,
              fontSize: 12,
              bgcolor: 'rgba(230,180,80,0.12)',
              color: COLORS.riskMedium,
              border: '1px solid rgba(230,180,80,0.25)',
            }}
          />
        )}
        <Box sx={{ flex: 1 }} />
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 30 }}>
          <Tab icon={<ViewKanbanIcon sx={{ fontSize: 16 }} />} iconPosition="start" label="看板" sx={{ minHeight: 30 }} />
          <Tab icon={<ViewListIcon sx={{ fontSize: 16 }} />} iconPosition="start" label="列表" sx={{ minHeight: 30 }} />
        </Tabs>
      </Stack>

      {/* AI follow-up suggestion strip */}
      {urgent[0] && (
        <Box
          sx={{
            px: 2,
            py: 1.25,
            borderRadius: '8px',
            bgcolor: COLORS.accentMuted,
            border: '1px solid rgba(144,129,228,0.2)',
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
          }}
        >
          <Typography sx={{ fontSize: 12, flex: 1 }}>
            <Box component="span" sx={{ color: COLORS.accent, fontWeight: 600 }}>
              AI 建议跟进 ·{' '}
            </Box>
            {urgent[0].company}「{urgent[0].position}」— 可发送礼貌催询，提及上次沟通要点
          </Typography>
          <Button
            size="small"
            variant="outlined"
            sx={{ fontSize: 12, flexShrink: 0 }}
            onClick={() => {
              startAnalysis(
                `请为「${urgent[0].company} · ${urgent[0].position}」生成投递跟进话术：礼貌催询，提及上次沟通要点，控制在 200 字内`,
              )
              push('info', '已预置「生成话术」上下文')
            }}
          >
            生成话术
          </Button>
        </Box>
      )}

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
              key={col}
              sx={{
                minWidth: 150,
                width: 150,
                flex: '0 0 150px',
                display: 'flex',
                flexDirection: 'column',
                bgcolor: COLORS.bgElevated,
                borderRadius: '10px',
                border: `1px solid ${COLORS.border}`,
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
                <Typography sx={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{col}</Typography>
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
                  {byStatus[col]?.length ?? 0}
                </Typography>
              </Stack>
              <Box sx={{ flex: 1, overflow: 'auto', p: 1 }}>
                {(byStatus[col] ?? []).map((app) => (
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
            border: `1px solid ${COLORS.border}`,
            bgcolor: COLORS.bgElevated,
          }}
        >
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: '1.2fr 1.4fr 0.8fr 0.7fr 0.7fr 1fr',
              px: 2,
              py: 1,
              borderBottom: `1px solid ${COLORS.border}`,
              position: 'sticky',
              top: 0,
              bgcolor: COLORS.bgElevated,
            }}
          >
            {['公司', '岗位', '状态', '紧急度', '跟进日', '备注'].map((h) => (
              <Typography key={h} sx={{ fontSize: 12, color: COLORS.textMuted, fontWeight: 600 }}>
                {h}
              </Typography>
            ))}
          </Box>
          {filtered.map((a) => {
            const u = URGENCY_META[a.urgency]
            return (
              <Box
                key={a.id}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '1.2fr 1.4fr 0.8fr 0.7fr 0.7fr 1fr',
                  px: 2,
                  py: 1.25,
                  borderBottom: `1px solid ${COLORS.border}`,
                  alignItems: 'center',
                  '&:hover': { bgcolor: COLORS.bgHover },
                }}
              >
                <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{a.company}</Typography>
                <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }} noWrap>
                  {a.position}
                </Typography>
                <Select
                  size="small"
                  value={a.status}
                  onChange={(e) => {
                    const st = e.target.value as ApplicationStatus
                    update(a.id, st)
                    push('info', `${a.company} → ${st}`)
                  }}
                  sx={{
                    fontSize: 12,
                    height: 26,
                    '& .MuiOutlinedInput-notchedOutline': { borderColor: COLORS.border },
                    '& .MuiSelect-select': { py: 0.25 },
                  }}
                >
                  {COLUMNS.map((s) => (
                    <MenuItem key={s} value={s} sx={{ fontSize: 12 }}>
                      {s}
                    </MenuItem>
                  ))}
                </Select>
                <Typography sx={{ fontSize: 12, color: u.color }}>
                  {u.icon} {u.label}
                </Typography>
                <Typography sx={{ fontSize: 12, fontFamily: COLORS.mono, color: COLORS.textMuted }}>
                  {a.followupDue?.slice(5) ?? '—'}
                </Typography>
                <Typography sx={{ fontSize: 12, color: COLORS.textMuted }} noWrap>
                  {a.notes ?? '—'}
                </Typography>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}
