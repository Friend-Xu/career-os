import { useState } from 'react'
import { Box, Button, Chip, CircularProgress, Collapse, Stack, Typography } from '@mui/material'
import { alpha, COLORS } from '../../data/constants'
import { MarkdownView } from '../markdown-view'
import { getEngine, useAppStore } from '../../store/app-store'
import type { StageArtifact, StageArtifactState } from '../../../engine/ir/schema.ts'

/**
 * 评估明细投影卡（Career Workflow Contract v0.3 Stage 3）——UI 只投影不裁决：
 * - 数据源：store.evaluationsByWorkflow[activeWorkflowId]（Store 层按 workflow scope 拉取，组件只取 key）
 * - 每条 = 评估结论摘要（claim，登记时快照）+ 依据引用（evidence_refs，含 directions/ 引用）+ state 芯片
 * - 「评估细节」展开 = person/evaluations/get 全文渲染（评估字段正文：技能匹配/行业匹配/风险）——
 *   只展示评估产物，不展示 Agent 原始推理链
 * - 评估是 Stage 3 输入型产物（无用户裁决动作）——只读，无动作按钮
 */
const STATE_META: Record<StageArtifactState, { label: string; color: string }> = {
  registered: { label: '已登记', color: COLORS.accent },
  confirmed: { label: '已保留', color: COLORS.riskLow },
  rejected: { label: '已排除', color: COLORS.textMuted },
}

export function EvaluationCard() {
  const workflows = useAppStore((s) => s.workflows)
  const evaluationsByWorkflow = useAppStore((s) => s.evaluationsByWorkflow)
  const person = useAppStore((s) => s.currentPerson())
  const [detailByArtifact, setDetailByArtifact] = useState<Record<string, string>>({})
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  const active = workflows.find((w) => w.status === 'active')
  if (!active || active.currentStage !== 'direction_evaluation') return null
  const evaluations = evaluationsByWorkflow[active.id] ?? []
  if (evaluations.length === 0) return null

  const toggle = (a: StageArtifact) => {
    if (openId === a.artifact_id) {
      setOpenId(null)
      return
    }
    setOpenId(a.artifact_id)
    if (detailByArtifact[a.artifact_id] !== undefined || loadingId) return
    const engine = getEngine()
    if (!engine || !person.personId) return
    setLoadingId(a.artifact_id)
    engine
      .getEvaluationDetail(person.personId, a.artifact_id)
      .then((d) => setDetailByArtifact((prev) => ({ ...prev, [a.artifact_id]: d.markdown.replace(/^---\n[\s\S]*?\n---\n/, '') })))
      .catch(() => {})
      .finally(() => setLoadingId(null))
  }

  return (
    <Box
      sx={{
        p: 1.25,
        borderRadius: '8px',
        bgcolor: alpha(COLORS.accent, 0.06),
        border: `1px solid ${alpha(COLORS.accent, 0.35)}`,
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography sx={{ fontSize: 12, fontWeight: 600, color: COLORS.textSecondary }}>评估明细</Typography>
        <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>已登记 {evaluations.length} 条方向评估</Typography>
      </Stack>
      <Stack spacing={0.75}>
        {evaluations.map((a) => (
          <Box
            key={a.artifact_id}
            sx={{
              p: 1,
              borderRadius: '6px',
              bgcolor: COLORS.canvas,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <Typography sx={{ fontSize: 12.5, lineHeight: 1.5, flex: 1 }}>{a.claim}</Typography>
              <Chip
                size="small"
                label={STATE_META[a.state].label}
                sx={{
                  height: 18,
                  fontSize: 10.5,
                  flexShrink: 0,
                  bgcolor: alpha(STATE_META[a.state].color, 0.14),
                  color: STATE_META[a.state].color,
                }}
              />
            </Stack>
            {a.evidence_refs.length > 0 && (
              <Typography sx={{ fontSize: 11, color: COLORS.textMuted, mt: 0.5, lineHeight: 1.5 }}>
                依据：{a.evidence_refs.join('；')}
              </Typography>
            )}
            <Button size="small" sx={{ fontSize: 11, height: 22, minWidth: 0, px: 1, mt: 0.5 }} onClick={() => void toggle(a)}>
              {openId === a.artifact_id ? '收起细节' : '评估细节'}
            </Button>
            <Collapse in={openId === a.artifact_id}>
              {loadingId === a.artifact_id ? (
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', py: 1 }}>
                  <CircularProgress size={10} thickness={5} />
                  <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>加载评估字段…</Typography>
                </Stack>
              ) : detailByArtifact[a.artifact_id] !== undefined ? (
                <Box sx={{ pt: 0.5 }}>
                  <MarkdownView content={detailByArtifact[a.artifact_id]} />
                </Box>
              ) : null}
            </Collapse>
          </Box>
        ))}
      </Stack>
    </Box>
  )
}
