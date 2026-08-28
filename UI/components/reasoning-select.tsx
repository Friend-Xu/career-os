/**
 * 推理等级选择器（Agent 会话模型选择器旁）：thinking 控制档位。
 * - 档位映射（引擎 runner 实测驱动，2026-08-28）：auto=端点自适应（默认，最优）/
 *   low=思考预算 2K / high=思考预算 8K / off=关闭内部推理
 * - 即时保存（setAgentReasoning → settings/update），下一轮生效（与模型切换同语义）
 */
import PsychologyIcon from '@mui/icons-material/Psychology'
import { Box, MenuItem, Select, Tooltip, Typography } from '@mui/material'
import { COLORS, alpha } from '../data/constants'

export type ReasoningLevel = 'auto' | 'low' | 'high' | 'off'

const LEVELS: { value: ReasoningLevel; label: string; desc: string }[] = [
  { value: 'auto', label: '自动', desc: '思考自适应（默认）——模型按任务复杂度权衡，响应快且思考充分' },
  { value: 'low', label: '快速', desc: '思考预算 2K——优先响应速度，复杂任务可能欠思考' },
  { value: 'high', label: '深度', desc: '思考预算 8K——优先思考深度，适合复杂分析（更慢）' },
  { value: 'off', label: '关闭', desc: '关闭内部推理——最快，但复杂分析易缺关键判断' },
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
    <Tooltip title={`推理等级：${current.desc}`} placement="top">
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
