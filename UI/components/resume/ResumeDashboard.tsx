/**
 * Resume Dashboard（ADR-021 R0）：当前编辑对象状态卡 + 任务入口。
 * 落地页（非第五空间）——用户进入简历工作台先看到「我在哪、下一步做什么」。
 * 数据只用已有投影/规则：质量规则、targetCompany/Position、evidence/claims 引擎计数——
 * 不产生虚假指标（ADR-021 R0 DoD：Dashboard 不造数据）。
 */
import { Box, Button, Stack, Tooltip, Typography } from '@mui/material'
import EditIcon from '@mui/icons-material/Edit'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import HistoryIcon from '@mui/icons-material/History'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import { useMemo } from 'react'
import { useAppStore } from '../../store/app-store'
import { useToastStore } from '../../store/toast-store'
import { alpha, COLORS } from '../../data/constants'
import { computeResumeQuality } from '../../utils/resume-quality'

export function ResumeDashboard({ onDerive }: { onDerive: () => void }) {
  const person = useAppStore((s) => s.currentPerson())
  const resumes = useAppStore((s) => s.resumes)
  const activeResumeId = useAppStore((s) => s.activeResumeId)
  const setResumeWorkspaceView = useAppStore((s) => s.setResumeWorkspaceView)
  const careerContext = useAppStore((s) => s.careerContext)
  const evidenceItems = useAppStore((s) => s.evidence)
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const push = useToastStore((s) => s.push)

  const personResumes = useMemo(() => resumes.filter((r) => r.personId === person.id), [resumes, person.id])
  const current = personResumes.find((r) => r.id === activeResumeId) ?? personResumes[0]

  // 已有数据投影（不新增计算）：质量规则 / 引擎计数
  const quality = current ? computeResumeQuality(current.modules) : null
  const evidenceCount = evidenceItems.filter((e) => e.lifecycle !== 'legacy').length
  const claimCount = careerContext?.claims.length ?? 0
  const target = current ? [current.targetPosition, current.targetCompany].filter(Boolean).join(' · ') : ''

  if (!current) {
    return (
      <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', p: 3 }}>
        <Stack spacing={1.5} sx={{ alignItems: 'center', textAlign: 'center', maxWidth: 380 }}>
          <DescriptionOutlinedIcon sx={{ fontSize: 34, color: COLORS.textMuted, opacity: 0.45 }} />
          <Typography sx={{ fontSize: 15, fontWeight: 600 }}>「{person.name}」暂无简历</Typography>
          <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted, lineHeight: 1.7 }}>
            从 AI 面板发起首个简历生成，或基于已有 JD 派生定制版本
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="contained"
              disabled={person.initStatus === 'pending'}
              title={person.initStatus === 'pending' ? '完成基础档案后可生成简历' : undefined}
              onClick={() => {
                startAnalysis(`请为「${person.name}」生成简历：基于画像模块化输出，含量化指标与方向关键词`, {
                  taskType: 'resume_generation',
                  outputTarget: 'artifact',
                })
                push('info', '已预置「生成简历」上下文')
              }}
              sx={{ fontSize: 12.5 }}
            >
              生成简历
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={person.initStatus === 'pending'}
              title={person.initStatus === 'pending' ? '完成基础档案后可派生' : undefined}
              onClick={onDerive}
              sx={{ fontSize: 12.5 }}
            >
              基于 JD 派生
            </Button>
          </Stack>
        </Stack>
      </Box>
    )
  }

  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 3 }}>
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mb: 1.5 }}>简历工作台 · 当前编辑对象</Typography>

        {/* 当前对象卡（Unbound Draft 状态——ADR-021 §8） */}
        <Box
          sx={{
            p: 2,
            borderRadius: '10px',
            border: `1px solid ${alpha(COLORS.border, 0.8)}`,
            boxShadow: COLORS.cardShadow,
            bgcolor: COLORS.bgElevated,
            mb: 1.5,
          }}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
            <DescriptionOutlinedIcon sx={{ fontSize: 16, color: COLORS.accent }} />
            <Typography sx={{ fontSize: 15, fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>
              {current.name}
            </Typography>
            {target && (
              <Typography sx={{ fontSize: 12, color: COLORS.textMuted }} noWrap>
                → {target}
              </Typography>
            )}
          </Stack>
          <Box
            sx={{
              px: 1.25,
              py: 0.75,
              borderRadius: '6px',
              bgcolor: alpha(COLORS.riskMedium, 0.08),
              border: `1px solid ${alpha(COLORS.riskMedium, 0.3)}`,
            }}
          >
            <Typography sx={{ fontSize: 11.5, color: COLORS.textSecondary, lineHeight: 1.6 }}>
              <Box component="span" sx={{ fontWeight: 600, color: COLORS.riskMedium }}>当前为编辑草稿</Box>
              {' —— 此内容尚未纳入简历版本管理。完成资产绑定后，可追踪修改记录和证据来源。'}
            </Typography>
          </Box>
        </Box>

        {/* 状态卡（只用已有数据） */}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1.25, mb: 1.5 }}>
          {[
            { label: '内容完整度', value: `${quality}%`, hint: '结构完整 · 含量化指标 · 无明显空泛表述（表达诊断，非评分结论）' },
            { label: '目标岗位', value: current.targetPosition || '未绑定', hint: target || '未绑定岗位——可基于 JD 派生建立关联' },
            { label: '可用经历', value: `${evidenceCount} 条`, hint: '已登记的事实资产（有效）——简历内容的证据来源' },
            { label: '已有表达', value: `${claimCount} 条`, hint: '表达 = 已整理为简历可用内容的职业经历描述' },
          ].map((k) => (
            <Tooltip key={k.label} title={k.hint}>
              <Box
                sx={{
                  p: 1.5,
                  borderRadius: '10px',
                  border: `1px solid ${alpha(COLORS.border, 0.8)}`,
                  boxShadow: COLORS.cardShadow,
                  bgcolor: COLORS.bgElevated,
                  cursor: 'help',
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
            </Tooltip>
          ))}
        </Box>

        {/* 任务入口 */}
        <Box
          sx={{
            p: 2,
            borderRadius: '10px',
            border: `1px solid ${alpha(COLORS.border, 0.8)}`,
            boxShadow: COLORS.cardShadow,
            bgcolor: COLORS.bgElevated,
          }}
        >
          <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 1, color: COLORS.textSecondary }}>下一步</Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 0.75 }}>
            <Button
              size="small"
              variant="contained"
              startIcon={<EditIcon sx={{ fontSize: 14 }} />}
              onClick={() => setResumeWorkspaceView('edit')}
              sx={{ fontSize: 12.5 }}
            >
              继续编辑
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<AutoAwesomeIcon sx={{ fontSize: 14 }} />}
              onClick={() => setResumeWorkspaceView('optimize')}
              sx={{ fontSize: 12.5 }}
            >
              针对岗位优化
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<HistoryIcon sx={{ fontSize: 14 }} />}
              onClick={() => setResumeWorkspaceView('history')}
              sx={{ fontSize: 12.5 }}
            >
              查看历史
            </Button>
          </Stack>
        </Box>
      </Box>
    </Box>
  )
}
