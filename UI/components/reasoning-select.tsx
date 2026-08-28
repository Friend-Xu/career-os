/**
 * 推理等级选择器（Agent 会话模型选择器旁）：DeepSeek 原生 reasoning_effort 四档。
 * - 档位（2026-08-28 原生端点实测）：关闭=thinking disabled（思考 0、最快）；
 *   低=effort low（思考≈400 tokens）；高=effort high（≈700，默认档）；最大=effort max（≈1400）
 * - 即时保存（setAgentReasoning → settings/update），下一轮生效（与模型切换同语义）
 */
import PsychologyIcon from '@mui/icons-material/Psychology'
import { Box, MenuItem, Select, Tooltip, Typography } from '@mui/material'
import { COLORS, alpha } from '../data/constants'

export type ReasoningLevel = 'off' | 'low' | 'high' | 'max'

const LEVELS: { value: ReasoningLevel; label: string; desc: string }[] = [
  { value: 'off', label: '关闭', desc: '关闭思考推理——响应最快' },
  { value: 'low', label: '低', desc: '轻量思考——响应快，复杂任务可能欠思考' },
  { value: 'high', label: '高', desc: '标准思考（默认档）——均衡' },
  { value: 'max', label: '最大', desc: '深度思考——最严谨，耗时最长' },
]

export function ReasoningSelect({
  value,
  onChange,
}: {
  value: ReasoningLevel
  onChange: (level: ReasoningLevel) => void
}) {
  const current = LEVELS.find((l) => l.value === value) ?? LEVELS[0]!
  return (
    <Tooltip title={`推理等级：${current.desc}`} placement="bottom" enterDelay={400}>
      <Select
        size="small"
        value={value}
        onChange={(e) => onChange(e.target.value as ReasoningLevel)}
        IconComponent={() => null}
        renderValue={(v) => (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, fontSize: 11.5, whiteSpace: 'nowrap' }}>
            <PsychologyIcon sx={{ fontSize: 13, color: COLORS.accent, flexShrink: 0 }} />
            {LEVELS.find((l) => l.value === v)?.label ?? v}
          </Box>
        )}
        sx={{
          borderRadius: '10px',
          bgcolor: COLORS.bgElevated,
          border: `1px solid ${COLORS.border}`,
          minWidth: 92,
          height: 28,
          fontSize: 11.5,
          '& .MuiSelect-select': { py: 0.4, px: 1 },
          '&:hover': { borderColor: alpha(COLORS.accent, 0.5) },
          '&.Mui-focused': { borderColor: COLORS.accent },
          '& .MuiOutlinedInput-notchedOutline': { border: 'none' },
        }}
        MenuProps={{
          slotProps: {
            paper: {
              sx: {
                borderRadius: '12px',
                border: `1px solid ${COLORS.border}`,
                boxShadow: 3,
                '& .MuiMenuItem-root': { fontSize: 12, borderRadius: '8px', mx: 0.5, py: 0.6 },
                '& .MuiMenuItem-root:hover': { bgcolor: alpha(COLORS.accent, 0.1) },
                '& .Mui-selected': { bgcolor: `${alpha(COLORS.accent, 0.14)} !important`, fontWeight: 600 },
              },
            },
          },
        }}
      >
        {LEVELS.map((l) => (
          <MenuItem key={l.value} value={l.value}>
            <Box sx={{ display: 'flex', flexDirection: 'column', py: 0.2 }}>
              <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{l.label}</Typography>
              <Typography sx={{ fontSize: 10.5, color: COLORS.textMuted }}>{l.desc}</Typography>
            </Box>
          </MenuItem>
        ))}
      </Select>
    </Tooltip>
  )
}
