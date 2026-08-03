/**
 * 决策聚合视图（V1.5）：一个决策问题（DecisionContext）的完整聚合——
 * Options / Factors / Evidence / Conclusion / Risks + 「发起复盘」入口。
 * 数据来自引擎实时派生（contexts/list RPC），不落盘、不持久化；
 * 写入 decision-contexts/ 或 decisions/ 后由 data.decisions.changed 事件驱动重拉。
 */
import {
  Box,
  Button,
  Chip,
  Divider,
  Dialog,
  IconButton,
  Stack,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import { useEffect, useState, type ReactNode } from 'react'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, EASE, RISK_COLOR, RISK_LABEL } from '../data/constants'
import type { DecisionAggregate, DecisionRecord } from '../../engine/ir/schema.ts'

/** 四态配色复用现有语义色：探索中蓝（决策色）/ 评估中黄（riskMedium）/ 已决定绿（riskLow）/ 复盘中紫（人色） */
const STATUS_META: Record<
  DecisionAggregate['context']['status'],
  { label: string; color: string }
> = {
  exploring: { label: '探索中', color: '#59C2FF' },
  evaluating: { label: '评估中', color: RISK_COLOR.medium },
  decided: { label: '已决定', color: RISK_COLOR.low },
  reviewing: { label: '复盘中', color: '#9081E4' },
}

/** 选项状态：候选蓝 / 已选绿 / 已排除红（reasons 明示排除原因） */
const OPTION_META: Record<
  DecisionAggregate['options'][number]['status'],
  { label: string; color: string }
> = {
  candidate: { label: '候选', color: '#59C2FF' },
  selected: { label: '已选', color: RISK_COLOR.low },
  rejected: { label: '已排除', color: RISK_COLOR.high },
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box sx={{ mt: 2.5 }}>
      <Typography
        sx={{
          fontSize: 11.5,
          fontWeight: 600,
          color: COLORS.textMuted,
          letterSpacing: '0.05em',
          mb: 1,
        }}
      >
        {title}
      </Typography>
      <Stack spacing={1}>{children}</Stack>
    </Box>
  )
}

/** 决策记录摘要：title / 方向 / 匹配度 / 风险（选项展开形态的最小交互） */
function RecordSummary({ record }: { record: DecisionRecord }) {
  return (
    <Box
      sx={{
        ml: 0.75,
        pl: 1.5,
        py: 0.75,
        borderLeft: `1px solid ${COLORS.border}`,
        animation: `fade-in 0.2s ${EASE}`,
      }}
    >
      <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{record.title}</Typography>
      <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, mt: 0.25 }}>
        {record.direction && `方向 ${record.direction}`}
        {record.directionMatch > 0 && ` · 匹配 ${record.directionMatch}%`}
        {` · 风险${RISK_LABEL[record.riskLevel]}`}
      </Typography>
      {record.keyRisk && (
        <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mt: 0.25 }}>
          风险点：{record.keyRisk}
        </Typography>
      )}
    </Box>
  )
}

export function DecisionAggregateDialog({
  open,
  aggregate,
  onClose,
}: {
  open: boolean
  aggregate: DecisionAggregate | null
  onClose: () => void
}) {
  const startAnalysis = useAppStore((s) => s.startAnalysis)
  const push = useToastStore((s) => s.push)
  // 展开的选项名（查看其对应决策记录摘要）；抽屉关闭时重置
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    if (!open) setExpanded(null)
  }, [open])

  return (
    <Dialog

      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: 460,
            maxWidth: '92vw',
            borderRadius: '12px',
            bgcolor: COLORS.bgElevated,
            backgroundImage: 'none',
          },
        },
      }}
    >
      {aggregate && (
        <Box sx={{ maxHeight: '80vh', overflow: 'auto', p: 2.5 }}>
          {/* 顶部：问题 + 状态 */}
          <Stack direction="row" sx={{ alignItems: 'center', mb: 2 }}>
            <Typography sx={{ fontSize: 15, fontWeight: 600, flex: 1, minWidth: 0 }}>
              {aggregate.context.question}
            </Typography>
            <IconButton size="small" onClick={onClose}>
              <CloseIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Stack>
          <Chip
            size="small"
            label={STATUS_META[aggregate.context.status].label}
            sx={{
              mb: 1,
              bgcolor: alpha(STATUS_META[aggregate.context.status].color, 0.13),
              color: STATUS_META[aggregate.context.status].color,
            }}
          />
          {aggregate.review && (
            <Chip
              size="small"
              label="已复盘"
              sx={{
                ml: 0.75,
                mb: 1,
                bgcolor: alpha(RISK_COLOR.low, 0.13),
                color: RISK_COLOR.low,
              }}
            />
          )}

          {/* Options：状态标记 + rejected 原因 + 对应决策记录（点击展开） */}
          <Section title="选项">
            {aggregate.options.map((opt) => {
              const meta = OPTION_META[opt.status]
              // 对应决策记录：按 direction 匹配本问题的多个方向决策（Options 展开形态）
              const related = aggregate.records.filter((r) => r.direction === opt.name)
              const isExpanded = expanded === opt.name
              return (
                <Box key={opt.name}>
                  <Stack
                    direction="row"
                    spacing={1}
                    onClick={() => setExpanded(isExpanded ? null : opt.name)}
                    sx={{
                      alignItems: 'center',
                      px: 1,
                      py: 0.75,
                      mx: -1,
                      borderRadius: '8px',
                      cursor: related.length > 0 ? 'pointer' : 'default',
                      '&:hover': related.length > 0 ? { bgcolor: COLORS.bgHover } : undefined,
                    }}
                  >
                    <Typography sx={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0 }} noWrap>
                      {opt.name}
                    </Typography>
                    <Chip
                      size="small"
                      label={meta.label}
                      sx={{
                        height: 20,
                        fontSize: 11.5,
                        bgcolor: alpha(meta.color, 0.13),
                        color: meta.color,
                        flexShrink: 0,
                      }}
                    />
                    {related.length > 0 &&
                      (isExpanded ? (
                        <ExpandMoreIcon sx={{ fontSize: 16, color: COLORS.textMuted }} />
                      ) : (
                        <ChevronRightIcon sx={{ fontSize: 16, color: COLORS.textMuted }} />
                      ))}
                  </Stack>
                  {opt.status === 'rejected' && opt.reasons && opt.reasons.length > 0 && (
                    <Typography sx={{ fontSize: 12, color: COLORS.textMuted, mt: 0.25 }}>
                      排除原因：{opt.reasons.join('；')}
                    </Typography>
                  )}
                  {isExpanded &&
                    related.map((r) => <RecordSummary key={r.id} record={r} />)}
                </Box>
              )
            })}
          </Section>

          {/* Factors：只记概念，不评分 */}
          {aggregate.factors.length > 0 && (
            <Section title="考量因素">
              {aggregate.factors.map((f) => (
                <Stack key={f.name} spacing={0.25}>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 500 }}>{f.name}</Typography>
                  <Typography sx={{ fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.55 }}>
                    {f.description}
                  </Typography>
                </Stack>
              ))}
            </Section>
          )}

          {/* Evidence：type + content（+ source） */}
          {aggregate.evidence.length > 0 && (
            <Section title="依据">
              {aggregate.evidence.map((e, i) => (
                <Stack key={`${e.type}-${i}`} spacing={0.25}>
                  <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                    <Typography
                      sx={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: COLORS.accent,
                        letterSpacing: '0.04em',
                      }}
                    >
                      {e.type}
                    </Typography>
                    {e.source && (
                      <Typography sx={{ fontSize: 11, color: COLORS.textMuted }} noWrap>
                        {e.source}
                      </Typography>
                    )}
                  </Stack>
                  <Typography sx={{ fontSize: 12.5, color: COLORS.textSecondary, lineHeight: 1.55 }}>
                    {e.content}
                  </Typography>
                </Stack>
              ))}
            </Section>
          )}

          {/* Conclusion：无结论显式空态 */}
          <Section title="结论">
            {aggregate.conclusion ? (
              <Stack
                direction="row"
                sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}
              >
                <Typography
                  sx={{ fontSize: 13, fontWeight: 600, color: COLORS.riskLow }}
                >
                  {aggregate.conclusion.selected}
                </Typography>
                <Typography
                  sx={{ fontSize: 12, color: COLORS.textSecondary, fontFamily: COLORS.mono }}
                >
                  置信度 {aggregate.conclusion.confidence}
                </Typography>
              </Stack>
            ) : (
              <Typography sx={{ fontSize: 12.5, color: COLORS.textMuted }}>尚未结论</Typography>
            )}
          </Section>

          {/* Risks：描述 + 缓解措施 */}
          {aggregate.risks.length > 0 && (
            <Section title="风险">
              {aggregate.risks.map((r, i) => (
                <Stack key={i} direction="row" spacing={1}>
                  <Box
                    sx={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      bgcolor: RISK_COLOR.high,
                      mt: 0.5,
                      flexShrink: 0,
                    }}
                  />
                  <Stack spacing={0.25}>
                    <Typography sx={{ fontSize: 12.5 }}>{r.description}</Typography>
                    {r.mitigation && (
                      <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
                        缓解：{r.mitigation}
                      </Typography>
                    )}
                  </Stack>
                </Stack>
              ))}
            </Section>
          )}

          {/* 复盘：作者写入 `## 复盘` 段落，引擎实时派生；存在时展示 + 已复盘标记 */}
          {aggregate.review && (
            <Section title="复盘">
              <Stack spacing={0.25}>
                <Typography sx={{ fontSize: 12.5, lineHeight: 1.55 }}>
                  {aggregate.review.conclusion}
                </Typography>
                <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>
                  复盘日期 {aggregate.review.date}
                </Typography>
              </Stack>
            </Section>
          )}

          {/* Review 入口：唤起 AI 面板（与「重新评估」同模式）；关闭抽屉露出面板 */}
          <Divider sx={{ my: 2.5 }} />
          <Button
            variant="contained"
            fullWidth
            onClick={() => {
              startAnalysis(`请复盘决策「${aggregate.context.question}」：回顾预期与结果，输出复盘结论`)
              push('info', `复盘产出请写入 decision-contexts/ 的 ## 复盘 段落（结论 + 复盘日期）`)
              onClose()
            }}
            sx={{
              bgcolor: COLORS.accent,
              color: COLORS.onAccent,
              fontWeight: 600,
              fontSize: 13,
              '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 },
            }}
          >
            发起复盘
          </Button>
          <Typography
            sx={{
              fontSize: 11,
              color: COLORS.textMuted,
              mt: 1.5,
              lineHeight: 1.6,
              textAlign: 'center',
            }}
          >
            聚合视图由引擎实时派生：写入 decision-contexts/ 或 decisions/ 后自动刷新
          </Typography>
        </Box>
      )}
    </Dialog>
  )
}
