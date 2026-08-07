/**
 * 决策详情抽屉：卡片「查看完整评估」的落点——决策 md 全文渲染（结论/评估明细/打分依据/风险建议一体）。
 * 数据 = decisions/get RPC（引擎读 md 原文）；UI 不解析自由文本，全文由 MarkdownView 排版。
 * 方向/城市视图共用；与 DecisionEditDialog（摘要表编辑）并存：详情=只读全文，编辑=局部字段。
 */
import { Box, Chip, CircularProgress, Drawer, IconButton, Stack, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { useEffect, useState } from 'react'
import { getEngine } from '../store/app-store'
import { alpha, COLORS } from '../data/constants'
import { MarkdownView } from './markdown-view'
import type { DecisionView, CompanyDetail } from '../store/engine-client'

export function DecisionDetailDrawer({
  decision,
  onClose,
}: {
  decision: DecisionView | null
  onClose: () => void
}) {
  const [detail, setDetail] = useState<CompanyDetail | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setError(false)
    if (!decision) return
    const engine = getEngine()
    if (!engine) {
      setError(true)
      return
    }
    engine
      .getDecisionDetail(decision.id)
      .then((d) => {
        if (!cancelled) {
          // frontmatter（id/created_at/source_file）已由头部 chips 覆盖，正文不再重复
          setDetail({ ...d, markdown: d.markdown.replace(/^---\n[\s\S]*?\n---\n/, '') })
        }
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [decision?.id])

  return (
    <Drawer
      open={decision !== null}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: 640,
            maxWidth: '94vw',
            bgcolor: COLORS.canvas,
            backgroundImage: 'none',
          },
        },
      }}
    >
      {decision && (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* 头部：标题 + 元信息 */}
          <Box sx={{ p: 2.5, pb: 1.5, borderBottom: `1px solid ${COLORS.border}` }}>
            <Stack direction="row" sx={{ alignItems: 'flex-start', gap: 1 }}>
              <Typography sx={{ fontSize: 16, fontWeight: 600, flex: 1, minWidth: 0, lineHeight: 1.4 }}>
                {decision.title}
              </Typography>
              <IconButton size="small" onClick={onClose}>
                <CloseIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Stack>
            <Stack direction="row" spacing={0.75} sx={{ mt: 1, alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}>
              <Chip size="small" label={decision.createdAt || '无日期'} sx={{ height: 20, fontSize: 11.5 }} />
              {decision.skill && (
                <Chip size="small" label={decision.skill} sx={{ height: 20, fontSize: 11.5 }} />
              )}
              {decision.direction && decision.direction !== '方向待定' && (
                <Chip size="small" label={decision.direction} sx={{ height: 20, fontSize: 11.5 }} />
              )}
              {decision.protocolVersion && (
                <Typography sx={{ fontSize: 11, color: COLORS.textMuted, fontFamily: COLORS.mono }}>
                  v{decision.protocolVersion}
                </Typography>
              )}
            </Stack>
          </Box>

          {/* 正文：决策 md 全文（评估明细段落/打分依据/风险建议一体渲染） */}
          <Box sx={{ flex: 1, overflowY: 'auto', p: 2.5 }}>
            {error ? (
              <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted }}>
                评估详情加载失败（引擎未连接或决策缺失）
              </Typography>
            ) : !detail ? (
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', py: 4, justifyContent: 'center' }}>
                <CircularProgress size={16} sx={{ color: COLORS.accent }} />
                <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted }}>加载评估详情…</Typography>
              </Stack>
            ) : (
              <Box sx={{ maxWidth: 600, '& table': { display: 'block', overflowX: 'auto' } }}>
                <MarkdownView content={detail.markdown} />
              </Box>
            )}
          </Box>

          <Box sx={{ p: 1.5, borderTop: `1px solid ${COLORS.border}`, bgcolor: alpha(COLORS.bgElevated, 0.6) }}>
            <Typography sx={{ fontSize: 11, color: COLORS.textMuted, lineHeight: 1.6 }}>
              评估全文为历史决策记录；如需局部修改字段，请在时间线中打开编辑抽屉
            </Typography>
          </Box>
        </Box>
      )}
    </Drawer>
  )
}
