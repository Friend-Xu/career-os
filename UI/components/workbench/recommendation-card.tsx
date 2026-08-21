import { useEffect, useState } from 'react'
import { Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/material'
import { alpha, COLORS, RISK_COLOR } from '../../data/constants'
import { MarkdownView } from '../markdown-view'
import { getEngine, useAppStore } from '../../store/app-store'

/**
 * 推荐审阅卡（Career Workflow Contract v0.3 Stage 4）——UI 只投影 + Human Action，不直接改 decision：
 * - 数据源：workflow stage.artifacts（decision 系统 ID，onRecommendationDone 写入）→ decisions/get 全文
 * - 状态：waiting_gate = 待审阅（decision status 联动归引擎——采纳经 workflow/advance(review_recommendation)
 *   由引擎将 decision → accepted；UI 不写 decision 文件）
 * - 「采纳」= advanceWorkflow（引擎终判：缺件/联动失败 toast）；「重新生成」= restageWorkflow（新增一轮，方向池保留）
 */
export function RecommendationCard() {
  const workflows = useAppStore((s) => s.workflows)
  const advanceWorkflow = useAppStore((s) => s.advanceWorkflow)
  const restageWorkflow = useAppStore((s) => s.restageWorkflow)
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [fail, setFail] = useState(false)

  const active = workflows.find((w) => w.status === 'active')
  const stage = active?.stages.find((s) => s.id === 'recommendation')
  const decisionId = stage?.artifacts?.[0]
  const waitingGate = stage?.status === 'waiting_gate'

  useEffect(() => {
    let cancelled = false
    setMarkdown(null)
    setFail(false)
    if (!decisionId) return
    const engine = getEngine()
    if (!engine) {
      setFail(true)
      return
    }
    engine
      .getDecisionDetail(decisionId)
      .then((d) => {
        if (!cancelled) setMarkdown(d.markdown.replace(/^---\n[\s\S]*?\n---\n/, ''))
      })
      .catch(() => {
        if (!cancelled) setFail(true)
      })
    return () => {
      cancelled = true
    }
  }, [decisionId])

  if (!active || active.currentStage !== 'recommendation') return null

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
        <Typography sx={{ fontSize: 12, fontWeight: 600, color: COLORS.textSecondary }}>推荐方案</Typography>
        {waitingGate && (
          <Chip
            size="small"
            label="待审阅"
            sx={{ height: 18, fontSize: 10.5, bgcolor: alpha(COLORS.accent, 0.14), color: COLORS.accent }}
          />
        )}
      </Stack>
      {!decisionId && (
        <Typography sx={{ fontSize: 11.5, color: COLORS.textMuted, py: 0.5 }}>等待 Agent 产出推荐方案…</Typography>
      )}
      {decisionId && markdown === null && !fail && (
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', py: 0.5 }}>
          <CircularProgress size={10} thickness={5} />
          <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>正在加载推荐方案…</Typography>
        </Stack>
      )}
      {fail && (
        <Typography sx={{ fontSize: 11.5, color: RISK_COLOR.high, py: 0.5 }}>推荐方案读取失败——请重新生成后重试。</Typography>
      )}
      {markdown !== null && <MarkdownView content={markdown} />}
      {waitingGate && (
        <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 1 }}>
          <Button size="small" variant="contained" sx={{ fontSize: 11.5 }} onClick={() => void advanceWorkflow(active.id, stage?.gate?.id)}>
            采纳（确认推荐，登记决策）
          </Button>
          <Button size="small" variant="outlined" color="inherit" sx={{ fontSize: 11.5 }} onClick={() => void restageWorkflow(active.id)}>
            重新生成
          </Button>
        </Stack>
      )}
    </Box>
  )
}
