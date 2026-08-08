/**
 * 决策编辑抽屉：决策记录详情 + 摘要表字段编辑（局部修改）。
 * - 只读区：validation（invalid/degraded + 原因）、关联问题绑定聚合摘要（若有）
 * - 编辑区：skill/direction/匹配度/置信度/城市/城市分/薪资可行/风险/关键风险/状态
 * - 保存 → decisions/update RPC → 引擎写回 md → watcher 自动重扫 → data.decisions.changed 广播
 * - 值格式与摘要表协议一致（direction_match "82%"、city_score "8.2/10"、risk_level 中文档）
 */
import {
  Box,
  Button,
  Chip,
  Divider,
  Dialog,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import ErrorIcon from '@mui/icons-material/Error'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { useToastStore } from '../store/toast-store'
import { alpha, COLORS, RISK_COLOR } from '../data/constants'
import type { DecisionAggregate, DecisionRecord, Validation } from '../../engine/ir/schema.ts'

const RISK_REV: Record<string, string> = { low: '低', medium: '中', high: '中高' }
const CONF_REV: Record<string, string> = { high: '高', medium: '中', low: '低' }

/** IR 值 → 摘要表字符串（表单初始值；编辑提交原样写回摘要表） */
function toFormValues(d: DecisionRecord): Record<string, string> {
  return {
    skill: d.skill ?? '',
    direction: d.direction ?? '',
    direction_match: d.directionMatch !== undefined && d.directionMatch > 0 ? `${d.directionMatch}%` : '',
    direction_confidence: d.directionConfidence ? CONF_REV[d.directionConfidence] : '',
    city: d.city ?? '',
    city_score: d.cityScore !== undefined && d.cityScore > 0 ? `${d.cityScore}%` : '',
    salary_feasible: d.salaryFeasible !== undefined ? String(d.salaryFeasible) : '',
    risk_level: d.riskLevel ? RISK_REV[d.riskLevel] : '',
    key_risk: d.keyRisk ?? '',
    status: d.status ?? '',
  }
}

const FIELD_LABELS: Record<string, string> = {
  skill: '技能归属',
  direction: '方向',
  direction_match: '方向匹配度',
  direction_confidence: '匹配置信度',
  city: '城市',
  city_score: '城市评分',
  salary_feasible: '薪资可行',
  risk_level: '风险等级',
  key_risk: '关键风险',
  status: '状态',
}

function ValidationBanner({ validation }: { validation: Validation }) {
  const invalid = validation.status === 'invalid'
  const color = invalid ? RISK_COLOR.high : RISK_COLOR.medium
  const Icon = invalid ? ErrorIcon : WarningAmberIcon
  return (
    <Box
      sx={{
        p: 1.25,
        borderRadius: '8px',
        mb: 1.5,
        bgcolor: alpha(color, 0.08),
        border: `1px solid ${alpha(color, 0.3)}`,
        display: 'flex',
        gap: 1,
      }}
    >
      <Icon sx={{ fontSize: 16, color, mt: 0.25, flexShrink: 0 }} />
      <Stack spacing={0.5}>
        <Typography sx={{ fontSize: 12.5, fontWeight: 600, color }}>
          {invalid ? '待人工处理（数据无效）' : '数据降级（部分字段缺失）'}
        </Typography>
        {validation.issues.map((i, idx) => (
          <Typography key={idx} sx={{ fontSize: 12, color: COLORS.textSecondary }}>
            {i.path}：{i.reason}
          </Typography>
        ))}
      </Stack>
    </Box>
  )
}

function Field({
  label,
  value,
  onChange,
  select,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  select?: string[]
  placeholder?: string
}) {
  return (
    <Stack spacing={0.5}>
      <Typography sx={{ fontSize: 12, color: COLORS.textMuted }}>{label}</Typography>
      {select ? (
        <Select
          size="small"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          displayEmpty
          sx={{
            fontSize: 12.5,
            '& .MuiOutlinedInput-notchedOutline': { borderColor: COLORS.border },
          }}
        >
          <MenuItem value="" sx={{ fontSize: 12.5, color: COLORS.textMuted }}>
            —
          </MenuItem>
          {select.map((o) => (
            <MenuItem key={o} value={o} sx={{ fontSize: 12.5 }}>
              {o}
            </MenuItem>
          ))}
        </Select>
      ) : (
        <TextField
          size="small"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          sx={{
            '& .MuiInputBase-root': { fontSize: 12.5 },
          }}
        />
      )}
    </Stack>
  )
}

export function DecisionEditDialog({
  decision,
  aggregate,
  onClose,
  onOpenAggregate,
}: {
  decision: (DecisionRecord & { validation?: Validation }) | null
  /** 关联的问题绑定聚合（有则展示只读摘要），由调用方在 contexts 中匹配 */
  aggregate: DecisionAggregate | null
  onClose: () => void
  /** 有聚合时可用：切到完整聚合视图（DecisionAggregateDialog） */
  onOpenAggregate?: () => void
}) {
  const updateDecision = useAppStore((s) => s.updateDecision)
  const push = useToastStore((s) => s.push)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (decision) setValues(toFormValues(decision))
  }, [decision])

  if (!decision) return null

  const set = (field: string) => (v: string) => setValues((prev) => ({ ...prev, [field]: v }))

  const save = async () => {
    const init = toFormValues(decision)
    const dirty: Record<string, string> = {}
    for (const [k, v] of Object.entries(values)) {
      if (init[k] !== v && v.trim() !== '') dirty[k] = v.trim()
    }
    if (Object.keys(dirty).length === 0) {
      push('info', '没有需要保存的修改')
      return
    }
    setSaving(true)
    try {
      await updateDecision(decision.id, dirty)
      push('success', '已更新决策记录（引擎自动重扫）')
      onClose()
    } catch (err) {
      push('warning', `保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog

      open
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
      <Box sx={{ maxHeight: '80vh', overflow: 'auto', p: 2.5 }}>
        <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
          <Typography sx={{ fontSize: 15, fontWeight: 600, flex: 1, minWidth: 0 }}>
            {decision.title}
          </Typography>
          <IconButton size="small" onClick={onClose}>
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Stack>
        <Stack direction="row" spacing={0.75} sx={{ mb: 2, alignItems: 'center' }}>
          <Chip size="small" label={decision.createdAt || '无日期'} sx={{ height: 20, fontSize: 11.5 }} />
          {decision.protocolVersion && (
            <Typography sx={{ fontSize: 11, color: COLORS.textMuted }}>v{decision.protocolVersion}</Typography>
          )}
        </Stack>

        {decision.validation && <ValidationBanner validation={decision.validation} />}

        {aggregate && (
          <Box
            sx={{
              p: 1.25,
              borderRadius: '8px',
              mb: 1.5,
              bgcolor: COLORS.bgHover,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.5 }}>
              问题绑定 · {aggregate.context.question}
            </Typography>
            {aggregate.conclusion && (
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>
                结论：{aggregate.conclusion.selected}（置信度 {aggregate.conclusion.confidence}）
              </Typography>
            )}
            {aggregate.review && (
              <Typography sx={{ fontSize: 12, color: COLORS.textSecondary }}>
                已复盘：{aggregate.review.conclusion}
              </Typography>
            )}
            {onOpenAggregate && (
              <Button
                size="small"
                onClick={onOpenAggregate}
                sx={{ mt: 0.75, fontSize: 12, color: COLORS.accent, minWidth: 0, p: 0 }}
              >
                查看完整聚合 →
              </Button>
            )}
          </Box>
        )}

        <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 1.5, color: COLORS.textSecondary }}>
          评估结果（摘要表字段，保存即局部修改）
        </Typography>
        <Stack spacing={1.5}>
          <Field label={FIELD_LABELS.skill} value={values.skill ?? ''} onChange={set('skill')} />
          <Field label={FIELD_LABELS.direction} value={values.direction ?? ''} onChange={set('direction')} />
          <Field
            label={FIELD_LABELS.direction_match}
            value={values.direction_match ?? ''}
            onChange={set('direction_match')}
            placeholder="82%"
          />
          <Field
            label={FIELD_LABELS.direction_confidence}
            value={values.direction_confidence ?? ''}
            onChange={set('direction_confidence')}
            select={['高', '中', '低']}
          />
          <Field label={FIELD_LABELS.city} value={values.city ?? ''} onChange={set('city')} />
          <Field
            label={FIELD_LABELS.city_score}
            value={values.city_score ?? ''}
            onChange={set('city_score')}
            placeholder="8.2/10"
          />
          <Field
            label={FIELD_LABELS.salary_feasible}
            value={values.salary_feasible ?? ''}
            onChange={set('salary_feasible')}
            select={['true', 'false']}
          />
          <Field
            label={FIELD_LABELS.risk_level}
            value={values.risk_level ?? ''}
            onChange={set('risk_level')}
            select={['低', '中', '中高', '高']}
          />
          <Field label={FIELD_LABELS.key_risk} value={values.key_risk ?? ''} onChange={set('key_risk')} />
          <Field label={FIELD_LABELS.status} value={values.status ?? ''} onChange={set('status')} />
        </Stack>

        <Divider sx={{ my: 2.5 }} />
        <Button
          variant="contained"
          fullWidth
          disabled={saving}
          onClick={() => void save()}
          sx={{
            bgcolor: COLORS.accent,
            color: COLORS.onAccent,
            fontWeight: 600,
            fontSize: 13,
            '&:hover': { bgcolor: COLORS.accent, opacity: 0.9 },
          }}
        >
          {saving ? '保存中…' : '保存修改'}
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
          修改写回 decisions/ 摘要表，引擎自动重扫；决策是历史记录，不做删除
        </Typography>
      </Box>
    </Dialog>
  )
}
