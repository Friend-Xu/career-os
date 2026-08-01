import { Box, Typography, Stack, LinearProgress, Button, Divider } from '@mui/material'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import { useAppStore } from '../../store/app-store'
import { useToastStore } from '../../store/toast-store'
import { APPLICATION_STATS } from '../../data/mock-data'
import { alpha, COLORS, LAYOUT, RISK_COLOR, RISK_LABEL } from '../../data/constants'

const STAGE_PROMPTS: Record<string, string> = {
  direction: '请帮我进行职业方向探索：基于当前画像与市场机会，输出方向排序建议',
  transfer: '请帮我进行转行分析：基于当前技能画像与目标方向，输出差距分析与行动计划',
  city: '请帮我进行城市评估：结合当前画像对比候选城市，输出评分与建议',
  company: '请帮我进行公司筛选：基于当前城市与方向，输出目标公司清单',
  research: '请帮我进行公司尽调：对目标公司做背调与风险分析',
  jd: '请帮我分析这份 JD：拆解需求、匹配度与面试准备',
  resume: '请帮我撰写/优化简历：基于当前画像与目标方向',
}

function StageDot({ status }: { status: string }) {
  if (status === 'completed') {
    return (
      <Box
        sx={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          bgcolor: COLORS.riskLow,
          flexShrink: 0,
        }}
      />
    )
  }
  if (status === 'current') {
    return (
      <Box
        sx={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          bgcolor: COLORS.accent,
          flexShrink: 0,
          animation: 'pulse-ring 1.8s ease-out infinite',
        }}
      />
    )
  }
  return (
    <Box
      sx={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        border: `1.5px solid ${COLORS.textMuted}`,
        flexShrink: 0,
      }}
    />
  )
}

function WorkbenchSecondary() {
  const role = useAppStore((s) => s.currentRole())
  const setPage = useAppStore((s) => s.setPage)
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const push = useToastStore((s) => s.push)
  const roleStages = useAppStore((s) => s.roleStages[role.id])
  const stages = roleStages ?? []
  const completed = stages.filter((s) => s.status === 'completed').length
  const progress = stages.length ? Math.round((completed / stages.length) * 100) : 0

  return (
    <Stack sx={{ height: '100%', overflow: 'hidden' }}>
      <Box sx={{ p: 2, pb: 1.5 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 1.5 }}>
          <Box
            sx={{
              width: 40,
              height: 40,
              borderRadius: '10px',
              bgcolor: alpha(role.color, 0.13),
              border: `1px solid ${alpha(role.color, 0.27)}`,
              display: 'grid',
              placeItems: 'center',
              fontSize: 20,
            }}
          >
            {role.emoji}
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 600 }} noWrap>
              {role.name}
            </Typography>
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>当前角色</Typography>
          </Box>
        </Stack>

        <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
          <Box
            sx={{
              flex: 1,
              p: 1,
              borderRadius: '6px',
              bgcolor: COLORS.bgHover,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 0.25 }}>匹配度</Typography>
            <Typography
              sx={{ fontSize: 16, fontWeight: 600, fontFamily: COLORS.mono, color: COLORS.accent }}
            >
              {role.matchScore}%
            </Typography>
          </Box>
          <Box
            sx={{
              flex: 1,
              p: 1,
              borderRadius: '6px',
              bgcolor: COLORS.bgHover,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 0.25 }}>风险</Typography>
            <Typography sx={{ fontSize: 16, fontWeight: 600, color: RISK_COLOR[role.riskLevel] }}>
              {RISK_LABEL[role.riskLevel]}
            </Typography>
          </Box>
        </Stack>

        <Button
          fullWidth
          size="small"
          endIcon={<ArrowForwardIcon sx={{ fontSize: 14 }} />}
          onClick={() => {
            startAnalysis('请根据当前信息更新我的技能画像与决策背景')
            push('info', '已预置「更新画像」上下文')
          }}
          sx={{
            justifyContent: 'space-between',
            color: COLORS.textSecondary,
            border: `1px solid ${COLORS.border}`,
            fontSize: 12.5,
          }}
        >
          更新画像
        </Button>
      </Box>

      <Divider />

      <Box sx={{ px: 2, py: 1.5, flex: 1, overflow: 'auto' }}>
        <Typography
          sx={{
            fontSize: 12,
            fontWeight: 600,
            color: COLORS.textMuted,
            mb: 1.5,
            letterSpacing: '0.04em',
          }}
        >
          决策链
        </Typography>
        <Stack spacing={0.5}>
          {stages.map((stage) => (
            <Stack
              key={stage.id}
              direction="row"
              spacing={1}
              onClick={() => {
                if (stage.status !== 'completed') {
                  startAnalysis(STAGE_PROMPTS[stage.id] ?? '请帮我继续推进当前决策阶段')
                }
              }}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && stage.status !== 'completed') {
                  startAnalysis(STAGE_PROMPTS[stage.id] ?? '请帮我继续推进当前决策阶段')
                }
              }}
              sx={{
                alignItems: 'center',
                py: 0.75,
                px: 1,
                borderRadius: '6px',
                bgcolor: stage.status === 'current' ? COLORS.accentMuted : 'transparent',
                cursor: 'pointer',
                '&:hover': {
                  bgcolor: stage.status === 'current' ? COLORS.accentMuted : COLORS.bgHover,
                },
                '&:focus-visible': {
                  outline: `2px solid ${COLORS.accent}`,
                  outlineOffset: -1,
                },
              }}
            >
              <StageDot status={stage.status} />
              <Typography
                sx={{
                  fontSize: 13,
                  fontWeight: stage.status === 'current' ? 600 : 400,
                  color:
                    stage.status === 'pending'
                      ? COLORS.textMuted
                      : stage.status === 'current'
                        ? COLORS.accent
                        : COLORS.text,
                  flex: 1,
                }}
              >
                {stage.label}
              </Typography>
              {stage.status === 'pending' && (
                <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted }}>未开始</Typography>
              )}
            </Stack>
          ))}
        </Stack>

        <Box sx={{ mt: 2 }}>
          <Stack direction="row" sx={{ justifyContent: 'space-between', mb: 0.75 }}>
            <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>完成度</Typography>
            <Typography
              sx={{ fontSize: 12, fontFamily: COLORS.mono, color: COLORS.textSecondary }}
            >
              {completed}/{stages.length} · {progress}%
            </Typography>
          </Stack>
          <LinearProgress
            variant="determinate"
            value={progress}
            sx={{
              height: 4,
              borderRadius: 2,
              bgcolor: COLORS.bgHover,
              '& .MuiLinearProgress-bar': { bgcolor: COLORS.accent, borderRadius: 2 },
            }}
          />
        </Box>
      </Box>

      <Divider />

      <Box sx={{ p: 2 }}>
        <Stack
          direction="row"
          spacing={0.75}
          onClick={() => setPage('applications')}
          sx={{
            alignItems: 'center',
            p: 1.25,
            borderRadius: '8px',
            bgcolor: alpha(COLORS.riskMedium, 0.08),
            border: `1px solid ${alpha(COLORS.riskMedium, 0.2)}`,
            cursor: 'pointer',
          }}
        >
          <WarningAmberIcon sx={{ fontSize: 16, color: COLORS.riskMedium }} />
          <Typography sx={{ fontSize: 12, fontWeight: 500, flex: 1 }}>
            待跟进 ({APPLICATION_STATS.pendingFollowups})
          </Typography>
          <Typography sx={{ fontSize: 12, color: COLORS.accent }}>全部 →</Typography>
        </Stack>
      </Box>
    </Stack>
  )
}

function ListSecondary({
  title,
  items,
  onItemClick,
}: {
  title: string;
  items: { id: string; label: string; meta?: string; active?: boolean }[];
  onItemClick?: (id: string) => void;
}) {
  return (
    <Stack sx={{ height: '100%', overflow: 'hidden' }}>
      <Box sx={{ px: 2, py: 1.5, borderBottom: `1px solid ${COLORS.border}` }}>
        <Typography
          sx={{
            fontSize: 12,
            fontWeight: 600,
            color: COLORS.textMuted,
            letterSpacing: '0.04em',
          }}
        >
          {title}
        </Typography>
      </Box>
      <Box sx={{ flex: 1, overflow: 'auto', p: 1 }}>
        {items.map((item) => (
          <Box
            key={item.id}
            onClick={() => onItemClick?.(item.id)}
            tabIndex={onItemClick ? 0 : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && onItemClick) onItemClick(item.id)
            }}
            sx={{
              px: 1.25,
              py: 1,
              borderRadius: '6px',
              cursor: 'pointer',
              bgcolor: item.active ? COLORS.accentMuted : 'transparent',
              '&:hover': { bgcolor: item.active ? COLORS.accentMuted : COLORS.bgHover },
              '&:focus-visible': {
                outline: `2px solid ${COLORS.accent}`,
                outlineOffset: -1,
              },
              mb: 0.25,
            }}
          >
            <Typography
              sx={{
                fontSize: 13,
                fontWeight: item.active ? 600 : 400,
                color: item.active ? COLORS.accent : COLORS.text,
              }}
              noWrap
            >
              {item.label}
            </Typography>
            {item.meta && (
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mt: 0.25 }} noWrap>
                {item.meta}
              </Typography>
            )}
          </Box>
        ))}
      </Box>
    </Stack>
  )
}

export function SecondarySidebar() {
  const page = useAppStore((s) => s.currentPage)
  const sessions = useAppStore((s) => s.sessions)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const createSession = useAppStore((s) => s.createSession)
  const role = useAppStore((s) => s.currentRole())
  const applications = useAppStore((s) => s.applications)
  const infopoolFilter = useAppStore((s) => s.infopoolFilter)
  const companiesFilter = useAppStore((s) => s.companiesFilter)
  const applicationsFilter = useAppStore((s) => s.applicationsFilter)
  const setInfopoolFilter = useAppStore((s) => s.setInfopoolFilter)
  const setCompaniesFilter = useAppStore((s) => s.setCompaniesFilter)
  const setApplicationsFilter = useAppStore((s) => s.setApplicationsFilter)
  const push = useToastStore((s) => s.push)

  const content = (() => {
    switch (page) {
    case 'workbench':
      return <WorkbenchSecondary />
    case 'agent':
      return (
        <Stack sx={{ height: '100%' }}>
          <Box sx={{ p: 1.5, borderBottom: `1px solid ${COLORS.border}` }}>
            <Button
              fullWidth
              variant="outlined"
              size="small"
              onClick={() => {
                createSession()
                push('info', '已创建新会话')
              }}
              sx={{ fontSize: 12 }}
            >
                + 新会话 ⌘N
            </Button>
          </Box>
          <ListSecondary
            title="会话历史"
            items={sessions
              .filter((s) => s.roleId === role.id && !s.archived)
              .map((s) => ({
                id: s.id,
                label: s.title,
                meta: new Date(s.updatedAt).toLocaleDateString('zh-CN'),
                active: s.id === currentSessionId,
              }))}
            onItemClick={setCurrentSession}
          />
          {sessions.some((s) => s.archived) && (
            <Box sx={{ maxHeight: 160, overflow: 'auto' }}>
              <ListSecondary
                title="已归档"
                items={sessions
                  .filter((s) => s.archived)
                  .map((s) => ({
                    id: s.id,
                    label: s.title,
                    meta: '归档',
                  }))}
              />
            </Box>
          )}
        </Stack>
      )
    case 'infopool':
      return (
        <ListSecondary
          title="节点过滤"
          items={[
            { id: 'all', label: '全部节点', meta: '342', active: infopoolFilter === 'all' },
            { id: 'role', label: '角色', meta: '3', active: infopoolFilter === 'role' },
            { id: 'decision', label: '决策记录', meta: '28', active: infopoolFilter === 'decision' },
            { id: 'direction', label: '方向', meta: '6', active: infopoolFilter === 'direction' },
            { id: 'city', label: '城市', meta: '12', active: infopoolFilter === 'city' },
            { id: 'company', label: '公司', meta: '156', active: infopoolFilter === 'company' },
            { id: 'isolated', label: '⚠ 孤立节点', meta: '8', active: infopoolFilter === 'isolated' },
            { id: 'missing', label: '⚠ 字段缺失', meta: '3', active: infopoolFilter === 'missing' },
          ]}
          onItemClick={setInfopoolFilter}
        />
      )
    case 'companies':
      return (
        <ListSecondary
          title="公司列表"
          items={[
            { id: 'all', label: '全部', meta: '36', active: companiesFilter === 'all' },
            { id: 'sz', label: '深圳', meta: '14', active: companiesFilter === 'sz' },
            { id: 'sh', label: '上海', meta: '9', active: companiesFilter === 'sh' },
            { id: 'hz', label: '杭州', meta: '6', active: companiesFilter === 'hz' },
            { id: 'bj', label: '北京', meta: '5', active: companiesFilter === 'bj' },
            { id: 'robot', label: '产业: 机器人', meta: '22', active: companiesFilter === 'robot' },
            { id: 'contacted', label: '已联系', meta: '8', active: companiesFilter === 'contacted' },
          ]}
          onItemClick={setCompaniesFilter}
        />
      )
    case 'applications': {
      const statuses = ['全部', '面试中', '已投递', '已联系', '已回复', '已评估', '已拒绝'] as const
      const roleApps = applications.filter((a) => a.roleId === role.id)
      const counts: Record<string, number> = { 全部: roleApps.length }
      roleApps.forEach((a) => {
        counts[a.status] = (counts[a.status] ?? 0) + 1
      })
      return (
        <ListSecondary
          title="状态过滤"
          items={statuses.map((s) => ({
            id: s,
            label: s,
            meta: String(counts[s] ?? 0),
            active: applicationsFilter === s,
          }))}
          onItemClick={setApplicationsFilter}
        />
      )
    }
    case 'resumes':
      return (
        <ListSecondary
          title="版本 / 血缘"
          items={[
            { id: 'r-root', label: '原始简历 v1', meta: '根版本' },
            { id: 'r-dji', label: '↳ 大疆-算法工程师', meta: '派生', active: true },
            { id: 'r-ubtech', label: '↳ 优必选-感知算法', meta: '派生' },
          ]}
        />
      )
    case 'settings':
      return (
        <ListSecondary
          title="设置分类"
          items={[
            { id: 'roles', label: '角色管理', active: true },
            { id: 'model', label: '模型配置' },
            { id: 'data', label: '数据' },
            { id: 'appearance', label: '外观' },
          ]}
        />
      )
    default:
      return null
    }
  })()

  return (
    <Box
      sx={{
        width: LAYOUT.secondaryDefault,
        minWidth: LAYOUT.secondaryMin,
        maxWidth: LAYOUT.secondaryMax,
        borderRight: `1px solid ${COLORS.border}`,
        bgcolor: COLORS.bgElevated,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 10,
      }}
    >
      {content}
    </Box>
  )
}
