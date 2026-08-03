import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import ViewKanbanIcon from '@mui/icons-material/ViewKanban'
import ViewListIcon from '@mui/icons-material/ViewList'
import ErrorIcon from '@mui/icons-material/Error'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import ScheduleIcon from '@mui/icons-material/Schedule'
import CircleOutlinedIcon from '@mui/icons-material/CircleOutlined'
import { useMemo, useState, type ComponentType } from 'react'
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
  { label: string; color: string; icon: ComponentType<{ sx?: object }> }
> = {
  urgent: { label: '紧急', color: COLORS.riskHigh, icon: ErrorIcon },
  overdue: { label: '逾期', color: COLORS.riskMedium, icon: WarningAmberIcon },
  waiting: { label: '等待中', color: COLORS.accent, icon: ScheduleIcon },
  cooled: { label: '已冷却', color: COLORS.textMuted, icon: CircleOutlinedIcon },
}

/** 新增投递 Dialog：手动录入（公司/岗位自由输入；JD 粘贴 → 引擎建 Job 实体关联） */
function AddApplicationDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const addApplication = useAppStore((s) => s.addApplication)
  const createJob = useAppStore((s) => s.createJob)
  const setPage = useAppStore((s) => s.setPage)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)
  const person = useAppStore((s) => s.currentPerson())
  const push = useToastStore((s) => s.push)
  const [company, setCompany] = useState('')
  const [position, setPosition] = useState('')
  const [jdText, setJdText] = useState('')
  const [requirements, setRequirements] = useState('')
  const [status, setStatus] = useState<ApplicationStatus>('已评估')
  const [urgency, setUrgency] = useState<FollowupUrgency>('waiting')
  const [followupDue, setFollowupDue] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!company.trim() || !position.trim()) {
      push('warning', '公司与岗位必填')
      return
    }
    setSaving(true)
    try {
      let jobId: string | undefined
      // 有 JD 原文或技能要求 → 建 Job 实体（M1：JD 是一等数据对象）；都没有 → 纯投递记录
      if (jdText.trim() || requirements.trim()) {
        const job = await createJob({
          company: company.trim(),
          title: position.trim(),
          requirements: requirements.trim() || undefined,
          jdText: jdText.trim() || undefined,
        })
        jobId = job.id
      }
      addApplication({
        personId: person.id,
        company: company.trim(),
        position: position.trim(),
        jobId,
        status,
        urgency,
        ...(followupDue ? { followupDue } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      })
      push('success', `已新增投递：${company.trim()} · ${position.trim()}`)
      setCompany('')
      setPosition('')
      setJdText('')
      setRequirements('')
      setStatus('已评估')
      setUrgency('waiting')
      setFollowupDue('')
      setNotes('')
      onClose()
      // 有 JD → 跳岗位页工作区（下一步：分析 JD）
      if (jobId) {
        setSelectedJobId(jobId)
        setPage('jobs')
      }
    } catch (err) {
      push('warning', `创建失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: 420,
            bgcolor: COLORS.bgElevated,
            backgroundImage: 'none',
            borderRadius: '12px',
            border: `1px solid ${COLORS.borderStrong}`,
          },
        },
      }}
    >
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>新增投递</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: '8px !important' }}>
        <TextField
          size="small"
          label="公司"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          autoFocus
        />
        <TextField
          size="small"
          label="岗位"
          value={position}
          onChange={(e) => setPosition(e.target.value)}
        />
        <TextField
          size="small"
          label="技能要求（可选，分号分隔，如 Python;SolidWorks）"
          value={requirements}
          onChange={(e) => setRequirements(e.target.value)}
        />
        <TextField
          size="small"
          label="JD 原文（可选，粘贴招聘要求；保存为岗位实体）"
          value={jdText}
          onChange={(e) => setJdText(e.target.value)}
          multiline
          minRows={3}
          maxRows={6}
        />
        <Stack direction="row" spacing={1.5}>
          <Select
            size="small"
            value={status}
            onChange={(e) => setStatus(e.target.value as ApplicationStatus)}
            sx={{ flex: 1, fontSize: 12.5 }}
          >
            {COLUMNS.map((s) => (
              <MenuItem key={s} value={s} sx={{ fontSize: 12.5 }}>
                {s}
              </MenuItem>
            ))}
          </Select>
          <Select
            size="small"
            value={urgency}
            onChange={(e) => setUrgency(e.target.value as FollowupUrgency)}
            sx={{ flex: 1, fontSize: 12.5 }}
          >
            {Object.entries(URGENCY_META).map(([k, m]) => (
              <MenuItem key={k} value={k} sx={{ fontSize: 12.5 }}>
                {m.label}
              </MenuItem>
            ))}
          </Select>
        </Stack>
        <TextField
          size="small"
          label="跟进日（可选，如 2026-08-10）"
          value={followupDue}
          onChange={(e) => setFollowupDue(e.target.value)}
        />
        <TextField
          size="small"
          label="备注（可选）"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button size="small" onClick={onClose} sx={{ fontSize: 12.5, color: COLORS.textSecondary }}>
          取消
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={saving}
          onClick={() => void submit()}
          sx={{ fontSize: 12.5, bgcolor: COLORS.accent, color: COLORS.onAccent, '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 } }}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** 投递卡片（Level 1 快速决策）：公司/岗位/地点/评分/状态；点击 → 岗位页工作区（有 JD 时） */
function KanbanCard({ app }: { app: Application }) {
  const update = useAppStore((s) => s.updateApplicationStatus)
  const push = useToastStore((s) => s.push)
  const jobs = useAppStore((s) => s.jobs)
  const companies = useAppStore((s) => s.companies)
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId)
  const setPage = useAppStore((s) => s.setPage)
  const u = URGENCY_META[app.urgency]
  const UrgencyIcon = u.icon

  const job = app.jobId ? jobs.find((j) => j.id === app.jobId) : undefined
  const company = companies.find((c) => c.name === app.company)

  const changeStatus = (status: ApplicationStatus) => {
    update(app.id, status)
    push('info', `${app.company} → ${status}`)
  }

  const openWorkspace = () => {
    if (!job) return
    setSelectedJobId(job.id)
    setPage('jobs')
  }

  return (
    <Box
      onClick={openWorkspace}
      sx={{
        p: 1.5,
        borderRadius: '8px',
        bgcolor: COLORS.bg,
        border: `1px solid ${COLORS.border}`,
        mb: 1,
        cursor: job ? 'pointer' : 'default',
        '&:hover': { borderColor: job ? COLORS.borderStrong : COLORS.border },
      }}
    >
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start', mb: 0.5 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1, lineHeight: 1.35 }}>
          {app.company}
        </Typography>
        <Box sx={{ display: 'grid', placeItems: 'center' }} title={u.label}>
          <UrgencyIcon sx={{ fontSize: 14, color: u.color }} />
        </Box>
      </Stack>
      <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, mb: 0.5 }} noWrap>
        {app.position}
      </Typography>
      {(company || job) && (
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, mb: 0.75 }} noWrap>
          {company && (
            <>
              {company.matchScore > 0 && (
                <Box component="span" sx={{ color: COLORS.accent, fontWeight: 600 }}>
                  {company.matchScore}%
                </Box>
              )}
              {company.city && <Box component="span"> · {company.city}</Box>}
              {company.headcount && <Box component="span"> · {company.headcount}</Box>}
              {company.industry && <Box component="span"> · {company.industry}</Box>}
            </>
          )}
          {!company && job?.location && <Box component="span">{job.location}</Box>}
        </Typography>
      )}
      {app.notes && (
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 0.75 }} noWrap>
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
        {job && (
          <Typography
            sx={{
              fontSize: 11.5,
              color: COLORS.accent,
              ml: 'auto',
            }}
          >
            工作区 →
          </Typography>
        )}
      </Stack>

      <Select
        size="small"
        value={app.status}
        onClick={(e) => e.stopPropagation()}
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
  const person = useAppStore((s) => s.currentPerson())
  const push = useToastStore((s) => s.push)

  const personApps = applications.filter((a) => a.personId === person.id)

  const filtered =
    applicationsFilter === '全部'
      ? personApps
      : personApps.filter((a) => a.status === applicationsFilter)

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

  const urgent = personApps.filter((a) => a.urgency === 'urgent' || a.urgency === 'overdue')
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', p: 2, gap: 1.5, overflow: 'hidden' }}>
      <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1.5}>
        <Typography sx={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>投递管理</Typography>
        <Chip size="small" label={`${personApps.length} 条`} sx={{ height: 22, fontSize: 12 }} />
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
        <Button
          size="small"
          variant="contained"
          startIcon={<AddIcon sx={{ fontSize: 16 }} />}
          onClick={() => setDialogOpen(true)}
          sx={{
            fontSize: 12.5,
            bgcolor: COLORS.accent,
            color: COLORS.onAccent,
            '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 },
          }}
        >
          新增投递
        </Button>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 30 }}>
          <Tab icon={<ViewKanbanIcon sx={{ fontSize: 16 }} />} iconPosition="start" label="看板" sx={{ minHeight: 30 }} />
          <Tab icon={<ViewListIcon sx={{ fontSize: 16 }} />} iconPosition="start" label="列表" sx={{ minHeight: 30 }} />
        </Tabs>
      </Stack>

      {/* 状态过滤在侧栏（ApplicationsSidebar）——此处只消费过滤结果 */}

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
            const UrgencyIcon = u.icon
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
                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                  <UrgencyIcon sx={{ fontSize: 13, color: u.color }} />
                  <Typography sx={{ fontSize: 12, color: u.color }}>{u.label}</Typography>
                </Stack>
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

      <AddApplicationDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </Box>
  )
}
