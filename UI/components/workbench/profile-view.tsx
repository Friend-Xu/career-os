/**
 * 工作台子视图 · 职业画像：Person 在系统中的状态镜像（职业画像地图）。
 * 回答「AI 如何理解这个人、画像建立到什么程度」——主体是 Person 不是 AI。
 * 三层：身份+AI 摘要（叙事式，ChatGPT Memory 模式）→ 画像地图（SVG 节点状态，
 * 继承信息池图谱语言但无连接线——不制造未证实的关系）→ 画像状态/内容（证据轴计数 + 技能/目标）。
 * 数据全部来自现有 store（person/decisions/initCandidates），零引擎改动。
 */
import { useEffect } from 'react'
import { Box, Button, Chip, Stack, Typography } from '@mui/material'
import { useAppStore } from '../../store/app-store'
import { COLORS, alpha } from '../../data/constants'
import { belongsToPerson } from '../../utils/ownership'
import { hasPersonDirection, latestPersonDirection } from '../../utils/direction-state'

type DimKey = 'skills' | 'education' | 'goals' | 'direction' | 'experience' | 'city' | 'preference'
type DimState = 'confirmed' | 'pending' | 'inferred' | 'missing'

interface ProfileDim {
  key: DimKey
  label: string
  state: DimState
  detail: string
}

/** 维度状态推导：数据可得性 + 确认状态 → 视觉状态（诚实反映：缺数据 = 未建立，不假装了解） */
function useProfileDims(): { dims: ProfileDim[]; stats: { confirmed: number; pending: number; rejected: number; skills: number; decisions: number; resumes: number } } {
  const person = useAppStore((s) => s.currentPerson())
  const decisions = useAppStore((s) => s.decisions)
  const candidates = useAppStore((s) => s.initCandidates)
  const resumes = useAppStore((s) => s.resumes)

  const personDecisions = decisions.filter((d) => belongsToPerson(d, person))
  const hasDirection = hasPersonDirection(decisions, person)

  const skills = person.skills ?? []
  const interests = person.initialInterest ?? []
  const targets = person.targetRoles ?? []

  const byCat = (cat: string, st: string) =>
    candidates.filter((c) => c.category === cat && c.status === st).length

  const dims: ProfileDim[] = [
    {
      key: 'skills',
      label: '技能',
      state: skills.length > 0 ? 'confirmed' : 'missing',
      detail: skills.length > 0 ? `${skills.length} 项声明` : '未建立',
    },
    {
      key: 'education',
      label: '教育',
      state: (person.education ?? []).length > 0 ? 'confirmed' : 'missing',
      detail:
        (person.education ?? []).length > 0
          ? person.education!.map((e) => `${e.school} · ${e.degree}`).join('、')
          : '未建立',
    },
    {
      key: 'goals',
      label: '目标岗位',
      state: targets.length > 0 ? 'confirmed' : 'missing',
      detail: targets.length > 0 ? `${targets.length} 个目标` : '未建立',
    },
    {
      key: 'direction',
      label: '职业方向',
      state: hasDirection ? 'confirmed' : interests.length > 0 ? 'inferred' : 'missing',
      detail: hasDirection ? latestPersonDirection(decisions, person) ?? '已探索' : interests.length > 0 ? `${interests.length} 个自报意向` : '未探索',
    },
    {
      key: 'experience',
      label: '经历',
      state: byCat('experience', 'confirmed') > 0 ? 'confirmed' : byCat('experience', 'pending') > 0 ? 'pending' : 'missing',
      detail:
        byCat('experience', 'confirmed') > 0
          ? `${byCat('experience', 'confirmed')} 项已确认`
          : byCat('experience', 'pending') > 0
            ? `${byCat('experience', 'pending')} 项待确认`
            : '未建立',
    },
    { key: 'city', label: '城市', state: 'missing', detail: '未评估' },
    { key: 'preference', label: '偏好', state: 'missing', detail: '未建立' },
  ]

  return {
    dims,
    stats: {
      confirmed: candidates.filter((c) => c.status === 'confirmed').length,
      pending: candidates.filter((c) => c.status === 'pending').length,
      rejected: candidates.filter((c) => c.status === 'rejected').length,
      skills: skills.length,
      decisions: personDecisions.length,
      resumes: resumes.filter((r) => r.personId === person.id).length,
    },
  }
}

/** 身份区：头像（呼吸光晕 = 画像正在被维护）+ 渠道/初始化徽章 + AI 叙事摘要 */
function IdentityCard() {
  const person = useAppStore((s) => s.currentPerson())
  const { dims, stats } = useProfileDims()
  const direction = dims.find((d) => d.key === 'direction')!

  const summary =
    person.initStatus === 'pending'
      ? `初始化采集中：AI 正从${person.sourceMode === 'resume' ? '简历' : '访谈'}中提取候选事实，等你确认后写入画像——当前 ${stats.confirmed} 项已确认，${stats.pending} 项待确认。`
      : direction.state === 'confirmed'
        ? `基于 ${stats.skills} 项技能声明、${stats.confirmed} 项已确认事实与 ${stats.decisions} 条决策记录，AI 认为你当前聚焦「${direction.detail}」方向。`
        : `基于 ${stats.skills} 项技能声明与 ${stats.confirmed} 项已确认事实，你的职业方向尚未建立——AI 已记录${person.initialInterest?.length ? `自报意向「${person.initialInterest.join('、')}」` : '你的初始资料'}，等待方向分析。`

  return (
    <Box
      sx={{
        p: 2,
        borderRadius: '12px',
        border: `1px solid ${alpha(COLORS.border, 0.8)}`,
        boxShadow: COLORS.cardShadow,
        bgcolor: COLORS.bgElevated,
        display: 'flex',
        gap: 2.5,
        alignItems: 'center',
      }}
    >
      {/* 头像：主题色底 + 呼吸光晕（4.5s 慢周期，安静表达「画像正在被维护」） */}
      <Box sx={{ position: 'relative', width: 72, height: 72, flexShrink: 0 }}>
        <Box
          sx={{
            position: 'absolute',
            inset: -7,
            borderRadius: '50%',
            bgcolor: alpha(COLORS.accent, 0.18),
            animation: 'cos-profile-breathe 4.5s ease-in-out infinite',
          }}
        />
        <Box
          sx={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            bgcolor: person.color,
            fontSize: 34,
            lineHeight: 1,
            boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
          }}
        >
          {person.emoji}
        </Box>
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5 }}>
          <Typography sx={{ fontSize: 18, fontWeight: 600 }}>{person.name}</Typography>
          <Chip
            size="small"
            label={person.sourceMode === 'resume' ? '简历通道' : '访谈通道'}
            sx={{ height: 20, fontSize: 10.5, color: COLORS.textSecondary, borderColor: COLORS.border }}
            variant="outlined"
          />
          <Chip
            size="small"
            label={person.initStatus === 'pending' ? '初始化采集中' : '初始化完成'}
            sx={{
              height: 20,
              fontSize: 10.5,
              color: person.initStatus === 'pending' ? COLORS.riskMedium : COLORS.riskLow,
              borderColor: person.initStatus === 'pending' ? COLORS.riskMedium : COLORS.riskLow,
              animation: person.initStatus === 'pending' ? 'cos-profile-breathe 4.5s ease-in-out infinite' : 'none',
            }}
            variant="outlined"
          />
        </Stack>
        <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, lineHeight: 1.65 }}>{summary}</Typography>
      </Box>
    </Box>
  )
}

/** 画像地图：中心人物节点 + 六维画像节点（无连接线——不制造未证实的关系）。
 *  状态视觉：已确认=实心 / 待确认=空心呼吸 / AI 推断=半透明虚线 / 未建立=弱化虚线。 */
function ProfileMap() {
  const person = useAppStore((s) => s.currentPerson())
  const { dims } = useProfileDims()

  const CX = 160
  const CY = 158
  const R = 106
  const pos = (i: number) => {
    const a = ((-90 + i * 60) * Math.PI) / 180
    return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) }
  }

  const st = (state: DimState): { fill: string; stroke: string; dash?: string; animate?: boolean } => {
    switch (state) {
      case 'confirmed':
        return { fill: person.color, stroke: person.color }
      case 'pending':
        return { fill: 'transparent', stroke: person.color, animate: true }
      case 'inferred':
        return { fill: alpha(COLORS.accent, 0.18), stroke: COLORS.accent, dash: '4 3' }
      case 'missing':
        return { fill: 'transparent', stroke: COLORS.borderStrong ?? COLORS.textMuted, dash: '3 3' }
    }
  }

  return (
    <Box
      sx={{
        p: 2,
        borderRadius: '12px',
        border: `1px solid ${alpha(COLORS.border, 0.8)}`,
        boxShadow: COLORS.cardShadow,
        bgcolor: COLORS.bgElevated,
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <svg viewBox="0 0 320 300" style={{ width: '100%', maxWidth: 400, height: 'auto' }}>
        {/* 中心人物节点 + 呼吸光晕 */}
        <circle cx={CX} cy={CY} r={40} fill={alpha(COLORS.accent, 0.08)} style={{ animation: 'cos-profile-breathe 4.5s ease-in-out infinite' }} />
        <circle cx={CX} cy={CY} r={27} fill={person.color} stroke="rgba(255,255,255,0.65)" strokeWidth={1.5} />
        <text x={CX} y={CY + 8} textAnchor="middle" fontSize={24}>
          {person.emoji}
        </text>
        <text x={CX} y={CY + 52} textAnchor="middle" fontSize={11.5} fontWeight={600} fill={COLORS.text}>
          {person.name}
        </text>

        {dims.map((d, i) => {
          const { x, y } = pos(i)
          const s = st(d.state)
          return (
            <g key={d.key}>
              <circle
                cx={x}
                cy={y}
                r={15}
                fill={s.fill}
                stroke={s.stroke}
                strokeWidth={1.5}
                strokeDasharray={s.dash}
                style={s.animate ? { animation: 'cos-profile-breathe 4s ease-in-out infinite' } : undefined}
              />
              <text x={x} y={y + 33} textAnchor="middle" fontSize={11} fontWeight={600} fill={COLORS.text}>
                {d.label}
              </text>
              <text x={x} y={y + 47} textAnchor="middle" fontSize={9.5} fill={COLORS.textMuted}>
                {d.detail}
              </text>
            </g>
          )
        })}
      </svg>
      <Typography sx={{ fontSize: 10.5, color: COLORS.textMuted, mt: 0.5 }}>
        图例：实心=已建立 · 空心呼吸=待确认 · 虚线=推断或未建立（画像地图不画关系线——连接会暗示未经证实的关系）
      </Typography>
    </Box>
  )
}

/** 状态 + 内容：左列画像状态（覆盖度/证据轴计数），右列画像内容（技能/目标/意向） */
function StatusContent() {
  const person = useAppStore((s) => s.currentPerson())
  const setWorkbenchView = useAppStore((s) => s.setWorkbenchView)
  const setPage = useAppStore((s) => s.setPage)
  const { dims, stats } = useProfileDims()

  const covered = dims.filter((d) => d.state === 'confirmed').length
  const skills = person.skills ?? []

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 2 }}>
      {/* 画像状态 */}
      <Box sx={{ p: 2, borderRadius: '12px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bgElevated }}>
        <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 1.25, color: COLORS.textSecondary }}>画像状态</Typography>
        <Stack spacing={0.75}>
          <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary }}>
            覆盖维度
            <Box component="span" sx={{ fontFamily: COLORS.mono, color: COLORS.text }}>
              {' '}{covered}/6
            </Box>
          </Typography>
          <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary }}>
            已确认事实
            <Box component="span" sx={{ fontFamily: COLORS.mono, color: COLORS.riskLow }}>
              {' '}{stats.confirmed}
            </Box>
            {stats.pending > 0 && (
              <>
                {' '}· 待确认
                <Box component="span" sx={{ fontFamily: COLORS.mono, color: COLORS.riskMedium }}>
                  {' '}{stats.pending}
                </Box>
              </>
            )}
            {stats.rejected > 0 && (
              <>
                {' '}· 已拒绝
                <Box component="span" sx={{ fontFamily: COLORS.mono, color: COLORS.textMuted }}>
                  {' '}{stats.rejected}
                </Box>
              </>
            )}
          </Typography>
          <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary }}>
            决策记录
            <Box component="span" sx={{ fontFamily: COLORS.mono, color: COLORS.text }}>
              {' '}{stats.decisions}
            </Box>
            <Button size="small" onClick={() => setWorkbenchView('decisions')} sx={{ ml: 0.5, minWidth: 0, p: 0.25, fontSize: 11.5, color: COLORS.accent }}>
              查看 →
            </Button>
          </Typography>
          <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary }}>
            简历版本
            <Box component="span" sx={{ fontFamily: COLORS.mono, color: COLORS.text }}>
              {' '}{stats.resumes}
            </Box>
            <Button size="small" onClick={() => setPage('resumes')} sx={{ ml: 0.5, minWidth: 0, p: 0.25, fontSize: 11.5, color: COLORS.accent }}>
              查看 →
            </Button>
          </Typography>
        </Stack>
      </Box>

      {/* 画像内容 */}
      <Box sx={{ p: 2, borderRadius: '12px', border: `1px solid ${alpha(COLORS.border, 0.8)}`, boxShadow: COLORS.cardShadow, bgcolor: COLORS.bgElevated }}>
        <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 1.25, color: COLORS.textSecondary }}>画像内容</Typography>
        {skills.length > 0 ? (
          <Stack spacing={0.75} sx={{ mb: 1.5 }}>
            {skills.slice(0, 8).map((sk) => (
              <Stack key={sk.name} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography sx={{ fontSize: 12, width: 110, flexShrink: 0 }}>{sk.name}</Typography>
                <Stack direction="row" spacing={0.35}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <Box
                      key={n}
                      sx={{
                        width: 14,
                        height: 6,
                        borderRadius: '3px',
                        bgcolor: n <= sk.level ? person.color : COLORS.bgHover,
                      }}
                    />
                  ))}
                </Stack>
                <Typography sx={{ fontSize: 10.5, color: COLORS.textMuted, fontFamily: COLORS.mono }}>L{sk.level}</Typography>
              </Stack>
            ))}
          </Stack>
        ) : (
          <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1.5 }}>暂无技能声明——AI 完成采集后建立</Typography>
        )}
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
          {(person.targetRoles ?? []).length > 0 && (
            <>
              <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>目标岗位</Typography>
              {(person.targetRoles ?? []).map((t) => (
                <Chip key={t} size="small" label={t} sx={{ height: 20, fontSize: 11, color: COLORS.accent, borderColor: alpha(COLORS.accent, 0.4) }} variant="outlined" />
              ))}
            </>
          )}
          {(person.initialInterest ?? []).length > 0 && (
            <>
              <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>自报意向</Typography>
              {(person.initialInterest ?? []).map((t) => (
                <Chip key={t} size="small" label={t} sx={{ height: 20, fontSize: 11, color: COLORS.textSecondary, borderColor: COLORS.border }} variant="outlined" />
              ))}
            </>
          )}
          {(person.targetRoles ?? []).length === 0 && (person.initialInterest ?? []).length === 0 && (
            <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>目标与意向待建立</Typography>
          )}
        </Stack>
      </Box>
    </Box>
  )
}

/** 行动入口：状态驱动（初始化采集中 → 继续采集；方向未建立 → 探索方向）；无待办时隐藏 */
function ActionRow() {
  const person = useAppStore((s) => s.currentPerson())
  const startInitializationSession = useAppStore((s) => s.startInitializationSession)
  const startAgentTask = useAppStore((s) => s.startAgentTask)
  const decisions = useAppStore((s) => s.decisions)

  const hasDirection = hasPersonDirection(decisions, person)

  const actions: { label: string; onClick: () => void }[] = []
  if (person.initStatus === 'pending') {
    actions.push({
      label: '继续采集 →',
      onClick: () =>
        startInitializationSession({
          personName: person.name,
          sourceMode: person.sourceMode ?? 'interview',
          interests: person.initialInterest,
        }),
    })
  }
  if (!hasDirection && person.initStatus !== 'pending') {
    actions.push({
      label: '探索职业方向 →',
      onClick: () =>
        startAgentTask(
          `请基于「${person.name}」的职业档案，探索适合的发展方向：结合经历、技能与自报意向，给出 2-3 个候选方向及理由。`,
          { type: 'career-direction', title: '探索职业方向' },
        ),
    })
  }
  if (actions.length === 0) return null

  return (
    <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
      {actions.map((a) => (
        <Button key={a.label} size="small" variant="contained" onClick={a.onClick} sx={{ fontSize: 12.5 }}>
          {a.label}
        </Button>
      ))}
    </Stack>
  )
}

export function ProfileView() {
  // 经历/技能维度数据源 = 引擎初始化资产（candidates.md）——挂载即拉，不依赖 agent-page 先访问
  const personId = useAppStore((s) => s.currentPerson().personId)
  const loadInitCandidates = useAppStore((s) => s.loadInitCandidates)
  useEffect(() => {
    if (personId) void loadInitCandidates(personId)
  }, [personId, loadInitCandidates])

  return (
    <Box sx={{ p: 2.5, maxWidth: 900, mx: 'auto', width: '100%' }}>
      <Typography sx={{ fontSize: 16, fontWeight: 600, mb: 0.25 }}>职业画像</Typography>
      <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1.5, lineHeight: 1.6 }}>
        AI 对你职业状态的理解 · 画像随你的确认与决策逐步建立（主体是「你」，不是 AI）
      </Typography>
      <Stack spacing={2}>
        <IdentityCard />
        <ProfileMap />
        <StatusContent />
        <ActionRow />
      </Stack>
    </Box>
  )
}
